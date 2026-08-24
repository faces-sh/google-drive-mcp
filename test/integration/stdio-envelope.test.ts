// The envelope has to survive the REAL transport, and only a real transport can
// show that it does.
//
// Every other test in this repo enters below the auth boundary: the harness
// injects a fake client, so `ensureAuthSystem()` never runs and nothing it can
// throw is ever exercised. That is precisely where the envelope was escaping.
// With `await ensureAuthSystem()` one line ABOVE the handler's try, a credential
// path that did not exist made all 116 tools answer
//
//   {"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"ENOENT: ..."}}
//
// which is a JSON-RPC PROTOCOL error, not a tool result. It carries no `isError`
// flag, the model never sees its text, and Maestro's `declaresFailure` (which
// looks for a leading `[snake_case_code]`) can never match it. The mocked suite
// was 100% green throughout.
//
// So this test spawns the BUILT server as a separate process, speaks raw
// JSON-RPC over its stdio, and asserts on the bytes that come back.

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A leading `[snake_case_code]` followed by a sentence. Identical to the regex
 *  Maestro's `declaresFailure` uses: if the two ever disagree, this server can
 *  satisfy its own tests and still be read as a success by the app. */
const CODE = /^\[[a-z][a-z0-9_]*\]\s+\S/;
const STATUS_LINE = /^HTTP \d{3}(?: [A-Za-z][A-Za-z ]*)?$/;

class StdioServer {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 0;

  constructor(serverPath: string, env: Record<string, string>, unset: string[] = []) {
    const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
    // The auth mode is chosen by env-var PRESENCE, so a var inherited from the
    // outer shell would silently pick a different mode than the one under test.
    for (const key of unset) delete childEnv[key];
    // `if (!process.env.MCP_TESTING) main()` guards the CLI so the module can be
    // IMPORTED by a test. We are SPAWNING it, so the guard must not be inherited
    // or the child boots into a process that never starts a transport and every
    // request hangs until the timeout.
    delete childEnv.MCP_TESTING;
    this.proc = spawn(process.execPath, [serverPath], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf-8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.startsWith('{')) continue; // a server logging to stdout
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        const resolve = this.pending.get(msg.id);
        if (resolve) { this.pending.delete(msg.id); resolve(msg); }
      }
    });
    this.proc.stderr.resume(); // drain the server's logging
  }

  rpc(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params: unknown) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async start() {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'stdio-envelope-test', version: '1' },
    });
    this.notify('notifications/initialized', {});
  }

  stop() { this.proc.kill('SIGTERM'); }
}

describe('the envelope over the real stdio transport, with no credentials', () => {
  let server: StdioServer;
  let credDir: string;
  let toolNames: string[] = [];

  before(async () => {
    // Built by `npm run test:build`, which runs scripts/build.js.
    const serverPath = join(process.cwd(), 'dist', 'index.js');
    assert.ok(existsSync(serverPath), `built server missing at ${serverPath}; run npm run build`);

    // Point the credential path at a file that does not exist. Every call then
    // dies at the auth boundary, which is both the condition under test and the
    // only posture in which it is safe to call all 116 tools: not one of them
    // can reach a real account, file or calendar.
    credDir = mkdtempSync(join(tmpdir(), 'gdrive-envelope-'));
    server = new StdioServer(serverPath, {
      GOOGLE_APPLICATION_CREDENTIALS: join(credDir, 'does-not-exist.json'),
    });
    await server.start();

    const listed = await server.rpc('tools/list', {});
    toolNames = (listed.result?.tools ?? []).map((t: { name: string }) => t.name);
  });

  after(() => {
    server?.stop();
    if (credDir) rmSync(credDir, { recursive: true, force: true });
  });

  it('advertises its tools', () => {
    assert.ok(toolNames.length > 100, `expected the full tool set, saw ${toolNames.length}`);
  });

  it('answers a tool result with isError, never a JSON-RPC protocol error', async () => {
    const msg = await server.rpc('tools/call', { name: 'listCalendars', arguments: {} });

    // THE regression. Before the fix this was
    // {"error":{"code":-32603,"message":"ENOENT: no such file or directory ..."}}
    assert.equal(
      msg.error,
      undefined,
      `a JSON-RPC error is not a tool result: ${JSON.stringify(msg.error)}`,
    );
    assert.equal(msg.result?.isError, true);

    const text: string = msg.result.content[0].text;
    assert.match(text, CODE);
    assert.ok(text.startsWith('[no_credentials] '), `unexpected code: ${text.slice(0, 60)}`);
    // It names the file it looked for.
    assert.match(text, /does-not-exist\.json/);
    // Rule 4: this never reached Google, so there is no status line to invent.
    assert.doesNotMatch(text, /\nHTTP \d/);
    // Rule 7: no remedy.
    assert.doesNotMatch(text, /reconnect|try again|please run/i);
  });

  it('every advertised tool returns the envelope, not a protocol error', async () => {
    const offenders: string[] = [];

    for (const name of toolNames) {
      const msg = await server.rpc('tools/call', { name, arguments: {} });

      if (msg.error) { offenders.push(`${name}: JSON-RPC error ${JSON.stringify(msg.error)}`); continue; }
      const result = msg.result;
      // A tool that SUCCEEDS on empty arguments has not broken the contract; it
      // simply had nothing to fail at. Only failures are held to the shape.
      if (!result?.isError) continue;

      const text: string = (result.content ?? []).map((c: any) => c.text ?? '').join('\n').trim();
      if (!CODE.test(text)) { offenders.push(`${name}: no [code] and sentence: ${text.slice(0, 80)}`); continue; }
      const afterCode = text.split('\n')[0].split(']', 2)[1].trim();
      if (afterCode.split(/\s+/).length < 3) offenders.push(`${name}: line 1 is not a sentence: ${text.slice(0, 80)}`);
      for (const line of text.split('\n')) {
        if (line.startsWith('HTTP ') && !STATUS_LINE.test(line)) offenders.push(`${name}: malformed status line: ${line}`);
      }
      // Rule 8, over the real wire.
      for (const rx of [/\bya29\.[A-Za-z0-9_-]{10,}/, /\b1\/\/[A-Za-z0-9_-]{20,}/, /\bGOCSPX-[A-Za-z0-9_-]{10,}/]) {
        if (rx.test(text)) offenders.push(`${name}: leaks a credential`);
      }
    }

    assert.deepEqual(offenders, [], `${offenders.length} of ${toolNames.length} tools broke the contract`);
  });
});

