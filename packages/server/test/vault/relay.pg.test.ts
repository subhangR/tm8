/**
 * Secure Vault relay (task 01a1fa87-dd1a, WS-A) on a REAL node: the production
 * composition root (`bootstrap`) over a scratch database with every migration
 * applied, real bearers minted through issue_auth_session and
 * issue_agent_auth_session, and a stand-in broker on an owner-only Unix socket
 * that checks every request it receives with the broker's own
 * AttestationVerifier.
 *
 * What this pins that a unit test cannot:
 *   - http/server.ts sends /v2/vault to the relay after checkTransport and
 *     identity resolution, and before readJsonBody, so the bytes the
 *     attestation digests are the bytes the broker receives;
 *   - the member, space and admin bit the broker sees come from the database
 *     under the caller's own claims, and a space-pinned agent cannot name
 *     another space;
 *   - no tm8 credential, cookie or client header crosses to the broker, and
 *     only the broker's own two cookies come back;
 *   - alerts reach public.notifications through 451's internal.vault_notify
 *     as tm8_app, one row per burst, never for a non-member.
 *
 * Fixture: H owns spaces A and B and is the node owner; H2 is a member of A
 * only; H3 owns C only; G is H's agent, pinned to A by its work session.
 *
 * Needs the test cluster, like every W1 scratch suite: test/db/pg-port-guard.ts
 * resolves its URL (CI sets TM8_MIGRATION_DATABASE_URL). A missing cluster is
 * red, never a skip.
 * Every key and token is generated at runtime and never printed.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createServer, request as httpRequest,
  type ClientRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Server, type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE, VAULT_SPACE_HEADER } from '@tm8/contract';
import {
  AttestationError, AttestationVerifier, VAULT_ALERTS_HEADER, VAULT_ALERT_KINDS, VAULT_ATTESTATION_HEADER, encodeVaultAlerts,
  exportAttestationKeyPair, generateAttestationKeyPair,
} from '@tm8/vault/relay';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { loadConfig } from '../../src/http/config.js';
import { TM8_SESSION_COOKIE } from '../../src/http/session-cookie.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { CAPTURE_RESPONSE_HEADERS } from '../../src/vault/capture-page.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

type Caller = ReturnType<AttestationVerifier['verify']>;

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  readonly caller: Caller | null;
  readonly refusal: string | null;
  aborted: boolean;
}

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
}

interface Fixture {
  spaceA: string; spaceB: string; spaceC: string;
  identityH: string; identityH2: string; identityH3: string;
  accountH: string; accountH2: string; accountH3: string;
  memberHA: string; memberHB: string; memberH2A: string; memberH3C: string;
  persona: string; workSession: string;
}

/** The broker's error shape, as the relay writes its own refusals. */
function reasonOf(answer: Answer): string | undefined {
  return (JSON.parse(answer.text) as { error?: { details?: { reason?: string } } }).error?.details?.reason;
}

