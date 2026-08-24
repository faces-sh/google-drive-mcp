// ---------------------------------------------------------------------------
// AccountResolver — decides which account(s) a tool call targets.
//
// Resolution order:
//   1. Explicit `account` param (string → single; array → fanout for reads).
//   2. Session default (per MCP session).
//   3. Global default (persisted in tokens.json).
//   4. Eligibility filter by acceptable scopes (any-of semantics — an account
//      matches if it has at least one of the acceptable scopes granted):
//        - 0 eligible → error pointing at `manage_accounts add`
//        - 1 eligible → single (sole-authenticated)
//        - N eligible + read → fanout (merged-eligible)
//        - N eligible + write → error listing aliases, require explicit choice
// ---------------------------------------------------------------------------

import { AccountStore } from './accountStore.js';
import { SessionStore } from './sessionStore.js';
import { AccountRecord, AccountTargeting, ToolOpKind } from './types.js';
import { splitScopes } from './scopes.js';
import { ToolFailure } from '../errors.js';

export interface ResolveContext {
  sessionId: string;
  /**
   * Scopes the tool can operate with. Any-of semantics: an account is eligible
   * when it has granted ANY of these scopes. Pass `[]` to skip scope filtering
   * (e.g. admin tools that don't hit Google APIs).
   */
  acceptableScopes: string[];
}

export class AccountResolver {
  constructor(
    private store: AccountStore,
    private sessions: SessionStore,
  ) {}

  async resolve(
    input: string | string[] | undefined,
    kind: ToolOpKind,
    ctx: ResolveContext,
  ): Promise<AccountTargeting> {
    const hasScopes = (rec: AccountRecord) => coversScopes(rec.scope, ctx.acceptableScopes);

    // 1. Explicit account param
    if (input !== undefined && input !== null) {
      if (Array.isArray(input)) {
        if (kind !== 'read') {
          throw new ToolFailure(
            'bad_request',
            `The 'account' parameter may only be an array on read tools; this is a ${kind} tool.`,
          );
        }
        const resolved: AccountRecord[] = [];
        for (const alias of input) {
          const rec = this.store.get(alias);
          if (!rec) throw new ToolFailure('not_found', `Unknown account: "${alias}".`);
          if (!hasScopes(rec)) {
            throw new ToolFailure('insufficient_scope', scopeShortageMessage(alias, ctx.acceptableScopes));
          }
          resolved.push(rec);
        }
        if (resolved.length === 0) {
          throw new ToolFailure('bad_request', "The 'account' array is empty.");
        }
        return { kind: 'fanout', accounts: resolved, resolutionReason: 'explicit-param' };
      }

      const rec = this.store.get(input);
      if (!rec) throw new ToolFailure('not_found', `Unknown account: "${input}".`);
      if (!hasScopes(rec)) {
        throw new ToolFailure('insufficient_scope', scopeShortageMessage(input, ctx.acceptableScopes));
      }
      return { kind: 'single', accounts: [rec], resolutionReason: 'explicit-param' };
    }

    // 2. Session default
    // Remember a configured default that exists but lacks the needed scopes, so
    // step 4 can surface it (with re-consent guidance) instead of silently
    // routing this call to a different account than the user chose. Use `??=` so
    // the higher-precedence session alias wins the message if both are short.
    let skippedDefaultAlias: string | undefined;
    const sessionDefaultAlias = this.sessions.get(ctx.sessionId)?.defaultAccountAlias;
    if (sessionDefaultAlias) {
      const rec = this.store.get(sessionDefaultAlias);
      if (rec && hasScopes(rec)) {
        return { kind: 'single', accounts: [rec], resolutionReason: 'session-default' };
      }
      if (rec) skippedDefaultAlias ??= sessionDefaultAlias;
    }

    // 3. Global default
    const globalDefaultAlias = this.store.getDefault();
    if (globalDefaultAlias) {
      const rec = this.store.get(globalDefaultAlias);
      if (rec && hasScopes(rec)) {
        return { kind: 'single', accounts: [rec], resolutionReason: 'global-default' };
      }
      if (rec) skippedDefaultAlias ??= globalDefaultAlias;
    }

    // 4. Eligibility filter
    const all = this.store.list();
    if (all.length === 0) {
      throw new ToolFailure('no_credentials', 'No Google account is authenticated on this server.');
    }
    const eligible = all.filter(hasScopes);
    if (eligible.length === 0) {
      // Distinguish the sole-account shortage from the generic no-eligible case
      // — if there's exactly one account and it lacks scopes, point at it directly.
      if (all.length === 1) {
        throw new ToolFailure('insufficient_scope', scopeShortageMessage(all[0].alias, ctx.acceptableScopes));
      }
      throw new ToolFailure(
        'insufficient_scope',
        `No authenticated account has any of the required scopes: ${ctx.acceptableScopes.join(', ')}.`,
      );
    }
    // A configured default exists but is scope-short: don't silently substitute
    // a different account — tell the user their default lacks the scope (and how
    // to re-consent it in place).
    if (skippedDefaultAlias) {
      throw new ToolFailure('insufficient_scope', scopeShortageMessage(skippedDefaultAlias, ctx.acceptableScopes));
    }
    if (eligible.length === 1) {
      return { kind: 'single', accounts: eligible, resolutionReason: 'sole-authenticated' };
    }
    if (kind === 'read') {
      return { kind: 'fanout', accounts: eligible, resolutionReason: 'merged-eligible' };
    }
    throw new ToolFailure(
      'bad_request',
      `Multiple accounts have the required scopes (${eligible.map((e) => e.alias).join(', ')}), so ` +
        `this ${kind} call has no single target.`,
    );
  }
}

/** Any-of scope check: true iff `granted` contains at least one `acceptable` scope. */
export function coversScopes(granted: string, acceptable: string[]): boolean {
  if (acceptable.length === 0) return true;
  const grantedSet = new Set(splitScopes(granted));
  return acceptable.some((s) => grantedSet.has(s));
}

function scopeShortageMessage(alias: string, acceptable: string[]): string {
  const scopeList = acceptable.length === 0
    ? '(no scopes required — this should not happen)'
    : acceptable.join(', ');
  return (
    `Account '${alias}' is connected but lacks the required scope for this ` +
    `operation: ${scopeList}.`
  );
}
