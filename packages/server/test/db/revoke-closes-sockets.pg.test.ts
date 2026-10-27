/**
 * P7 (task 01a0db30-b2f9, lane L2a) — every revoke path closes the sockets of
 * the sessions it ended, and no others.
 *
 * Before P7 only `auth.sessions.revoke` (W4) and W1's membership end closed
 * sockets, each from its own call site, and W1 only the sockets SUBSCRIBED to
 * the space. Every other path ended the session in SQL and the socket stayed
 * open, receiving events, until it dropped. P7 re-verifies every open socket's
 * session once per event-pump tick (`public.ended_auth_sessions`, migration auth_session_liveness) and
 * `auth.logout` closes its own session at once.
 *
 * Each cell boots the REAL server over one scratch database, opens real
 * WebSockets with real bearer tokens, ends a session the way that path does,
 * and asserts: the ended session's socket closes with 4401
 * (`WS_CLOSE_SESSION_ENDED`), and a bystander socket — another session, often
 * of the same identity — stays open past a pump tick. Every cell runs under
 * `TM8_SPACE_SESSIONS` off, agents and enforce (one server each, a fresh
 * fixture each). The W6 link paths are in space-link-provenance.pg.test.ts.
 *
 * RED ON MAIN: every cell below except `accounts.disable` over HTTP and a
 * revoke through `auth.sessions.revoke` (both already closed) fails on main
 * 79efe3fb3 with the ended socket still open at the deadline.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { loadConfig } from '../../src/http/config.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const MODES = ['off', 'agents', 'enforce'] as const;
type Mode = (typeof MODES)[number];

/** Longer than a pump tick (1s) plus a slow liveness query. */
const CLOSES_WITHIN_MS = 8_000;
/** At least two pump ticks: a bystander that survives this survived the sweep. */
const STAYS_OPEN_FOR_MS = 2_500;

let database: W1ScratchDatabase;
let db: Db;

interface Human {
  identityId: string;
  accountId: string;
  /** space id → member entity id */
  memberIds: Map<string, string>;
}

interface Spaces {
  spaceA: string;
  spaceB: string;
  admin: Human;
}

interface Minted {
  token: string;
  id: string;
}

function asIdentity<T>(who: Human, fn: (q: Querier) => Promise<T>, extra: Partial<DbClaims> = {}): Promise<T> {
  return db.tx({ identityId: who.identityId, authKind: 'browser', requestId: `p7-${randomUUID()}`, ...extra } as DbClaims, fn);
}

async function human(label: string, memberships: Array<[string, 'owner' | 'member']>): Promise<Human> {
  const who: Human = { identityId: `p7-${label}-${randomUUID()}`, accountId: randomUUID(), memberIds: new Map() };
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query('insert into public.user_profiles(identity_id, display_name) values ($1, $2)', [who.identityId, label]);
    await client.query(
      'insert into public.accounts(id, identity_id, username) values ($1, $2, $3)',
      [who.accountId, who.identityId, `p7-${label}-${who.accountId.slice(0, 8)}`]);
  });
  await enrol(who, memberships);
  return who;
}

async function enrol(who: Human, memberships: Array<[string, 'owner' | 'member']>): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    for (const [space, role] of memberships) {
      const entityId = randomUUID();
      who.memberIds.set(space, entityId);
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'member', $1, 'space')`,
        [entityId, space]);
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $5)`,
        [entityId, space, who.identityId, role, who.identityId]);
    }
  });
}

/** The node's one owner and node admin; every mode's spaces are its. */
let admin: Human;

