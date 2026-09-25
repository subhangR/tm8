import { mkdtemp } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db, Querier } from '../../src/db/types.js';
import { loadConfig } from '../../src/http/config.js';
import { TM8_SESSION_COOKIE } from '../../src/http/session-cookie.js';
import { formatToken, generateSecret, hashToken, parseToken } from '../../src/identity/crypto.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

/**
 * CROSS-SPACE TOKEN MATRIX — one top-level describe per T-number, one `it` per
 * cell, every refusal followed by its paired positive.
 *
 * Credentials are REAL tokens: generateSecret() -> hashToken() -> the
 * production mint RPC -> formatToken(row.id, secret). Token strings are never
 * logged or stored.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  spaceA: string;
  spaceB: string;
  identityH: string;
  identityH2: string;
  accountH: string;
  accountH2: string;
  memberHA: string;
  memberHB: string;
  memberH2A: string;
  personaA: string;
  workSessionA: string;
  chatA: string;
}

let database: W1ScratchDatabase;
let db: Db;
let fixture: Fixture;

async function asIdentity<T>(identityId: string, fn: (q: Querier) => Promise<T>): Promise<T> {
  return db.tx({ identityId, authKind: 'browser', requestId: `cross-space-${randomUUID()}` }, fn);
}

async function mintBrowser(accountId: string, identityId: string): Promise<string> {
  const secret = generateSecret();
  const row = await asIdentity(identityId, (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [
      accountId, hashToken(secret), 'browser',
      new Date(Date.now() + 3_600_000).toISOString(), null, 'cross-space browser',
    ]));
  return formatToken(row.id, secret);
}

async function mintAgent(): Promise<string> {
  const secret = generateSecret();
  const row = await asIdentity(fixture.identityH, (q) =>
    q.rpc<{ id: string }>('issue_agent_auth_session', [
      fixture.workSessionA, fixture.personaA, hashToken(secret),
      new Date(Date.now() + 3_600_000).toISOString(), 'cross-space agent G',
    ]));
  return formatToken(row.id, secret);
}

async function seed(): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids: Fixture = {
      spaceA: randomUUID(),
      spaceB: randomUUID(),
      identityH: 'cross-space-h',
      identityH2: 'cross-space-h2',
      accountH: randomUUID(),
      accountH2: randomUUID(),
      memberHA: randomUUID(),
      memberHB: randomUUID(),
      memberH2A: randomUUID(),
      personaA: randomUUID(),
      workSessionA: randomUUID(),
      chatA: randomUUID(),
    };
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'H'), ($2, 'H2')`,
      [ids.identityH, ids.identityH2],
    );
    await client.query(
      `insert into public.accounts(id, identity_id, username)
       values ($1, $2, 'cross-space-h'), ($3, $4, 'cross-space-h2')`,
      [ids.accountH, ids.identityH, ids.accountH2, ids.identityH2],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'Cross-space A', $3), ($2, 'Cross-space B', $3)`,
      [ids.spaceA, ids.spaceB, ids.identityH],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $6, 'member', $1, 'space'),
              ($2, $7, 'member', $2, 'space'),
              ($3, $6, 'member', $3, 'space'),
              ($4, $6, 'team_member', $1, 'space'),
              ($5, $6, 'work_session', $4, 'space')`,
      [ids.memberHA, ids.memberHB, ids.memberH2A, ids.personaA, ids.workSessionA, ids.spaceA, ids.spaceB],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $4, $6, 'owner', 'H'),
              ($2, $5, $6, 'owner', 'H'),
              ($3, $4, $7, 'member', 'H2')`,
      [ids.memberHA, ids.memberHB, ids.memberH2A, ids.spaceA, ids.spaceB, ids.identityH, ids.identityH2],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'Agent G', 'worker', 'persona')`,
      [ids.personaA, ids.memberHA],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
       values ($1, 'Cross-space session', 'running', 'none', now())`,
      [ids.workSessionA],
    );
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'participates_in', $2)`,
      [ids.spaceA, ids.personaA, ids.workSessionA],
    );
    return ids;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('cross_space_token');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  fixture = await seed();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

/**
 * T26 — THE NAMED-SERVER RELAY (G1).
 *
 * `/v2/server-connections/:name/proxy/*` used to dispatch before any identity
 * was resolved and to look the target up as the NODE OWNER — so a request with
 * no session, or an agent's token, drove every registered remote. The relay now
 * resolves the caller first, admits browser/cli sessions only, and reads the
 * target under the CALLER's claims (044: node admins only until links exist).
 *
 * HTTP, not SQL: the refusal lives in the transport, so the cells go through
 * the production composition root (`bootstrap`) on this file's database, with
 * the auto-owner arm OFF — on loopback it would otherwise answer every
 * no-credential request as the owner and the 401 cell could not be reached.
 * The upstream is a real listener that records what arrives, because acceptance
 * a3 is a claim about the far end, not about a header helper.
 *
 * Every refusal is paired with a positive: the kind refusals with H's own
 * browser session (the refusal is by kind, not by space — T11's pairing), the
 * claims refusal (H2) with H on the same connection.
 */
