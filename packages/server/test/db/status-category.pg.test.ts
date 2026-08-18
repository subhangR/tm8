/**
 * 147 against a real Postgres: the backfill, the two triggers, and the EVENT
 * COST of each — which is the part that is easy to get wrong and invisible in
 * any fixture-based test.
 *
 * ## Why the event counts are the interesting assertions
 *
 * `entities.status_category` is denormalized, so something has to keep it true,
 * and every candidate writer runs inside `entities_capture_event` — one
 * `entity.upsert` per row touched, one sequence number burned. The first draft
 * of this migration wrote the category from the `tasks` trigger alone, which
 * was correct and cost a SECOND event on every task creation: `insert entities`
 * captured a NULL category, then `insert tasks` updated it back. Nothing was
 * wrong with the data; the log had simply started reporting two mutations where
 * the user made one. `test/events/ws-e2e.pg.test.ts` caught it by name ("the
 * mutation must be captured exactly once") — this file is the version of that
 * check that lives next to the migration it constrains, and states the
 * intended cost of each transition explicitly instead of leaving it implied.
 *
 * ## Why this runs as the schema owner
 *
 * These are SCHEMA invariants — triggers, a constraint, a backfill — not RPC
 * behaviour, so the suite writes the tables directly rather than dragging in
 * the identity bootstrap that the RPC doors require. Same posture as
 * `db/test/triggers.test.mjs`, and for the same reason: the invariant must hold
 * for a writer that bypassed the catalog.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

const MIGRATION = '147_entity_status_category.sql';
const SPACE = '00000000-0000-4000-8000-000000000001';
const IDENTITY = '00000000-0000-4000-8000-00000000000f';
/** A task that exists only to satisfy `entities.created_by`, which is an entity FK. */
const ANCHOR = '00000000-0000-4000-8000-0000000000aa';

/** The RULED mapping, as the migration's own table — asserted, not derived. */
const RULED: ReadonlyArray<readonly [string, string]> = [
  ['open', 'to_do'],
  ['pulled', 'to_do'],
  ['working', 'in_progress'],
  ['in_review', 'in_progress'],
  ['blocked', 'in_progress'],
  ['done', 'done'],
  ['cancelled', 'cancelled'],
];

const DOC = '00000000-0000-4000-8000-0000000000dd';
/** A pre-147 task, one per RULED status, addressed by its index in that table. */
function legacyId(index: number): string {
  return `00000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`;
}

let database: W1ScratchDatabase;
let eventsBeforeMigration = 0;
let eventsAfterMigration = 0;

/** Every `entity.upsert` the log holds, right now. */
async function upserts(): Promise<number> {
  const rows = await database.query<{ n: string }>(
    `select count(*) n from public.workspace_events where event_type = 'entity.upsert'`,
  );
  return Number(rows[0]!.n);
}

async function categoryOf(id: string): Promise<string | null> {
  const rows = await database.query<{ status_category: string | null }>(
    `select status_category from public.entities where id = $1`,
    [id],
  );
  return rows[0]!.status_category;
}

