import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';
import { readKey } from '../../src/tools/docs.js';

/**
 * The read loop-breaker must refuse a model that is spinning, and ONLY that model.
 *
 * It used to key on `documentId` alone and cap at 2 reads per 90s, so the third read of a document was
 * refused no matter what it asked for. Reading tab A, tab B then tab C of one document was impossible;
 * so was reading a doc as text and then as markdown. Each refusal told the model
 *
 *   "You already have it, do NOT ask again"
 *
 * about content it had never seen. Two things fix it: count a read as the same only when the whole request
 * matches, and check that the ANSWER was identical rather than assuming it. A shared document can change
 * under us at any moment, because the person can edit it in their browser between two reads.
 */
describe('read loop-breaker', () => {
  let ctx: TestContext;

  before(async () => { ctx = await setupTestServer(); });
  after(async () => { await ctx.cleanup(); });
  beforeEach(() => {
    ctx.mocks.drive.tracker.reset();
    ctx.mocks.docs.tracker.reset();
    ctx.mocks.drive.service.files.get._resetImpl();
  });

  const tab = (tabId: string, title: string, content: string) => ({
    tabProperties: { tabId, title },
    documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content } }] } }] } },
  });

  /** THE bug. Three tabs of one document is three different reads, and all three must return content. */
  it('reads every tab of one document, however many there are', async () => {
    ctx.mocks.docs.service.documents.get._setImpl(async () => ({
      data: {
        documentId: 'doc-guard-1', title: 'Three tabs',
        tabs: [tab('tab-1', 'One', 'Alpha\n'), tab('tab-2', 'Two', 'Bravo\n'), tab('tab-3', 'Three', 'Charlie\n')],
      },
    }));

    for (const [tabId, expected] of [['tab-1', 'Alpha'], ['tab-2', 'Bravo'], ['tab-3', 'Charlie']] as const) {
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-guard-1', tabId });
      assert.equal(res.isError, false);
      assert.ok(res.content[0].text!.includes(expected),
                `${tabId} was refused or empty: ${JSON.stringify(res.content[0].text)}`);
    }
  });

  /** A document that changed between two identical requests must be returned, not refused. */
  it('returns a changed answer even when the request is identical', async () => {
    let n = 0;
    ctx.mocks.docs.service.documents.get._setImpl(async () => ({
      data: {
        documentId: 'doc-guard-2', title: 'Edited elsewhere',
        body: { content: [{ paragraph: { elements: [{ textRun: { content: `revision ${++n}\n` } }] } }] },
      },
    }));

    for (const expected of ['revision 1', 'revision 2', 'revision 3', 'revision 4']) {
      const res = await callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-guard-2' });
      assert.ok(res.content[0].text!.includes(expected),
                `a read whose answer changed was refused: ${JSON.stringify(res.content[0].text)}`);
    }
  });

  /** And the behaviour it exists for: the same question, the same answer, over and over. */
  it('refuses the same request once it has returned the same answer twice', async () => {
    ctx.mocks.docs.service.documents.get._setImpl(async () => ({
      data: {
        documentId: 'doc-guard-3', title: 'Unchanging',
        body: { content: [{ paragraph: { elements: [{ textRun: { content: 'stable\n' } }] } }] },
      },
    }));

    const read = () => callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-guard-3' });
    assert.ok((await read()).content[0].text!.includes('stable'));
    assert.ok((await read()).content[0].text!.includes('stable'));
    const third = await read();
    assert.ok(third.content[0].text!.includes('do NOT ask again'),
              `the third identical read should have been refused: ${JSON.stringify(third.content[0].text)}`);
  });

  /** A write means the next read is legitimately fresh, whatever it returns. */
  it('starts over after the document is written to', async () => {
    ctx.mocks.docs.service.documents.get._setImpl(async () => ({
      data: {
        documentId: 'doc-guard-4', title: 'Written',
        body: { content: [{ paragraph: { elements: [{ textRun: { content: 'same\n' } }] } }] },
      },
    }));

    const read = () => callTool(ctx.client, 'readGoogleDoc', { documentId: 'doc-guard-4' });
    await read(); await read();
    assert.ok((await read()).content[0].text!.includes('do NOT ask again'), 'precondition: guard is engaged');

    await callTool(ctx.client, 'updateGoogleDoc', { documentId: 'doc-guard-4', content: 'new body' });

    const after = await read();
    assert.ok(after.content[0].text!.includes('same'),
              `a read after a write must return content: ${JSON.stringify(after.content[0].text)}`);
  });

  describe('readKey', () => {
    it('separates reads that differ in any way they can differ', () => {
      const base = { documentId: 'd' };
      const keys = [
        readKey('getGoogleDocContent', base),
        readKey('readGoogleDoc', { ...base, tabId: 'tab-1' }),
        readKey('readGoogleDoc', { ...base, tabId: 'tab-2' }),
        readKey('readGoogleDoc', { ...base, format: 'markdown' }),
        readKey('listDocumentTabs', base),
      ];
      assert.equal(new Set(keys).size, keys.length, 'every one of these is a different read');
    });

    it('is stable regardless of the order the arguments arrive in', () => {
      assert.equal(readKey('t', { a: 1, b: 2 }), readKey('t', { b: 2, a: 1 }));
    });
  });
});
