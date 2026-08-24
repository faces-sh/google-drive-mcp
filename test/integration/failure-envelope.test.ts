// Every failure this server returns has ONE shape:
//
//   [<code>] <one plain sentence: what did not happen>
//   HTTP <status> <reason phrase>
//   <the provider's response body, verbatim>
//
// These are the cases that made the shape necessary. A 401 and a 403 are both
// "the call was refused", and only Google's body says whether the credential
// expired or the account was never on the file; before this, both arrived as a
// one-line message with the body thrown away. The partial-batchUpdate case is
// the one that shipped a real bug: a Google Doc was created, its content
// insertion failed, and the call still read as a success.

import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

/** A GaxiosError as googleapis actually throws it. */
function googleError(status: number, statusText: string, body: unknown, message = 'API error') {
  const err = new Error(message) as Error & {
    code?: number;
    response?: { status: number; statusText: string; data: unknown };
  };
  err.code = status;
  err.response = { status, statusText, data: body };
  return err;
}

/** Split an envelope into its three parts. */
function parseEnvelope(text: string) {
  const lines = text.split('\n');
  const codeMatch = /^\[([a-z0-9_]+)\] (.*)$/.exec(lines[0]);
  return {
    code: codeMatch?.[1],
    sentence: codeMatch?.[2],
    statusLine: lines[1],
    body: lines.slice(2).join('\n'),
  };
}

