/**
 * 204 — `workspace_events.subject_ids`, its online backfill, and the
 * `index_incomplete` gate (change-feed spec doc 01a0cf35, §4 Storage, §5, §6.5).
 *
 * The chain is applied in TWO parts on purpose: everything before 204, then a
 * seeded log written with no `subject_ids` column at all, then 204. That is the
 * state a live node is in when it upgrades, and it is the only way to test the
 * backfill against rows 204 did not write.
 */
import { randomUUID } from 'node:crypto';
import { type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isCollabError } from '@tm8/contract';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { createTestDb, type TestDb } from './pg-harness.js';
import {
  assertIndexCovers,
  gateSubjectIndex,
  INDEX_INCOMPLETE,
  minCoveredAfter,
  readIndexedFrom,
} from '../../src/events/subject-index.js';
import {
  runEventSubjectBackfillStep,
  runEventSubjectBackfillTick,
} from '../../src/scheduler/jobs/event-subject-backfill.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const MIGRATION = '204_workspace_event_subject_ids.sql';
/** Rows seeded before 204, so the backfill has several batches to do. */
const SEEDED = 1_200;

describe.sequential('204 — subject_ids, the online backfill, and the index gate', () => {
  let database: W1ScratchDatabase;
  let db: TestDb;
  let spaceId: string;
  let memberId: string;
  let seededMax: number;
  const identityId = `identity_${randomUUID()}`;
  const claims = () => ({ identityId, nodeAdmin: true, requestId: `req_${randomUUID()}` });

  async function ownerRows<R extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return database.query<R>(sql, params);
  }

  const watermarkRow = async () =>
    (await ownerRows<{ indexed_from: string; completed_at: Date | null }>(
      `select indexed_from::text, completed_at from internal.event_subject_index where space_id = $1`,
      [spaceId],
    ))[0];

  const nullCount = async () =>
    Number((await ownerRows<{ n: string }>(
      `select count(*)::text n from public.workspace_events where space_id = $1 and subject_ids is null`,
      [spaceId],
    ))[0]!.n);

  /** The invariant the watermark promises, checked against the table itself. */
  const invariantHolds = async (): Promise<boolean> => {
    const indexedFrom = await readIndexedFrom(db, claims(), spaceId);
    const rows = await ownerRows<{ n: string }>(
      `select count(*)::text n from public.workspace_events
        where space_id = $1 and seq >= $2 and subject_ids is null`,
      [spaceId, indexedFrom],
    );
    return rows[0]!.n === '0';
  };

  /** Insert one raw row as the owner, exactly as an RPC-authored event would. */
  async function insertRaw(eventType: string, payload: Record<string, unknown>): Promise<string[] | null> {
    const rows = await ownerRows<{ subject_ids: string[] | null }>(
      `insert into public.workspace_events(space_id, seq, event_type, payload)
       values ($1, internal.next_event_seq($1), $2, $3::jsonb)
       returning subject_ids::text[] as subject_ids`,
      [spaceId, eventType, JSON.stringify(payload)],
    );
    return rows[0]!.subject_ids;
  }

  beforeAll(async () => {
    database = await createW1ScratchDatabase('subject_ids_204');
    const chain = migrationFiles();
    const at = chain.indexOf(MIGRATION);
    expect(at, `${MIGRATION} is not in the chain`).toBeGreaterThan(0);
    database.apply(chain.slice(0, at));

    db = createTestDb(database.url);
    await db.rpc({ identityId }, 'public.upsert_user_profile', ['Subject Index Test', null, null]);
    const created = await db.rpc<{ space: { id: string } }>({ identityId }, 'public.create_space', [
      'subject index space', 'backfill proof', 'private', null, null,
    ]);
    spaceId = created.space.id;
    memberId = (await db.query<{ entity_id: string }>(
      { identityId },
      'select entity_id from public.members where space_id = $1 and identity_id = $2',
      [spaceId, identityId],
    ))[0]!.entity_id;

    // A log written before 204 existed: real captures from the space's
    // creation, plus a bulk of synthetic rows of mixed types.
    await ownerRows(
      `insert into public.workspace_events(space_id, seq, event_type, payload)
       select $1, internal.next_event_seq($1),
              case i % 3 when 0 then 'entity.upsert' when 1 then 'edge.upsert' else 'handoff.created' end,
              jsonb_build_object('id', gen_random_uuid(), 'src_id', gen_random_uuid(), 'dst_id', gen_random_uuid())
         from generate_series(1, $2::int) i`,
      [spaceId, SEEDED],
    );
    seededMax = Number((await ownerRows<{ m: string }>(
      `select max(seq)::text m from public.workspace_events where space_id = $1`, [spaceId],
    ))[0]!.m);

    database.apply([MIGRATION]);
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await database?.destroy();
  }, 120_000);

  it('leaves every pre-204 row NULL and puts the watermark just above them', async () => {
    expect(await nullCount()).toBeGreaterThanOrEqual(SEEDED);
    const row = await watermarkRow();
    expect(Number(row!.indexed_from)).toBe(seededMax + 1);
    expect(row!.completed_at).toBeNull();
    expect(await readIndexedFrom(db, claims(), spaceId)).toBe(seededMax + 1);
    expect(await invariantHolds()).toBe(true);
  });

  it('the trigger fills subject_ids for every event type, and never leaves NULL', async () => {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    const sorted = (xs: string[]) => [...xs].sort();

    expect(await insertRaw('entity.upsert', { id: a })).toEqual([a]);
    expect(await insertRaw('entity.deleted', { id: a })).toEqual([a]);
    expect(await insertRaw('entity.activity_touched', { id: a, kind: 'task' })).toEqual([a]);
    expect(await insertRaw('edge.upsert', { id: c, src_id: a, dst_id: b })).toEqual(sorted([a, b]));
    expect(await insertRaw('edge.deleted', { id: c, src_id: a, dst_id: b })).toEqual(sorted([a, b]));
    expect(await insertRaw('message.created', { entity_id: a, anchor_id: b })).toEqual(sorted([a, b]));
    expect(await insertRaw('message.updated', { entity_id: a, anchor_id: b })).toEqual(sorted([a, b]));
    expect(await insertRaw('message.deleted', { entity_id: a, anchor_id: b })).toEqual(sorted([a, b]));
    expect(await insertRaw('activity.created', { id: c, entity_id: a, actor_id: b })).toEqual([a]);
    expect(await insertRaw('notification.created', { id: c, target_entity_id: a, actor_id: b })).toEqual([a]);
    expect(await insertRaw('notification.read', { id: c, target_entity_id: a })).toEqual([a]);
    expect(await insertRaw('git.commit_recorded', { type: 'git.commit_recorded', commitEntityId: a })).toEqual([a]);
    expect(await insertRaw('git.pr_state_changed', { type: 'git.pr_state_changed', prEntityId: a })).toEqual([a]);
    expect(await insertRaw('git.worktree_status_changed', { worktreeEntityId: a, projectId: b })).toEqual([a]);
    // An edge to itself names the entity once.
    expect(await insertRaw('edge.upsert', { id: c, src_id: a, dst_id: a })).toEqual([a]);
    // About nothing is '{}', never NULL — NULL is reserved for "not indexed".
    expect(await insertRaw('counter.changed', { entity_id: a })).toEqual([]);
    expect(await insertRaw('handoff.created', { whatever: a })).toEqual([]);
    expect(await insertRaw('activity.created', { id: c, entity_id: null })).toEqual([]);
    expect(await insertRaw('entity.upsert', { id: 'not-a-uuid' })).toEqual([]);
  });

  it('the real capture path fills it too: a task, an edge and a message written by RPCs', async () => {
    const before = seededMax;
    const task = await db.rpc<{ entity: { id: string } }>(claims(), 'public.create_task', [
      spaceId, 'subject task', memberId, '',
      null, null, null, 'medium', null, null, null, null, null, 'attached_to', `cmid_${randomUUID()}`,
    ]);
    const other = await db.rpc<{ entity: { id: string } }>(claims(), 'public.create_task', [
      spaceId, 'subject other', memberId, '',
      null, null, null, 'medium', null, null, null, null, null, 'attached_to', `cmid_${randomUUID()}`,
    ]);
    await db.rpc(claims(), 'public.write_edge', [task.entity.id, other.entity.id, 'depends_on', null, memberId, `cmid_${randomUUID()}`]);
    // The door `messages.post` uses (the old `post_message` is no longer granted).
    await db.query(
      claims(),
      `select public.w2_post_message_batch($1::uuid[], $2::text, null::uuid, '{}'::uuid[], '{}'::uuid[],
              null::uuid, $3::uuid, $4::text, null::text, null::uuid)`,
      [[task.entity.id], 'hello subjects', memberId, `cmid_${randomUUID()}`],
    );

    const rows = await ownerRows<{ event_type: string; subject_ids: string[] | null; payload: Record<string, unknown> }>(
      `select event_type, subject_ids::text[] subject_ids, payload
         from public.workspace_events where space_id = $1 and seq > $2 order by seq`,
      [spaceId, before],
    );
    expect(rows.every((r) => r.subject_ids !== null), 'a post-204 row was written with NULL subject_ids').toBe(true);

    const types = new Set(rows.map((r) => r.event_type));
    for (const t of ['entity.upsert', 'edge.upsert', 'message.created', 'activity.created']) {
      expect(types, `fixture produced no ${t}`).toContain(t);
    }
    const edge = rows.find((r) => r.event_type === 'edge.upsert' && r.payload['type'] === 'depends_on')!;
    expect(edge.subject_ids).toEqual([task.entity.id, other.entity.id].sort());
    const message = rows.find((r) => r.event_type === 'message.created' && r.payload['body'] === 'hello subjects')!;
    expect(message.subject_ids).toContain(task.entity.id);
    expect(message.subject_ids).toContain(message.payload['entity_id']);
  });

  it('the GIN index serves an overlap query', async () => {
    const plan = await database.transaction(async (client) => {
      await client.query('set local enable_seqscan = off');
      const r = await client.query<{ 'QUERY PLAN': string }>(
        `explain select seq from public.workspace_events where subject_ids && array[$1::uuid]`,
        [randomUUID()],
      );
      return r.rows.map((x) => x['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('workspace_events_subject_ids_gin_idx');
  });

  it('the gate refuses a window below the watermark and names the covered cursor', async () => {
    const indexedFrom = await readIndexedFrom(db, claims(), spaceId);
    expect(indexedFrom).toBe(seededMax + 1);

    await expect(gateSubjectIndex(db, claims(), spaceId, 0)).rejects.toSatisfy((e: unknown) => {
      if (!isCollabError(e)) return false;
      const details = e.details as { reason: string; indexedFrom: number; hint: string };
      return details.reason === INDEX_INCOMPLETE
        && details.indexedFrom === indexedFrom
        && details.hint === `retry with --after ${String(indexedFrom - 1)}, or tm8 event list`;
    });
    // One below the covered cursor is refused; the covered cursor itself passes.
    expect(() => { assertIndexCovers(indexedFrom - 2, indexedFrom); }).toThrow();
    await expect(gateSubjectIndex(db, claims(), spaceId, minCoveredAfter(indexedFrom))).resolves.toEqual({ indexedFrom });
  });

  it('the backfill door is node-admin only', async () => {
    await expect(
      db.rpc({ identityId, nodeAdmin: false }, 'public.backfill_event_subject_ids', [10]),
    ).rejects.toThrow(/node admin/);
  });

  it('backfills in batches, survives an interrupted batch, and lowers the watermark monotonically', async () => {
    const batch = 250;
    const first = await runEventSubjectBackfillStep(db, claims(), batch);
    expect(first.spaceId).toBe(spaceId);
    expect(first.updated).toBe(batch);
    const afterFirst = await readIndexedFrom(db, claims(), spaceId);
    expect(afterFirst).toBeLessThan(seededMax + 1);
    expect(await invariantHolds()).toBe(true);

    // Partially backfilled: a window reaching below the watermark is still refused.
    await expect(gateSubjectIndex(db, claims(), spaceId, 0)).rejects.toSatisfy(
      (e: unknown) => isCollabError(e) && (e.details as { reason: string }).reason === INDEX_INCOMPLETE,
    );

    // INTERRUPTION: a batch that dies mid-transaction leaves nothing behind.
    await database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id', $1, true), set_config('tm8.node_admin', 'true', true)`,
        [identityId],
      );
      await client.query('select public.backfill_event_subject_ids(250)');
      throw new Error('simulated crash');
    }).catch((e: unknown) => {
      if (!(e instanceof Error) || e.message !== 'simulated crash') throw e;
    });
    expect(await readIndexedFrom(db, claims(), spaceId)).toBe(afterFirst);
    expect(await invariantHolds()).toBe(true);

    // Resume to completion, one batch per call.
    let previous = afterFirst;
    let calls = 0;
    for (;;) {
      const step = await runEventSubjectBackfillStep(db, claims(), batch);
      calls += 1;
      const now = await readIndexedFrom(db, claims(), spaceId);
      expect(now, 'the watermark rose').toBeLessThanOrEqual(previous);
      expect(await invariantHolds()).toBe(true);
      previous = now;
      if (step.done) break;
      expect(calls).toBeLessThan(50);
    }
    expect(calls).toBeGreaterThan(2);
    expect(await nullCount()).toBe(0);
    expect(await readIndexedFrom(db, claims(), spaceId)).toBe(1);
    expect((await watermarkRow())!.completed_at).not.toBeNull();

    // The same request that was refused now succeeds.
    await expect(gateSubjectIndex(db, claims(), spaceId, 0)).resolves.toEqual({ indexedFrom: 1 });

    // A finished backfill makes the tick a no-op.
    await expect(runEventSubjectBackfillTick({ db, claims: () => Promise.resolve(claims()) })).resolves.toEqual({
      skipped: true, reason: 'every space is indexed',
    });
  });

  it('the backfilled values equal what the trigger would have written', async () => {
    const mismatched = await ownerRows<{ n: string }>(
      `select count(*)::text n from public.workspace_events
        where space_id = $1 and subject_ids is distinct from internal.event_subject_ids(event_type, payload)`,
      [spaceId],
    );
    expect(mismatched[0]!.n).toBe('0');
  });

  it('re-applying 204 is safe: no error, no rows touched, the watermark stays put', async () => {
    const before = await ownerRows<{ n: string; s: string }>(
      `select count(*)::text n, coalesce(sum(cardinality(subject_ids)), 0)::text s
         from public.workspace_events where space_id = $1`,
      [spaceId],
    );
    database.apply([MIGRATION]);
    const after = await ownerRows<{ n: string; s: string }>(
      `select count(*)::text n, coalesce(sum(cardinality(subject_ids)), 0)::text s
         from public.workspace_events where space_id = $1`,
      [spaceId],
    );
    expect(after).toEqual(before);
    expect(await readIndexedFrom(db, claims(), spaceId)).toBe(1);
    expect((await watermarkRow())!.completed_at).not.toBeNull();
    const triggers = await ownerRows<{ n: string }>(
      `select count(*)::text n from pg_trigger
        where tgrelid = 'public.workspace_events'::regclass and tgname = 'workspace_events_fill_subject_ids'`,
    );
    expect(triggers[0]!.n).toBe('1');
  });

  it('a space created after 204 has no backfill row and reads as fully indexed', async () => {
    const fresh = await db.rpc<{ space: { id: string } }>({ identityId }, 'public.create_space', [
      'post-204 space', '', 'private', null, null,
    ]);
    expect(await readIndexedFrom(db, claims(), fresh.space.id)).toBe(1);
    const nulls = await ownerRows<{ n: string }>(
      `select count(*)::text n from public.workspace_events where space_id = $1 and subject_ids is null`,
      [fresh.space.id],
    );
    expect(nulls[0]!.n).toBe('0');
  });
});
