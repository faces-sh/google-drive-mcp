// ---------------------------------------------------------------------------
// The uniform failure envelope.
//
// Every failure this server returns has one shape:
//
//   [<code>] <one plain sentence: what did not happen>
//   HTTP <status> <reason phrase>
//   <the provider's response body, verbatim>
//
// Line 1 is for a person and for the model. Lines 2 and 3 are the evidence.
//
// The rules this file implements (see docs/MCP_FAILURE_ENVELOPE.md in the
// Maestro repo, which is the authoritative spec):
//
//   1. `isError: true` on the MCP result. Always.
//   2. `[<code>]` is `http_<status>` for an HTTP failure, lowercase snake_case
//      otherwise (`no_credentials`, `not_found`, `timeout`, `bad_request`, ...).
//   3. Line 1 says what did not happen, in words a person reads.
//   4. The status line is literal, and is omitted entirely when the failure was
//      not HTTP.
//   5. The body is VERBATIM and UNINTERPRETED, capped at 4000 characters.
//   6. Never swallow a failure into a success.
//   7. Never invent a remedy.
//   8. No secrets: Authorization, Cookie, and any access_token / refresh_token /
//      client_secret / client_id value is replaced with `<redacted>`.
//
// Why the body and not a summary: an expired credential and a permission the
// account never had are both "403" and want opposite responses. Only Google's
// body separates them, and only the caller can act on the difference.
// ---------------------------------------------------------------------------

import type { ToolResult } from './types.js';

/** Rule 5: the provider's body is capped, never summarised. */
export const MAX_BODY_CHARS = 4000;

/** Appended when the body is cut at MAX_BODY_CHARS. */
export const TRUNCATION_MARKER = ' ...[truncated]';

/**
 * Reason phrases for the statuses Google actually returns, used only when the
 * transport did not give us one. Never invented beyond this table: an unknown
 * status yields `HTTP <status>` with no phrase rather than a guess.
 */
const REASON_PHRASES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  416: 'Requested Range Not Satisfiable',
  422: 'Unprocessable Entity',
  423: 'Locked',
  429: 'Too Many Requests',
  499: 'Client Closed Request',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

// ---------------------------------------------------------------------------
// Rule 8 — redaction
// ---------------------------------------------------------------------------

/**
 * Every key whose VALUE is credential material. Order matters only in that the
 * longer names must precede their prefixes (`client_secret` before `client_id`
 * is irrelevant here, but `refresh_token` must not be eaten by `token`, which is
 * why no bare `token` key is listed).
 */
const SECRET_KEYS = [
  'authorization',
  'proxy-authorization',
  'set-cookie',
  'cookie',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'client_id',
  'code_verifier',
  'assertion',
  'private_key',
];

const KEY_ALTERNATION = SECRET_KEYS.map((k) => k.replace(/[-]/g, '\\-')).join('|');

/** `"access_token": "ya29..."` — JSON and JS object literals, single or double quoted. */
const QUOTED_KV = new RegExp(
  `(["'](?:${KEY_ALTERNATION})["']\\s*:\\s*)(["'])(?:\\\\.|(?!\\2)[^\\\\])*\\2`,
  'gi',
);

/** `Authorization: Bearer ya29...` — a raw header line. */
const HEADER_LINE = new RegExp(`^([ \\t]*(?:${KEY_ALTERNATION})[ \\t]*:[ \\t]*)(.+)$`, 'gim');

/** `refresh_token=1//abc&client_secret=xyz` — form-encoded bodies and query strings. */
const FORM_KV = new RegExp(`((?:${KEY_ALTERNATION})=)([^&\\s"'\\\\]+)`, 'gi');

/** A credential following an auth scheme, wherever it appears. */
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/=]+/gi;