describe('the failure envelope', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await setupTestServer();
  });

  after(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    ctx.mocks.drive.tracker.reset();
    ctx.mocks.docs.tracker.reset();
    ctx.mocks.drive.service.files.list._resetImpl();
    ctx.mocks.drive.service.files.get._resetImpl();
    ctx.mocks.drive.service.files.create._resetImpl();
    ctx.mocks.docs.service.documents.get._resetImpl();
    ctx.mocks.docs.service.documents.batchUpdate._resetImpl();
  });

  // -------------------------------------------------------------------------
  // 401 — an expired credential
  // -------------------------------------------------------------------------
  it('401: carries the status line and Google\'s body verbatim', async () => {
    const body = {
      error: {
        code: 401,
        message: 'Request had invalid authentication credentials. Expected OAuth 2 access token.',
        status: 'UNAUTHENTICATED',
      },
    };
    ctx.mocks.drive.service.files.list._setImpl(async () => {
      throw googleError(401, 'Unauthorized', body, 'Invalid Credentials');
    });

    const res = await callTool(ctx.client, 'search', { query: 'anything' });

    assert.equal(res.isError, true);
    const env = parseEnvelope(res.content[0].text!);
    assert.equal(env.code, 'http_401');
    assert.equal(env.statusLine, 'HTTP 401 Unauthorized');
    // Rule 5: byte for byte, so the caller can tell an expired token from a
    // permission that was never granted.
    assert.equal(env.body, JSON.stringify(body));
    assert.ok(env.sentence && env.sentence.length > 0);
    // Rule 7: the server does not tell anyone what to do about it.
    assert.doesNotMatch(res.content[0].text!, /reconnect|try again|re-authenticate/i);
  });

  // -------------------------------------------------------------------------
  // 403 — a permission the account never had
  // -------------------------------------------------------------------------
  it('403: the body says PERMISSION_DENIED, and the server does not interpret it', async () => {
    const body = {
      error: {
        code: 403,
        message: 'The caller does not have permission',
        status: 'PERMISSION_DENIED',
      },
    };
    ctx.mocks.docs.service.documents.batchUpdate._setImpl(async () => {
      throw googleError(403, 'Forbidden', body, 'The caller does not have permission');
    });

    const res = await callTool(ctx.client, 'insertTable', {
      documentId: 'doc-1',
      index: 1,
      rows: 2,
      columns: 2,
    });

    assert.equal(res.isError, true);
    const env = parseEnvelope(res.content[0].text!);
    assert.equal(env.code, 'http_403');
    assert.equal(env.statusLine, 'HTTP 403 Forbidden');
    assert.equal(env.body, JSON.stringify(body));
    assert.match(env.body, /PERMISSION_DENIED/);
  });

  // -------------------------------------------------------------------------
  // 404 — a file id that does not resolve
  // -------------------------------------------------------------------------
  it('404 on a missing file id: not found, with the id and the body', async () => {
    const body = { error: { code: 404, message: 'File not found: no-such-file.', status: 'NOT_FOUND' } };
    ctx.mocks.drive.service.files.get._setImpl(async () => {
      throw googleError(404, 'Not Found', body, 'File not found: no-such-file.');
    });

    const res = await callTool(ctx.client, 'readTextFile', { fileId: 'no-such-file' });

    assert.equal(res.isError, true);
    const env = parseEnvelope(res.content[0].text!);
    assert.equal(env.code, 'http_404');
    assert.equal(env.statusLine, 'HTTP 404 Not Found');
    assert.equal(env.body, JSON.stringify(body));
  });

  // -------------------------------------------------------------------------
  // Partial success: the document exists and is empty
  // -------------------------------------------------------------------------
  it('createGoogleDoc whose batchUpdate fails is a FAILURE, not a success with a note', async () => {
    ctx.mocks.drive.service.files.list._setImpl(async () => ({ data: { files: [] } }));
    ctx.mocks.drive.service.files.create._setImpl(async () => ({
      data: { id: 'doc-partial', name: 'Quarterly Report', webViewLink: 'https://docs.example/doc-partial' },
    }));
    const body = {
      error: { code: 400, message: 'Invalid requests[0].insertText: Index 1 must be less than the end index', status: 'INVALID_ARGUMENT' },
    };
    ctx.mocks.docs.service.documents.batchUpdate._setImpl(async () => {
      throw googleError(400, 'Bad Request', body, 'Invalid requests[0].insertText');
    });

    const res = await callTool(ctx.client, 'createGoogleDoc', {
      name: 'Quarterly Report',
      content: 'the body that never landed',
    });

    assert.equal(res.isError, true);
    const env = parseEnvelope(res.content[0].text!);
    assert.equal(env.code, 'http_400');
    assert.equal(env.statusLine, 'HTTP 400 Bad Request');
    assert.equal(env.body, JSON.stringify(body));
    // The document is real, so its id is a fact the caller needs.
    assert.match(env.sentence!, /doc-partial/);
    // ...but the call did not do what it was asked to do, and says so.
    assert.match(env.sentence!, /could not put any content in it/);
    // Rule 7: no "retry with updateGoogleDoc".
    assert.doesNotMatch(res.content[0].text!, /\bretry\b/i);
  });

  // -------------------------------------------------------------------------
  // Rule 8 — no secrets
  // -------------------------------------------------------------------------
  it('redacts credentials out of an echoed body', async () => {
    const body = {
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.',
      client_id: '1234-abc.apps.googleusercontent.com',
      client_secret: 'GOCSPX-super-secret',
      refresh_token: '1//0gLeAkEdRefreshToken',
      request_headers: { authorization: 'Bearer ya29.a0LeAkEdAccessToken' },
    };
    ctx.mocks.drive.service.files.list._setImpl(async () => {
      throw googleError(400, 'Bad Request', body);
    });

    const res = await callTool(ctx.client, 'search', { query: 'anything' });
    const text = res.content[0].text!;

    assert.equal(res.isError, true);
    for (const secret of [
      'GOCSPX-super-secret',
      '1//0gLeAkEdRefreshToken',
      'ya29.a0LeAkEdAccessToken',
      '1234-abc.apps.googleusercontent.com',
    ]) {
      assert.ok(!text.includes(secret), `envelope leaked ${secret}`);
    }
    assert.match(text, /<redacted>/);
    // Everything that is NOT a credential still arrives untouched.
    assert.match(text, /invalid_grant/);
    assert.match(text, /Token has been expired or revoked\./);
  });

  // -------------------------------------------------------------------------
  // Rule 6 — a failed existence check is not "it does not exist"
  // -------------------------------------------------------------------------
  it('a failed duplicate-name lookup fails the call instead of creating a second file', async () => {
    const body = { error: { code: 403, message: 'Insufficient Permission', status: 'PERMISSION_DENIED' } };
    ctx.mocks.drive.service.files.list._setImpl(async () => {
      throw googleError(403, 'Forbidden', body, 'Insufficient Permission');
    });
    let created = false;
    ctx.mocks.drive.service.files.create._setImpl(async () => {
      created = true;
      return { data: { id: 'should-not-exist', name: 'Report' } };
    });

    const res = await callTool(ctx.client, 'createGoogleDoc', { name: 'Report', content: 'x' });

    assert.equal(res.isError, true);
    assert.equal(created, false, 'a failed lookup must not be read as "the name is free"');
    const env = parseEnvelope(res.content[0].text!);
    assert.equal(env.code, 'http_403');
    assert.equal(env.body, JSON.stringify(body));
  });

  // -------------------------------------------------------------------------
  // Rule 4 — no status line when the failure was not HTTP
  // -------------------------------------------------------------------------
  it('a non-HTTP failure carries no invented status line', async () => {
    const res = await callTool(ctx.client, 'readGoogleDoc', {});
    assert.equal(res.isError, true);
    const text = res.content[0].text!;
    assert.match(text, /^\[[a-z0-9_]+\] /);
    assert.doesNotMatch(text, /\nHTTP \d/);
  });
});
