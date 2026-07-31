/**
 * badges.staleness — the derived staleness badge (056 + entity-read.ts).
 *
 * Every assertion is a red/green pair over the derivation rules in design
 * §3.3: absence means UNFLAGGED (never "verified"), each reason fires on its
 * own mark, precedence ORDERS the reasons array without hiding any, and an
 * answered dispute reopens the moment the target's content moves past the
 * version the verification pinned.
 */
import { EntityStalenessSchema } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Querier } from '../../src/db/types.js';
import { loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  otherMemberId: string;
  taskId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (await client.query<Fixture>(
      `select 'mem-staleness-owner'::text "identityId",
              internal.new_id()::text "spaceId", internal.new_id()::text "memberId",
              internal.new_id()::text "otherMemberId", internal.new_id()::text "taskId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Staleness owner'),('mem-staleness-other','Other')`,
      [f.identityId],
    );
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Staleness',$2)`,
      [f.spaceId, f.identityId]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$3,'member',null,0,$1),($2,$3,'member',null,1,$2),($4,$3,'task',null,10,$1)`,
      [f.memberId, f.otherMemberId, f.spaceId, f.taskId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name) values
       ($1,$3,$4,'owner','Staleness owner'),($2,$3,'mem-staleness-other','member','Other')`,
      [f.memberId, f.otherMemberId, f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.tasks(entity_id,title,work_status,priority) values($1,'basis task','open','medium')`,
      [f.taskId],
    );
    return f;
  });
}

/** A memory entity + detail row, created directly as the graph owner. */
async function mintMemory(statement: string, createdBy?: string): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'memory',null,0,$3)`,
      [id, fixture.spaceId, createdBy ?? fixture.memberId],
    );
    await client.query(
      `insert into public.memories(entity_id,statement,mechanism,subject_scope,does_not_establish)
       values($1,$2,'direct seed','this scratch database','runtime behavior')`,
      [id, statement],
    );
    return id;
  });
}

async function drawEdge(src: string, dst: string, type: string, props: Record<string, unknown>): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return (await client.query<{ id: string }>(
      `insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
       values($1,$2,$3,$4,$5,$6) returning id::text`,
      [fixture.spaceId, src, dst, type, JSON.stringify(props), fixture.memberId],
    )).rows[0]!.id;
  });
}

async function ownerSql(sql: string, params: readonly unknown[] = []): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(sql, [...params]);
  });
}

/** Read one summary through the REAL assembler (owner connection; RLS is not under test here). */
async function summaryOf(id: string) {
  return database.transaction(async (client) => {
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
        (await client.query(sql, [...params])).rows as R[],
      rpc: async () => { throw new Error('reads only'); },
    };
    const summaries = await loadEntitySummariesByIds(q, [id], fixture.identityId);
    expect(summaries).toHaveLength(1);
    return summaries[0]!;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('memory_staleness');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
});

