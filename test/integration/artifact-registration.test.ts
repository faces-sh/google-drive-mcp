import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { createServer, type Server } from 'node:http';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

/**
 * A document that EXISTS must be registered with Maestro, even when the same call went on to fail.
 *
 * Registration is how a created document reaches the user's resource list. It used to happen at the very
 * end of `createGoogleDoc`, after the content insert, so a failed insert returned early and the document
 * was never registered: a real, empty file sat in the person's Drive that Maestro had never heard of and
 * they could not find again through the app.
 *
 * The envelope goes out of band, to Maestro's loopback broker, and never through the tool result the model
 * reads. That is the charter rule ("never send the model machine data"), and it is why this test asserts on
 * a captured POST rather than on the tool's text.
 */
describe('artifact registration', () => {
  let ctx: TestContext;
  let broker: Server;
  let received: any[] = [];

  before(async () => {
    ctx = await setupTestServer();
    broker = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ secret: req.headers['x-artifact-secret'], envelope: JSON.parse(body || '{}') });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((r) => broker.listen(0, '127.0.0.1', r));
    const port = (broker.address() as any).port;
    process.env.MAESTRO_ARTIFACT_URL = `http://127.0.0.1:${port}/`;
    process.env.MAESTRO_ARTIFACT_SECRET = 'test-secret';
  });

  after(async () => {
    delete process.env.MAESTRO_ARTIFACT_URL;
    delete process.env.MAESTRO_ARTIFACT_SECRET;
    await new Promise<void>((r) => broker.close(() => r()));
    await ctx.cleanup();
  });

  beforeEach(() => {
    received = [];
    ctx.mocks.drive.tracker.reset();
    ctx.mocks.docs.tracker.reset();
    ctx.mocks.drive.service.files.get._resetImpl();
    ctx.mocks.drive.service.files.list._setImpl(async () => ({ data: { files: [] } }));
    ctx.mocks.drive.service.files.create._setImpl(async () => ({
      data: { id: 'doc-reg-1', name: 'Registered doc',
              webViewLink: 'https://docs.google.com/document/d/doc-reg-1/edit' },
    }));
  });

  /** Registration is fire-and-forget, so give the POST a moment to land. */
  const settle = async () => { for (let i = 0; i < 50 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 10)); };

  it('registers a document whose content insert failed', async () => {
    ctx.mocks.docs.service.documents.batchUpdate._setImpl(async () => {
      const e: any = new Error('Invalid requests[0].insertText: something the server refused');
      e.code = 400;                       // a client error: wrong forever, so it is not retried
      throw e;
    });

    const res = await callTool(ctx.client, 'createGoogleDoc', { name: 'Registered doc', content: 'hello' });
    assert.equal(res.isError, true, 'precondition: the insert failed');

    await settle();
    assert.equal(received.length, 1, 'the document exists, so exactly one envelope should have been sent');
    assert.equal(received[0].envelope.provider_ref, 'doc-reg-1');
    assert.equal(received[0].envelope.provider, 'google_docs');
    assert.equal(received[0].envelope.uri, 'https://docs.google.com/document/d/doc-reg-1/edit');
    assert.equal(received[0].secret, 'test-secret', 'the broker is authenticated');
  });

  it('registers a blank document, which performs no insert at all', async () => {
    const res = await callTool(ctx.client, 'createGoogleDoc', { name: 'Registered doc', content: '' });
    assert.equal(res.isError, false);

    await settle();
    assert.equal(received.length, 1);
    assert.equal(received[0].envelope.provider_ref, 'doc-reg-1');
  });

  it('registers an ordinary successful creation exactly once', async () => {
    ctx.mocks.docs.service.documents.batchUpdate._setImpl(async () => ({ data: {} }));

    const res = await callTool(ctx.client, 'createGoogleDoc', { name: 'Registered doc', content: 'hello' });
    assert.equal(res.isError, false);

    await settle();
    assert.equal(received.length, 1, 'moving registration earlier must not double-register');
  });
});