function json(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

async function waitFor<T>(probe: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('vault relay on a real node', () => {
  let database: W1ScratchDatabase;
  let db: Db;
  let node: BootstrappedServer;
  let broker: Server;
  let dir: string;
  let dataDir: string;
  let f: Fixture;
  let verifier: AttestationVerifier;
  const seen: Seen[] = [];
  const ok = (_entry: Seen, res: ServerResponse): void => json(res, 200, { data: { ok: true } });
  let reply: (entry: Seen, res: ServerResponse) => void = ok;

  const claims = (identityId: string): DbClaims => ({
    identityId, authKind: 'browser', nodeAdmin: false, requestId: `vault-relay-${randomUUID()}`,
  });

  async function mintBrowser(identityId: string, accountId: string): Promise<string> {
    const secret = generateSecret();
    const row = await db.tx(claims(identityId), (q) => q.rpc<{ id: string }>('issue_auth_session', [
      accountId, hashToken(secret), 'browser', new Date(Date.now() + 3_600_000).toISOString(), null, 'vault-relay browser',
    ]));
    return formatToken(row.id, secret);
  }

  async function mintAgent(): Promise<string> {
    const secret = generateSecret();
    const row = await db.tx(claims(f.identityH), (q) => q.rpc<{ id: string }>('issue_agent_auth_session', [
      f.workSession, f.persona, hashToken(secret), new Date(Date.now() + 3_600_000).toISOString(), 'vault-relay agent',
    ]));
    return formatToken(row.id, secret);
  }

  function send(
    method: string, path: string, headers: OutgoingHttpHeaders = {}, body?: string | Buffer,
  ): { request: ClientRequest; answer: Promise<Answer> } {
    const base = new URL(node.url);
    let request!: ClientRequest;
    const answer = new Promise<Answer>((resolve, reject) => {
      request = httpRequest({
        host: base.hostname, port: base.port, method, path, agent: false,
        headers: { ...headers, ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      request.on('error', reject);
      request.end(body);
    });
    return { request, answer };
  }
  const call = (method: string, path: string, headers: OutgoingHttpHeaders = {}, body?: string | Buffer): Promise<Answer> =>
    send(method, path, headers, body).answer;
  const bearer = (token: string): OutgoingHttpHeaders => ({ authorization: `Bearer ${token}` });

  async function seed(): Promise<Fixture> {
    const fx: Fixture = {
      spaceA: randomUUID(), spaceB: randomUUID(), spaceC: randomUUID(),
      identityH: `vault-relay-h-${randomUUID()}`, identityH2: `vault-relay-h2-${randomUUID()}`, identityH3: `vault-relay-h3-${randomUUID()}`,
      accountH: randomUUID(), accountH2: randomUUID(), accountH3: randomUUID(),
      memberHA: randomUUID(), memberHB: randomUUID(), memberH2A: randomUUID(), memberH3C: randomUUID(),
      persona: randomUUID(), workSession: randomUUID(),
    };
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.user_profiles(identity_id, display_name) values ($1, 'H'), ($2, 'H2'), ($3, 'H3')`,
        [fx.identityH, fx.identityH2, fx.identityH3]);
      // bootstrap() needs a node owner; H is one, which must not widen what H's vault calls can name.
      await client.query(
        `insert into public.accounts(id, identity_id, username, is_owner)
         values ($1, $4, 'vault-relay-h', true), ($2, $5, 'vault-relay-h2', false), ($3, $6, 'vault-relay-h3', false)`,
        [fx.accountH, fx.accountH2, fx.accountH3, fx.identityH, fx.identityH2, fx.identityH3]);
      await client.query(
        `insert into public.spaces(id, name, created_by_identity)
         values ($1, 'Vault A', $4), ($2, 'Vault B', $4), ($3, 'Vault C', $5)`,
        [fx.spaceA, fx.spaceB, fx.spaceC, fx.identityH, fx.identityH3]);
      const members: Array<[string, string, string, string, string]> = [
        [fx.memberHA, fx.spaceA, fx.identityH, 'owner', 'H'],
        [fx.memberHB, fx.spaceB, fx.identityH, 'owner', 'H'],
        [fx.memberH2A, fx.spaceA, fx.identityH2, 'member', 'H2'],
        [fx.memberH3C, fx.spaceC, fx.identityH3, 'owner', 'H3'],
      ];
      for (const [id, space, identity, role, name] of members) {
        await client.query(
          `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'member', $1, 'space')`,
          [id, space]);
        await client.query(
          `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $5)`,
          [id, space, identity, role, name]);
      }
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility)
         values ($1, $3, 'team_member', $4, 'space'), ($2, $3, 'work_session', $1, 'space')`,
        [fx.persona, fx.workSession, fx.spaceA, fx.memberHA]);
      await client.query(
        `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
         values ($1, $2, 'Vault agent', 'worker', 'persona')`, [fx.persona, fx.memberHA]);
      await client.query(
        `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
         values ($1, 'Vault run', 'running', 'none', now())`, [fx.workSession]);
      await client.query(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1, $2, $3, 'participates_in', $2)`, [fx.spaceA, fx.persona, fx.workSession]);
    });
    return fx;
  }

  beforeAll(async () => {
    database = await createW1ScratchDatabase('vault_relay');
    database.apply(migrationFiles());
    db = createDb(database.url, { max: 4 });
    f = await seed();

    dir = await mkdtemp(join(tmpdir(), 'tm8-vault-relay-'));
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-vault-relay-data-'));
    const pair = generateAttestationKeyPair();
    verifier = new AttestationVerifier(pair.publicKey);
    const keyFile = join(dir, 'relay.key');
    await writeFile(keyFile, exportAttestationKeyPair(pair).privatePem, { mode: 0o600 });
    const socketPath = join(dir, 'broker.sock');

    broker = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url ?? '/', 'http://broker.invalid');
        let caller: Caller | null = null;
        let refusal: string | null = null;
        try {
          caller = verifier.verify(req.headers[VAULT_ATTESTATION_HEADER], {
            method: req.method ?? '', path: url.pathname, query: url.search.slice(1), body,
          });
        } catch (error) {
          refusal = error instanceof AttestationError ? error.code : 'unexpected';
        }
        const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, caller, refusal, aborted: false };
        seen.push(entry);
        res.on('close', () => { if (!res.writableFinished) entry.aborted = true; });
        reply(entry, res);
      });
    });
    await new Promise<void>((resolve) => broker.listen(socketPath, resolve));

    // The relay reads its configuration once, at boot, from process.env.
    const vaultEnv: Record<string, string> = {
      TM8_VAULT_MODE: 'pre_review',
      TM8_VAULT_BROKER_SOCKET: socketPath,
      TM8_VAULT_RELAY_PRIVATE_KEY_FILE: keyFile,
      TM8_VAULT_RELAY_TIMEOUT_MS: '10000',
    };
    const prior = Object.fromEntries(Object.keys(vaultEnv).map((name) => [name, process.env[name]]));
    Object.assign(process.env, vaultEnv);
    try {
      const configured = loadConfig({
        ...process.env,
        TM8_BIND: '127.0.0.1',
        TM8_PORT: '4610',
        TM8_NODE_MODE: 'single',
        TM8_DATABASE_URL: database.url,
        TM8_DATA_DIR: dataDir,
        TM8_DISABLE_AUTO_OWNER: '1',
      });
      node = await bootstrap({ config: { ...configured, port: 0 } });
    } finally {
      for (const [name, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 240_000);

  afterAll(async () => {
    await node?.server.close();
    await node?.db?.end();
    await new Promise<void>((resolve) => (broker ? broker.close(() => resolve()) : resolve()));
    await db?.end();
    await database?.destroy();
    if (dir) await rm(dir, { recursive: true, force: true });
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }, 240_000);

  beforeEach(() => {
    seen.length = 0;
    reply = ok;
  });

  it('refuses a request with no credential before any vault decision: 401, nothing reaches the broker', async () => {
    const answer = await call('GET', '/v2/vault/status');
    expect(answer.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('admits a member of one space: the broker verifies the attestation and sees the member, the space and no tm8 credential', async () => {
    const token = await mintBrowser(f.identityH2, f.accountH2);
    const answer = await call('GET', '/v2/vault/status?probe=1', { ...bearer(token), 'user-agent': 'vault-relay-test', 'x-extra': 'never-forwarded' });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({ data: { ok: true } });
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.headers['referrer-policy']).toBe('no-referrer');
    expect(answer.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(answer.headers['x-tm8-request-id']).toMatch(/\S/);

    expect(seen).toHaveLength(1);
    const entry = seen[0]!;
    expect(entry.refusal).toBeNull();
    expect(entry.caller).toEqual({
      kind: 'member', memberId: f.memberH2A, spaceId: f.spaceA, sessionId: null, name: null, isSpaceAdmin: false, ip: '127.0.0.1',
    });
    expect(entry.method).toBe('GET');
    expect(entry.url).toBe('/v2/vault/status?probe=1');
    // Exactly what the relay sends: no authorization, cookie, user agent or client header.
    expect(Object.keys(entry.headers).sort()).toEqual(['connection', 'content-length', 'host', VAULT_ATTESTATION_HEADER].sort());
    expect(entry.headers['content-length']).toBe('0');
    expect(JSON.stringify(entry.headers).includes(token)).toBe(false);
  });

  it('a member of two spaces names one: none is space_required, a space they are not in is space_forbidden, a malformed one invalid_space', async () => {
    const token = await mintBrowser(f.identityH, f.accountH);
    const named = (space: string): OutgoingHttpHeaders => ({ ...bearer(token), [VAULT_SPACE_HEADER]: space });

    const none = await call('GET', '/v2/vault/status', bearer(token));
    expect([none.status, reasonOf(none)]).toEqual([400, 'space_required']);
    const b = await call('GET', '/v2/vault/status', named(f.spaceB.toUpperCase()));
    expect(b.status).toBe(200);
    // The node owner's admin claim does not widen the spaces a vault call can name.
    const other = await call('GET', '/v2/vault/status', named(f.spaceC));
    const unknown = await call('GET', '/v2/vault/status', named(randomUUID()));
    expect([other.status, reasonOf(other), unknown.status, reasonOf(unknown)]).toEqual([403, 'space_forbidden', 403, 'space_forbidden']);
    const malformed = await call('GET', '/v2/vault/status', named('not-a-space'));
    expect([malformed.status, reasonOf(malformed)]).toEqual([400, 'invalid_space']);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.caller).toMatchObject({ kind: 'member', memberId: f.memberHB, spaceId: f.spaceB, sessionId: null, isSpaceAdmin: true });
  });

  it('an agent is attributed to its launching member and its own work session, and cannot leave its pinned space', async () => {
    const token = await mintAgent();
    const own = await call('GET', '/v2/vault/items', bearer(token));
    expect(own.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.caller).toEqual({
      kind: 'agent', memberId: f.memberHA, spaceId: f.spaceA, sessionId: f.workSession, name: null, isSpaceAdmin: true, ip: '127.0.0.1',
    });
    // H is a member of B, but this agent's session is pinned to A.
    const away = await call('GET', '/v2/vault/items', { ...bearer(token), [VAULT_SPACE_HEADER]: f.spaceB });
    expect([away.status, reasonOf(away)]).toEqual([403, 'space_forbidden']);
    expect(seen).toHaveLength(1);
  });

  it('forwards only the two vault cookies and passes back only Set-Cookie in the broker exact shape', async () => {
    const token = await mintBrowser(f.identityH2, f.accountH2);
    const vaultSession = randomUUID().replaceAll('-', '');
    reply = (_entry, res) => json(res, 200, { data: { ok: true } }, {
      'set-cookie': [
        'tm8_vault_session=abc_DEF-123; Max-Age=900; Path=/v2/vault; HttpOnly; Secure; SameSite=Strict',
        'tm8_vault_session=wide; Max-Age=900; Path=/; HttpOnly; Secure; SameSite=Strict',
        `${TM8_SESSION_COOKIE}=forged; Path=/; HttpOnly; Secure; SameSite=Lax`,
        'tm8_vault_refresh=; Max-Age=0; Path=/v2/vault/session; HttpOnly; Secure; SameSite=Strict',
        'tm8_vault_refresh=lax; Max-Age=900; Path=/v2/vault/session; HttpOnly; Secure; SameSite=Lax',
      ],
      'access-control-allow-origin': '*',
      'x-powered-by': 'broker',
    });
    const answer = await call('GET', '/v2/vault/sessions', {
      cookie: `${TM8_SESSION_COOKIE}=${token}; tm8_vault_session=${vaultSession}; theme=dark; tm8_vault_refresh=refB`,
    });
    expect(answer.status).toBe(200);
    expect(answer.headers['set-cookie']).toEqual([
      'tm8_vault_session=abc_DEF-123; Max-Age=900; Path=/v2/vault; HttpOnly; Secure; SameSite=Strict',
      'tm8_vault_refresh=; Max-Age=0; Path=/v2/vault/session; HttpOnly; Secure; SameSite=Strict',
    ]);
    expect(answer.headers['access-control-allow-origin']).toBeUndefined();
    expect(answer.headers['x-powered-by']).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.cookie).toBe(`tm8_vault_session=${vaultSession}; tm8_vault_refresh=refB`);
    expect(JSON.stringify(seen[0]!.headers).includes(token)).toBe(false);
    expect(seen[0]!.caller).toMatchObject({ memberId: f.memberH2A, spaceId: f.spaceA });

    // S6 runs first: a cookie-carrying command without X-TM8-Client never reaches the relay.
    const csrf = await call('POST', '/v2/vault/session/end', { cookie: `${TM8_SESSION_COOKIE}=${token}`, 'content-type': 'application/json' }, '{}');
    expect(csrf.status).toBe(403);
    expect(csrf.text).toContain('X-TM8-Client (S6)');
    // A vault cookie alone is a tm8 cookie too: the capture page's commands carry the header for this.
    const vaultOnly = await call('POST', '/v2/vault/session/end', { cookie: `tm8_vault_session=${vaultSession}`, 'content-type': 'application/json' }, '{}');
    expect([vaultOnly.status, vaultOnly.text.includes('X-TM8-Client (S6)')]).toEqual([403, true]);
    expect(seen).toHaveLength(1);
    const command = await call('POST', '/v2/vault/session/end', {
      cookie: `${TM8_SESSION_COOKIE}=${token}`, 'content-type': 'application/json', [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
    }, '{}');
    expect(command.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.headers[TM8_CLIENT_HEADER]).toBeUndefined();
  });

  it('strips the alerts header and writes each alert to its member inbox, once per burst, never for a non-member', async () => {
    const token = await mintBrowser(f.identityH2, f.accountH2);
    const item = randomUUID();
    const first = new Date(Date.now() - 1_000).toISOString();
    const later = new Date().toISOString();
    const alertsAt = (at: string): string => encodeVaultAlerts({
      dropped: 0,
      alerts: [
        { kind: 'canary_detected', memberId: f.memberH2A, spaceId: f.spaceA, itemId: item, params: { origin: 'https://example.test' }, at },
        // The broker's queue is global: an alert for a member of B can ride on a caller in A.
        { kind: 'approval_requested', memberId: f.memberHB, spaceId: f.spaceB, itemId: null, params: {}, at },
        // H3 is not a member of A: 451 writes nothing.
        { kind: 'egress_refused', memberId: f.memberH3C, spaceId: f.spaceA, itemId: item, params: {}, at },
      ],
    });
    const inbox = (member: string) => database.query<{ id: string; kind: string; payload: Record<string, unknown> }>(
      `select id::text, kind, payload from public.notifications where recipient_member_id = $1 and kind like 'vault\\_%' escape '\\'`,
      [member]);

    reply = (_entry, res) => json(res, 200, { data: { ok: true } }, { [VAULT_ALERTS_HEADER]: alertsAt(first) });
    const answer = await call('GET', '/v2/vault/status', bearer(token));
    expect(answer.status).toBe(200);
    expect(answer.headers[VAULT_ALERTS_HEADER]).toBeUndefined();

    const h2 = await waitFor(async () => { const rows = await inbox(f.memberH2A); return rows.length > 0 ? rows : undefined; });
    const hb = await waitFor(async () => { const rows = await inbox(f.memberHB); return rows.length > 0 ? rows : undefined; });
    expect(h2).toHaveLength(1);
    expect(h2[0]!.kind).toBe('vault_canary_detected');
    expect(h2[0]!.payload).toMatchObject({ alert: 'canary_detected', itemId: item, params: { origin: 'https://example.test' }, count: 1 });
    expect(hb.map((row) => row.kind)).toEqual(['vault_approval_requested']);

    reply = (_entry, res) => json(res, 200, { data: { ok: true } }, { [VAULT_ALERTS_HEADER]: alertsAt(later) });
    expect((await call('GET', '/v2/vault/status', bearer(token))).status).toBe(200);
    const bumped = await waitFor(async () => {
      const rows = await inbox(f.memberH2A);
      return rows.length === 1 && rows[0]!.payload['count'] === 2 ? rows : undefined;
    });
    expect(bumped[0]!.id).toBe(h2[0]!.id);
    expect(new Date(String(bumped[0]!.payload['lastAt'])).toISOString()).toBe(later);
    expect(await inbox(f.memberH3C)).toEqual([]);
  });

  it('451 accepts exactly the broker alert kinds, for an active member of the space only', async () => {
    const rollback = new Error('rollback');
    const accepted: Record<string, boolean> = {};
    await expect(database.transaction(async (client) => {
      const notify = async (space: string, member: string, kind: string): Promise<boolean> => {
        const result = await client.query<{ id: string | null }>(
          `select internal.vault_notify($1::uuid, $2::uuid, $3::text, $4::uuid, '{}'::jsonb, now())::text as id`,
          [space, member, kind, randomUUID()]);
        return result.rows[0]?.id !== null;
      };
      for (const kind of [...VAULT_ALERT_KINDS, 'bogus_kind', 'Canary_detected', 'canary_detected ']) {
        accepted[kind] = await notify(f.spaceA, f.memberH2A, kind);
      }
      accepted['member of another space'] = await notify(f.spaceA, f.memberHB, 'canary_detected');
      accepted['no such member'] = await notify(f.spaceA, randomUUID(), 'canary_detected');
      throw rollback;
    })).rejects.toBe(rollback);
    expect(accepted).toEqual({
      ...Object.fromEntries(VAULT_ALERT_KINDS.map((kind) => [kind, true])),
      bogus_kind: false, Canary_detected: false, 'canary_detected ': false,
      'member of another space': false, 'no such member': false,
    });
  });

  it('answers an unknown route 404 and an over-long query 414 without contacting the broker', async () => {
    const token = await mintBrowser(f.identityH2, f.accountH2);
    const results = await Promise.all([
      call('GET', '/v2/vault/nope', bearer(token)),
      call('POST', '/v2/vault/status', { ...bearer(token), 'content-type': 'application/json' }, '{}'),
      call('GET', '/v2/vault/items/not-a-uuid', bearer(token)),
      call('GET', `/v2/vault/status?q=${'a'.repeat(5_000)}`, bearer(token)),
    ]);
    expect(results.map((answer) => [answer.status, reasonOf(answer)])).toEqual([
      [404, 'not_found'], [404, 'not_found'], [404, 'not_found'], [414, 'uri_too_long'],
    ]);
    expect(seen).toHaveLength(0);
  });

  it('caps and types bodies before the broker, and forwards the exact bytes it signed', async () => {
    const token = await mintBrowser(f.identityH2, f.accountH2);
    const auth = bearer(token);
    const big = await call('POST', '/v2/vault/capture-links', { ...auth, 'content-type': 'application/json' }, `"${'a'.repeat(128 * 1024)}"`);
    expect([big.status, reasonOf(big)]).toEqual([413, 'payload_too_large']);
    const text = await call('POST', '/v2/vault/capture-links', { ...auth, 'content-type': 'text/plain' }, '{}');
    expect([text.status, reasonOf(text)]).toEqual([400, 'invalid_request']);
    const getBody = await call('GET', '/v2/vault/status', { ...auth, 'content-type': 'application/json' }, '{}');
    expect([getBody.status, reasonOf(getBody)]).toEqual([400, 'invalid_request']);
    expect(seen).toHaveLength(0);

    const body = '{"label":"Vendor login","ttlSeconds":600}';
    const sent = await call('POST', '/v2/vault/capture-links', { ...auth, 'content-type': 'application/json; charset=utf-8' }, body);
    expect(sent.status).toBe(200);
    const empty = await call('POST', `/v2/vault/sessions/${randomUUID()}/revoke`, auth);
    expect(empty.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen.map((entry) => entry.refusal)).toEqual([null, null]);
    expect(seen[0]!.body.toString('utf8')).toBe(body);
    expect(seen[0]!.headers['content-type']).toBe('application/json');
    expect(seen[1]!.body.length).toBe(0);
    expect(seen[1]!.headers['content-type']).toBeUndefined();
  });

  it('passes back the status, a numeric Retry-After and nothing else of the broker headers', async () => {
    const token = await mintBrowser(f.identityH2, f.accountH2);
    reply = (_entry, res) => json(res, 429, { error: { code: 'rate_limited' } }, { 'retry-after': '7' });
    const limited = await call('GET', '/v2/vault/status', bearer(token));
    expect([limited.status, limited.headers['retry-after']]).toEqual([429, '7']);
    reply = (_entry, res) => json(res, 429, { error: { code: 'rate_limited' } }, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' });
    const dated = await call('GET', '/v2/vault/status', bearer(token));
    expect([dated.status, dated.headers['retry-after']]).toEqual([429, undefined]);
  });

  it('maps a dropped connection, a non-JSON answer and a stalled broker to 503 vault_unavailable', async () => {
    const token = await mintBrowser(f.identityH2, f.accountH2);
    reply = (_entry, res) => res.socket?.destroy();
    const dropped = await call('GET', '/v2/vault/status', bearer(token));
    reply = (_entry, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>hi</p>'); };
    const html = await call('GET', '/v2/vault/status', bearer(token));
    expect([dropped.status, reasonOf(dropped), html.status, reasonOf(html)]).toEqual([503, 'vault_unavailable', 503, 'vault_unavailable']);
    expect((JSON.parse(dropped.text) as { error: { retryable: boolean } }).error.retryable).toBe(true);
    expect(html.text.includes('<p>')).toBe(false);

    reply = () => { /* never answers */ };
    const started = Date.now();
    const stalled = await call('GET', '/v2/vault/status', bearer(token));
    expect([stalled.status, reasonOf(stalled)]).toEqual([503, 'vault_unavailable']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_500);
    await waitFor(async () => (seen[2]?.aborted ? true : undefined));
  });

  it('cuts the broker request when the client goes away', async () => {
    const token = await mintBrowser(f.identityH2, f.accountH2);
    reply = () => { /* holds the request open */ };
    const { request, answer } = send('POST', `/v2/vault/items/${randomUUID()}/fill`, { ...bearer(token), 'content-type': 'application/json' }, '{}');
    answer.catch(() => undefined);
    await waitFor(async () => (seen.length === 1 ? true : undefined));
    request.destroy();
    await waitFor(async () => (seen[0]!.aborted ? true : undefined));
  });

  it('serves the capture page under its own CSP: the document, only its built modules, GET and HEAD only', async () => {
    const page = await call('GET', `/vault/capture/${randomUUID()}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    for (const [name, value] of Object.entries(CAPTURE_RESPONSE_HEADERS)) expect(page.headers[name.toLowerCase()]).toBe(value);
    expect(page.text).toContain('assets/capture.js');

    const script = await call('GET', '/vault/capture/assets/capture.js');
    expect([script.status, script.headers['content-type']]).toEqual([200, 'text/javascript; charset=utf-8']);
    const style = await call('GET', '/vault/capture/assets/capture.css');
    expect([style.status, style.headers['content-type']]).toEqual([200, 'text/css; charset=utf-8']);
    const missing = await call('GET', '/vault/capture/assets/not-a-module.js');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-security-policy']).toBe(CAPTURE_RESPONSE_HEADERS['Content-Security-Policy']);
    const head = await call('HEAD', '/vault/capture/import');
    expect([head.status, head.text, head.headers['content-length']]).toEqual([200, '', String(Buffer.byteLength(page.text))]);
    const post = await call('POST', '/vault/capture/x', { 'content-type': 'application/json' }, '{}');
    expect([post.status, post.headers.allow]).toEqual([405, 'GET, HEAD']);
  });
});