describe('T26 relay — dispatch after resolveIdentity, human session required', () => {
  let relayServer: BootstrappedServer;
  /** Same database, auto-owner arm ON — only the cells that document it use this. */
  let ownerRelayServer: BootstrappedServer;
  let upstream: Server;
  let arrived: IncomingHttpHeaders[] = [];
  let adminBefore: Array<{ id: string; is_node_admin: boolean; is_owner: boolean }> = [];
  const CONNECTION = 't26-remote';

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      arrived.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (typeof address === 'string' || address === null) throw new Error('no upstream port');

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      // H owns and administers the node, H2 does not: the claims cell needs
      // exactly that split, and `bootstrap` needs an owner. It is also the
      // regression: the relay used to read the target AS THE OWNER, so H2
      // reached it on H's claims. Restored in afterAll so no later block
      // inherits it.
      const before = await client.query<{ id: string; is_node_admin: boolean; is_owner: boolean }>(
        'select id::text, is_node_admin, is_owner from public.accounts where id = any($1::uuid[])',
        [[fixture.accountH, fixture.accountH2]],
      );
      adminBefore = before.rows;
      await client.query(
        `update public.accounts set is_node_admin = (id = $1::uuid), is_owner = (id = $1::uuid)
          where id = any($2::uuid[])`,
        [fixture.accountH, [fixture.accountH, fixture.accountH2]],
      );
      await client.query(
        'insert into public.server_connections(name, base_url) values ($1, $2)',
        [CONNECTION, `http://127.0.0.1:${address.port}`],
      );
    });

    const start = async (disableAutoOwner: '1' | '0'): Promise<BootstrappedServer> => {
      const configured = loadConfig({
        ...process.env,
        TM8_BIND: '127.0.0.1',
        TM8_PORT: '4610',
        TM8_NODE_MODE: 'single',
        TM8_DATABASE_URL: database.url,
        TM8_DATA_DIR: await mkdtemp(join(tmpdir(), 'tm8-t26-')),
        TM8_DISABLE_AUTO_OWNER: disableAutoOwner,
      });
      return bootstrap({ config: { ...configured, port: 0 } });
    };
    relayServer = await start('1');
    ownerRelayServer = await start('0');
  }, 180_000);

  afterAll(async () => {
    for (const server of [relayServer, ownerRelayServer]) {
      await server?.server.close();
      await server?.db?.end();
    }
    await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query('delete from public.server_connections where name = $1', [CONNECTION]);
      for (const row of adminBefore) {
        await client.query(
          'update public.accounts set is_node_admin = $2, is_owner = $3 where id = $1::uuid',
          [row.id, row.is_node_admin, row.is_owner],
        );
      }
    });
  }, 180_000);

  async function relay(
    headers: Record<string, string>,
    server: BootstrappedServer = relayServer,
  ): Promise<{ status: number; seen: IncomingHttpHeaders | undefined }> {
    arrived = [];
    const response = await fetch(new URL(`/v2/server-connections/${CONNECTION}/proxy/health`, server.url), {
      headers: { [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE, ...headers },
    });
    await response.arrayBuffer();
    return { status: response.status, seen: arrived[0] };
  }

  async function mintCli(accountId: string, identityId: string): Promise<string> {
    const secret = generateSecret();
    const row = await asIdentity(identityId, (q) =>
      q.rpc<{ id: string }>('issue_auth_session', [
        accountId, hashToken(secret), 'cli',
        new Date(Date.now() + 3_600_000).toISOString(), null, 'T26 cli',
      ]));
    return formatToken(row.id, secret);
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const cookie = (token: string) => ({ cookie: `${TM8_SESSION_COOKIE}=${token}` });

  it('no session is refused 401 and nothing reaches the remote', async () => {
    const { status, seen } = await relay({});
    expect(status).toBe(401);
    expect(seen).toBeUndefined();
  });

  it('positive — H (browser cookie) reaches the connection', async () => {
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    const { status, seen } = await relay(cookie(token));
    expect(status).toBe(200);
    expect(seen).toBeDefined();
  });

  it('agent token is refused 403 and nothing reaches the remote', async () => {
    const token = await mintAgent();
    const { status, seen } = await relay(bearer(token));
    expect(status).toBe(403);
    expect(seen).toBeUndefined();
  });

  it('agent token as a cookie is refused 403 too', async () => {
    const token = await mintAgent();
    const { status, seen } = await relay(cookie(token));
    expect(status).toBe(403);
    expect(seen).toBeUndefined();
  });

  it('positive — H (cli token) reaches the connection, and its token stays on this node', async () => {
    const token = await mintCli(fixture.accountH, fixture.identityH);
    const { status, seen } = await relay(bearer(token));
    expect(status).toBe(200);
    // Booleans, not values: a failing assertion must never print a token.
    expect(seen !== undefined && 'authorization' in seen).toBe(false);
    expect(JSON.stringify(seen).includes(token)).toBe(false);
  });

  it('H2 (browser, not a node admin) is refused: the target is read under H2\'s claims', async () => {
    const token = await mintBrowser(fixture.accountH2, fixture.identityH2);
    const { status, seen } = await relay(cookie(token));
    expect(status).toBe(404);
    expect(seen).toBeUndefined();
  });

  it('positive — H (browser) on the same connection forwards only the remote pass it presented', async () => {
    const token = await mintBrowser(fixture.accountH, fixture.identityH);
    const remotePass = 'tm8s_00000000-0000-0000-0000-000000000000.remote-pass-not-local';
    const { status, seen } = await relay({ ...cookie(token), ...bearer(remotePass) });
    expect(status).toBe(200);
    expect(seen?.authorization).toBe(`Bearer ${remotePass}`);
    expect(seen !== undefined && 'cookie' in seen).toBe(false);
    expect(JSON.stringify(seen).includes(token)).toBe(false);
  });
  async function revoke(token: string): Promise<void> {
    const sessionId = parseToken(token)?.sessionId;
    if (!sessionId) throw new Error('minted token did not parse');
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query('update public.auth_sessions set revoked_at = now() where id = $1::uuid', [sessionId]);
    });
  }

  it('auto-owner off: an Authorization unknown here, no cookie, is refused 401 and nothing reaches the remote', async () => {
    const unknown = 'tm8s_00000000-0000-0000-0000-000000000000.not-a-session-here';
    const { status, seen } = await relay(bearer(unknown));
    expect(status).toBe(401);
    expect(seen).toBeUndefined();
  });

  /**
   * F1 / W2 PIN — TODAY'S BEHAVIOUR, WHICH W2 CHANGES. Loopback peer, single
   * mode, auto-owner arm on, no token, no X-Forwarded-For: the NODE-WIDE
   * loopback auto-owner rule (security.ts `autoOwnerResolver`) makes the
   * request the node owner on every route, and the relay admits the owner like
   * any other human. This is plan finding F1, and the fix is phase-1a task W2
   * (01a0d9fd-6957-7da5-a590-9655ebbf2ace: launch cookie,
   * TM8_AUTO_OWNER_COOKIE=required), not the relay. W2 flips this expectation
   * to 401; until then nothing may change it silently in either direction.
   */
  it('F1/W2 pin: loopback, single mode, no token, no X-Forwarded-For — relay admits as owner TODAY', async () => {
    const { status, seen } = await relay({}, ownerRelayServer);
    expect(status).toBe(200);
    expect(seen).toBeDefined();
  });

  /**
   * DOCUMENTS A KNOWN GAP (review round 1, item 2). A LOCAL token that no
   * longer resolves (revoked, expired) is indistinguishable here from a
   * remote's pass: both are `tm8s_<uuid>.<secret>`, and `tm8_app` cannot read
   * `auth_sessions` to ask "was this session id ever ours?" — that needs a new
   * security-definer RPC, i.e. a migration, which this PR does not add. So
   * next to a live cookie such a token is FORWARDED. It is dead on this node,
   * so the remote cannot replay it here; the disclosure is of a spent secret.
   * When the RPC lands, flip this cell to `false`.
   */
  it('KNOWN GAP: a revoked LOCAL token beside H\'s cookie is forwarded as if it were a remote pass', async () => {
    const cookieToken = await mintBrowser(fixture.accountH, fixture.identityH);
    const dead = await mintCli(fixture.accountH, fixture.identityH);
    await revoke(dead);
    const { status, seen } = await relay({ ...cookie(cookieToken), ...bearer(dead) });
    expect(status).toBe(200);
    expect(seen?.authorization === `Bearer ${dead}`).toBe(true);
    expect(JSON.stringify(seen).includes(cookieToken)).toBe(false);
  });

  it('a revoked LOCAL token alone is refused 401 with auto-owner off, and nothing reaches the remote', async () => {
    const dead = await mintCli(fixture.accountH, fixture.identityH);
    await revoke(dead);
    const { status, seen } = await relay(bearer(dead));
    expect(status).toBe(401);
    expect(seen).toBeUndefined();
  });

  it('positive — the same cli credential, before revocation, reaches the connection', async () => {
    const live = await mintCli(fixture.accountH, fixture.identityH);
    const { status } = await relay(bearer(live));
    expect(status).toBe(200);
  });
});