// ---------------------------------------------------------------------------
// Configured, but nobody has signed in.
//
// This state used to HANG. `buildAuthSystem()` with an empty store starts an
// OAuth server, opens a browser and then polls once a second, forever, waiting
// for a consent nobody can see when the server is a bundled stdio child. The
// tool call never returned at all. There is no timeout under an MCP client's
// dispatch loop, so it took the whole turn with it and said nothing.
//
// A hang cannot be caught by asserting on a reply, because there is no reply to
// assert on. So the TIMEOUT is the assertion here: the rpc helper rejects, and
// the rejection is what fails the test.
// ---------------------------------------------------------------------------

/** Generous enough to never flake, far below the forever this used to take. */
const MUST_ANSWER_WITHIN_MS = 10_000;

describe('the envelope with valid client keys and zero authorized accounts', () => {
  let server: StdioServer;
  let dir: string;

  before(async () => {
    const serverPath = join(process.cwd(), 'dist', 'index.js');
    assert.ok(existsSync(serverPath), `built server missing at ${serverPath}`);

    dir = mkdtempSync(join(tmpdir(), 'gdrive-zero-accounts-'));
    // A well-formed OAuth client: the server CAN talk to Google. The secret is
    // obviously fake and never leaves this directory.
    writeFileSync(join(dir, 'keys.json'), JSON.stringify({
      installed: {
        client_id: '1234.apps.googleusercontent.com',
        client_secret: 'not-a-real-secret',
        redirect_uris: ['http://127.0.0.1:3000/oauth2callback'],
      },
    }));
    // A valid, EMPTY v2 token store: no account has been authorized.
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify({ version: 2, accounts: {} }));

    server = new StdioServer(serverPath, {
      GOOGLE_DRIVE_OAUTH_CREDENTIALS: join(dir, 'keys.json'),
      GOOGLE_DRIVE_MCP_TOKEN_PATH: join(dir, 'tokens.json'),
    }, ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_DRIVE_MCP_ACCESS_TOKEN']);
    await server.start();
  });

  after(() => {
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('answers within the budget instead of opening a browser and polling forever', async () => {
    const started = Date.now();
    const msg = await server.rpc('tools/call', { name: 'search', arguments: { query: 'x' } },
      MUST_ANSWER_WITHIN_MS).catch((err: Error) => {
      assert.fail(
        `the call never came back (${err.message}). This is the hang: with an empty ` +
        `store the server used to open a browser and poll for consent forever, and an ` +
        `MCP dispatch loop has no timeout under it.`,
      );
    });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < MUST_ANSWER_WITHIN_MS, `took ${elapsed}ms`);
    assert.equal(msg.error, undefined, `a JSON-RPC error is not a tool result: ${JSON.stringify(msg.error)}`);
    assert.equal(msg.result?.isError, true);

    const text: string = msg.result.content[0].text;
    // `no_accounts`, not `no_credentials`: the server has an OAuth client, it has
    // no account to act as. Those want opposite responses from the caller.
    assert.ok(text.startsWith('[no_accounts] '), `unexpected code: ${text.slice(0, 60)}`);
    // Rule 7 asks it to name what is missing, not what to do about it.
    assert.match(text, /tokens\.json/);
    assert.doesNotMatch(text, /\nHTTP \d/);
    assert.doesNotMatch(text, /\brun\b|reconnect|try again/i);
  });

  it('still answers the account tools, which are how you diagnose this state', async () => {
    const listed = await server.rpc('tools/call',
      { name: 'manage_accounts', arguments: { action: 'list' } }, MUST_ANSWER_WITHIN_MS);
    assert.equal(listed.error, undefined);
    assert.notEqual(listed.result?.isError, true, 'manage_accounts must work with zero accounts');

    const status = await server.rpc('tools/call',
      { name: 'authGetStatus', arguments: {} }, MUST_ANSWER_WITHIN_MS);
    assert.equal(status.error, undefined);
    assert.notEqual(status.result?.isError, true, 'authGetStatus must work with zero accounts');
  });
});
