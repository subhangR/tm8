/**
 * G6 — THE MEMBER TOMBSTONE (plan 01a0d9eb §3 W1, migration 232).
 *
 * `spaces.leave` / `spaces.members.remove` end a membership WITHOUT deleting
 * the row: `members.status` goes to `left` / `removed`, `left_at` is stamped,
 * and in the same commit the member's pinned tokens are revoked, their live
 * work sessions recorded exited, their personas deactivated (kept) and their
 * assignments cleared with the reason on the task's feed. `accounts.disable`
 * turns an account off and revokes every session.
 *
 * Every refusal here is paired with a positive (the same caller, a case it
 * may do), so no row passes merely because everything is refused.
 *
 * Fixture: spaces A (public) and B. O owns both and is the node owner. N is a
 * node admin, member of A. D is an admin of A. L is a member of A and B, with
 * a persona PL in B running a work session WS on an agent token, and two
 * tasks in B assigned to L and to PL. R is a member of A. X is a plain
 * account with a browser session, member of A.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db, Querier } from '../../src/db/types.js';
import { loadActors, loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import { queryCollection } from '../../src/facade/handlers/collections.js';
import { generateSecret, hashToken } from '../../src/identity/crypto.js';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  spaceA: string;
  spaceB: string;
  identityO: string;
  identityN: string;
  identityD: string;
  identityL: string;
  identityR: string;
  identityX: string;
  accountO: string;
  accountN: string;
  accountL: string;
  accountX: string;
  memberOA: string;
  memberOB: string;
  memberNA: string;
  memberDA: string;
  memberLA: string;
  memberLB: string;
  memberRA: string;
  memberXA: string;
  personaLB: string;
  workSessionLB: string;
  taskForL: string;
  taskForPL: string;
  /** L's unpinned browser session and pinned agent token (ids, not tokens). */
  browserL: string;
  agentL: string;
  browserX: string;
}

let database: W1ScratchDatabase;
let db: Db;
let f: Fixture;

function as<T>(identityId: string, fn: (q: Querier) => Promise<T>, authKind = 'browser'): Promise<T> {
  return db.tx({ identityId, authKind, requestId: `member-tombstone-${randomUUID()}` }, fn);
}

/** Read as the graph owner, past RLS — the assertion's own view of the rows. */
async function ownerQuery<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return (await client.query<T>(sql, params)).rows;
  });
}

