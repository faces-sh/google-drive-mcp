import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bodyTextRequests } from '../../src/tools/docs.js';

/**
 * A blank document must be creatable.
 *
 * `createGoogleDoc` used to send an insertText unconditionally, so asking for a doc with no content
 * created the file in Drive and then failed the batch:
 *
 *   Error: Created Google Doc but content insertion failed: meta issue test
 *   Reason: Invalid requests[0].insertText: Insert text requests must specify text
 *
 * The doc existed, the tool reported an error, and the caller was told to retry an insertion that
 * could never succeed. Empty content is a legal ask, not a failure.
 */
describe('bodyTextRequests', () => {
  it('asks for nothing when there is nothing to write', () => {
    assert.deepEqual(bodyTextRequests(''), []);
    assert.deepEqual(bodyTextRequests('', 'tab.1'), []);
  });

  it('inserts the text and styles exactly the range it inserted', () => {
    const requests = bodyTextRequests('hello');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].insertText, { location: { index: 1 }, text: 'hello' });
    assert.deepEqual(requests[1].updateParagraphStyle.range, { startIndex: 1, endIndex: 6 });
    assert.equal(requests[1].updateParagraphStyle.paragraphStyle.namedStyleType, 'NORMAL_TEXT');
  });

  it('scopes both requests to a tab when one is named', () => {
    const requests = bodyTextRequests('hi', 'tab.7');
    assert.equal(requests[0].insertText.location.tabId, 'tab.7');
    assert.equal(requests[1].updateParagraphStyle.range.tabId, 'tab.7');
  });

  /**
   * Whitespace is content. Someone asking for a blank line gets a blank line, and Google accepts it,
   * so the empty check is length-based and never trims.
   */
  it('treats whitespace as content', () => {
    assert.equal(bodyTextRequests('\n').length, 2);
    assert.equal(bodyTextRequests(' ')[0].insertText.text, ' ');
  });
});