describe('badges.staleness derivation', () => {
  it('an unmarked memory is UNFLAGGED: no staleness badge, typed state, derived title', async () => {
    const id = await mintMemory('unmarked claim about the basis task');
    const summary = await summaryOf(id);
    expect(summary.badges.staleness).toBeUndefined();
    expect(summary.title).toBe('unmarked claim about the basis task');
    expect(summary.excerpt).toBe('unmarked claim about the basis task');
    expect(summary.state).toMatchObject({
      kind: 'memory',
      mechanism: 'direct seed',
      subjectScope: 'this scratch database',
      doesNotEstablish: 'runtime behavior',
      measuredAt: null,
    });
  });

  it('basisMoved fires when the pinned target version advances — and not before', async () => {
    const id = await mintMemory('pinned claim');
    await drawEdge(id, fixture.taskId, 'based_on', { pinnedVersion: 1, pinnedAt: '2026-07-31T00:00:00Z' });

    const fresh = await summaryOf(id);
    expect(fresh.badges.staleness).toBeUndefined();

    await ownerSql(`update public.entities set version = version + 1 where id = $1`, [fixture.taskId]);
    const drifted = await summaryOf(id);
    expect(drifted.badges.staleness?.reasons).toEqual(['basisMoved']);
    expect(drifted.badges.staleness?.basisMoved).toEqual({ count: 1 });
    expect(EntityStalenessSchema.safeParse(drifted.badges.staleness).success).toBe(true);

    // restore for the suites below
    await ownerSql(`update public.entities set version = version - 1 where id = $1`, [fixture.taskId]);
  });

  it('basisDeleted fires on a soft-deleted basis and outranks basisMoved in display order', async () => {
    const id = await mintMemory('claim on a doomed basis');
    const doomed = await mintMemory('the doomed basis');
    await drawEdge(id, doomed, 'based_on', { pinnedVersion: 1, pinnedAt: '2026-07-31T00:00:00Z' });
    await ownerSql(
      `update public.entities set deleted_at = now(), version = version + 1 where id = $1`,
      [doomed],
    );
    const summary = await summaryOf(id);
    // The delete bumped the version too — BOTH reasons fire, deleted first.
    expect(summary.badges.staleness?.reasons).toEqual(['basisDeleted', 'basisMoved']);
    expect(summary.badges.staleness?.basisDeleted).toEqual({ count: 1 });
  });

  it('disputed opens on a dispute, closes on a current-version answer, and REOPENS when the content moves', async () => {
    const target = await mintMemory('disputed claim');
    const evidence = await mintMemory('disputing evidence', fixture.otherMemberId);
    const disputeEdge = await drawEdge(evidence, target, 'disputes', {
      quote: 'claim', expected: 'x', observed: 'y', pinnedVersion: 1,
    });

    const open = await summaryOf(target);
    expect(open.badges.staleness?.reasons).toEqual(['disputed']);
    expect(open.badges.staleness?.disputed?.openCount).toBe(1);
    // A dispute alone is not a verification: the field must be absent.
    expect(open.badges.staleness?.verified).toBeUndefined();

    const verifier = await mintMemory('verifying evidence', fixture.otherMemberId);
    await drawEdge(verifier, target, 'verifies', {
      mechanism: 're-measured', answers: [disputeEdge], pinnedVersion: 1, independenceBasis: 'actor',
    });
    const answered = await summaryOf(target);
    // Answered and nothing else wrong ⇒ UNFLAGGED. Absence of the badge is the
    // design's rule: reasons:[] is never emitted, even with a verification.
    expect(answered.badges.staleness).toBeUndefined();

    // The claim's content moves on — the old clear stops clearing.
    await ownerSql(`update public.entities set version = version + 1 where id = $1`, [target]);
    const reopened = await summaryOf(target);
    expect(reopened.badges.staleness?.reasons).toEqual(['disputed']);
    expect(reopened.badges.staleness?.verified).toMatchObject({ atVersion: 1, current: false, independenceBasis: 'actor' });
  });

  it('superseded resolves the chain head, wins display precedence, and stacks with other reasons', async () => {
    const first = await mintMemory('first claim');
    const second = await mintMemory('second claim');
    const third = await mintMemory('third claim');
    await drawEdge(second, first, 'supersedes', { reason: 'remeasured' });
    await drawEdge(third, second, 'supersedes', { reason: 'remeasured again' });
    // Pile a dispute and a drifted pin onto the superseded one.
    const evidence = await mintMemory('pile-on evidence', fixture.otherMemberId);
    await drawEdge(evidence, first, 'disputes', { quote: 'q', expected: 'e', observed: 'o', pinnedVersion: 1 });
    await drawEdge(first, fixture.taskId, 'based_on', { pinnedVersion: 1, pinnedAt: '2026-07-31T00:00:00Z' });
    await ownerSql(`update public.entities set version = version + 1 where id = $1`, [fixture.taskId]);

    const summary = await summaryOf(first);
    expect(summary.badges.staleness?.reasons).toEqual(['superseded', 'disputed', 'basisMoved']);
    expect(summary.badges.staleness?.superseded).toEqual({
      byId: second, headId: third, depthTruncated: false,
    });
    expect(EntityStalenessSchema.safeParse(summary.badges.staleness).success).toBe(true);

    await ownerSql(`update public.entities set version = version - 1 where id = $1`, [fixture.taskId]);
  });
});