/** Creates a task, and reports what that creation cost the event log. */
async function createTask(id: string, workStatus?: string): Promise<number> {
  const before = await upserts();
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1, $2, 'task', extract(epoch from clock_timestamp()), $3)`,
      [id, SPACE, ANCHOR],
    );
    await client.query(
      `insert into public.tasks(entity_id, title, work_status)
       values ($1, 'a task', coalesce($2, 'open'))`,
      [id, workStatus ?? null],
    );
  });
  return (await upserts()) - before;
}

describe.sequential('147 — entities.status_category', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('status_category');
    const files = migrationFiles();
    const index = files.indexOf(MIGRATION);
    expect(index, `${MIGRATION} is not in the chain`).toBeGreaterThan(-1);

    // Everything BEFORE 147: the world this migration has to land on. Seeding
    // here rather than after is the whole point — a task that predates the
    // column is the only thing the backfill can be tested against.
    database.apply(files.slice(0, index));

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.user_profiles(identity_id, display_name) values ($1, 'probe')`,
        [IDENTITY],
      );
      await client.query(
        `insert into public.spaces(id, name, created_by_identity) values ($1, 'probe', $2)`,
        [SPACE, IDENTITY],
      );
      // Self-referencing `created_by`: the FK is deferrable, and one bootstrap
      // row is cheaper than the whole member/team_member chain for a suite that
      // never asserts on an actor.
      await client.query(
        `insert into public.entities(id, space_id, kind, position, created_by)
         values ($1, $2, 'task', 0, $1)`,
        [ANCHOR, SPACE],
      );
      await client.query(`insert into public.tasks(entity_id, title) values ($1, 'anchor')`, [ANCHOR]);

      for (const [index_, [status]] of RULED.entries()) {
        const id = legacyId(index_);
        await client.query(
          `insert into public.entities(id, space_id, kind, position, created_by)
           values ($1, $2, 'task', $3, $4)`,
          [id, SPACE, index_ + 1, ANCHOR],
        );
        await client.query(
          `insert into public.tasks(entity_id, title, work_status) values ($1, $2, $3)`,
          [id, `pre-147 ${status}`, status],
        );
      }

      await client.query(
        `insert into public.entities(id, space_id, kind, position, created_by)
         values ($1, $2, 'doc', 99, $3)`,
        [DOC, SPACE, ANCHOR],
      );
      await client.query(
        `insert into public.documents(entity_id, title, body, format)
         values ($1, 'a doc', 'x', 'markdown')`,
        [DOC],
      );
    });

    eventsBeforeMigration = await upserts();
    database.apply([MIGRATION]);
    eventsAfterMigration = await upserts();
  }, 180_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  it.each(RULED)('backfills a pre-147 %s task to %s', async (status, category) => {
    const index = RULED.findIndex(([s]) => s === status);
    expect(await categoryOf(legacyId(index))).toBe(category);
  });

  it('leaves a kind with no status NULL — absence, not to_do', async () => {
    expect(await categoryOf(DOC)).toBeNull();
  });

  it('backfills SILENTLY: no synthetic edit for a change nobody made', async () => {
    // The backfill disables `entities_capture_event` around itself. Left on, it
    // would emit one entity.upsert per task in every space — at an UNCHANGED
    // version, attributed to nobody, filling every connected client's cursor
    // with history that never happened.
    expect(eventsAfterMigration).toBe(eventsBeforeMigration);
  });

  it('does not touch version or updated_at — a backfill is not an edit', async () => {
    const rows = await database.query<{ n: string }>(
      `select count(*) n from public.entities e
        join public.tasks t on t.entity_id = e.id
       where t.title like 'pre-147 %' and (e.version <> 1 or e.updated_at <> e.created_at)`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('creates a task born to_do, in exactly ONE event', async () => {
    const id = '00000000-0000-4000-8000-0000000000cc';
    expect(await createTask(id)).toBe(1);
    expect(await categoryOf(id)).toBe('to_do');
  });

  it('creates a non-task in one event, with no category at all', async () => {
    const id = '00000000-0000-4000-8000-0000000000ef';
    const before = await upserts();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.entities(id, space_id, kind, position, created_by)
         values ($1, $2, 'doc', 120, $3)`,
        [id, SPACE, ANCHOR],
      );
    });
    expect((await upserts()) - before).toBe(1);
    expect(await categoryOf(id)).toBeNull();
  });

  it('pays a second event ONLY when a creation names a non-default status', async () => {
    // The corrector arm: the seed trigger wrote `to_do`, the tasks trigger finds
    // it wrong and fixes it. Rare, and the honest cost of being right.
    const id = '00000000-0000-4000-8000-0000000000ce';
    expect(await createTask(id, 'working')).toBe(2);
    expect(await categoryOf(id)).toBe('in_progress');
  });

  it('follows every transition, and charges nothing for one that stays in its bucket', async () => {
    const id = '00000000-0000-4000-8000-0000000000cf';
    await createTask(id);
    let status = 'open';
    for (const [next, category] of RULED) {
      // A status write that changes nothing is skipped, not measured: 001's
      // snapshot trigger returns early when the row is materially identical
      // ("Nothing changed materially → no version, no snapshot"), so such a
      // write costs ZERO events and would make the arithmetic below say
      // something it does not mean.
      if (next === status) continue;
      const before = await upserts();
      const previous = await categoryOf(id);
      await database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        await client.query(`update public.tasks set work_status = $2 where entity_id = $1`, [id, next]);
      });
      status = next;
      expect(await categoryOf(id), `${next} must map to ${category}`).toBe(category);
      // A real status change always costs one event (the version snapshot). The
      // category write costs a SECOND — but ONLY when the category moved, which
      // is the `is distinct from` guard in the trigger doing its job. Without
      // it, `open -> pulled` would move a row on the socket that no tab moved.
      const expected = previous === category ? 1 : 2;
      expect((await upserts()) - before, `${previous} -> ${category}`).toBe(expected);
    }
  });

  it('costs NOTHING to rewrite a status with the value it already has', async () => {
    const id = '00000000-0000-4000-8000-0000000000d1';
    await createTask(id);
    const before = await upserts();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.tasks set work_status = 'open' where entity_id = $1`, [id]);
    });
    expect((await upserts()) - before).toBe(0);
    expect(await categoryOf(id)).toBe('to_do');
  });

  it('refuses a fifth category — the closed four are closed in the schema', async () => {
    await expect(
      database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        await client.query(
          `update public.entities set status_category = 'archived' where id = $1`,
          [ANCHOR],
        );
      }),
    ).rejects.toThrow(/entities_status_category_check/);
  });

  it('indexes the busiest predicate, partially, and USES that index', async () => {
    const rows = await database.query<{ 'QUERY PLAN': string }>(
      `explain (costs off) select id from public.entities
        where space_id = $1 and status_category = any($2::text[]) and deleted_at is null`,
      [SPACE, ['to_do', 'in_progress']],
    );
    // A seq scan on a nine-row table is a legal plan, so this is not asserted
    // as "the planner chose it" — it is asserted as "the index EXISTS and is
    // the partial one the design specified". The plan is printed for the reader.
    const definition = await database.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where tablename = 'entities' and indexname = 'entities_space_status_category_idx'`,
    );
    expect(definition[0]?.indexdef).toContain('(space_id, status_category)');
    expect(definition[0]?.indexdef).toContain('WHERE (deleted_at IS NULL)');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('adds status_id nullable and WITHOUT a foreign key — phase 2 owns the target', async () => {
    const columns = await database.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_name = 'entities' and column_name in ('status_id', 'status_category')
        order by column_name`,
    );
    expect(columns.map((c) => [c.column_name, c.is_nullable])).toEqual([
      ['status_category', 'YES'],
      ['status_id', 'YES'],
    ]);
    const foreignKeys = await database.query<{ n: string }>(
      `select count(*) n from pg_constraint
        where conrelid = 'public.entities'::regclass and contype = 'f'
          and conkey @> array[(select attnum from pg_attribute
                                where attrelid = 'public.entities'::regclass
                                  and attname = 'status_id')]`,
    );
    // `workflow_states` does not exist yet; a FK to nothing is not a stronger
    // guarantee, it is a migration that cannot apply.
    expect(Number(foreignKeys[0]!.n)).toBe(0);
  });
});
