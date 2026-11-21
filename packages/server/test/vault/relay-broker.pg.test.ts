/**
 * Independent review F04: one REAL relay-to-broker run of the owner's human-only commands.
 *
 * The broker is the production entry point, `node packages/vault/dist/broker/main.js`, as its own process on this
 * suite's scratch database. The relay is the tm8 node's own, booted by `bootstrap()`. Between them there is only the
 * broker's owner-only Unix socket. Over HTTP to the node, the suite drives the whole path a browser takes:
 *   - the enrollment code, minted by the broker's operator CLI;
 *   - passkey registration, then passkey sign-in (the vault session cookie comes back through the relay);
 *   - a capture link an agent issues, which the owner opens and submits, sealed, under a bound step-up;
 *   - an origin an agent asks for, which the owner approves, under a bound step-up.
 *
 * Before the fix, the relay sent no Origin and the broker needed one for every human-only command, so the FIRST step
 * of this path failed with 403 forbidden. Now the relay signs the Origin that checkTransport accepted into the
 * attestation, and only for a browser session. The broker still compares it exactly with its WebAuthn origins.
 * The negative half proves no check was relaxed to get there. Each of these is still refused, at the broker or
 * before it: a CLI session, an agent session, a browser call with no Origin, and a foreign Origin.
 *
 * Missing pieces are failures, never skips. The broker's dist must be built (`tsc -b packages/vault`). The scratch
 * cluster comes from the same resolution every server .pg suite uses (test/db/pg-port-guard.ts).
 * Every secret value here is synthetic and generated for each run.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE, VAULT_SPACE_HEADER } from '@tm8/contract';
import { VAULT_COOKIE_NAMES, sealCapture } from '@tm8/vault';
import { exportAttestationKeyPair, generateAttestationKeyPair } from '@tm8/vault/relay';

import { SoftwareAuthenticator } from '../../../vault/test/owner-auth/authenticator.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { loadConfig } from '../../src/http/config.js';
import { TM8_SESSION_COOKIE } from '../../src/http/session-cookie.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { REPO_ROOT, createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

const BROKER_MAIN = join(REPO_ROOT, 'packages', 'vault', 'dist', 'broker', 'main.js');
/** The tm8 UI's origin, which a browser sends. The node allows exactly this origin, and the broker's WebAuthn allows exactly this one too. */
const BROWSER_ORIGIN = 'http://localhost:5173';
const RP_ID = 'localhost';
const CEREMONY = { origin: BROWSER_ORIGIN, rpId: RP_ID };

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
  readonly json: any;
}

interface Fixture {
  spaceA: string; spaceB: string; identityH: string; accountH: string; memberHA: string; memberHB: string;
  persona: string; workSession: string;
}