/**
 * Rule 8. Replace every credential value with `<redacted>`; leave everything
 * else byte for byte as the provider wrote it.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  out = out.replace(QUOTED_KV, (_m, lead: string, quote: string) => `${lead}${quote}<redacted>${quote}`);
  out = out.replace(HEADER_LINE, '$1<redacted>');
  out = out.replace(FORM_KV, '$1<redacted>');
  out = out.replace(AUTH_SCHEME, '$1 <redacted>');
  return out;
}

// ---------------------------------------------------------------------------
// HTTP details
// ---------------------------------------------------------------------------

export interface HttpDetails {
  status: number;
  /** May be empty: an unknown status gets no invented phrase. */
  reason: string;
  /** The provider's body, verbatim (rule 5). May be empty. */
  body: string;
}

function asStatus(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
}

/**
 * Serialise a provider body without interpreting it. A string stays a string; a
 * parsed JSON body (which is what googleapis hands back) is re-serialised; a
 * Buffer is decoded as UTF-8.
 */
function bodyToText(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return data;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return data.toString('utf-8');
  if (typeof data !== 'object') return String(data);
  try {
    return JSON.stringify(data);
  } catch {
    // Circular or otherwise unserialisable (e.g. a stream response). Say so
    // rather than guessing at its contents.
    return '';
  }
}

/**
 * Pull `{ status, reason, body }` off anything Google's clients throw:
 * a gaxios `GaxiosError` (googleapis, google-auth-library), a `Response`-shaped
 * rejection, or a plain error carrying `status` / numeric `code`.
 *
 * Returns null when the failure was not HTTP, which is rule 4's signal to omit
 * the status line entirely.
 */
export function httpDetailsOf(err: unknown): HttpDetails | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as {
    status?: unknown;
    code?: unknown;
    body?: unknown;
    response?: { status?: unknown; statusText?: unknown; data?: unknown };
  };
  const res = e.response;
  // `code` is last: gaxios sets it to the numeric status for HTTP failures but
  // to a Node syscall code (ENOTFOUND, ETIMEDOUT) for transport failures, and
  // asStatus rejects those.
  const status = asStatus(res?.status) ?? asStatus(e.status) ?? asStatus(e.code);
  if (status === undefined) return null;

  const statusText = typeof res?.statusText === 'string' ? res.statusText.trim() : '';
  const reason = statusText || REASON_PHRASES[status] || '';
  const body = bodyToText(res?.data ?? e.body);
  return { status, reason, body };
}

// ---------------------------------------------------------------------------
// Envelope construction
// ---------------------------------------------------------------------------

/** Render the envelope text: `[code] sentence`, then the evidence lines. */
export function envelopeText(code: string, sentence: string, http?: HttpDetails | null): string {
  const lines = [`[${code}] ${sentence.trim()}`];
  if (http) {
    lines.push(`HTTP ${http.status}${http.reason ? ` ${http.reason}` : ''}`);
    const body = http.body ?? '';
    if (body.length > 0) {
      lines.push(body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + TRUNCATION_MARKER : body);
    }
  }
  return redactSecrets(lines.join('\n'));
}

/** Build the MCP result. Rule 1: `isError: true`, always. */
export function envelope(code: string, sentence: string, http?: HttpDetails | null): ToolResult {
  return { content: [{ type: 'text', text: envelopeText(code, sentence, http) }], isError: true };
}

/**
 * A failure carrying its own envelope, thrown from a helper so the details
 * survive the trip to whichever handler catches it.
 *
 * A helper that re-wraps a Google error in a bare `new Error(...)` destroys the
 * status and the body, which is the exact defect this file exists to end.
 */
export class ToolFailure extends Error {
  readonly code: string;
  readonly sentence: string;
  readonly http: HttpDetails | null;

  constructor(code: string, sentence: string, http?: HttpDetails | null) {
    super(envelopeText(code, sentence, http));
    this.name = 'ToolFailure';
    this.code = code;
    this.sentence = sentence;
    this.http = http ?? null;
  }

  toResult(): ToolResult {
    return envelope(this.code, this.sentence, this.http);
  }
}

/** Node/undici transport codes that mean the request never reached Google. */
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/** Classify a non-HTTP failure. Nothing here inspects a provider body. */
function nonHttpCode(err: unknown): string {
  if (!err || typeof err !== 'object') return 'internal_error';
  const e = err as { name?: unknown; code?: unknown };
  const code = typeof e.code === 'string' ? e.code.toUpperCase() : '';
  if (e.name === 'TimeoutError' || e.name === 'AbortError' || TIMEOUT_CODES.has(code)) return 'timeout';
  if (NETWORK_CODES.has(code)) return 'network_error';
  return 'internal_error';
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(err);
}

