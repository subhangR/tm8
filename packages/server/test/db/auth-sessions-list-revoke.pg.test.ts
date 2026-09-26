/**
 * W4 — auth.sessions.list / auth.sessions.revoke (plan 01a0d9eb §3 W4,
 * migration 249).
 *
 * Two spaces, four humans, every credential minted by the production RPC and
 * resolved by the production identity resolver + `claimsFor`:
 *
 *   ADM  owner of A only        — the space admin of a2
 *   MEM  member of A and B      — the non-admin of a3; owns sessions pinned
 *                                 to A and to B
 *   BADM owner of B only        — B's admin (positive for the B refusal)
 *   BOTH owner of A and B       — an admin whose PIN decides what it may list
 *
 * Every refusal is paired with a positive case: the same credential against
 * what it IS allowed to see.
 *
 * The last block boots the real server and opens real WebSockets: revoking
 * session X closes X's socket and leaves the same identity's session Y open
 * (phone vs tab), the revoked token is refused on its next call, and revoking
 * a gate session closes the sockets of the pinned sessions entered from it.
 *
 * Nothing here logs a token.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  TM8_CLIENT_HEADER,
  TM8_CLIENT_HEADER_VALUE,
  type AuthSessionListing,
  type AuthSessionsListResult,
  type AuthSessionsRevokeResult,
} from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db, Querier } from '../../src/db/types.js';
import { claimsFor } from '../../src/facade/context.js';
import { loadConfig } from '../../src/http/config.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import type { RequestContext, RequestIdentity } from '../../src/http/types.js';
import { formatToken, generateSecret, hashToken, parseToken } from '../../src/identity/crypto.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { listAuthSessions, revokeListedAuthSession } from '../../src/identity/pg-auth.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Human {
  identityId: string;
  accountId: string;
}

interface Fixture {
  spaceA: string;
  spaceB: string;
  adm: Human;
  mem: Human;
  badm: Human;
  both: Human;
  personaA: string;
  workSessionA: string;
}

let database: W1ScratchDatabase;
let db: Db;
let f: Fixture;

const NOT_THE_OWNER: LoopbackOwner = {
  identityId: 'w4-sessions-not-the-owner',
  accountId: randomUUID(),
  username: 'nobody',
  isNodeAdmin: false,
  isOwner: false,
};

// ---------------------------------------------------------------------------
// Credentials.
// ---------------------------------------------------------------------------

function asIdentity<T>(identityId: string, fn: (q: Querier) => Promise<T>, authKind = 'browser'): Promise<T> {
  return db.tx({ identityId, authKind, requestId: `w4-seed-${randomUUID()}` }, fn);
}

interface Minted {
  token: string;
  id: string;
}

async function mintGate(who: Human, kind: 'browser' | 'cli' = 'browser'): Promise<Minted> {
  const secret = generateSecret();
  const row = await asIdentity(who.identityId, (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [
      who.accountId, hashToken(secret), kind,
      new Date(Date.now() + 3_600_000).toISOString(), null, 'w4 gate',
    ]));
  return { token: formatToken(row.id, secret), id: row.id };
}

/** A session pinned to `spaceId`, entered from `gate` (fresh when absent). */
async function mintPinned(who: Human, spaceId: string, gate?: Minted): Promise<Minted & { parent: Minted }> {
  const parent = gate ?? await mintGate(who);
  const secret = generateSecret();
  const row = await asIdentity(who.identityId, (q) =>
    q.rpc<{ id: string; space_id: string }>('enter_space', [
      spaceId, parent.id, hashToken(secret),
      new Date(Date.now() + 3_600_000).toISOString(), 'w4 pinned',
    ]));
  expect(row.space_id).toBe(spaceId);
  return { token: formatToken(row.id, secret), id: row.id, parent };
}

async function mintAgent(): Promise<Minted> {
  const secret = generateSecret();
  const row = await asIdentity(f.adm.identityId, (q) =>
    q.rpc<{ id: string }>('issue_agent_auth_session', [
      f.workSessionA, f.personaA, hashToken(secret),
      new Date(Date.now() + 3_600_000).toISOString(), 'w4 agent',
    ]));
  return { token: formatToken(row.id, secret), id: row.id };
}

