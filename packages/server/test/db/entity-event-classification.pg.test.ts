/**
 * Migration 165 — an entity event is emitted only for a change that happened.
 *
 * The capture trigger had no `WHEN` clause, so every idempotent re-upsert put a
 * full `to_jsonb(row)` on the durable log. Measured on the live node, 39% of
 * entity upserts reported that nothing at all had changed and a further 34%
 * moved only the recency columns.
 *
 * THE ONE THAT MATTERS MOST IS `versionBumpStaysAFullUpsert`. `public.entities`
 * is a spine with no content columns; a title, a body, a status all live in one
 * of 27 detail tables, and NONE of those tables has a capture trigger. What
 * they have is `internal.snapshot_entity_version`, whose entire effect on the
 * entities row is `version`, `activity_at`, `updated_at`. So folding `version`
 * into the "recency" set — which looks obviously right from the histogram, and
 * takes the claimed saving from 73% to 99.5% — would stop every rename and
 * every body edit from ever reaching a second client. Silently.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  taskId: string;
  otherId: string;
}

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const fixture = (await client.query<Fixture>(
      `select 'entity-event-classification'::text "identityId",
              internal.new_id()::text "spaceId", internal.new_id()::text "memberId",
              internal.new_id()::text "taskId",  internal.new_id()::text "otherId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Classification owner')`,
      [fixture.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Event classification',$2)`,
      [fixture.spaceId, fixture.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1), ($3,$2,'task',null,1,$1), ($4,$2,'task',null,2,$1)`,
      [fixture.memberId, fixture.spaceId, fixture.taskId, fixture.otherId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Classification owner')`,
      [fixture.memberId, fixture.spaceId, fixture.identityId],
    );
    await client.query(
      `insert into public.tasks(entity_id,title,work_status) values($1,'Original','open'),($2,'Other','open')`,
      [fixture.taskId, fixture.otherId],
    );
    return fixture;
  });
}

describe.sequential('entity event classification (migration 165)', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('entity_event_classification');
    database.apply(migrationFiles());
    fixture = await seed(database);
  }, 180_000);

  afterAll(async () => database?.destroy(), 30_000);

  /**
   * Run `mutation` as the owner and report every event it produced for the
   * probe entity, newest last. Each call starts from the current high-water
   * mark so the buckets cannot bleed into one another.
   */
  async function emitted(mutation: string, params: readonly unknown[] = []): Promise<
    { type: string; payload: Record<string, unknown> }[]
  > {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const mark = (await client.query<{ seq: string | null }>(
        `select max(seq)::text seq from public.workspace_events where space_id = $1`,
        [fixture.spaceId],
      )).rows[0]!.seq ?? '0';
      await client.query(mutation, [...params]);
      const rows = (await client.query<{ event_type: string; payload: Record<string, unknown> }>(
        `select event_type, payload from public.workspace_events
          where space_id = $1 and seq > $2::bigint and (payload->>'id')::uuid = $3
          order by seq`,
        [fixture.spaceId, mark, fixture.taskId],
      )).rows;
      return rows.map((r) => ({ type: r.event_type, payload: r.payload }));
    });
  }

  it('emits NOTHING for an UPDATE that writes identical values', async () => {
    // 39% of every entity upsert on the live node was exactly this shape.
    expect(await emitted(
      `update public.entities set version = version where id = $1`, [fixture.taskId],
    )).toEqual([]);
  });

  it('emits NOTHING when only updated_at moved', async () => {
    expect(await emitted(
      `update public.entities set updated_at = now() where id = $1`, [fixture.taskId],
    )).toEqual([]);
  });

  it('emits a THIN entity.activity_touched when only the recency hint moved', async () => {
    const events = await emitted(
      `update public.entities set activity_at = now() where id = $1`, [fixture.taskId],
    );
    expect(events.map((e) => e.type)).toEqual(['entity.activity_touched']);
    // The point of the event is what it does NOT carry. A full row payload here
    // would restore every byte this migration removed.
    expect(Object.keys(events[0]!.payload).sort()).toEqual(['activity_at', 'id', 'kind']);
    expect(events[0]!.payload['kind']).toBe('task');
  });

  /** The same shape an edge write produces, through the real trigger. */
  it('an edge write produces a thin touch, not a full snapshot', async () => {
    const events = await emitted(
      `insert into public.edges(space_id,src_id,dst_id,type,created_by)
       values($1,$2,$3,'relates_to',$4)`,
      [fixture.spaceId, fixture.taskId, fixture.otherId, fixture.memberId],
    );
    expect(events.map((e) => e.type)).toEqual(['entity.activity_touched']);
  });

  /**
   * THE REGRESSION GUARD. A detail-table content edit reaches the log ONLY as a
   * version bump on the spine. If this goes red because someone added
   * `version` to the recency set, the visible symptom in the product is that
   * renaming a task stops updating anyone else's screen.
   */
  it('a title rename through the detail table stays a FULL entity.upsert', async () => {
    const events = await emitted(
      `update public.tasks set title = 'Renamed' where entity_id = $1`, [fixture.taskId],
    );
    expect(events.map((e) => e.type)).toEqual(['entity.upsert']);
    // Full row payload, exactly as before this migration.
    expect(Object.keys(events[0]!.payload)).toContain('space_id');
    expect(Object.keys(events[0]!.payload)).toContain('created_by');
  });

  /**
   * A status change emits TWO full upserts and that is PRE-EXISTING, not
   * something this migration introduced: `entities_status_from_state` writes
   * `status_id`/`status_category` onto the spine and `snapshot_entity_version`
   * then bumps `version`, and they are separate statements. Pinned at two so
   * that folding them is a deliberate change with a red test to justify it —
   * and, more importantly, so that neither one can quietly become a thin touch.
   */
  it('a status change stays FULL entity.upserts, never a touch', async () => {
    const events = await emitted(
      `update public.tasks set work_status = 'working' where entity_id = $1`, [fixture.taskId],
    );
    expect(events.map((e) => e.type)).toEqual(['entity.upsert', 'entity.upsert']);
  });

  it('a move (parent/position) stays a FULL entity.upsert', async () => {
    const events = await emitted(
      `update public.entities set position = position + 1, updated_at = now(), activity_at = now()
        where id = $1`,
      [fixture.taskId],
    );
    expect(events.map((e) => e.type)).toEqual(['entity.upsert']);
  });

  it('a soft delete stays entity.deleted, not a touch', async () => {
    const events = await emitted(
      `update public.entities set deleted_at = now() where id = $1`, [fixture.taskId],
    );
    expect(events.map((e) => e.type)).toEqual(['entity.deleted']);
  });

  it('INSERT and hard DELETE still emit through the split trigger', async () => {
    const created = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'task',null,9,$3)`,
        [id, fixture.spaceId, fixture.memberId],
      );
      await client.query(
        `insert into public.tasks(entity_id,title,work_status) values($1,'Ephemeral','open')`, [id]);
      const after = (await client.query<{ event_type: string }>(
        `select event_type from public.workspace_events
          where space_id = $1 and (payload->>'id')::uuid = $2 order by seq`,
        [fixture.spaceId, id],
      )).rows.map((r) => r.event_type);
      await client.query(`delete from public.entities where id = $1`, [id]);
      const withDelete = (await client.query<{ event_type: string }>(
        `select event_type from public.workspace_events
          where space_id = $1 and (payload->>'id')::uuid = $2 order by seq`,
        [fixture.spaceId, id],
      )).rows.map((r) => r.event_type);
      return { after, withDelete };
    });
    expect(created.after).toEqual(['entity.upsert']);
    expect(created.withDelete).toEqual(['entity.upsert', 'entity.deleted']);
  });

  /**
   * The guard itself. Losing the `WHEN` clause is invisible in behaviour terms
   * — everything above still passes on the strength of the in-function check —
   * so it is asserted directly.
   */
  it('the UPDATE half carries its WHEN guard and the undivided trigger is gone', async () => {
    const triggers = await database.transaction(async (client) => (
      await client.query<{ tgname: string; guarded: boolean }>(
        `select tgname, tgqual is not null guarded from pg_trigger
          where tgrelid = 'public.entities'::regclass and not tgisinternal
            and tgname like 'entities_capture_event%' order by tgname`,
      )).rows);
    expect(triggers).toEqual([
      { tgname: 'entities_capture_event_ins_del', guarded: false },
      { tgname: 'entities_capture_event_upd', guarded: true },
    ]);
  });
});