/** Two fresh spaces the admin owns. */
async function spaces(): Promise<Spaces> {
  const spaceA = randomUUID();
  const spaceB = randomUUID();
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'P7 A', $3), ($2, 'P7 B', $3)`,
      [spaceA, spaceB, admin.identityId]);
  });
  await enrol(admin, [[spaceA, 'owner'], [spaceB, 'owner']]);
  return { spaceA, spaceB, admin };
}

async function mintGate(who: Human, kind: 'browser' | 'cli' = 'browser'): Promise<Minted> {
  const secret = generateSecret();
  const row = await asIdentity(who, (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [
      who.accountId, hashToken(secret), kind,
      new Date(Date.now() + 3_600_000).toISOString(), null, 'p7 gate',
    ]));
  return { token: formatToken(row.id, secret), id: row.id };
}

/** A session pinned to `spaceId`, entered from `gate` (fresh when absent). */
async function mintPinned(who: Human, spaceId: string, gate?: Minted): Promise<Minted & { parent: Minted }> {
  const parent = gate ?? await mintGate(who);
  const secret = generateSecret();
  const row = await asIdentity(who, (q) =>
    q.rpc<{ id: string }>('enter_space', [
      spaceId, parent.id, hashToken(secret),
      new Date(Date.now() + 3_600_000).toISOString(), 'p7 pinned',
    ]));
  return { token: formatToken(row.id, secret), id: row.id, parent };
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('p7_revoke_sockets');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  admin = await human('admin', []);
  // bootstrap() resolves the loopback owner from this row.
  await database.query('update public.accounts set is_owner = true, is_node_admin = true where id = $1', [admin.accountId]);
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

interface Socket {
  ws: WebSocket;
  closed: Promise<{ code: number; reason: string }>;
}

const within = <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> =>
  Promise.race([p, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms))]);

describe.each(MODES)('TM8_SPACE_SESSIONS=%s', (mode: Mode) => {
  let server: BootstrappedServer;
  let s: Spaces;
  const open: WebSocket[] = [];

  beforeAll(async () => {
    s = await spaces();
    const configured = loadConfig({
      ...process.env,
      TM8_BIND: '127.0.0.1',
      TM8_PORT: '4610',
      TM8_NODE_MODE: 'single',
      TM8_DATABASE_URL: database.url,
      TM8_DATA_DIR: await mkdtemp(join(tmpdir(), `tm8-p7-${mode}-`)),
      TM8_DISABLE_AUTO_OWNER: '1',
      TM8_SPACE_SESSIONS: mode,
    });
    expect(configured.spaceSessions).toBe(mode);
    server = await bootstrap({ config: { ...configured, port: 0 } });
  }, 180_000);

  afterAll(async () => {
    for (const ws of open) ws.close();
    await server?.server.close();
    await server?.db?.end();
  }, 180_000);

  async function call(method: string, path: string, token: string, body: unknown = {}): Promise<number> {
    const response = await fetch(new URL(path, server.url), {
      method,
      headers: {
        [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    await response.text();
    return response.status;
  }

  function socket(token: string): Promise<Socket> {
    const url = new URL('/v2/ws', server.url);
    url.protocol = 'ws:';
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
    open.push(ws);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })));
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve({ ws, closed }), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws connection failed')), { once: true });
    });
  }

  async function expectClosed(sock: Socket, reason?: string): Promise<void> {
    const got = await within(sock.closed, CLOSES_WITHIN_MS);
    expect(got).not.toBe('timeout');
    expect(got).toMatchObject({ code: 4401, ...(reason ? { reason } : {}) });
  }

  async function expectOpen(sock: Socket): Promise<void> {
    expect(await within(sock.closed, STAYS_OPEN_FOR_MS)).toBe('timeout');
    expect(sock.ws.readyState).toBe(WebSocket.OPEN);
  }

  // ---- a1/a2: auth.logout ------------------------------------------------------

  it('auth.logout closes the logged-out session\'s socket at once; the same identity\'s other session stays open', async () => {
    const who = await human('logout', [[s.spaceA, 'member']]);
    const tab = await mintGate(who);
    const phone = await mintGate(who, 'cli');
    const tabWs = await socket(tab.token);
    const phoneWs = await socket(phone.token);

    expect(await call('POST', '/v2/auth/logout', tab.token)).toBe(200);

    // Immediate: logout closes its own session before answering; well inside a tick.
    expect(await within(tabWs.closed, 900)).toEqual({ code: 4401, reason: 'session revoked' });
    await expectOpen(phoneWs);
    expect(await call('GET', '/v2/auth/session', phone.token)).toBe(200);
  });

  it('auth.logout presented by a PINNED session closes that socket; its gate\'s socket stays open', async () => {
    const who = await human('logout-pinned', [[s.spaceA, 'member']]);
    const pinned = await mintPinned(who, s.spaceA);
    const pinnedWs = await socket(pinned.token);
    const gateWs = await socket(pinned.parent.token);

    expect(await call('POST', '/v2/auth/logout', pinned.token)).toBe(200);

    await expectClosed(pinnedWs, 'session revoked');
    await expectOpen(gateWs);
  });

  // ---- 249 cascade (P5) --------------------------------------------------------

  it('auth.logout of a GATE closes the sockets of the pinned sessions entered from it (249 cascade); another gate\'s child stays open', async () => {
    const who = await human('cascade', [[s.spaceA, 'member'], [s.spaceB, 'member']]);
    const inA = await mintPinned(who, s.spaceA);
    const inB = await mintPinned(who, s.spaceB, inA.parent);
    const other = await mintPinned(who, s.spaceA);
    const gateWs = await socket(inA.parent.token);
    const aWs = await socket(inA.token);
    const bWs = await socket(inB.token);
    const otherWs = await socket(other.token);

    expect(await call('POST', '/v2/auth/logout', inA.parent.token)).toBe(200);

    await expectClosed(gateWs, 'session revoked');
    await expectClosed(aWs, 'session ended');
    await expectClosed(bWs, 'session ended');
    await expectOpen(otherWs);
  });

  // ---- W1 membership end, W1 account disable --------------------------------

  it('leave_space ends the pinned session\'s socket, subscribed or not; the same human\'s session pinned elsewhere stays open', async () => {
    const who = await human('leave', [[s.spaceA, 'member'], [s.spaceB, 'member']]);
    const inB = await mintPinned(who, s.spaceB);
    const inA = await mintPinned(who, s.spaceA, inB.parent);
    const bWs = await socket(inB.token);
    const aWs = await socket(inA.token);

    // The SQL path, with no server call site after it: W1's handler closes only
    // sockets SUBSCRIBED to B, and this one never subscribed.
    await asIdentity(who, (q) => q.rpc('leave_space', [s.spaceB, `p7-leave-${randomUUID()}`]));

    await expectClosed(bWs, 'session ended');
    await expectOpen(aWs);
  });

  it('remove_space_member ends the removed member\'s pinned socket; a fellow member\'s stays open', async () => {
    const who = await human('removed', [[s.spaceA, 'member']]);
    const fellow = await human('fellow', [[s.spaceA, 'member']]);
    const pinned = await mintPinned(who, s.spaceA);
    const fellowPinned = await mintPinned(fellow, s.spaceA);
    const whoWs = await socket(pinned.token);
    const fellowWs = await socket(fellowPinned.token);

    await asIdentity(s.admin, (q) =>
      q.rpc('remove_space_member', [s.spaceA, who.memberIds.get(s.spaceA), `p7-remove-${randomUUID()}`]));

    await expectClosed(whoWs, 'session ended');
    await expectOpen(fellowWs);
  });

  it('(a) a member row turning `left` closes the pinned socket even with auth_sessions still live', async () => {
    const who = await human('left-row', [[s.spaceA, 'member'], [s.spaceB, 'member']]);
    const inA = await mintPinned(who, s.spaceA);
    const inB = await mintPinned(who, s.spaceB, inA.parent);
    const aWs = await socket(inA.token);
    const bWs = await socket(inB.token);

    // No revoke at all: only the membership changes. A path that forgets to
    // revoke is still covered, because liveness reads the member row.
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.members set status = 'left', left_at = now() where entity_id = $1`, [who.memberIds.get(s.spaceA)]);
    });
    const [row] = await database.query<{ revoked: boolean }>(
      'select revoked_at is not null as revoked from public.auth_sessions where id = $1', [inA.id]);
    expect(row!.revoked).toBe(false);

    await expectClosed(aWs, 'session ended');
    await expectOpen(bWs);
  });

  /** Subscribe `sock` (opened with session `sessionId`) to `spaceId`; resolves once the server registered it. */
  async function subscribe(sock: Socket, sessionId: string, spaceId: string): Promise<void> {
    sock.ws.send(JSON.stringify({ type: 'subscribe', spaceIds: [spaceId] }));
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const sink = server.subscriptions.sinks().find((s) => s.identity.sessionId === sessionId);
      if (sink && server.subscriptions.spacesFor(sink.id).includes(spaceId)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`socket of ${sessionId} never subscribed to ${spaceId}`);
  }

  it('W1 spaces.leave over HTTP: the SUBSCRIBED pinned socket closes with 4401 (dead credential) in every mode; the unpinned gate\'s gets 1008', async () => {
    const who = await human('w1-http-leave', [[s.spaceA, 'member'], [s.spaceB, 'member']]);
    const pinned = await mintPinned(who, s.spaceA);
    const pinnedWs = await socket(pinned.token);
    await subscribe(pinnedWs, pinned.id, s.spaceA);
    const gateWs = await socket(pinned.parent.token);
    // Under enforce a gate session may not subscribe to a space at all.
    if (mode !== 'enforce') await subscribe(gateWs, pinned.parent.id, s.spaceA);

    expect(await call('POST', `/v2/spaces/${s.spaceA}/leave`, pinned.token, { clientMutationId: `p7-${randomUUID()}` })).toBe(200);

    // Keyed on the session ROW's space, not the claim pin (empty under off).
    const got = await within(pinnedWs.closed, CLOSES_WITHIN_MS);
    expect(got).toMatchObject({ code: 4401 });
    if (mode === 'enforce') {
      await expectOpen(gateWs);
    } else {
      // The gate is still good elsewhere: 1008, and a reconnect is fine.
      expect(await within(gateWs.closed, CLOSES_WITHIN_MS)).toEqual({ code: 1008, reason: 'membership ended' });
    }
  });

  it('(a) at UPGRADE: a pinned session whose membership ended is refused, not opened and closed a tick later; the same human\'s other pin still opens', async () => {
    const who = await human('upgrade-left', [[s.spaceA, 'member'], [s.spaceB, 'member']]);
    const inA = await mintPinned(who, s.spaceA);
    const inB = await mintPinned(who, s.spaceB, inA.parent);
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.members set status = 'left', left_at = now() where entity_id = $1`, [who.memberIds.get(s.spaceA)]);
    });

    await expect(socket(inA.token)).rejects.toThrow('ws connection failed');
    await expectOpen(await socket(inB.token));
  });

  it('disable_account closes every socket of the account; another account\'s stays open', async () => {
    const who = await human('disabled', [[s.spaceA, 'member']]);
    const bystander = await human('bystander', [[s.spaceA, 'member']]);
    const gate = await mintGate(who);
    const pinned = await mintPinned(who, s.spaceA, gate);
    const gateWs = await socket(gate.token);
    const pinnedWs = await socket(pinned.token);
    const bystanderWs = await socket((await mintGate(bystander)).token);

    await asIdentity(s.admin, (q) => q.rpc('disable_account', [who.accountId, `p7-disable-${randomUUID()}`]), { nodeAdmin: true });

    await expectClosed(gateWs, 'session ended');
    await expectClosed(pinnedWs, 'session ended');
    await expectOpen(bystanderWs);
  });

  // ---- expiry --------------------------------------------------------------------

  it('an expired session\'s socket closes; an unexpired one stays open', async () => {
    const who = await human('expiry', [[s.spaceA, 'member']]);
    const short = await mintGate(who);
    const long = await mintGate(who);
    const shortWs = await socket(short.token);
    const longWs = await socket(long.token);

    await database.query(`update public.auth_sessions set expires_at = now() - interval '1 second' where id = $1`, [short.id]);

    await expectClosed(shortWs, 'session ended');
    await expectOpen(longWs);
  });
});
