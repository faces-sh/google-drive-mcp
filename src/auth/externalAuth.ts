// ---------------------------------------------------------------------------
// External authentication modes: Service Account & pre-obtained OAuth tokens
// ---------------------------------------------------------------------------

import { createPrivateKey } from 'crypto';
import { readFileSync } from 'fs';
import { OAuth2Client } from 'google-auth-library';
import { GoogleAuth, GoogleAuthOptions } from 'google-auth-library';
import { resolveOAuthScopes } from './scopes.js';
import { ToolFailure } from '../errors.js';
import { describeErrorForLog } from './utils.js';

// ---------------------------------------------------------------------------
// Service Account mode
// ---------------------------------------------------------------------------

/** True when `GOOGLE_APPLICATION_CREDENTIALS` is set (standard Google convention). */
export function isServiceAccountMode(): boolean {
  return !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
}

export type ActiveAuthMode = 'service_account' | 'external_token' | 'oauth';

/**
 * Env vars whose mere presence overrides the local `tokens.json` OAuth flow.
 * Keyed by the mode they force. Used to explain to users *why* their
 * authenticated `tokens.json` is being bypassed (see issue #137).
 */
export const AUTH_MODE_OVERRIDE_ENV_VARS: Record<Exclude<ActiveAuthMode, 'oauth'>, string> = {
  service_account: 'GOOGLE_APPLICATION_CREDENTIALS',
  external_token: 'GOOGLE_DRIVE_MCP_ACCESS_TOKEN',
};

/**
 * The single source of truth for which auth mode `authenticate()` (src/auth.ts)
 * selects, based purely on env-var presence. Service-account and external-token
 * modes take strict priority over the local `tokens.json` OAuth flow;
 * `authenticate()` switches on this value.
 */
export function getActiveAuthMode(): ActiveAuthMode {
  if (isServiceAccountMode()) return 'service_account';
  if (isExternalTokenMode()) return 'external_token';
  return 'oauth';
}

/**
 * The user-facing warning for the issue #137 trap: an override env var forces
 * service-account/external-token mode while an authenticated `tokens.json`
 * exists on disk and is therefore silently ignored. Returns `null` when no such
 * token file exists (nothing is being bypassed). The caller supplies the token
 * path and its existence so both the startup warning and `authGetStatus` emit
 * identical wording; the set of currently-active override env vars is read from
 * `process.env` here (consistent with the mode predicates in this module).
 */
export function describeBypassedTokens(
  mode: Exclude<ActiveAuthMode, 'oauth'>,
  tokenPath: string,
  tokenExists: boolean,
): string | null {
  if (!tokenExists) return null;
  const envVar = AUTH_MODE_OVERRIDE_ENV_VARS[mode];
  // Every override var that is currently set — unsetting only the winning one
  // just hands control to the next override, so tokens.json stays bypassed.
  const setOverrideVars = Object.values(AUTH_MODE_OVERRIDE_ENV_VARS).filter(
    (v) => !!process.env[v],
  );
  const remedy =
    setOverrideVars.length > 1
      ? `Unset ${setOverrideVars.join(' and ')} to use your authenticated Google account`
      : `Unset ${envVar} to use your authenticated Google account`;
  return `The local OAuth token at ${tokenPath} exists but is IGNORED because ` +
    `${envVar} is set (active auth mode: ${mode}). ${remedy} (see issue #137).`;
}

/**
 * Build `GoogleAuth` options from the current environment.
 *
 * When `GOOGLE_DRIVE_MCP_SUBJECT` is set, the returned options include
 * `clientOptions.subject`, which instructs `GoogleAuth` to mint a JWT that
 * impersonates the given user via domain-wide delegation. The Workspace admin
 * must have authorized the service account's client ID for the requested
 * scopes under Security → API controls → Manage Domain-wide Delegation.
 *
 * Scopes are resolved via {@link resolveOAuthScopes}, so `GOOGLE_DRIVE_MCP_SCOPES`
 * narrows the SA's authority the same way it does for interactive OAuth.
 *
 * Exported so tests can assert the shape without hitting the filesystem.
 */
export function buildServiceAccountAuthOptions(): GoogleAuthOptions {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS!;
  const subject = process.env.GOOGLE_DRIVE_MCP_SUBJECT?.trim();

  const options: GoogleAuthOptions = {
    keyFile,
    scopes: resolveOAuthScopes(),
  };

  if (subject) {
    options.clientOptions = { subject };
  }

  return options;
}

/**
 * Check the service account key file is actually usable, at the auth boundary.
 *
 * `GoogleAuth.getClient()` accepts a key file it has not really validated and
 * defers parsing to the first JWT signing, which happens deep inside an API
 * call. A malformed key therefore surfaced as
 * `[internal_error] ... error:1E08010C:DECODER routines::unsupported` from
 * whichever tool the user happened to call: a CREDENTIAL problem wearing the
 * label of a server bug, which is exactly the distinction this contract exists
 * to preserve.
 *
 * Nothing read here is ever echoed. The parse error is passed through
 * `describeErrorForLog`, which collapses a SyntaxError to a constant precisely
 * because Node's own message quotes the unparseable source, and for this file
 * that source is the private key.
 */