async function identityFor(token: string): Promise<RequestIdentity> {
  const resolve = createSessionIdentityResolver({
    db,
    owner: async () => NOT_THE_OWNER,
    spaceSessions: 'enforce',
  });
  return resolve(
    { authorization: `Bearer ${token}` },
    { remoteAddress: '203.0.113.9', disableAutoOwner: true },
  );
}

/** `auth.sessions.list`'s data path, as `token`. */
async function list(token: string, spaceId: string | null): Promise<AuthSessionListing[]> {
  const identity = await identityFor(token);
  const ctx = { identity, requestId: `w4-${randomUUID()}` } as unknown as RequestContext;
  return listAuthSessions(db, claimsFor(NOT_THE_OWNER, ctx), spaceId, identity.sessionId);
}

/** `auth.sessions.revoke`'s data path, as `token`. */
async function revoke(token: string, sessionId: string): Promise<AuthSessionsRevokeResult> {
  const identity = await identityFor(token);
  const ctx = { identity, requestId: `w4-${randomUUID()}` } as unknown as RequestContext;
  return revokeListedAuthSession(db, claimsFor(NOT_THE_OWNER, ctx), sessionId);
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    const code = (err as { details?: { sqlstate?: string } }).details?.sqlstate
      ?? (err as { cause?: { code?: string } }).cause?.code
      ?? (err as { code?: string }).code;
    return String(code);
  }
}

const ids = (rows: readonly AuthSessionListing[]): string[] => rows.map((r) => r.sessionId);

async function revokedAt(sessionId: string): Promise<Date | null> {
  const rows = await database.query<{ revoked_at: Date | null }>(
    'select revoked_at from public.auth_sessions where id = $1', [sessionId]);
  return rows[0]!.revoked_at;
}

// ---------------------------------------------------------------------------
// Fixture.
// ---------------------------------------------------------------------------

