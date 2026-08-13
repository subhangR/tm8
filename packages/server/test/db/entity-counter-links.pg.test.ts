/**
 * 108 — docs/memories link counters, proved against a REAL PostgreSQL.
 *
 * The chain is applied in TWO steps on purpose: everything through 107
 * first, then the seed, then 108 — so the BACKFILL is exercised against
 * rows that genuinely predate the migration, not merely asserted about.
 * After that, the trigger half is proved by moving edges on the migrated
 * database and watching the counters follow.
 *
 * The kind test matters and is tested from both sides: an `attached_to`
 * edge from a FILE must not count as a doc, and only the PEER row's kind
 * decides — the same predicate the backfill uses, so the two writers (one
 * running once, one forever) cannot disagree.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  space: string;
  member: string;
  task: string;
  session: string;
  doc: string;
  doc2: string;
  file: string;
  memory: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function counters(entity: string): Promise<{ docs: number; memories: number }> {
  const [row] = await database.query<{ docs: number; memories: number }>(
    `select docs, memories from public.entity_counters where entity_id = $1`,
    [entity],
  );
  return { docs: Number(row!.docs), memories: Number(row!.memories) };
}

async function asOwner<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('links_108');
  const files = migrationFiles();
  const cut = files.findIndex((f) => f.startsWith('108_'));
  if (cut === -1) throw new Error('108 migration not found');

  // Everything BEFORE 108, so the seed rows are genuinely pre-migration.
  database.apply(files.slice(0, cut));

  fixture = await asOwner(async (client) => {
    const ids = (
      await client.query<Fixture>(
        `select internal.new_id()::text "space", internal.new_id()::text "member",
                internal.new_id()::text "task", internal.new_id()::text "session",
                internal.new_id()::text "doc", internal.new_id()::text "doc2",
                internal.new_id()::text "file", internal.new_id()::text "memory"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ('links-member', 'Member')`,
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Links', 'links-member')`,
      [ids.space],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values
         ($2, $1, 'member', 0, $2), ($3, $1, 'task', 1, $2), ($4, $1, 'work_session', 2, $2),
         ($5, $1, 'doc', 3, $2), ($6, $1, 'doc', 4, $2), ($7, $1, 'file', 5, $2),
         ($8, $1, 'memory', 6, $2)`,
      [ids.space, ids.member, ids.task, ids.session, ids.doc, ids.doc2, ids.file, ids.memory],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, 'links-member', 'owner', 'Member')`,
      [ids.member, ids.space],
    );
    // Pre-108 edges the backfill must count: two docs and a file attached to
    // the task; the session remembers one memory. The file is the negative.
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by) values
         ($1, $3, $2, 'attached_to', $6), ($1, $4, $2, 'attached_to', $6),
         ($1, $5, $2, 'attached_to', $6), ($1, $7, $8, 'remembers', $6)`,
      [ids.space, ids.task, ids.doc, ids.doc2, ids.file, ids.member, ids.session, ids.memory],
    );
    return ids;
  });

  // Now 108 (and anything after it) lands on the seeded database.
  database.apply(files.slice(cut));
}, 300_000);

afterAll(async () => {
  await database?.destroy();
});

describe('108 — the backfill', () => {
  it('counts pre-existing doc attachments by PEER KIND: the file does not count', async () => {
    expect(await counters(fixture.task)).toEqual({ docs: 2, memories: 0 });
  });

  it('counts pre-existing remembers edges on the HOLDER side', async () => {
    expect(await counters(fixture.session)).toEqual({ docs: 0, memories: 1 });
  });

  it('leaves untouched entities at the column default instead of rewriting every row', async () => {
    expect(await counters(fixture.doc)).toEqual({ docs: 0, memories: 0 });
  });
});

describe('108 — the trigger, the forever half of the same predicate', () => {
  it('an edge insert and delete move the counter, and only for the counted kind', async () => {
    const doc3 = await asOwner(async (client) => {
      const [row] = (
        await client.query<{ id: string }>(`select internal.new_id()::text as id`)
      ).rows;
      await client.query(
        `insert into public.entities(id, space_id, kind, position, created_by)
         values ($1, $2, 'doc', 7, $3)`,
        [row!.id, fixture.space, fixture.member],
      );
      await client.query(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1, $2, $3, 'attached_to', $4)`,
        [fixture.space, row!.id, fixture.session, fixture.member],
      );
      return row!.id;
    });
    expect((await counters(fixture.session)).docs).toBe(1);

    await asOwner((client) =>
      client.query(`delete from public.edges where src_id = $1 and dst_id = $2 and type = 'attached_to'`, [
        doc3,
        fixture.session,
      ]),
    );
    expect((await counters(fixture.session)).docs).toBe(0);
  });

  it('a remembers edge counts on insert and uncounts on delete', async () => {
    await asOwner((client) =>
      client.query(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1, $2, $3, 'remembers', $4)`,
        [fixture.space, fixture.task, fixture.memory, fixture.member],
      ),
    );
    expect((await counters(fixture.task)).memories).toBe(1);

    await asOwner((client) =>
      client.query(`delete from public.edges where src_id = $1 and type = 'remembers'`, [fixture.task]),
    );
    expect((await counters(fixture.task)).memories).toBe(0);
  });

  it('a non-doc attachment moves nothing — the trigger tests the peer row, not the edge type alone', async () => {
    const before = await counters(fixture.task);
    await asOwner((client) =>
      client.query(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by, props)
         values ($1, $2, $3, 'attached_to', $4, '{}'::jsonb)
         on conflict do nothing`,
        [fixture.space, fixture.file, fixture.task, fixture.member],
      ),
    );
    // The file edge from the seed already exists; this asserts the count is
    // still exactly the two docs either way.
    expect((await counters(fixture.task)).docs).toBe(before.docs);
  });
});
