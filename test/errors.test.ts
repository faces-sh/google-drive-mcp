// Unit tests for the envelope builder itself: redaction (rule 8), the status
// line (rules 2 and 4), the 4000-character cap (rule 5), and the classification
// of a failure that never reached Google.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_BODY_CHARS,
  TRUNCATION_MARKER,
  ToolFailure,
  envelopeText,
  errorResponse,
  failure,
  httpDetailsOf,
  humanizeToolName,
  redactSecrets,
} from '../src/errors.js';

function gaxios(status: number, statusText: string, data: unknown) {
  const err = new Error('boom') as Error & {
    code?: number;
    response?: { status: number; statusText: string; data: unknown };
  };
  err.code = status;
  err.response = { status, statusText, data };
  return err;
}

// ---------------------------------------------------------------------------
// Rule 8 — redaction
// ---------------------------------------------------------------------------

test('redactSecrets: JSON credential values', () => {
  const out = redactSecrets('{"access_token":"ya29.abc","expires_in":3599}');
  assert.equal(out, '{"access_token":"<redacted>","expires_in":3599}');
});

test('redactSecrets: header lines', () => {
  const out = redactSecrets('Authorization: Bearer ya29.abc\nCookie: SID=xyz\nAccept: */*');
  assert.equal(out, 'Authorization: <redacted>\nCookie: <redacted>\nAccept: */*');
});

test('redactSecrets: form-encoded refresh bodies', () => {
  const out = redactSecrets('grant_type=refresh_token&refresh_token=1//abc&client_secret=GOCSPX-x');
  assert.equal(out, 'grant_type=refresh_token&refresh_token=<redacted>&client_secret=<redacted>');
});

test('redactSecrets: a bearer token anywhere in the text', () => {
  assert.equal(redactSecrets('sent Bearer ya29.abcDEF-123 upstream'), 'sent Bearer <redacted> upstream');
});

test('redactSecrets: leaves everything that is not a credential alone', () => {
  const body = '{"error":{"code":403,"message":"The caller does not have permission","status":"PERMISSION_DENIED"}}';
  assert.equal(redactSecrets(body), body);
});

// ---------------------------------------------------------------------------
// Rules 2 and 4 — the code and the status line
// ---------------------------------------------------------------------------

test('httpDetailsOf: reads status, reason and body off a gaxios error', () => {
  const d = httpDetailsOf(gaxios(429, 'Too Many Requests', { error: { code: 429 } }));
  assert.deepEqual(d, { status: 429, reason: 'Too Many Requests', body: '{"error":{"code":429}}' });
});

test('httpDetailsOf: supplies the reason phrase when the transport omits it', () => {
  const err = new Error('x') as Error & { response?: { status: number; data: unknown } };
  err.response = { status: 403, data: 'nope' };
  assert.deepEqual(httpDetailsOf(err), { status: 403, reason: 'Forbidden', body: 'nope' });
});

test('httpDetailsOf: a Node syscall code is not a status', () => {
  const err = new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com') as Error & { code?: string };
  err.code = 'ENOTFOUND';
  assert.equal(httpDetailsOf(err), null);
});

test('failure: an HTTP error becomes http_<status> with the literal status line', () => {
  const res = failure('Could not read the document.', gaxios(404, 'Not Found', { error: 'gone' }));
  assert.equal(res.isError, true);
  assert.equal(
    res.content[0].text,
    '[http_404] Could not read the document.\nHTTP 404 Not Found\n{"error":"gone"}',
  );
});

test('failure: a transport error carries no status line and is classified', () => {
  const err = new Error('getaddrinfo ENOTFOUND www.googleapis.com') as Error & { code?: string };
  err.code = 'ENOTFOUND';
  const res = failure('Could not reach Google.', err);
  assert.equal(
    res.content[0].text,
    '[network_error] Could not reach Google: getaddrinfo ENOTFOUND www.googleapis.com',
  );
});

test('failure: a ToolFailure keeps the code its thrower chose', () => {
  const res = failure('ignored', new ToolFailure('no_credentials', 'No Google account is authenticated.'));
  assert.equal(res.content[0].text, '[no_credentials] No Google account is authenticated.');
});

test('errorResponse: defaults to bad_request and is always isError', () => {
  const res = errorResponse('endIndex must be greater than startIndex.');
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, '[bad_request] endIndex must be greater than startIndex.');
});

// ---------------------------------------------------------------------------
// Rule 5 — the cap
// ---------------------------------------------------------------------------

test('envelopeText: a long body is cut at the cap and marked, never summarised', () => {
  const body = 'x'.repeat(MAX_BODY_CHARS + 500);
  const text = envelopeText('http_500', 'Could not do it.', {
    status: 500,
    reason: 'Internal Server Error',
    body,
  });
  const lines = text.split('\n');
  assert.equal(lines[1], 'HTTP 500 Internal Server Error');
  assert.equal(lines[2].length, MAX_BODY_CHARS + TRUNCATION_MARKER.length);
  assert.ok(lines[2].endsWith(TRUNCATION_MARKER));
});

test('envelopeText: an empty body leaves the third line off entirely', () => {
  const text = envelopeText('http_503', 'Could not do it.', { status: 503, reason: 'Service Unavailable', body: '' });
  assert.equal(text, '[http_503] Could not do it.\nHTTP 503 Service Unavailable');
});

// ---------------------------------------------------------------------------
// Rule 3 — line 1 is words, not symbols
// ---------------------------------------------------------------------------

test('humanizeToolName: spells a tool name out', () => {
  assert.equal(humanizeToolName('createGoogleDoc'), 'create Google doc');
  assert.equal(humanizeToolName('listSpreadsheetSheets'), 'list spreadsheet sheets');
  assert.equal(humanizeToolName('uploadPdfWithSplit'), 'upload PDF with split');
});