async function seed(): Promise<Fixture> {
  const human = (): Human => ({ identityId: `w4-${randomUUID()}`, accountId: randomUUID() });
  const x = {
    spaceA: randomUUID(),
    spaceB: randomUUID(),
    adm: human(),
    mem: human(),
    badm: human(),
    both: human(),
    personaA: randomUUID(),
    workSessionA: randomUUID(),
  };
  const members: Array<[Human, string, 'owner' | 'member', string]> = [
    [x.adm, x.spaceA, 'owner', 'Adm'],
    [x.mem, x.spaceA, 'member', 'Mem'],
    [x.mem, x.spaceB, 'member', 'Mem'],
    [x.badm, x.spaceB, 'owner', 'BAdm'],
    [x.both, x.spaceA, 'owner', 'Both'],
    [x.both, x.spaceB, 'owner', 'Both'],
  ];
  const memberIds = new Map<string, string>();
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    for (const [who, name] of [[x.adm, 'adm'], [x.mem, 'mem'], [x.badm, 'badm'], [x.both, 'both']] as const) {
      await client.query(
        'insert into public.user_profiles(identity_id, display_name) values ($1, $2)', [who.identityId, name]);
      await client.query(
        'insert into public.accounts(id, identity_id, username) values ($1, $2, $3)',
        [who.accountId, who.identityId, `w4-${name}-${x.spaceA.slice(0, 8)}`]);
    }
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'W4 Space A', $3), ($2, 'W4 Space B', $3)`,
      [x.spaceA, x.spaceB, x.adm.identityId]);
    for (const [who, space, role, display] of members) {
      const entityId = randomUUID();
      memberIds.set(`${who.identityId}/${space}`, entityId);
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility)
         values ($1, $2, 'member', $1, 'space')`, [entityId, space]);
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name)
         values ($1, $2, $3, $4, $5)`, [entityId, space, who.identityId, role, display]);
    }
    const admA = memberIds.get(`${x.adm.identityId}/${x.spaceA}`)!;
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $3, 'team_member', $2, 'space'), ($4, $3, 'work_session', $1, 'space')`,
      [x.personaA, admA, x.spaceA, x.workSessionA]);
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'W4 G', 'worker', 'persona')`, [x.personaA, admA]);
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
       values ($1, 'W4 G run', 'running', 'none', now())`, [x.workSessionA]);
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'participates_in', $2)`, [x.spaceA, x.personaA, x.workSessionA]);
  });
  return x;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('w4_auth_sessions');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  f = await seed();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

// ---------------------------------------------------------------------------
// a1 — own sessions.
// ---------------------------------------------------------------------------

describe('a1 a user lists their own sessions and revokes one', () => {
  it('lists every live session of the caller, gate and pinned, with derived origin and no token', async () => {
    const pinned = await mintPinned(f.mem, f.spaceA);
    // Listed from the unpinned gate: under a pin the gate is hidden (W4-P1).
    const rows = await list(pinned.parent.token, null);
    const mine = rows.find((r) => r.sessionId === pinned.id)!;
    const gate = rows.find((r) => r.sessionId === pinned.parent.id)!;
    expect(mine).toMatchObject({
      kind: 'browser', origin: 'space_enter', spaceId: f.spaceA, spaceName: 'W4 Space A',
      parentSessionId: pinned.parent.id, current: false, label: 'w4 pinned',
    });
    expect(gate).toMatchObject({ origin: 'login', spaceId: null, parentSessionId: null, current: true });
    expect(rows.every((r) => r.owner.identityId === f.mem.identityId)).toBe(true);
    const wire = JSON.stringify(rows);
    expect(wire).not.toMatch(/token_hash|tokenHash/);
    expect(wire).not.toMatch(/[a-f0-9]{64}/);
    expect(wire).not.toContain(pinned.token);
  });

  it('an agent session reads origin spawn and names its work session', async () => {
    const agent = await mintAgent();
    const gate = await mintGate(f.adm);
    const row = (await list(gate.token, null)).find((r) => r.sessionId === agent.id)!;
    expect(row).toMatchObject({ kind: 'agent', origin: 'spawn', originEntityId: f.workSessionA, spaceId: f.spaceA });
  });

  it('revokes one of its own sessions; the revoked token is refused on its next call', async () => {
    const tab = await mintGate(f.mem);
    const phone = await mintGate(f.mem, 'cli');
    const result = await revoke(tab.token, phone.id);
    expect(result).toEqual({ sessionId: phone.id, revoked: true, revokedSessionIds: [phone.id] });
    await expect(identityFor(phone.token)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(ids(await list(tab.token, null))).not.toContain(phone.id);
  });

  it('positive — the session that revoked stays live', async () => {
    const tab = await mintGate(f.mem);
    const phone = await mintGate(f.mem, 'cli');
    await revoke(tab.token, phone.id);
    expect(await identityFor(tab.token)).toMatchObject({ kind: 'bearer', sessionId: tab.id });
  });

  it('revoking an already-revoked session is a no-op that revokes nothing', async () => {
    const tab = await mintGate(f.mem);
    const phone = await mintGate(f.mem);
    await revoke(tab.token, phone.id);
    expect(await revoke(tab.token, phone.id)).toEqual({ sessionId: phone.id, revoked: false, revokedSessionIds: [] });
  });
});

// ---------------------------------------------------------------------------
// Coordinator ruling: a gate revoke cascades to its pinned children.
// ---------------------------------------------------------------------------

describe('gate revoke cascades to the pinned sessions entered from it', () => {
  it('revoking the gate revokes both children and reports every id', async () => {
    const inA = await mintPinned(f.both, f.spaceA);
    const inB = await mintPinned(f.both, f.spaceB, inA.parent);
    const other = await mintGate(f.both);
    const result = await revoke(other.token, inA.parent.id);
    expect(result.revoked).toBe(true);
    expect(new Set(result.revokedSessionIds)).toEqual(new Set([inA.parent.id, inA.id, inB.id]));
    for (const token of [inA.parent.token, inA.token, inB.token]) {
      await expect(identityFor(token)).rejects.toMatchObject({ code: 'unauthenticated' });
    }
  });

  it('positive — revoking a CHILD leaves its gate and its sibling live', async () => {
    const inA = await mintPinned(f.both, f.spaceA);
    const inB = await mintPinned(f.both, f.spaceB, inA.parent);
    const result = await revoke(inA.parent.token, inA.id);
    expect(result.revokedSessionIds).toEqual([inA.id]);
    expect(await revokedAt(inA.parent.id)).toBeNull();
    expect(await revokedAt(inB.id)).toBeNull();
  });

  it('logout (revoke_auth_session) of a gate cascades too — the trigger, not the caller', async () => {
    const inA = await mintPinned(f.both, f.spaceA);
    await asIdentity(f.both.identityId, (q) => q.rpc('revoke_auth_session', [inA.parent.id]));
    expect(await revokedAt(inA.id)).not.toBeNull();
  });

  it('positive — an unrelated gate of the same account is untouched by that cascade', async () => {
    const inA = await mintPinned(f.both, f.spaceA);
    const second = await mintPinned(f.both, f.spaceA);
    await asIdentity(f.both.identityId, (q) => q.rpc('revoke_auth_session', [inA.parent.id]));
    expect(await revokedAt(second.id)).toBeNull();
    expect(await revokedAt(second.parent.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// a2 — a space admin sees and revokes sessions pinned to THEIR space.
// ---------------------------------------------------------------------------

describe('a2 a space admin sees sessions pinned to their space, not other spaces\'', () => {
  it('ADM lists A: MEM\'s A-pinned session is there, MEM\'s B-pinned and gate sessions are not', async () => {
    const memA = await mintPinned(f.mem, f.spaceA);
    const memB = await mintPinned(f.mem, f.spaceB, memA.parent);
    const adm = await mintPinned(f.adm, f.spaceA);
    const rows = await list(adm.token, f.spaceA);
    expect(ids(rows)).toContain(memA.id);
    expect(ids(rows)).not.toContain(memB.id);
    expect(ids(rows)).not.toContain(memA.parent.id);
    expect(rows.every((r) => r.spaceId === f.spaceA)).toBe(true);
    expect(rows.find((r) => r.sessionId === memA.id)!.owner).toEqual({
      identityId: f.mem.identityId, displayName: 'Mem',
    });
  });

  it('ADM cannot list B at all (not an admin there): 42501', async () => {
    const adm = await mintGate(f.adm);
    expect(await outcome(() => list(adm.token, f.spaceB))).toBe('42501');
  });

  it('positive — BADM lists B and sees MEM\'s B-pinned session', async () => {
    const memB = await mintPinned(f.mem, f.spaceB);
    const badm = await mintGate(f.badm);
    expect(ids(await list(badm.token, f.spaceB))).toContain(memB.id);
  });

  it('ADM revokes MEM\'s A-pinned session; MEM\'s gate stays live', async () => {
    const memA = await mintPinned(f.mem, f.spaceA);
    const adm = await mintPinned(f.adm, f.spaceA);
    expect((await revoke(adm.token, memA.id)).revokedSessionIds).toEqual([memA.id]);
    await expect(identityFor(memA.token)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(await revokedAt(memA.parent.id)).toBeNull();
  });

  it('ADM cannot revoke MEM\'s B-pinned session: not_found (P0002), still live', async () => {
    const memB = await mintPinned(f.mem, f.spaceB);
    const adm = await mintGate(f.adm);
    expect(await outcome(() => revoke(adm.token, memB.id))).toBe('P0002');
    expect(await revokedAt(memB.id)).toBeNull();
  });

  it('positive — BADM revokes that same B-pinned session', async () => {
    const memB = await mintPinned(f.mem, f.spaceB);
    const badm = await mintGate(f.badm);
    expect((await revoke(badm.token, memB.id)).revoked).toBe(true);
  });

  it('ADM cannot revoke MEM\'s GATE session (pinned to no space): P0002', async () => {
    const memGate = await mintGate(f.mem);
    const adm = await mintGate(f.adm);
    expect(await outcome(() => revoke(adm.token, memGate.id))).toBe('P0002');
  });

  it('pin-aware: BOTH pinned to A cannot list or revoke in B (42501 / P0002)', async () => {
    const both = await mintPinned(f.both, f.spaceA);
    const memB = await mintPinned(f.mem, f.spaceB);
    expect(await outcome(() => list(both.token, f.spaceB))).toBe('42501');
    expect(await outcome(() => revoke(both.token, memB.id))).toBe('P0002');
  });

  it('positive — BOTH pinned to B lists and revokes in B', async () => {
    const both = await mintPinned(f.both, f.spaceB);
    const memB = await mintPinned(f.mem, f.spaceB);
    expect(ids(await list(both.token, f.spaceB))).toContain(memB.id);
    expect((await revoke(both.token, memB.id)).revoked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// a3 — a non-admin member cannot see other members' sessions.
// ---------------------------------------------------------------------------

describe('a3 a non-admin member cannot see other members\' sessions', () => {
  it('MEM lists A as a space: 42501', async () => {
    const mem = await mintPinned(f.mem, f.spaceA);
    expect(await outcome(() => list(mem.token, f.spaceA))).toBe('42501');
  });

  it('positive — ADM lists A with the same call', async () => {
    const adm = await mintPinned(f.adm, f.spaceA);
    expect(await outcome(() => list(adm.token, f.spaceA))).toBe('ok');
  });

  it('MEM\'s own list holds only MEM\'s sessions, never ADM\'s A-pinned one', async () => {
    const admA = await mintPinned(f.adm, f.spaceA);
    const mem = await mintPinned(f.mem, f.spaceA);
    const rows = await list(mem.token, null);
    expect(ids(rows)).not.toContain(admA.id);
    expect(rows.every((r) => r.owner.identityId === f.mem.identityId)).toBe(true);
  });

  it('MEM cannot revoke ADM\'s session: P0002, still live', async () => {
    const admA = await mintPinned(f.adm, f.spaceA);
    const mem = await mintPinned(f.mem, f.spaceA);
    expect(await outcome(() => revoke(mem.token, admA.id))).toBe('P0002');
    expect(await revokedAt(admA.id)).toBeNull();
  });

  it('positive — MEM revokes its own session with the same credential', async () => {
    // W4-P1: a pinned caller's own reach is its pinned space.
    const mem = await mintPinned(f.mem, f.spaceA);
    const own = await mintPinned(f.mem, f.spaceA, mem.parent);
    expect((await revoke(mem.token, own.id)).revoked).toBe(true);
  });

  it('an unknown id answers exactly like a foreign one (P0002)', async () => {
    const mem = await mintGate(f.mem);
    expect(await outcome(() => revoke(mem.token, randomUUID()))).toBe('P0002');
  });
});

// 249 re-creates enter_space, so it must keep 232's tombstone (248's
// `m.status = 'active'`): a member who LEFT or was REMOVED cannot pin.
// W4-P1 (security, train-1 audit): under a pin the own list and revoke stay
// inside the pinned space — a session pinned to A must not read or end the
// same account's sessions in B (cross-space metadata read + revocation).
describe('W4-P1 a pinned session stays inside its space', () => {
  it('list: pinned to A, the own list omits B\'s sessions and the gate', async () => {
    const inA = await mintPinned(f.both, f.spaceA);
    const inB = await mintPinned(f.both, f.spaceB, inA.parent);
    const seen = ids(await list(inA.token, null));
    expect(seen).toContain(inA.id);
    expect(seen).not.toContain(inB.id);
    expect(seen).not.toContain(inA.parent.id);
  });

  it('revoke: pinned to A, revoking its own B-pinned session is P0002 and B stays live', async () => {
    const inA = await mintPinned(f.both, f.spaceA);
    const inB = await mintPinned(f.both, f.spaceB, inA.parent);
    expect(await outcome(() => revoke(inA.token, inB.id))).toBe('P0002');
    expect(await revokedAt(inB.id)).toBeNull();
  });

  // M3: the gate has space_id NULL, so only a NULL-safe comparison refuses it
  // (`is distinct from`; a plain `<>` yields NULL and would let it through).
  it('revoke: pinned to A, revoking its OWN GATE (the unpinned parent) is P0002; the gate and B\'s child stay live', async () => {
    const inA = await mintPinned(f.both, f.spaceA);
    const inB = await mintPinned(f.both, f.spaceB, inA.parent);
    expect(await outcome(() => revoke(inA.token, inA.parent.id))).toBe('P0002');
    expect(await revokedAt(inA.parent.id)).toBeNull();
    expect(await revokedAt(inB.id)).toBeNull();
  });

  it('revoke: pinned to A, revoking another OWN unpinned gate session (not its parent) is P0002', async () => {
    const inA = await mintPinned(f.both, f.spaceA);
    const otherGate = await mintGate(f.both, 'cli');
    expect(await outcome(() => revoke(inA.token, otherGate.id))).toBe('P0002');
    expect(await revokedAt(otherGate.id)).toBeNull();
  });

  it('positive (paired with the own-gate refusal) — the same pinned session revokes a same-space session', async () => {
    const inA = await mintPinned(f.both, f.spaceA);
    const inA2 = await mintPinned(f.both, f.spaceA, inA.parent);
    expect((await revoke(inA.token, inA2.id)).revoked).toBe(true);
    expect(await revokedAt(inA2.id)).not.toBeNull();
  });

  it('positive — the unpinned gate still lists and revokes the B-pinned session', async () => {
    const inA = await mintPinned(f.both, f.spaceA);
    const inB = await mintPinned(f.both, f.spaceB, inA.parent);
    expect(ids(await list(inA.parent.token, null))).toContain(inB.id);
    expect((await revoke(inA.parent.token, inB.id)).revoked).toBe(true);
  });
});

describe('enter_space after 249 keeps the member tombstone (232, 248)', () => {
  it('MEM, left or removed from A, cannot enter A: 42501', async () => {
    for (const status of ['left', 'removed']) {
      await database.query(
        `update public.members set status = $3, left_at = now() where space_id = $1 and identity_id = $2`,
        [f.spaceA, f.mem.identityId, status]);
      try {
        expect(await outcome(() => mintPinned(f.mem, f.spaceA))).toBe('42501');
      } finally {
        await database.query(
          `update public.members set status = 'active', left_at = null where space_id = $1 and identity_id = $2`,
          [f.spaceA, f.mem.identityId]);
      }
    }
  });

  it('positive — reactivated, MEM enters A again', async () => {
    expect(await outcome(() => mintPinned(f.mem, f.spaceA))).toBe('ok');
  });
});

describe('humans only', () => {
  it('an agent token cannot list or revoke (42501)', async () => {
    const agent = await mintAgent();
    const target = await mintGate(f.adm);
    expect(await outcome(() => list(agent.token, null))).toBe('42501');
    expect(await outcome(() => list(agent.token, f.spaceA))).toBe('42501');
    expect(await outcome(() => revoke(agent.token, target.id))).toBe('42501');
    expect(await revokedAt(target.id)).toBeNull();
  });

  it('positive — the agent\'s launching human lists and revokes the agent session', async () => {
    const agent = await mintAgent();
    const adm = await mintGate(f.adm);
    expect(ids(await list(adm.token, f.spaceA))).toContain(agent.id);
    expect((await revoke(adm.token, agent.id)).revoked).toBe(true);
    await expect(identityFor(agent.token)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

// ---------------------------------------------------------------------------
// a1 end to end: HTTP + real WebSockets on the booted server.
// ---------------------------------------------------------------------------

describe('a1 over HTTP: revoke closes exactly the revoked sessions\' sockets', () => {
  let server: BootstrappedServer;
  const open: WebSocket[] = [];

  beforeAll(async () => {
    await database.query('update public.accounts set is_owner = true, is_node_admin = true where id = $1', [f.both.accountId]);
    const configured = loadConfig({
      ...process.env,
      TM8_BIND: '127.0.0.1',
      TM8_PORT: '4610',
      TM8_NODE_MODE: 'single',
      TM8_DATABASE_URL: database.url,
      TM8_DATA_DIR: await mkdtemp(join(tmpdir(), 'tm8-w4-')),
      TM8_DISABLE_AUTO_OWNER: '1',
    });
    server = await bootstrap({ config: { ...configured, port: 0 } });
  }, 180_000);

  afterAll(async () => {
    for (const ws of open) ws.close();
    await server?.server.close();
    await server?.db?.end();
  }, 180_000);

  async function call(method: string, path: string, token: string): Promise<{ status: number; body: unknown }> {
    const response = await fetch(new URL(path, server.url), {
      method,
      headers: {
        [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
        authorization: `Bearer ${token}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  const data = <T>(body: unknown): T => ((body as { data?: T }).data ?? body) as T;

  function socket(token: string): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }> }> {
    const url = new URL('/v2/ws', server.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    // Node's WebSocket (undici) accepts upgrade headers; the server reads the bearer.
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
    open.push(ws);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })));
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve({ ws, closed }), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws connection failed')), { once: true });
    });
  }

  const within = <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> =>
    Promise.race([p, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms))]);

  it('GET /v2/auth/sessions lists the caller\'s sessions with `current` set', async () => {
    const tab = await mintGate(f.mem);
    const { status, body } = await call('GET', '/v2/auth/sessions', tab.token);
    expect(status).toBe(200);
    const result = data<AuthSessionsListResult>(body);
    expect(result.spaceId).toBeNull();
    expect(result.sessions.find((s) => s.sessionId === tab.id)?.current).toBe(true);
  });

  it('GET /v2/auth/sessions?spaceId= as a non-admin is refused 403', async () => {
    const mem = await mintGate(f.mem);
    expect((await call('GET', `/v2/auth/sessions?spaceId=${f.spaceA}`, mem.token)).status).toBe(403);
  });

  it('positive — the same request as the space admin answers 200', async () => {
    const adm = await mintGate(f.adm);
    expect((await call('GET', `/v2/auth/sessions?spaceId=${f.spaceA}`, adm.token)).status).toBe(200);
  });

  it('revoking session X closes X\'s socket (1008) and leaves session Y of the same identity open', async () => {
    const phone = await mintGate(f.mem, 'cli');
    const tab = await mintGate(f.mem);
    const x = await socket(phone.token);
    const y = await socket(tab.token);

    const { status, body } = await call('POST', `/v2/auth/sessions/${phone.id}/revoke`, tab.token);
    expect(status).toBe(200);
    expect(data<AuthSessionsRevokeResult>(body).revokedSessionIds).toEqual([phone.id]);

    expect(await within(x.closed, 10_000)).toEqual({ code: 1008, reason: 'session revoked' });
    expect(await within(y.closed, 500)).toBe('timeout');
    expect(y.ws.readyState).toBe(WebSocket.OPEN);

    // The revoked token is refused on its next call; the other still works.
    expect((await call('GET', '/v2/auth/session', phone.token)).status).toBe(401);
    expect((await call('GET', '/v2/auth/session', tab.token)).status).toBe(200);
  });

  it('revoking a gate closes the gate\'s socket and its pinned children\'s sockets, and no other', async () => {
    const child = await mintPinned(f.both, f.spaceA);
    const bystander = await mintGate(f.both);
    const gateWs = await socket(child.parent.token);
    const childWs = await socket(child.token);
    const bystanderWs = await socket(bystander.token);

    const { status, body } = await call('POST', `/v2/auth/sessions/${child.parent.id}/revoke`, bystander.token);
    expect(status).toBe(200);
    expect(new Set(data<AuthSessionsRevokeResult>(body).revokedSessionIds)).toEqual(new Set([child.parent.id, child.id]));

    expect(await within(gateWs.closed, 10_000)).toMatchObject({ code: 1008 });
    expect(await within(childWs.closed, 10_000)).toMatchObject({ code: 1008 });
    expect(await within(bystanderWs.closed, 500)).toBe('timeout');
    expect((await call('GET', '/v2/auth/session', child.token)).status).toBe(401);
  });

  it('a space admin\'s revoke closes the member\'s pinned socket', async () => {
    const memA = await mintPinned(f.mem, f.spaceA);
    const adm = await mintGate(f.adm);
    const memWs = await socket(memA.token);
    expect((await call('POST', `/v2/auth/sessions/${memA.id}/revoke`, adm.token)).status).toBe(200);
    expect(await within(memWs.closed, 10_000)).toMatchObject({ code: 1008 });
  });

  it('a foreign session answers 404 and its socket stays open', async () => {
    const admA = await mintPinned(f.adm, f.spaceA);
    const mem = await mintGate(f.mem);
    const admWs = await socket(admA.token);
    expect((await call('POST', `/v2/auth/sessions/${admA.id}/revoke`, mem.token)).status).toBe(404);
    expect(await within(admWs.closed, 500)).toBe('timeout');
  });
});