/** The SQLSTATE a refused call raised, or `'ok'`. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    const code = (err as { code?: string; details?: { sqlstate?: string } }).details?.sqlstate
      ?? (err as { cause?: { code?: string } }).cause?.code
      ?? (err as { code?: string }).code;
    return String(code);
  }
}

const cmid = (): string => `member-tombstone-${randomUUID()}`;

const leave = (identityId: string, spaceId: string, mutationId = cmid(), authKind = 'browser') =>
  as(identityId, (q) => q.rpc<Record<string, unknown>>('leave_space', [spaceId, mutationId]), authKind);

const removeMember = (identityId: string, spaceId: string, memberId: string, mutationId = cmid()) =>
  as(identityId, (q) => q.rpc<Record<string, unknown>>('remove_space_member', [spaceId, memberId, mutationId]));

const disable = (identityId: string, accountId: string, mutationId = cmid()) =>
  as(identityId, (q) => q.rpc<Record<string, unknown>>('disable_account', [accountId, mutationId]));

const visibleIn = (identityId: string, spaceId: string): Promise<number> =>
  as(identityId, async (q) => (await q.query<{ n: number }>(
    'select count(*)::int as n from public.entities where space_id = $1 and deleted_at is null', [spaceId]))[0]!.n);

async function mintBrowser(accountId: string, identityId: string): Promise<string> {
  const row = await as(identityId, (q) => q.rpc<{ id: string }>('issue_auth_session', [
    accountId, hashToken(generateSecret()), 'browser',
    new Date(Date.now() + 3_600_000).toISOString(), null, 'member-tombstone browser',
  ]));
  return row.id;
}

async function seed(): Promise<Fixture> {
  const ids = {
    spaceA: randomUUID(),
    spaceB: randomUUID(),
    identityO: `tombstone-o-${randomUUID()}`,
    identityN: `tombstone-n-${randomUUID()}`,
    identityD: `tombstone-d-${randomUUID()}`,
    identityL: `tombstone-l-${randomUUID()}`,
    identityR: `tombstone-r-${randomUUID()}`,
    identityX: `tombstone-x-${randomUUID()}`,
    accountO: randomUUID(),
    accountN: randomUUID(),
    accountD: randomUUID(),
    accountL: randomUUID(),
    accountR: randomUUID(),
    accountX: randomUUID(),
    memberOA: randomUUID(),
    memberOB: randomUUID(),
    memberNA: randomUUID(),
    memberDA: randomUUID(),
    memberLA: randomUUID(),
    memberLB: randomUUID(),
    memberRA: randomUUID(),
    memberXA: randomUUID(),
    personaLB: randomUUID(),
    workSessionLB: randomUUID(),
    taskForL: randomUUID(),
    taskForPL: randomUUID(),
  };
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'O'), ($2, 'N'), ($3, 'D'), ($4, 'L'), ($5, 'R'), ($6, 'X')`,
      [ids.identityO, ids.identityN, ids.identityD, ids.identityL, ids.identityR, ids.identityX],
    );
    await client.query(
      `insert into public.accounts(id, identity_id, username, is_owner, is_node_admin) values
       ($1, $2, 'tombstone-o', true, true),
       ($3, $4, 'tombstone-n', false, true),
       ($5, $6, 'tombstone-d', false, false),
       ($7, $8, 'tombstone-l', false, false),
       ($9, $10, 'tombstone-r', false, false),
       ($11, $12, 'tombstone-x', false, false)`,
      [ids.accountO, ids.identityO, ids.accountN, ids.identityN, ids.accountD, ids.identityD,
       ids.accountL, ids.identityL, ids.accountR, ids.identityR, ids.accountX, ids.identityX],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity, visibility)
       values ($1, 'Tombstone A', $3, 'public'), ($2, 'Tombstone B', $3, 'private')`,
      [ids.spaceA, ids.spaceB, ids.identityO],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility) values
       ($1, $3, 'member', $1, 'space'),
       ($2, $4, 'member', $2, 'space'),
       ($5, $3, 'member', $5, 'space'),
       ($6, $3, 'member', $6, 'space'),
       ($7, $3, 'member', $7, 'space'),
       ($8, $4, 'member', $8, 'space'),
       ($9, $3, 'member', $9, 'space'),
       ($10, $3, 'member', $10, 'space'),
       ($11, $4, 'team_member', $8, 'space'),
       ($12, $4, 'work_session', $11, 'space'),
       ($13, $4, 'task', $2, 'space'),
       ($14, $4, 'task', $2, 'space')`,
      [ids.memberOA, ids.memberOB, ids.spaceA, ids.spaceB, ids.memberNA, ids.memberDA,
       ids.memberLA, ids.memberLB, ids.memberRA, ids.memberXA, ids.personaLB,
       ids.workSessionLB, ids.taskForL, ids.taskForPL],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name) values
       ($1, $9, $11, 'owner', 'O'),
       ($2, $10, $11, 'owner', 'O'),
       ($3, $9, $12, 'member', 'N'),
       ($4, $9, $13, 'admin', 'D'),
       ($5, $9, $14, 'member', 'L'),
       ($6, $10, $14, 'member', 'L'),
       ($7, $9, $15, 'member', 'R'),
       ($8, $9, $16, 'member', 'X')`,
      [ids.memberOA, ids.memberOB, ids.memberNA, ids.memberDA, ids.memberLA, ids.memberLB,
       ids.memberRA, ids.memberXA, ids.spaceA, ids.spaceB,
       ids.identityO, ids.identityN, ids.identityD, ids.identityL, ids.identityR, ids.identityX],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'L''s persona', 'worker', 'persona')`,
      [ids.personaLB, ids.memberLB],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
       values ($1, 'L''s run in B', 'running', 'none', now())`,
      [ids.workSessionLB],
    );
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'participates_in', $2)`,
      [ids.spaceB, ids.personaLB, ids.workSessionLB],
    );
    await client.query(
      `insert into public.tasks(entity_id, title, work_status, priority) values
       ($1, 'Assigned to L', 'open', 'medium'),
       ($2, 'Assigned to L''s persona', 'open', 'medium')`,
      [ids.taskForL, ids.taskForPL],
    );
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by) values
       ($1, $2, $3, 'assigned_to', $5),
       ($1, $4, $6, 'assigned_to', $5)`,
      [ids.spaceB, ids.taskForL, ids.memberLB, ids.taskForPL, ids.memberOB, ids.personaLB],
    );
  });
  const agentL = await as(ids.identityL, (q) => q.rpc<{ id: string }>('issue_agent_auth_session', [
    ids.workSessionLB, ids.personaLB, hashToken(generateSecret()),
    new Date(Date.now() + 3_600_000).toISOString(), 'member-tombstone agent',
  ]));
  const { accountD: _d, accountR: _r, ...rest } = ids;
  return {
    ...rest,
    browserL: await mintBrowser(ids.accountL, ids.identityL),
    agentL: agentL.id,
    browserX: await mintBrowser(ids.accountX, ids.identityX),
  };
}

const memberRow = (memberId: string) =>
  ownerQuery<{ status: string; left_at: Date | null; role: string }>(
    'select status, left_at, role from public.members where entity_id = $1', [memberId]);

const revokedAt = async (sessionId: string): Promise<Date | null> =>
  (await ownerQuery<{ revoked_at: Date | null }>(
    'select revoked_at from public.auth_sessions where id = $1', [sessionId]))[0]!.revoked_at;

beforeAll(async () => {
  database = await createW1ScratchDatabase('member_tombstone');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  f = await seed();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

describe.sequential('spaces.leave — L leaves B', () => {
  let result: Record<string, unknown>;
  const mutationId = cmid();

  it('the last owner cannot leave (42501); the positive: L, not an owner, can see B before leaving', async () => {
    expect(await outcome(() => leave(f.identityO, f.spaceB))).toBe('42501');
    expect(await visibleIn(f.identityL, f.spaceB)).toBeGreaterThan(0);
    expect((await memberRow(f.memberOB))[0]!.status).toBe('active');
  });

  it('is human-only: an agent authKind is refused (42501), and nothing ends', async () => {
    expect(await outcome(() => leave(f.identityL, f.spaceB, cmid(), 'agent'))).toBe('42501');
    expect((await memberRow(f.memberLB))[0]!.status).toBe('active');
  });

  it('L leaves B: the result names every effect', async () => {
    result = await leave(f.identityL, f.spaceB, mutationId);
    expect(result).toMatchObject({
      spaceId: f.spaceB,
      memberId: f.memberLB,
      status: 'left',
      stoppedSessionIds: [f.workSessionLB],
      deactivatedPersonaIds: [f.personaLB],
      unassignedEntityIds: [f.taskForL, f.taskForPL].sort(),
      identityId: f.identityL,
    });
    expect(result.revokedTokenCount).toBeGreaterThanOrEqual(1);
    expect(typeof result.leftAt).toBe('string');
  });

  it('a4: the member row is NOT deleted — it exists with status left and left_at set', async () => {
    const rows = await memberRow(f.memberLB);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('left');
    expect(rows[0]!.left_at).not.toBeNull();
    // The member entity is kept too, so old content still names its author.
    const entity = await ownerQuery('select 1 from public.entities where id = $1 and deleted_at is null', [f.memberLB]);
    expect(entity).toHaveLength(1);
  });

  it('only the membership in B ended — L is still active in A', async () => {
    expect((await memberRow(f.memberLA))[0]!.status).toBe('active');
  });

  it('a1: L is refused in B; the positive: the same L still reads A', async () => {
    expect(await visibleIn(f.identityL, f.spaceB)).toBe(0);
    expect(await visibleIn(f.identityL, f.spaceA)).toBeGreaterThan(0);
    expect(await outcome(() => as(f.identityL, (q) => q.rpc('create_document', [f.spaceB, 'after leaving']))))
      .toBe('42501');
    expect(await outcome(() => as(f.identityL, (q) => q.rpc('create_document', [f.spaceA, 'still here']))))
      .toBe('ok');
  });

  it('the unpinned browser session survives (it serves A); the agent token pinned to B is revoked', async () => {
    expect(await revokedAt(f.browserL)).toBeNull();
    expect(await revokedAt(f.agentL)).not.toBeNull();
  });

  it('the work session is recorded exited, stopped by the operator', async () => {
    const [ws] = await ownerQuery<{ status: string; ended_kind: string; ended_reason: string; exited_at: Date | null }>(
      'select status, ended_kind, ended_reason, exited_at from public.work_sessions where entity_id = $1',
      [f.workSessionLB]);
    expect(ws).toMatchObject({ status: 'exited', ended_kind: 'stopped_by_operator' });
    expect(ws!.ended_reason).toMatch(/left the space/);
    expect(ws!.exited_at).not.toBeNull();
  });

  it('the persona is kept, deactivated', async () => {
    const [tm] = await ownerQuery<{ deactivated_at: Date | null }>(
      'select deactivated_at from public.team_members where entity_id = $1', [f.personaLB]);
    expect(tm).toBeDefined();
    expect(tm!.deactivated_at).not.toBeNull();
  });

  it('assignments are cleared, each with the reason on the task feed', async () => {
    const edges = await ownerQuery(
      `select 1 from public.edges where type = 'assigned_to' and src_id = any($1::uuid[])`,
      [[f.taskForL, f.taskForPL]]);
    expect(edges).toHaveLength(0);
    const feed = await ownerQuery<{ entity_id: string; summary: { reason: string } }>(
      `select entity_id::text, summary from public.activity
        where verb = 'unlinked' and entity_id = any($1::uuid[]) order by entity_id`,
      [[f.taskForL, f.taskForPL]]);
    expect(feed.map((row) => row.entity_id).sort()).toEqual([f.taskForL, f.taskForPL].sort());
    for (const row of feed) expect(row.summary.reason).toBe('member_left');
  });

  it('the membership change is on the member\'s own feed', async () => {
    const feed = await ownerQuery<{ summary: { status: string } }>(
      `select summary from public.activity where verb = 'updated' and entity_id = $1`, [f.memberLB]);
    expect(feed.map((row) => row.summary.status)).toContain('left');
  });

  it('a3: O still resolves L and L\'s persona as authors, marked left', async () => {
    const actors = await as(f.identityO, (q) => loadActors(q, [f.memberLB, f.personaLB, f.memberOB]));
    expect(actors.get(f.memberLB)).toMatchObject({ memberStatus: 'left' });
    expect(actors.get(f.personaLB)).toMatchObject({ memberStatus: 'left' });
    // The positive: an active member carries no status at all.
    expect(actors.get(f.memberOB)).toBeDefined();
    expect(actors.get(f.memberOB)!.memberStatus).toBeUndefined();
  });

  it('a replay with the same mutation id returns the recorded result', async () => {
    const replay = await leave(f.identityL, f.spaceB, mutationId);
    expect(replay).toEqual(result);
  });

  it('leaving again with a fresh id is refused: L is not a member of B', async () => {
    expect(await outcome(() => leave(f.identityL, f.spaceB))).toBe('42501');
  });

  it('an invite brings L back as the SAME member, persona reactivated', async () => {
    const invite = await as(f.identityO, (q) => q.rpc<{ invite: { code: string } }>(
      'create_invite', [f.spaceB, 1, null, null, cmid(), 'member']));
    const joined = await as(f.identityL, (q) => q.rpc<{ memberId: string; joined: boolean }>(
      'redeem_invite', [invite.invite.code, cmid()]));
    expect(joined).toMatchObject({ memberId: f.memberLB, joined: true });
    const [row] = await memberRow(f.memberLB);
    expect(row).toMatchObject({ status: 'active', left_at: null });
    const [tm] = await ownerQuery<{ deactivated_at: Date | null }>(
      'select deactivated_at from public.team_members where entity_id = $1', [f.personaLB]);
    expect(tm!.deactivated_at).toBeNull();
    expect(await visibleIn(f.identityL, f.spaceB)).toBeGreaterThan(0);
  });
});

describe.sequential('spaces.members.remove', () => {
  it('only an owner removes an owner: admin D is refused on O (42501); positive: D removes R', async () => {
    expect(await outcome(() => removeMember(f.identityD, f.spaceA, f.memberOA))).toBe('42501');
    expect((await memberRow(f.memberOA))[0]!.status).toBe('active');
    const result = await removeMember(f.identityD, f.spaceA, f.memberRA);
    expect(result).toMatchObject({ memberId: f.memberRA, status: 'removed' });
  });

  it('a4: the removed row exists with status removed', async () => {
    const rows = await memberRow(f.memberRA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('removed');
    expect(rows[0]!.left_at).not.toBeNull();
  });

  it('a plain member cannot remove anyone (42501); nor can you remove yourself (22023)', async () => {
    expect(await outcome(() => removeMember(f.identityX, f.spaceA, f.memberNA))).toBe('42501');
    expect(await outcome(() => removeMember(f.identityO, f.spaceA, f.memberOA))).toBe('22023');
  });

  it('a removed member cannot walk back in through the public door (42501); the positive: an invite works', async () => {
    expect(await outcome(() => as(f.identityR, (q) => q.rpc('join_public_space', [f.spaceA, cmid()])))).toBe('42501');
    expect(await visibleIn(f.identityR, f.spaceA)).toBe(0);
    const invite = await as(f.identityO, (q) => q.rpc<{ invite: { code: string } }>(
      'create_invite', [f.spaceA, 1, null, null, cmid(), 'member']));
    const joined = await as(f.identityR, (q) => q.rpc<{ memberId: string }>(
      'redeem_invite', [invite.invite.code, cmid()]));
    expect(joined.memberId).toBe(f.memberRA);
    expect((await memberRow(f.memberRA))[0]!.status).toBe('active');
  });

  it('a member who LEFT a public space may rejoin it through the public door', async () => {
    await leave(f.identityX, f.spaceA);
    expect((await memberRow(f.memberXA))[0]!.status).toBe('left');
    const joined = await as(f.identityX, (q) => q.rpc<{ memberId: string; joined: boolean }>(
      'join_public_space', [f.spaceA, cmid()]));
    expect(joined).toMatchObject({ memberId: f.memberXA, joined: true });
  });

  it('the members list and member_count count active members only', async () => {
    await removeMember(f.identityO, f.spaceA, f.memberRA);
    const [count] = await as(f.identityO, (q) => q.query<{ n: number }>(
      `select count(*)::int as n from public.members where space_id = $1 and status = 'active'`, [f.spaceA]));
    const [all] = await ownerQuery<{ n: number }>(
      'select count(*)::int as n from public.members where space_id = $1', [f.spaceA]);
    expect(all!.n).toBe(count!.n + 1);
  });

  it('the entity list drops a removed member on re-query; positive: an active member is listed, and the removed row still resolves by id', async () => {
    // R was removed by the test above. A reload is a fresh query.
    const listed = async (kinds?: string[]) => {
      const result = await as(f.identityO, (q) => queryCollection(
        q, { spaceId: f.spaceA, ...(kinds ? { kinds } : {}), limit: 200 } as never, f.identityO));
      return result.page.items.map((item) => item.id);
    };
    for (const kinds of [['member'], ['member', 'channel'], undefined]) {
      const ids = await listed(kinds);
      expect(ids).not.toContain(f.memberRA);
      expect(ids).toContain(f.memberOA);
    }
    // Old content renders: the row is reachable by id and says why it is not listed.
    const [removed, active] = await as(f.identityO, (q) =>
      loadEntitySummariesByIds(q, [f.memberRA, f.memberOA], f.identityO)).then((rows) =>
      [rows.find((r) => r.id === f.memberRA), rows.find((r) => r.id === f.memberOA)]);
    expect(removed?.state).toMatchObject({ kind: 'member', memberStatus: 'removed' });
    expect(active?.state).toMatchObject({ kind: 'member' });
    expect((active!.state as { memberStatus?: string }).memberStatus).toBeUndefined();
  });

  it('the entity list drops a removed member\'s persona; positive: an active member\'s persona is listed, and the removed one still resolves by id', async () => {
    const personaR = randomUUID();
    const personaO = randomUUID();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values
         ($1, $3, 'team_member', $4, 'space'), ($2, $3, 'team_member', $5, 'space')`,
        [personaR, personaO, f.spaceA, f.memberRA, f.memberOA]);
      await client.query(
        `insert into public.team_members(entity_id, owner_member_id, name, role, identity) values
         ($1, $3, 'R''s persona', 'worker', 'persona'), ($2, $4, 'O''s persona', 'worker', 'persona')`,
        [personaR, personaO, f.memberRA, f.memberOA]);
    });
    for (const kinds of [['team_member'], ['member', 'team_member'], undefined]) {
      const result = await as(f.identityO, (q) => queryCollection(
        q, { spaceId: f.spaceA, ...(kinds ? { kinds } : {}), limit: 200 } as never, f.identityO));
      const ids = result.page.items.map((item) => item.id);
      expect(ids).not.toContain(personaR);
      expect(ids).toContain(personaO);
    }
    const rows = await as(f.identityO, (q) => loadEntitySummariesByIds(q, [personaR, personaO], f.identityO));
    const removed = rows.find((r) => r.id === personaR)!;
    const active = rows.find((r) => r.id === personaO)!;
    expect(removed.state).toMatchObject({ kind: 'team_member', owner: { id: f.memberRA, memberStatus: 'removed' } });
    expect(active.state).toMatchObject({ kind: 'team_member', owner: { id: f.memberOA } });
    expect((active.state as { owner: { memberStatus?: string } }).owner.memberStatus).toBeUndefined();
  });
});

describe.sequential('accounts.disable', () => {
  it('a non-admin is refused (42501); the positive: X\'s sessions are live', async () => {
    expect(await outcome(() => disable(f.identityL, f.accountX))).toBe('42501');
    expect(await revokedAt(f.browserX)).toBeNull();
  });

  it('you cannot disable yourself, nor the node owner (42501)', async () => {
    expect(await outcome(() => disable(f.identityN, f.accountN))).toBe('42501');
    expect(await outcome(() => disable(f.identityN, f.accountO))).toBe('42501');
  });

  it('is human-only: an agent authKind is refused (42501)', async () => {
    expect(await outcome(() => as(f.identityN, (q) => q.rpc('disable_account', [f.accountX, cmid()]), 'agent')))
      .toBe('42501');
  });

  it('a2: a node admin disables X — every session revoked, the memberships kept', async () => {
    const mutationId = cmid();
    const result = await disable(f.identityN, f.accountX, mutationId);
    expect(result).toMatchObject({ accountId: f.accountX, status: 'disabled', identityId: f.identityX });
    expect(result.revokedSessionCount).toBeGreaterThanOrEqual(1);
    expect(await revokedAt(f.browserX)).not.toBeNull();
    const live = await ownerQuery(
      'select 1 from public.auth_sessions where account_id = $1 and revoked_at is null', [f.accountX]);
    expect(live).toHaveLength(0);
    expect((await memberRow(f.memberXA))[0]!.status).toBe('active');
    expect(await disable(f.identityN, f.accountX, mutationId)).toEqual(result);
  });
});

// ---------------------------------------------------------------------------
// THE OWNER RACE (review of #841). Two owners removing each other must leave
// exactly one owner: remove_space_member takes the owner-row lock, in a fixed
// order, before the target row, and re-reads its caller under it.
// ---------------------------------------------------------------------------
describe.sequential('spaces.members.remove — the owner race', () => {
  /** A fresh space whose owners are O and D. */
  async function twoOwnerSpace(): Promise<{ spaceId: string; ownerO: string; ownerD: string }> {
    const spaceId = randomUUID();
    const ownerO = randomUUID();
    const ownerD = randomUUID();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.spaces(id, name, created_by_identity, visibility) values ($1, 'Two owners', $2, 'private')`,
        [spaceId, f.identityO]);
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values
         ($1, $3, 'member', $1, 'space'), ($2, $3, 'member', $2, 'space')`,
        [ownerO, ownerD, spaceId]);
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values
         ($1, $3, $4, 'owner', 'O'), ($2, $3, $5, 'owner', 'D')`,
        [ownerO, ownerD, spaceId, f.identityO, f.identityD]);
    });
    return { spaceId, ownerO, ownerD };
  }

  const activeOwners = async (spaceId: string): Promise<number> => (await ownerQuery<{ n: number }>(
    `select count(*)::int as n from public.members where space_id = $1 and role = 'owner' and status = 'active'`,
    [spaceId]))[0]!.n;

  /** Resolves once some backend is waiting on a lock inside remove_space_member. */
  async function untilBlockedOnLock(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const rows = await database.transaction(async (client) => (await client.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock' and query like '%remove_space_member%'`)).rows);
      if (rows[0]!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the second removal never waited on the owner lock');
  }

  it('positive: an owner removes a co-owner; the space keeps exactly one owner', async () => {
    const s = await twoOwnerSpace();
    const result = await removeMember(f.identityO, s.spaceId, s.ownerD);
    expect(result).toMatchObject({ memberId: s.ownerD, status: 'removed' });
    expect(await activeOwners(s.spaceId)).toBe(1);
    expect((await memberRow(s.ownerO))[0]!.status).toBe('active');
  });

  it('refused: mutual removal, interleaved — the second owner waits on the lock, then is refused (42501); one owner remains', async () => {
    const s = await twoOwnerSpace();
    let second: Promise<string> | undefined;
    await as(f.identityO, async (q) => {
      await q.rpc('remove_space_member', [s.spaceId, s.ownerD, cmid()]);
      // O's removal holds the owner rows, uncommitted. D's removal of O starts now.
      second = outcome(() => removeMember(f.identityD, s.spaceId, s.ownerO));
      await untilBlockedOnLock();
    });
    expect(await second).toBe('42501');
    expect(await activeOwners(s.spaceId)).toBe(1);
    expect((await memberRow(s.ownerO))[0]!.status).toBe('active');
    expect((await memberRow(s.ownerD))[0]!.status).toBe('removed');
  });

  // An end-state invariant, not a race proof: Promise.all can serialize the two
  // calls, and then the second is refused whether or not the lock exists. The
  // race is proven by the interleaved cell above, which forces the overlap.
  it('invariant: concurrent mutual removal ends with exactly one owner (end state only; the race is proven by the interleaved cell)', async () => {
    const s = await twoOwnerSpace();
    const results = await Promise.all([
      outcome(() => removeMember(f.identityO, s.spaceId, s.ownerD)),
      outcome(() => removeMember(f.identityD, s.spaceId, s.ownerO)),
    ]);
    expect(results.sort()).toEqual(['42501', 'ok']);
    expect(await activeOwners(s.spaceId)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Forcing interleavings. Every wait below is observed in pg_stat_activity /
  // pg_blocking_pids, never assumed from a sleep. The forcing device is a
  // plain row lock held open on the scratch cluster's admin connection.
  // -------------------------------------------------------------------------

  /** Admin-side reads (pg_stat_activity, pg_blocking_pids) on the 5443 scratch cluster's admin role. */
  async function adminRead<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return database.transaction(async (client) => (await client.query<T>(sql, params)).rows);
  }

  /** The poll must see OTHER roles' backends, or every wait below reads as "none". */
  async function assertStatsRole(): Promise<void> {
    const [row] = await adminRead<{ ok: boolean }>(
      `select (r.rolsuper or pg_has_role(current_user, 'pg_read_all_stats', 'member')) as ok
         from pg_roles r where r.rolname = current_user`);
    expect(row!.ok).toBe(true);
  }

  async function until(cond: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await cond()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(what);
  }

  const blockersOf = async (pid: number): Promise<number[]> =>
    (await adminRead<{ b: number[] }>('select pg_blocking_pids($1) as b', [pid]))[0]!.b;

  interface Held {
    pid: Promise<number>;
    /** The SQLSTATE `work` raised, or 'ok'; published before the commit. */
    worked: Promise<string>;
    release: () => void;
    done: Promise<void>;
    settled: () => boolean;
    /** Settled, or waiting on a lock right now. */
    parked: () => Promise<boolean>;
  }

  /** A transaction held open: `work` runs, then it commits (or rolls back if refused) on release(). */
  function held(identityId: string, work: (q: Querier) => Promise<unknown>): Held {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let publishPid!: (pid: number) => void;
    const pid = new Promise<number>((resolve) => { publishPid = resolve; });
    let publish!: (o: string) => void;
    const worked = new Promise<string>((resolve) => { publish = resolve; });
    let isSettled = false;
    void worked.then(() => { isSettled = true; });
    const done = as(identityId, async (q) => {
      publishPid((await q.query<{ pid: number }>('select pg_backend_pid() as pid'))[0]!.pid);
      const o = await outcome(() => work(q));
      publish(o);
      await gate;
      if (o !== 'ok') throw new Error(o);
    }).then(() => undefined, () => undefined);
    const settled = () => isSettled;
    const parked = async () => isSettled || (await blockersOf(await pid)).length > 0;
    return { pid, worked, release, done, settled, parked };
  }

  /** The forcing device: `select … for update` on one members row, held open until release(). */
  function holdRow(memberId: string): { pid: Promise<number>; release: () => void; done: Promise<void> } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let publishPid!: (pid: number) => void;
    const pid = new Promise<number>((resolve) => { publishPid = resolve; });
    const done = database.transaction(async (client) => {
      await client.query('select 1 from public.members where entity_id = $1 for update', [memberId]);
      publishPid((await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid);
      await gate;
    });
    return { pid, release, done };
  }

  const setRole = (q: Querier, spaceId: string, memberId: string, role: string) =>
    q.rpc('set_member_role', [spaceId, memberId, role, null, cmid()]);

  // -------------------------------------------------------------------------
  // N1: a PROMOTION between two removals. O is the only owner, D an admin.
  // O removes D; O promotes D; D, now an owner, removes O. Before the fix,
  // set_member_role locked owner rows only on demotion and remove_space_member
  // took them only for a target it had READ as an owner, so O's removal of
  // "an admin" and D's removal of O serialized on nothing: both committed and
  // the space had no owner.
  // -------------------------------------------------------------------------

  /** A fresh space whose only owner is O and whose admin is D. */
  async function ownerAndAdminSpace(): Promise<{ spaceId: string; ownerO: string; adminD: string }> {
    const spaceId = randomUUID();
    const ownerO = randomUUID();
    const adminD = randomUUID();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.spaces(id, name, created_by_identity, visibility) values ($1, 'Owner and admin', $2, 'private')`,
        [spaceId, f.identityO]);
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values
         ($1, $3, 'member', $1, 'space'), ($2, $3, 'member', $2, 'space')`,
        [ownerO, adminD, spaceId]);
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values
         ($1, $3, $4, 'owner', 'O'), ($2, $3, $5, 'admin', 'D')`,
        [ownerO, adminD, spaceId, f.identityO, f.identityD]);
    });
    return { spaceId, ownerO, adminD };
  }

  it('positive: uncontended, O promotes admin D and D then removes O; it commits and D is the one owner', async () => {
    const s = await ownerAndAdminSpace();
    await as(f.identityO, (q) => setRole(q, s.spaceId, s.adminD, 'owner'));
    expect(await removeMember(f.identityD, s.spaceId, s.ownerO)).toMatchObject({ memberId: s.ownerO, status: 'removed' });
    expect(await activeOwners(s.spaceId)).toBe(1);
    expect((await memberRow(s.adminD))[0]!).toMatchObject({ role: 'owner', status: 'active' });
  });

  it('refused: N1, forced — O removes admin D, O promotes D, D removes O; the space keeps an owner', async () => {
    await assertStatsRole();
    const s = await ownerAndAdminSpace();

    // The forcing device holds O's row. Before the fix it parks D's removal of
    // O between its owner-row lock (taken while D is an admin, so it covers O
    // alone) and its caller re-read (after the promotion commits: an owner).
    const lock = holdRow(s.ownerO);
    const lockPid = await lock.pid;

    // X: O promotes D, held open. (Fixed: it waits on O's row for the owner set.)
    const x = held(f.identityO, (q) => setRole(q, s.spaceId, s.adminD, 'owner'));
    await until(x.parked, 'the promotion neither finished nor waited');

    // B: D removes O. It waits on O's row.
    const b = held(f.identityD, (q) => q.rpc('remove_space_member', [s.spaceId, s.ownerO, cmid()]));
    b.release();
    await until(async () => (await blockersOf(await b.pid)).length > 0, "D's removal of O never waited");
    // A: O removes D. It waits — before the fix on the promotion's lock on D's row.
    const a = held(f.identityO, (q) => q.rpc('remove_space_member', [s.spaceId, s.adminD, cmid()]));
    await until(async () => (await blockersOf(await a.pid)).length > 0, "O's removal of D never waited");
    if (!x.settled()) {
      // Fixed order: all three queue on O's row behind the forcing device.
      expect(await blockersOf(await x.pid)).toContain(lockPid);
    }

    // The promotion is released to commit; O's removal then finishes or stays parked.
    x.release();
    if (x.settled()) await x.done; // before the fix it ran; now it commits
    await until(a.parked, "O's removal neither finished nor waited after the promotion");

    // The device lets go: D's removal re-reads its caller and runs until it finishes or parks.
    lock.release();
    await lock.done;
    await until(b.parked, "D's removal neither finished nor waited after the device let go");

    a.release();
    await Promise.all([x.done, a.done, b.done]);
    const outcomes = [await x.worked, await a.worked, await b.worked];
    expect(await activeOwners(s.spaceId)).toBe(1);
    expect(outcomes).not.toContain('40P01');
    // Serialized: the promotion commits, and of the two removals the second
    // finds its caller tombstoned.
    expect(outcomes.sort()).toEqual(['42501', 'ok', 'ok']);
  });

  // -------------------------------------------------------------------------
  // LOCK ORDER. All three functions lock the owner set (entity_id order)
  // first, then their own/target row. At 00c0db5e leave_space and
  // set_member_role took the row first, so each pair below deadlocked (40P01).
  // Owners A < C < B by entity_id. The device holds C: the first call locks A
  // and parks on C; the second call starts; then the device lets go. Old
  // order: the second call already held B, the first reaches for B — 40P01.
  // Fixed order: the second call parks on A behind the first — no row held.
  // -------------------------------------------------------------------------

  /** A fresh space with owners A < C < B (entity_id order): O is A, N is C, D is B. */
  async function threeOwnerSpace(): Promise<{ spaceId: string; a: string; c: string; b: string }> {
    const spaceId = randomUUID();
    const [a, c, b] = [randomUUID(), randomUUID(), randomUUID()].sort();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.spaces(id, name, created_by_identity, visibility) values ($1, 'Three owners', $2, 'private')`,
        [spaceId, f.identityO]);
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values
         ($1, $4, 'member', $1, 'space'), ($2, $4, 'member', $2, 'space'), ($3, $4, 'member', $3, 'space')`,
        [a, c, b, spaceId]);
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values
         ($1, $4, $5, 'owner', 'A'), ($2, $4, $6, 'owner', 'C'), ($3, $4, $7, 'owner', 'B')`,
        [a, c, b, spaceId, f.identityO, f.identityN, f.identityD]);
    });
    return { spaceId, a: a!, c: c!, b: b! };
  }

  type Call = [identityId: string, work: (q: Querier) => Promise<unknown>];

  async function forcedPair(s: { c: string }, first: Call, second: Call): Promise<string[]> {
    await assertStatsRole();
    const lock = holdRow(s.c);
    const lockPid = await lock.pid;
    const one = held(...first);
    one.release();
    await until(async () => (await blockersOf(await one.pid)).includes(lockPid),
      'the first call never parked on C');
    const two = held(...second);
    two.release();
    await until(async () => (await blockersOf(await two.pid)).length > 0, 'the second call never waited');
    lock.release();
    await lock.done;
    await Promise.all([one.done, two.done]);
    return [await one.worked, await two.worked];
  }

  it('lock order: leave_space(B) against remove_space_member(A removes B), forced — no 40P01; A and C stay owners', async () => {
    const s = await threeOwnerSpace();
    const outcomes = await forcedPair(s,
      [f.identityO, (q) => q.rpc('remove_space_member', [s.spaceId, s.b, cmid()])],
      [f.identityD, (q) => q.rpc('leave_space', [s.spaceId, cmid()])]);
    expect(outcomes).not.toContain('40P01');
    expect(outcomes).toEqual(['ok', 'P0002']); // B was removed first, so B's leave finds no membership
    expect(await activeOwners(s.spaceId)).toBe(2);
  });

  it('lock order: leave_space(A) against leave_space(B), forced — no 40P01; both leave, C stays owner', async () => {
    const s = await threeOwnerSpace();
    const outcomes = await forcedPair(s,
      [f.identityO, (q) => q.rpc('leave_space', [s.spaceId, cmid()])],
      [f.identityD, (q) => q.rpc('leave_space', [s.spaceId, cmid()])]);
    expect(outcomes).not.toContain('40P01');
    expect(outcomes).toEqual(['ok', 'ok']);
    expect(await activeOwners(s.spaceId)).toBe(1);
  });

  it('lock order: demote B (set_member_role) against remove_space_member(A removes B), forced — no 40P01; A and C stay owners', async () => {
    const s = await threeOwnerSpace();
    const outcomes = await forcedPair(s,
      [f.identityO, (q) => q.rpc('remove_space_member', [s.spaceId, s.b, cmid()])],
      [f.identityN, (q) => setRole(q, s.spaceId, s.b, 'admin')]);
    expect(outcomes).not.toContain('40P01');
    expect(outcomes).toEqual(['ok', 'P0002']); // B was removed first, so the demotion finds no member
    expect(await activeOwners(s.spaceId)).toBe(2);
  });

  it('lock order: demote A against demote B (set_member_role), forced — no 40P01; both demote, C stays owner', async () => {
    const s = await threeOwnerSpace();
    const outcomes = await forcedPair(s,
      [f.identityN, (q) => setRole(q, s.spaceId, s.a, 'admin')],
      [f.identityN, (q) => setRole(q, s.spaceId, s.b, 'admin')]);
    expect(outcomes).not.toContain('40P01');
    expect(outcomes).toEqual(['ok', 'ok']);
    expect(await activeOwners(s.spaceId)).toBe(1);
  });
});
