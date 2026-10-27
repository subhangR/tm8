import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/**
 * 310 — internal.record_activity coalesces autosave 'updated' rows.
 *
 * A run of body saves ({kind:'doc'} / {kind:'task'}) by one actor on one
 * entity within 10 minutes is ONE activity row: the later calls return the
 * first row's id and insert nothing. Anything else still inserts.
 */

vi.setConfig({ testTimeout: 120_000 });

interface Fixture { spaceId: string; docId: string; aliceId: string; bobId: string }

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<Fixture>(
      `select internal.new_id()::text "spaceId", internal.new_id()::text "docId",
              internal.new_id()::text "aliceId", internal.new_id()::text "bobId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name)
       values('coalesce-alice','Alice'),('coalesce-bob','Bob')`,
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Coalesce','coalesce-alice')`,
      [ids.spaceId],
    );
    for (const [id, identity, name, position] of [
      [ids.aliceId, 'coalesce-alice', 'Alice', 0],
      [ids.bobId, 'coalesce-bob', 'Bob', 1],
    ] as const) {
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'member',null,$3,$1)`,
        [id, ids.spaceId, position],
      );
      await client.query(
        `insert into public.members(entity_id,space_id,identity_id,role,display_name)
         values($1,$2,$3,'owner',$4)`,
        [id, ids.spaceId, identity, name],
      );
    }
    // Any entity serves as the subject; a third member keeps the fixture small.
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,2,$3)`,
      [ids.docId, ids.spaceId, ids.aliceId],
    );
    return ids;
  });
}

describe.sequential('310 coalesce autosave activity', () => {
  let database: W1ScratchDatabase;
  let fx: Fixture;

  /** One call per transaction, so each sees its own now() — like real saves. */
  const record = (actor: string, verb: string, summary: object): Promise<string> =>
    database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const row = (await client.query<{ id: string }>(
        `select internal.record_activity($1,$2,$3,$4,null,$5::jsonb)::text id`,
        [fx.spaceId, fx.docId, actor, verb, JSON.stringify(summary)],
      )).rows[0]!;
      return row.id;
    });

  const rows = async (): Promise<number> =>
    Number((await database.query<{ n: string }>(
      `select count(*) n from public.activity where entity_id = $1`, [fx.docId],
    ))[0]!.n);

  beforeAll(async () => {
    database = await createW1ScratchDatabase('coalesce_activity');
    database.apply(migrationFiles());
    fx = await seed(database);
  }, 180_000);

  afterAll(async () => {
    await database?.destroy();
  }, 120_000);

  it('folds repeated doc saves by one actor into one row and fires one event', async () => {
    const events = async (): Promise<number> =>
      Number((await database.query<{ n: string }>(`select count(*) n from public.workspace_events`))[0]!.n);
    const before = await events();
    const first = await record(fx.aliceId, 'updated', { kind: 'doc' });
    const second = await record(fx.aliceId, 'updated', { kind: 'doc' });
    const third = await record(fx.aliceId, 'updated', { kind: 'doc' });
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(await rows()).toBe(1);
    expect(await events()).toBe(before + 1);
  });

  it('starts a new row when another actor saves', async () => {
    const before = await rows();
    const alice = await record(fx.aliceId, 'updated', { kind: 'doc' });
    const bob = await record(fx.bobId, 'updated', { kind: 'doc' });
    expect(bob).not.toBe(alice);
    expect(await rows()).toBe(before + 1);
  });

  it('starts a new row after a different verb breaks the run', async () => {
    const lead = await record(fx.aliceId, 'updated', { kind: 'doc' });
    const moved = await record(fx.aliceId, 'moved', { kind: 'doc' });
    const after = await record(fx.aliceId, 'updated', { kind: 'doc' });
    expect(new Set([lead, moved, after]).size).toBe(3);
  });

  it('starts a new row once the run is older than 10 minutes', async () => {
    const old = await record(fx.aliceId, 'updated', { kind: 'doc' });
    await database.query(
      `update public.activity set created_at = now() - interval '11 minutes' where id = $1`, [old],
    );
    const fresh = await record(fx.aliceId, 'updated', { kind: 'doc' });
    expect(fresh).not.toBe(old);
  });

  it('coalesces task saves too, but never across summaries', async () => {
    const task1 = await record(fx.aliceId, 'updated', { kind: 'task' });
    const task2 = await record(fx.aliceId, 'updated', { kind: 'task' });
    const doc = await record(fx.aliceId, 'updated', { kind: 'doc' });
    expect(task2).toBe(task1);
    expect(doc).not.toBe(task1);
  });

  it('leaves every other updated summary on the insert-always path', async () => {
    const a = await record(fx.aliceId, 'updated', { kind: 'file' });
    const b = await record(fx.aliceId, 'updated', { kind: 'file' });
    expect(b).not.toBe(a);
  });
});