function assertUsableServiceAccountKey(keyFile: string): void {
  let raw: string;
  try {
    raw = readFileSync(keyFile, 'utf-8');
  } catch (err) {
    throw new ToolFailure(
      'no_credentials',
      `Could not read the service account key file at ${keyFile}: ${describeErrorForLog(err)}`,
    );
  }

  let key: { type?: unknown; client_email?: unknown; private_key?: unknown };
  try {
    key = JSON.parse(raw);
  } catch (err) {
    throw new ToolFailure(
      'invalid_configuration',
      `The service account key file at ${keyFile} is not valid JSON: ${describeErrorForLog(err)}`,
    );
  }

  const missing = (['client_email', 'private_key'] as const).filter((f) => typeof key[f] !== 'string');
  if (key.type !== 'service_account' || missing.length > 0) {
    throw new ToolFailure(
      'invalid_configuration',
      `The file at ${keyFile} is not a Google service account key` +
        (missing.length > 0 ? ` (missing: ${missing.join(', ')})` : '') + '.',
    );
  }

  try {
    createPrivateKey(key.private_key as string);
  } catch (err) {
    // The OpenSSL failure names a decoder, never the key bytes; even so it goes
    // through describeErrorForLog and then the envelope's own redaction.
    throw new ToolFailure(
      'invalid_configuration',
      `The private key in the service account key file at ${keyFile} could not be parsed: ` +
        `${describeErrorForLog(err)}`,
    );
  }
}

/**
 * Create an authorized client from a service account JSON key file.
 * `GoogleAuth` handles JWT signing and token refresh automatically.
 */
export async function createServiceAccountAuth(): Promise<any> {
  const options = buildServiceAccountAuthOptions();
  const subject = process.env.GOOGLE_DRIVE_MCP_SUBJECT?.trim();
  console.error(
    `Using service account credentials from ${options.keyFile}` +
      (subject ? ` (impersonating ${subject} via domain-wide delegation)` : ''),
  );

  assertUsableServiceAccountKey(options.keyFile as string);

  try {
    const auth = new GoogleAuth(options);
    const client = await auth.getClient();
    console.error('Service account authentication successful');
    return client;
  } catch (err) {
    // A missing or unreadable key file used to escape as a bare fs ENOENT, which
    // reached the client as a JSON-RPC protocol error rather than a tool result:
    // no code, no sentence, and nothing the model ever saw.
    if (err instanceof ToolFailure) throw err;
    throw new ToolFailure(
      'no_credentials',
      `Could not load the service account key file at ${options.keyFile}: ${describeErrorForLog(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// External OAuth Token mode
// ---------------------------------------------------------------------------

/** True when `GOOGLE_DRIVE_MCP_ACCESS_TOKEN` is set. */
export function isExternalTokenMode(): boolean {
  return !!process.env.GOOGLE_DRIVE_MCP_ACCESS_TOKEN;
}

/**
 * Validate that the env-var combination makes sense.
 * Throws with an actionable message on mis-configuration.
 */
export function validateExternalTokenConfig(): void {
  const accessToken = process.env.GOOGLE_DRIVE_MCP_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new ToolFailure(
      'invalid_configuration',
      'GOOGLE_DRIVE_MCP_ACCESS_TOKEN is set but empty.',
    );
  }

  const refreshToken = process.env.GOOGLE_DRIVE_MCP_REFRESH_TOKEN?.trim();
  const clientId = process.env.GOOGLE_DRIVE_MCP_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_DRIVE_MCP_CLIENT_SECRET?.trim();

  if (refreshToken) {
    if (!clientId || !clientSecret) {
      throw new ToolFailure(
        'invalid_configuration',
        'GOOGLE_DRIVE_MCP_REFRESH_TOKEN is set but GOOGLE_DRIVE_MCP_CLIENT_ID and/or ' +
          'GOOGLE_DRIVE_MCP_CLIENT_SECRET are missing; all three are required for automatic token refresh.',
      );
    }
  }

  // Warn about partial client credential sets (one without the other)
  if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
    throw new ToolFailure(
      'invalid_configuration',
      'Both GOOGLE_DRIVE_MCP_CLIENT_ID and GOOGLE_DRIVE_MCP_CLIENT_SECRET must be provided together.',
    );
  }
}

/**
 * Create an OAuth2Client pre-loaded with externally-obtained credentials.
 * When a refresh token + client credentials are provided, the client will
 * auto-refresh transparently.
 */
export function createExternalOAuth2Client(): OAuth2Client {
  const accessToken = process.env.GOOGLE_DRIVE_MCP_ACCESS_TOKEN!.trim();
  const refreshToken = process.env.GOOGLE_DRIVE_MCP_REFRESH_TOKEN?.trim();
  const clientId = process.env.GOOGLE_DRIVE_MCP_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_DRIVE_MCP_CLIENT_SECRET?.trim();

  const oauth2Client = new OAuth2Client(clientId, clientSecret);

  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken || undefined,
  });

  if (!refreshToken) {
    console.error(
      'Warning: No refresh token provided. The access token will not auto-refresh when it expires.'
    );
  } else {
    console.error('External OAuth tokens configured with auto-refresh support.');
  }

  return oauth2Client;
}
