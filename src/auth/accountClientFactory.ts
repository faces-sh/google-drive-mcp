// ---------------------------------------------------------------------------
// AccountClientFactory — per-alias OAuth2Client cache with refresh dedupe.
//
// - Builds one `OAuth2Client` per alias (from the shared client_id/client_secret
//   in gcp-oauth.keys.json) and caches it.
// - Attaches a `'tokens'` listener that merges refresh results into the
//   underlying AccountStore, so rotating access tokens persist to disk.
// - Dedupes concurrent refreshes of the same alias so N in-flight tool calls
//   trigger at most one refresh request to Google.
// - In synthetic modes (service-account / external-token / test), returns
//   the pre-seeded client from the store unchanged.
// ---------------------------------------------------------------------------

import { Credentials, OAuth2Client } from 'google-auth-library';
import { AccountStore } from './accountStore.js';
import { loadCredentials } from './client.js';
import { AccountRecord } from './types.js';
import { describeErrorForLog } from './utils.js';
import { ToolFailure, httpDetailsOf, toolFailure } from '../errors.js';

/** Buffer before access-token expiry that triggers a refresh (ms). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Detect an OAuth `invalid_grant` (refresh token revoked or expired) across the
 * shapes google-auth-library / gaxios surface it in.
 */
function isInvalidGrant(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { response?: { data?: { error?: unknown } }; message?: unknown };
  if (e.response?.data?.error === 'invalid_grant') return true;
  return typeof e.message === 'string' && e.message.includes('invalid_grant');
}

export class AccountClientFactory {
  private clients = new Map<string, OAuth2Client>();
  private inflightRefresh = new Map<string, Promise<void>>();
  private baseCredentialsPromise: Promise<{ client_id: string; client_secret?: string }> | null = null;

  constructor(private store: AccountStore) {}

  /**
   * Return an OAuth2Client (or GoogleAuth-derived client) for the given alias,
   * validated/refreshed if necessary.
   */
  async getClient(alias: string): Promise<OAuth2Client> {
    const record = this.store.get(alias);
    if (!record) {
      throw new ToolFailure('no_credentials', `Unknown account: "${alias}".`);
    }

    const synthetic = this.store.getSyntheticClient(alias);
    if (synthetic) return synthetic as OAuth2Client;

    const client = await this.ensureClient(alias, record);
    await this.refreshIfNeeded(alias, client, record);
    return client;
  }

  /** Drop a cached client (e.g. after `remove`). */
  evict(alias: string): void {
    this.clients.delete(alias);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async ensureClient(alias: string, record: AccountRecord): Promise<OAuth2Client> {
    const existing = this.clients.get(alias);
    if (existing) return existing;

    const base = await this.loadBaseCredentials();
    const client = new OAuth2Client({
      clientId: base.client_id,
      clientSecret: base.client_secret || undefined,
    });
    client.setCredentials({
      access_token: record.accessToken || undefined,
      refresh_token: record.refreshToken || undefined,
      expiry_date: record.expiryDate || undefined,
      scope: record.scope || undefined,
      token_type: record.tokenType,
    });

    client.on('tokens', (newCreds) => {
      // Intentionally fire-and-forget: the library emits synchronously in the
      // middle of a request. We persist asynchronously via the write queue.
      this.persistRefreshedTokens(alias, newCreds).catch((err) => {
        // Never log the raw error: a gaxios error would print the request
        // config, including token material.
        console.error(
          `Failed to persist refreshed tokens for "${alias}": ${describeErrorForLog(err)}`,
        );
      });
    });

    this.clients.set(alias, client);
    return client;
  }

  private async loadBaseCredentials(): Promise<{ client_id: string; client_secret?: string }> {
    if (!this.baseCredentialsPromise) {
      this.baseCredentialsPromise = loadCredentials();
    }
    return this.baseCredentialsPromise;
  }

  private async refreshIfNeeded(
    alias: string,
    client: OAuth2Client,
    record: AccountRecord,
  ): Promise<void> {
    const expiry = client.credentials.expiry_date ?? record.expiryDate;
    const needsRefresh = expiry
      ? Date.now() >= expiry - REFRESH_BUFFER_MS
      : !client.credentials.access_token;

    if (!needsRefresh) return;
    if (!client.credentials.refresh_token) {
      // No refresh token — nothing we can do. Let the next API call surface a 401.
      return;
    }

    const inflight = this.inflightRefresh.get(alias);
    if (inflight) return inflight;

    const p = (async () => {
      try {
        const { credentials } = await client.refreshAccessToken();
        // The `'tokens'` listener handles persistence. `refreshAccessToken`
        // already calls `setCredentials` internally.
        if (!credentials.access_token) {
          throw new ToolFailure(
            'unexpected_response',
            `Google accepted the token refresh for "${alias}" but returned no access token.`,
          );
        }
      } catch (err) {
        if (err instanceof ToolFailure) throw err;
        if (isInvalidGrant(err)) {
          // Refresh token revoked or expired. Google's own body says WHICH
          // ("Token has been expired or revoked", "invalid_grant"), and that is
          // the one thing that separates a credential to reconnect from a
          // permission the account never had. Carry it through verbatim instead
          // of collapsing it to a sentence.
          throw toolFailure(
            `The stored authorization for account '${alias}' was revoked or has expired.`,
            err,
            'no_credentials',
          );
        }
        // Never log the raw error: gaxios embeds the refresh POST body (refresh
        // token + client secret) in err.config.
        console.error(`Token refresh failed for "${alias}": ${describeErrorForLog(err)}`);
        // A 4xx from Google's token endpoint is a decision about this account, not
        // a hiccup, and the next API call would report it as an opaque 401 with
        // none of the detail. Surface it here, with the status and the body.
        const http = httpDetailsOf(err);
        if (http && http.status >= 400 && http.status < 500) {
          throw toolFailure(`Could not refresh the access token for account '${alias}'.`, err);
        }
        // Transient (5xx, network): don't throw; let the caller's API call surface it.
      }
    })().finally(() => {
      this.inflightRefresh.delete(alias);
    });
    this.inflightRefresh.set(alias, p);
    return p;
  }

  private async persistRefreshedTokens(alias: string, newCreds: Credentials): Promise<void> {
    const current = this.store.get(alias);
    if (!current) return; // account was removed while a refresh was in flight
    const updated: AccountRecord = {
      ...current,
      accessToken: newCreds.access_token ?? current.accessToken,
      refreshToken: newCreds.refresh_token ?? current.refreshToken,
      expiryDate: newCreds.expiry_date ?? current.expiryDate,
      scope: newCreds.scope ?? current.scope,
      lastRefreshedAt: new Date().toISOString(),
    };
    await this.store.upsert(updated);
  }
}