async function waitFor<T>(probe: () => Promise<T | undefined>, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('vault owner flow through the real relay and the real broker process (F04)', () => {
  let database: W1ScratchDatabase;
  let db: Db;
  let node: BootstrappedServer;
  let brokerProcess: ChildProcess | undefined;
  let brokerExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const brokerOutput: string[] = [];
  let dir: string;
  let dataDir: string;
  let f: Fixture;
  let enrollmentCode: string;
  let ownerToken: string;
  let cliToken: string;
  let agentToken: string;
  /** The owner's browser cookie jar for the vault cookies only. The tm8 session cookie is sent explicitly. */
  const jar = new Map<string, { value: string; path: string }>();

  const claims = (identityId: string): DbClaims => ({
    identityId, authKind: 'browser', nodeAdmin: false, requestId: `vault-relay-broker-${randomUUID()}`,
  });

  async function mintSession(kind: 'browser' | 'cli'): Promise<string> {
    const secret = generateSecret();
    const row = await db.tx(claims(f.identityH), (q) => q.rpc<{ id: string }>('issue_auth_session', [
      f.accountH, hashToken(secret), kind, new Date(Date.now() + 3_600_000).toISOString(), null, `vault-relay-broker ${kind}`,
    ]));
    return formatToken(row.id, secret);
  }

  async function mintAgent(): Promise<string> {
    const secret = generateSecret();
    const row = await db.tx(claims(f.identityH), (q) => q.rpc<{ id: string }>('issue_agent_auth_session', [
      f.workSession, f.persona, hashToken(secret), new Date(Date.now() + 3_600_000).toISOString(), 'vault-relay-broker agent',
    ]));
    return formatToken(row.id, secret);
  }

  /** The broker's environment: only what it needs. No tm8 credential, and no test-runner variable, is passed to it. */
  function brokerEnv(): Record<string, string> {
    const url = new URL(database.url);
    // The broker refuses a password in its URL (a URL is logged and listed). A password-protected cluster passes it the way libpq does.
    const password = url.password ? decodeURIComponent(url.password) : '';
    url.password = '';
    return {
      PATH: process.env['PATH'] ?? '',
      ...(password ? { PGPASSWORD: password } : {}),
      TM8_VAULT_MODE: 'pre_review',
      TM8_VAULT_DATABASE_URL: url.toString(),
      TM8_VAULT_BROKER_SOCKET: join(dir, 'broker.sock'),
      TM8_VAULT_RELAY_PUBLIC_KEY_FILE: join(dir, 'relay.pub'),
      TM8_VAULT_DELETION_LEDGER: join(dir, 'deletions.log'),
      TM8_VAULT_FILL_SOCKET: join(dir, 'fill.sock'),
      TM8_VAULT_LOCAL_KEK_FILE: join(dir, 'kek'),
      TM8_VAULT_AUDIT_SINK: 'file',
      TM8_VAULT_CHECKPOINT_DIR: join(dir, 'checkpoints'),
      TM8_VAULT_CHECKPOINT_KEY_FILE: join(dir, 'checkpoint.key'),
      TM8_VAULT_PUBLIC_ORIGIN: BROWSER_ORIGIN,
    };
  }

  /** Every request the broker logged, in order. Each record holds only the op, the status, the duration and the request id. */
  function brokerRequests(): Array<{ op: string; status: number }> {
    return brokerOutput.join('').split('\n').filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { event?: string; op: string; status: number })
      .filter((record) => record.event === 'vault_broker_request')
      .map(({ op, status }) => ({ op, status }));
  }

  function http(method: string, path: string, headers: OutgoingHttpHeaders, body?: string): Promise<Reply> {
    const base = new URL(node.url);
    return new Promise<Reply>((resolve, reject) => {
      const request = httpRequest({
        host: base.hostname, port: base.port, method, path, agent: false,
        headers: { ...headers, ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try { json = JSON.parse(text); } catch { /* A refusal from the node may be plain text. */ }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
        res.on('error', reject);
      });
      request.on('error', reject);
      request.end(body);
    });
  }

  function remember(setCookie: readonly string[] | undefined): void {
    for (const line of setCookie ?? []) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const attribute = (key: string) => attributes.find((part) => part.toLowerCase().startsWith(`${key}=`))?.slice(key.length + 1);
      if (value === '' || attribute('max-age') === '0') jar.delete(name);
      else jar.set(name, { value, path: attribute('path') ?? '/' });
    }
  }

  /** RFC 6265 path match, as a browser sends the vault cookies back. */
  function cookiesFor(path: string): string[] {
    const pathname = path.split('?')[0]!;
    return [...jar].filter(([, cookie]) => pathname === cookie.path
      || pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`))
      .map(([name, cookie]) => `${name}=${cookie.value}`);
  }

  /** The owner's browser tab: the tm8 session cookie, the vault cookies, the client header and, unless told otherwise, the tab's Origin. */
  async function browser(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, origin: string | null = BROWSER_ORIGIN): Promise<Reply> {
    const headers: OutgoingHttpHeaders = {
      cookie: [`${TM8_SESSION_COOKIE}=${ownerToken}`, ...cookiesFor(path)].join('; '),
      [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
      [VAULT_SPACE_HEADER]: f.spaceA,
      ...(origin !== null ? { origin } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    };
    const reply = await http(method, path, headers, body === undefined ? undefined : JSON.stringify(body));
    remember(reply.headers['set-cookie']);
    return reply;
  }

  /** A bearer caller (the CLI or an agent). It may write any Origin header it likes. */
  function bearer(token: string, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, extra: OutgoingHttpHeaders = {}): Promise<Reply> {
    return http(method, path, {
      authorization: `Bearer ${token}`, [VAULT_SPACE_HEADER]: f.spaceA,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra,
    }, body === undefined ? undefined : JSON.stringify(body));
  }

  const command = (): { clientMutationId: string } => ({ clientMutationId: randomUUID() });

  async function challenge(input: Record<string, unknown>, origin: string | null = BROWSER_ORIGIN): Promise<{ challengeId: string; publicKey: { challenge: string } }> {
    const reply = await browser('POST', '/v2/vault/webauthn/challenges', { ...command(), ...input }, origin);
    expect(reply.status, reply.text).toBe(200);
    return reply.json.data;
  }

  /** A step-up bound to exactly the call that follows: its action, path params and body (stepUp excluded). */
  async function stepUp(device: SoftwareAuthenticator, action: string, pathParams: Record<string, string>, body: Record<string, unknown>) {
    const ch = await challenge({ purpose: 'step_up', action, pathParams, body });
    return { challengeId: ch.challengeId, assertion: device.assert(ch.publicKey.challenge, CEREMONY) };
  }

  async function seed(): Promise<Fixture> {
    const fx: Fixture = {
      spaceA: randomUUID(), spaceB: randomUUID(), identityH: `vault-relay-broker-h-${randomUUID()}`, accountH: randomUUID(),
      memberHA: randomUUID(), memberHB: randomUUID(), persona: randomUUID(), workSession: randomUUID(),
    };
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'H')`, [fx.identityH]);
      // bootstrap() needs a node owner.
      await client.query(`insert into public.accounts(id, identity_id, username, is_owner) values ($1, $2, 'vault-relay-broker-h', true)`,
        [fx.accountH, fx.identityH]);
      await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Vault A', $3), ($2, 'Vault B', $3)`,
        [fx.spaceA, fx.spaceB, fx.identityH]);
      for (const [id, space] of [[fx.memberHA, fx.spaceA], [fx.memberHB, fx.spaceB]] as const) {
        await client.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'member', $1, 'space')`, [id, space]);
        await client.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', 'H')`,
          [id, space, fx.identityH]);
      }
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility)
         values ($1, $3, 'team_member', $4, 'space'), ($2, $3, 'work_session', $1, 'space')`,
        [fx.persona, fx.workSession, fx.spaceA, fx.memberHA]);
      await client.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1, $2, 'Vault agent', 'worker', 'persona')`,
        [fx.persona, fx.memberHA]);
      await client.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1, 'Vault run', 'running', 'none', now())`,
        [fx.workSession]);
      await client.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'participates_in', $2)`,
        [fx.spaceA, fx.persona, fx.workSession]);
    });
    return fx;
  }

  beforeAll(async () => {
    // A missing build is a failure of this suite, not a reason to skip it.
    expect(existsSync(BROKER_MAIN), `${BROKER_MAIN} is missing: build packages/vault first`).toBe(true);
    database = await createW1ScratchDatabase('vault_relay_broker');
    database.apply(migrationFiles());
    db = createDb(database.url, { max: 4 });
    f = await seed();

    dir = await mkdtemp(join(tmpdir(), 'tm8-vault-rb-'));
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-vault-rb-data-'));
    const pair = generateAttestationKeyPair();
    const exported = exportAttestationKeyPair(pair);
    await writeFile(join(dir, 'relay.key'), exported.privatePem, { mode: 0o600 });
    await writeFile(join(dir, 'relay.pub'), exported.publicPem, { mode: 0o600 });
    await writeFile(join(dir, 'checkpoint.key'), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await mkdir(join(dir, 'checkpoints'), { mode: 0o700 });

    // The operator's enrollment CLI, as the runbook runs it.
    const enrolled = await promisify(execFile)(process.execPath, [BROKER_MAIN, 'enroll', f.memberHA, f.spaceA, '600'], { env: brokerEnv() });
    enrollmentCode = enrolled.stdout.trim();
    expect(enrollmentCode).toMatch(/^\S{8,64}$/);

    brokerProcess = spawn(process.execPath, [BROKER_MAIN], { env: brokerEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    brokerProcess.stdout!.on('data', (chunk: Buffer) => brokerOutput.push(chunk.toString('utf8')));
    brokerProcess.stderr!.on('data', (chunk: Buffer) => brokerOutput.push(chunk.toString('utf8')));
    brokerProcess.once('exit', (code, signal) => { brokerExit = { code, signal }; });
    await waitFor(async () => {
      if (brokerExit) throw new Error(`the broker exited before it listened (${JSON.stringify(brokerExit)}): ${brokerOutput.join('')}`);
      return brokerOutput.join('').includes('"vault_broker_listening"') ? true : undefined;
    }, 60_000);
    expect((await lstat(join(dir, 'broker.sock'))).mode & 0o777).toBe(0o600);

    const vaultEnv: Record<string, string> = {
      TM8_VAULT_MODE: 'pre_review',
      TM8_VAULT_BROKER_SOCKET: join(dir, 'broker.sock'),
      TM8_VAULT_RELAY_PRIVATE_KEY_FILE: join(dir, 'relay.key'),
      TM8_VAULT_RELAY_TIMEOUT_MS: '30000',
    };
    const prior = Object.fromEntries(Object.keys(vaultEnv).map((name) => [name, process.env[name]]));
    Object.assign(process.env, vaultEnv);
    try {
      const configured = loadConfig({
        ...process.env,
        TM8_BIND: '127.0.0.1',
        TM8_PORT: '4611',
        TM8_NODE_MODE: 'single',
        TM8_DATABASE_URL: database.url,
        TM8_DATA_DIR: dataDir,
        TM8_DISABLE_AUTO_OWNER: '1',
        // Exact Origin matching, the stricter of the node's two modes.
        TM8_ALLOWED_ORIGINS: BROWSER_ORIGIN,
      });
      node = await bootstrap({ config: { ...configured, port: 0 } });
    } finally {
      for (const [name, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    ownerToken = await mintSession('browser');
    cliToken = await mintSession('cli');
    agentToken = await mintAgent();
  }, 240_000);

  afterAll(async () => {
    await node?.server.close();
    await node?.db?.end();
    if (brokerProcess && !brokerExit) {
      const exited = new Promise<void>((resolve) => brokerProcess!.once('exit', () => resolve()));
      brokerProcess.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      if (!brokerExit) brokerProcess.kill('SIGKILL');
    }
    await db?.end();
    await database?.destroy();
    if (dir) await rm(dir, { recursive: true, force: true });
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }, 240_000);

  it('refuses a human-only command unless the relay attests the browser origin, and the node still refuses a foreign one first', async () => {
    // vault.session.end is human-only and needs no passkey or vault session, so only the origin decides it here.
    const path = '/v2/vault/session/end';
    const before = brokerRequests().length;
    // The control: the owner's browser tab, with its Origin.
    const control = await browser('POST', path, command());
    expect(control.status, control.text).toBe(200);
    // The same tab with no Origin: the relay has nothing to attest, so the broker refuses.
    const bare = await browser('POST', path, command(), null);
    // The CLI and an agent can write any Origin header, so the relay never attests one, and the broker refuses.
    const cli = await bearer(cliToken, 'POST', path, command(), { origin: BROWSER_ORIGIN });
    const agent = await bearer(agentToken, 'POST', path, command(), { origin: BROWSER_ORIGIN });
    for (const refused of [bare, cli, agent]) {
      expect(refused.status, refused.text).toBe(403);
      // The dispatcher's refusal carries no reason. A handler's 403, e.g. passkey_required, always does.
      expect(refused.json?.error).toMatchObject({ code: 'forbidden' });
      expect(refused.json.error.details).toBeUndefined();
    }
    expect(brokerRequests().slice(before)).toEqual([
      { op: 'vault.session.end', status: 200 },
      { op: 'vault.session.end', status: 403 },
      { op: 'vault.session.end', status: 403 },
      { op: 'vault.session.end', status: 403 },
    ]);

    // The node's own Origin check runs first and is not relaxed. A foreign, an opaque or a different-port origin never reaches the broker.
    for (const origin of ['https://attacker.example.test', 'null', 'http://localhost:5174']) {
      const refused = await browser('POST', path, command(), origin);
      expect(refused.status, origin).toBe(403);
    }
    // The CSRF header is not relaxed either: a cookie-carrying command without it never reaches the broker.
    const csrf = await http('POST', path, {
      cookie: `${TM8_SESSION_COOKIE}=${ownerToken}`, origin: BROWSER_ORIGIN, [VAULT_SPACE_HEADER]: f.spaceA, 'content-type': 'application/json',
    }, JSON.stringify(command()));
    expect(csrf.status).toBe(403);
    expect(brokerRequests().length).toBe(before + 4);
  });

  it('runs owner registration, sign-in, capture and approval end to end through the relay and the broker', async () => {
    const device = new SoftwareAuthenticator();

    // 1. The first passkey, with the operator's enrollment code.
    const begun = await browser('POST', '/v2/vault/passkeys/registrations', { ...command(), name: 'Relay test device', enrollmentCode });
    expect(begun.status, begun.text).toBe(200);
    const registration = begun.json.data as { registrationId: string; publicKey: { challenge: string; rp: { id: string } } };
    expect(registration.publicKey.rp.id).toBe(RP_ID);
    const finished = await browser('POST', `/v2/vault/passkeys/registrations/${registration.registrationId}/finish`,
      { ...command(), credential: device.register(registration.publicKey.challenge, CEREMONY) });
    expect(finished.status, finished.text).toBe(200);

    // 2. Sign-in. The vault session cookies come back through the relay.
    const signIn = await challenge({ purpose: 'sign_in' });
    const session = await browser('POST', '/v2/vault/session', { ...command(), challengeId: signIn.challengeId,
      assertion: device.assert(signIn.publicKey.challenge, CEREMONY), deviceLabel: 'Relay test device' });
    expect(session.status, session.text).toBe(200);
    expect([...jar.keys()].sort()).toEqual([VAULT_COOKIE_NAMES.refresh, VAULT_COOKIE_NAMES.session].sort());
    const sessions = await browser('GET', '/v2/vault/sessions');
    expect(sessions.status, sessions.text).toBe(200);
    expect(sessions.json.data.sessions).toHaveLength(1);

    // 3. An agent issues a capture link. The owner opens it and submits a sealed login under a bound step-up.
    const link = await bearer(agentToken, 'POST', '/v2/vault/capture-links', { ...command(), itemType: 'login', purpose: 'create', name: 'Relay test login' });
    expect(link.status, link.text).toBe(200);
    const captureId = link.json.data.captureId as string;
    const linkToken = new URLSearchParams(new URL(link.json.data.url as string).hash.slice(1)).get('t')!;
    const opened = await browser('POST', `/v2/vault/captures/${captureId}/open`, { ...command(), linkToken });
    expect(opened.status, opened.text).toBe(200);
    const password = `synthetic-${randomBytes(18).toString('base64url')}`;
    const plaintext = Buffer.from(JSON.stringify({ type: 'login', name: 'Relay test login', origin: 'https://app.example.com',
      username: 'synthetic-user', password }));
    const sealed = sealCapture(plaintext, opened.json.data.publicKey, captureId);
    plaintext.fill(0);
    const submit = { ...command(), linkToken, sealed };
    const submitted = await browser('POST', `/v2/vault/captures/${captureId}/submit`,
      { ...submit, stepUp: await stepUp(device, 'vault.captures.submit', { captureId }, submit) });
    expect(submitted.status, submitted.text).toBe(200);
    const itemId = submitted.json.data.id as string;
    expect(submitted.json.data).toMatchObject({ type: 'login', name: 'Relay test login', origins: ['https://app.example.com'] });

    // 4. The agent asks for a second origin. The owner approves it as standing, under a bound step-up.
    const requested = await bearer(agentToken, 'POST', `/v2/vault/items/${itemId}/origin-requests`,
      { ...command(), origin: 'https://login.example.com', mode: 'standing', purpose: 'Relay test sign-in page' });
    expect(requested.status, requested.text).toBe(200);
    const approval = requested.json.data as { id: string; intentHash: string; state: string };
    expect(approval.state).toBe('pending');
    const decide = { ...command(), decision: 'approve', approvalIntentHash: approval.intentHash, standing: true };
    const decided = await browser('POST', `/v2/vault/approvals/${approval.id}/decide`,
      { ...decide, stepUp: await stepUp(device, 'vault.approvals.decide', { approvalId: approval.id }, decide) });
    expect(decided.status, decided.text).toBe(200);
    expect(decided.json.data.state).toBe('approved');
    const item = await bearer(agentToken, 'GET', `/v2/vault/items/${itemId}`);
    expect(item.status, item.text).toBe(200);
    expect([...item.json.data.origins].sort()).toEqual(['https://app.example.com', 'https://login.example.com']);

    // The broker wrote one audit chain for all of it, and it verifies.
    const verification = await browser('GET', '/v2/vault/audit/verification');
    expect(verification.status, verification.text).toBe(200);
    expect(verification.json.data).toMatchObject({ status: 'verified', firstBrokenSeq: null });

    // Each human-only step reached the broker and was served, and the broker logged no value.
    const served = brokerRequests().filter((record) => record.status === 200).map((record) => record.op);
    for (const op of ['vault.passkeys.registerBegin', 'vault.passkeys.registerFinish', 'vault.webauthn.challenge', 'vault.session.begin',
      'vault.captures.open', 'vault.captures.submit', 'vault.approvals.decide', 'vault.audit.verify']) expect(served).toContain(op);
    const output = brokerOutput.join('');
    for (const value of [password, enrollmentCode, linkToken, ownerToken, agentToken]) expect(output.includes(value)).toBe(false);
  });
});