/**
 * Turn any caught error into the envelope.
 *
 * `sentence` says what did not happen, in the caller's own words. It is never
 * derived from the error, and the error is never summarised into it: for an
 * HTTP failure the status line and Google's body carry the evidence, and for a
 * non-HTTP failure (where rule 4 forbids a status line) the underlying message
 * is appended after a colon, because otherwise there would be no evidence at all.
 *
 * `fallbackCode` names the code to use when the failure is NOT HTTP; an HTTP
 * failure is always `http_<status>` (rule 2).
 */
export function failure(sentence: string, err: unknown, fallbackCode?: string): ToolResult {
  return toolFailure(sentence, err, fallbackCode).toResult();
}

/**
 * The `throw` form of {@link failure}, for helpers that cannot return a
 * ToolResult. Whatever catches it renders the same envelope.
 */
export function toolFailure(sentence: string, err: unknown, fallbackCode?: string): ToolFailure {
  if (err instanceof ToolFailure) return err;
  const http = httpDetailsOf(err);
  // Rule 2: an HTTP failure is always `http_<status>`, whatever the caller
  // believes it means. `fallbackCode` only names the NON-http case, where the
  // caller genuinely knows more than the classifier does.
  if (http) return new ToolFailure(`http_${http.status}`, sentence, http);
  const detail = messageOf(err).trim();
  const line = detail && !sentence.includes(detail) ? `${stripTrailingPeriod(sentence)}: ${detail}` : sentence;
  return new ToolFailure(fallbackCode ?? nonHttpCode(err), line, null);
}

function stripTrailingPeriod(s: string): string {
  return s.trim().replace(/\.$/, '');
}

// ---------------------------------------------------------------------------
// Non-HTTP failures with a known cause
// ---------------------------------------------------------------------------

/**
 * The failure result for everything the server itself refuses: a malformed
 * argument, a range that does not exist, a name that resolves to nothing.
 *
 * `code` defaults to `bad_request` because that is what an argument the server
 * rejects before it ever calls Google is. Pass `not_found`, `no_credentials`,
 * `unsupported` or `unexpected_response` where one of those is the truth.
 */
export function errorResponse(message: string, code: string = 'bad_request'): ToolResult {
  return envelope(code, message, null);
}

/** The caller named something that does not exist. */
export function notFound(message: string): ToolResult {
  return envelope('not_found', message, null);
}

/** No usable account/token: the call was never authenticated in the first place. */
export function noCredentials(message: string): ToolResult {
  return envelope('no_credentials', message, null);
}

/**
 * Google answered 2xx but the answer did not contain what the call needs. Not a
 * success (rule 6) and not an HTTP failure (rule 4), so it carries no status line.
 */
export function unexpectedResponse(message: string): ToolResult {
  return envelope('unexpected_response', message, null);
}

// ---------------------------------------------------------------------------
// Tool names in plain words
// ---------------------------------------------------------------------------

/**
 * Rule 3: line 1 is read by a person, so it must not contain a symbol.
 * `createGoogleDoc` becomes "create Google doc", `insertSlidesLocalImage`
 * becomes "insert Slides local image". Only the tool's own name is used;
 * nothing is ever read out of the error.
 */
export function humanizeToolName(toolName: string): string {
  const words = toolName
    .replace(/[._]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(properNoun);
  return words.length > 0 ? words.join(' ') : 'complete that request';
}

/** Names that stay capitalised (or upper-cased) when a tool name is spelled out. */
const PROPER_NOUNS: Record<string, string> = {
  google: 'Google',
  pdf: 'PDF',
  html: 'HTML',
  csv: 'CSV',
  docx: 'DOCX',
  url: 'URL',
  a1: 'A1',
};

function properNoun(word: string): string {
  return PROPER_NOUNS[word.toLowerCase()] ?? word.toLowerCase();
}
