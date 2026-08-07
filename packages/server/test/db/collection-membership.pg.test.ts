/**
 * Collection membership against a REAL PostgreSQL.
 *
 * These rules cannot be observed from a FakeDb. Auto-append reads
 * `max(props.position)` inside the write; the cycle refusal is a recursive
 * trigger (`internal.prevent_edge_cycle`, 001:814) fired by the registry flag
 * 077 flips; and the idempotent remove depends on the mutation ledger. A stub
 * that returned plausible values for all three would agree with every
 * assertion here and still ship a collection that cannot be ordered, can
 * contain its own ancestor, and errors on a retried remove.
 *
 * The curated-ORDER assertions are the ones that matter most. Before 077,
 * `sort:'position'` read `e.position` — the entity's place among its hierarchy
 * siblings — for a query asking a collection for its items. Both orderings
 * return the same rows, so nothing failed; the list was simply in the wrong
 * order, confidently. Every ordering test below therefore seeds hierarchy
 * positions that DISAGREE with the curated ones, because a fixture where the
 * two coincide passes against the bug.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CollectionQuery } from '@tm8/contract';
import type { Querier } from '../../src/db/types.js';
import { queryCollection } from '../../src/facade/handlers/collections.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

const MIGRATIONS = migrationFiles();

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  /** Hierarchy positions 1..3, seeded to DISAGREE with the curated order. */
  taskAId: string;
  taskBId: string;
  taskCId: string;
  /** A non-task member, so heterogeneity is exercised rather than assumed. */
  docId: string;
}

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const fixture = (await client.query<Fixture>(
      `select 'coll-owner'::text as "identityId",
              internal.new_id()::text as "spaceId",
              internal.new_id()::text as "memberId",
              internal.new_id()::text as "taskAId",
              internal.new_id()::text as "taskBId",
              internal.new_id()::text as "taskCId",
              internal.new_id()::text as "docId"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'Collection owner')`,
      [fixture.identityId],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Collections', $2)`,
      [fixture.spaceId, fixture.identityId],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, parent_id, position, created_by)
       values ($1, $2, 'member', null, 0, $1)`,
      [fixture.memberId, fixture.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, $3, 'owner', 'Collection owner')`,
      [fixture.memberId, fixture.spaceId, fixture.identityId],
    );
    // Hierarchy positions 1, 2, 3 in A, B, C order — the curated order below is
    // deliberately the REVERSE, so a reader that fell back to `e.position`
    // produces a visibly different list rather than an accidentally equal one.
    await client.query(
      `insert into public.entities(id, space_id, kind, parent_id, position, created_by)
       values ($1, $5, 'task', null, 1, $6),
              ($2, $5, 'task', null, 2, $6),
              ($3, $5, 'task', null, 3, $6),
              ($4, $5, 'doc',  null, 4, $6)`,
      [fixture.taskAId, fixture.taskBId, fixture.taskCId, fixture.docId,
        fixture.spaceId, fixture.memberId],
    );
    await client.query(
      `insert into public.tasks(entity_id, title, work_status, priority)
       values ($1, 'Task A', 'open', 'medium'),
              ($2, 'Task B', 'open', 'medium'),
              ($3, 'Task C', 'open', 'medium')`,
      [fixture.taskAId, fixture.taskBId, fixture.taskCId],
    );
    await client.query(
      `insert into public.documents(entity_id, title, body) values ($1, 'A doc', 'body')`,
      [fixture.docId],
    );
    return fixture;
  });
}

async function asApp<T>(
  database: W1ScratchDatabase,
  identityId: string,
  fn: (q: Querier) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'req-collections-pg', true)`,
      [identityId],
    );
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => (
        await client.query(sql, [...params])
      ).rows as R[],
      rpc: async <T2>(fnName: string, args: readonly unknown[] = []): Promise<T2> => {
        if (!/^[a-z_][a-z0-9_]*$/.test(fnName)) throw new Error(`unsafe test RPC ${fnName}`);
        const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
        const result = await client.query(`select public.${fnName}(${placeholders}) result`, [...args]);
        return result.rows[0]?.result as T2;
      },
    };
    return fn(q);
  });
}

interface RpcResult { entity?: { id?: string }; edge?: { id?: string }; removed?: boolean }

/** The membership query a client issues to list a collection in curated order. */
function itemsQuery(spaceId: string, collectionId: string, limit?: number): CollectionQuery {
  return {
    spaceId,
    sort: 'position',
    filters: { edge: { type: 'contains', direction: 'incoming', entityId: collectionId } },
    ...(limit === undefined ? {} : { limit }),
  };
}

describe.sequential('collection membership PostgreSQL semantics', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('collection_membership');
    database.apply(MIGRATIONS);
    fixture = await seed(database);
  }, 180_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  async function newCollection(name: string): Promise<string> {
    return asApp(database, fixture.identityId, async (q) => {
      const raw = await q.rpc<RpcResult>('create_collection', [fixture.spaceId, name]);
      const id = raw?.entity?.id;
      if (!id) throw new Error(`create_collection returned no entity for ${name}`);
      return id;
    });
  }

  it('appends at the end when no position is given, and holds mixed kinds', async () => {
    const collectionId = await newCollection('Mixed');
    await asApp(database, fixture.identityId, async (q) => {
      // Added in an order that is NOT the hierarchy order, so the assertion
      // below distinguishes curated order from entity position.
      await q.rpc('set_collection_item', [collectionId, fixture.taskCId]);
      await q.rpc('set_collection_item', [collectionId, fixture.docId]);
      await q.rpc('set_collection_item', [collectionId, fixture.taskAId]);
    });

    const rows = await asApp(database, fixture.identityId, (q) =>
      q.query<{ dst_id: string; pos: number }>(
        `select dst_id, (props ->> 'position')::double precision as pos
           from public.edges where src_id = $1 and type = 'contains' order by pos`,
        [collectionId],
      ));
    expect(rows.map((r) => r.pos)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.dst_id)).toEqual([fixture.taskCId, fixture.docId, fixture.taskAId]);
  });

  it('lists a collection in CURATED order, not hierarchy order', async () => {
    const collectionId = await newCollection('Ordered');
    await asApp(database, fixture.identityId, async (q) => {
      await q.rpc('set_collection_item', [collectionId, fixture.taskCId]);
      await q.rpc('set_collection_item', [collectionId, fixture.taskBId]);
      await q.rpc('set_collection_item', [collectionId, fixture.taskAId]);
    });

    const result = await asApp(database, fixture.identityId, (q) =>
      queryCollection(q, itemsQuery(fixture.spaceId, collectionId), fixture.identityId));

    // Curated: C, B, A. Hierarchy position would give A, B, C — the exact
    // wrong answer the pre-077 reader returned, and the reason this fixture
    // seeds the two orders as reverses of each other.
    expect(result.page.items.map((i) => i.id)).toEqual([
      fixture.taskCId, fixture.taskBId, fixture.taskAId,
    ]);
  });

  it('pages curated order without losing or repeating a row', async () => {
    const collectionId = await newCollection('Paged');
    await asApp(database, fixture.identityId, async (q) => {
      await q.rpc('set_collection_item', [collectionId, fixture.taskCId]);
      await q.rpc('set_collection_item', [collectionId, fixture.taskBId]);
      await q.rpc('set_collection_item', [collectionId, fixture.docId]);
      await q.rpc('set_collection_item', [collectionId, fixture.taskAId]);
    });

    const seen: string[] = [];
    let cursor: string | null | undefined;
    // Two at a time across four members: the keyset has to carry the EDGE's
    // position, so a cursor built from `e.position` would jump or repeat here.
    do {
      const page = await asApp(database, fixture.identityId, (q) =>
        queryCollection(
          q,
          { ...itemsQuery(fixture.spaceId, collectionId, 2), ...(cursor ? { cursor } : {}) },
          fixture.identityId,
        ));
      seen.push(...page.page.items.map((i) => i.id));
      cursor = page.page.nextCursor;
    } while (cursor);

    expect(seen).toEqual([
      fixture.taskCId, fixture.taskBId, fixture.docId, fixture.taskAId,
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('re-adding at an explicit position REORDERS rather than failing', async () => {
    const collectionId = await newCollection('Reordered');
    await asApp(database, fixture.identityId, async (q) => {
      await q.rpc('set_collection_item', [collectionId, fixture.taskAId]);
      await q.rpc('set_collection_item', [collectionId, fixture.taskBId]);
      await q.rpc('set_collection_item', [collectionId, fixture.taskCId]);
      // A midpoint, which is why position is a float: moving C between A and B
      // must not have to renumber anything else.
      await q.rpc('set_collection_item', [collectionId, fixture.taskCId, 1.5]);
    });

    const result = await asApp(database, fixture.identityId, (q) =>
      queryCollection(q, itemsQuery(fixture.spaceId, collectionId), fixture.identityId));
    expect(result.page.items.map((i) => i.id)).toEqual([
      fixture.taskAId, fixture.taskCId, fixture.taskBId,
    ]);

    const count = await asApp(database, fixture.identityId, (q) =>
      q.query<{ n: string }>(
        `select count(*)::text as n from public.edges where src_id = $1 and type = 'contains'`,
        [collectionId],
      ));
    // Three members, not four: the reorder upserted the existing edge.
    expect(count[0]!.n).toBe('3');
  });

  it('nests collections but refuses a cycle', async () => {
    const outerId = await newCollection('Outer');
    const innerId = await newCollection('Inner');

    await asApp(database, fixture.identityId, (q) =>
      q.rpc('set_collection_item', [outerId, innerId]));

    // Nesting is legal and shows up as ordinary membership.
    const nested = await asApp(database, fixture.identityId, (q) =>
      queryCollection(q, itemsQuery(fixture.spaceId, outerId), fixture.identityId));
    expect(nested.page.items.map((i) => i.id)).toEqual([innerId]);

    // The reverse closes a loop and is refused by the trigger 077 armed.
    await expect(
      asApp(database, fixture.identityId, (q) =>
        q.rpc('set_collection_item', [innerId, outerId])),
    ).rejects.toThrow(/cycle/i);

    // And a collection cannot contain itself.
    await expect(
      asApp(database, fixture.identityId, (q) =>
        q.rpc('set_collection_item', [outerId, outerId])),
    ).rejects.toThrow(/itself/i);
  });

  it('removes by PAIR, and a repeated remove is a no-op rather than an error', async () => {
    const collectionId = await newCollection('Removable');
    await asApp(database, fixture.identityId, async (q) => {
      await q.rpc('set_collection_item', [collectionId, fixture.taskAId]);
      await q.rpc('set_collection_item', [collectionId, fixture.taskBId]);
    });

    const first = await asApp(database, fixture.identityId, (q) =>
      q.rpc<RpcResult>('unset_collection_item', [collectionId, fixture.taskAId]));
    expect(first.removed).toBe(true);

    // The retry a dropped response would produce. Succeeds, reports the
    // distinction, and — asserted below — writes no second activity row.
    const second = await asApp(database, fixture.identityId, (q) =>
      q.rpc<RpcResult>('unset_collection_item', [collectionId, fixture.taskAId]));
    expect(second.removed).toBe(false);

    const remaining = await asApp(database, fixture.identityId, (q) =>
      queryCollection(q, itemsQuery(fixture.spaceId, collectionId), fixture.identityId));
    expect(remaining.page.items.map((i) => i.id)).toEqual([fixture.taskBId]);

    const unlinked = await asApp(database, fixture.identityId, (q) =>
      q.query<{ n: string }>(
        `select count(*)::text as n from public.activity
          where entity_id = $1 and verb = 'unlinked'`,
        [collectionId],
      ));
    expect(unlinked[0]!.n).toBe('1');
  });

  it('leaves the entity itself alone when its membership is removed', async () => {
    const collectionId = await newCollection('Transient');
    await asApp(database, fixture.identityId, async (q) => {
      await q.rpc('set_collection_item', [collectionId, fixture.taskAId]);
      await q.rpc('unset_collection_item', [collectionId, fixture.taskAId]);
    });

    const rows = await asApp(database, fixture.identityId, (q) =>
      q.query<{ id: string; deleted_at: string | null }>(
        `select id, deleted_at from public.entities where id = $1`,
        [fixture.taskAId],
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).toBeNull();
  });

  it('keeps one entity in many collections independently', async () => {
    const leftId = await newCollection('Left');
    const rightId = await newCollection('Right');
    await asApp(database, fixture.identityId, async (q) => {
      await q.rpc('set_collection_item', [leftId, fixture.taskAId]);
      await q.rpc('set_collection_item', [rightId, fixture.taskAId]);
      await q.rpc('unset_collection_item', [leftId, fixture.taskAId]);
    });

    const left = await asApp(database, fixture.identityId, (q) =>
      queryCollection(q, itemsQuery(fixture.spaceId, leftId), fixture.identityId));
    const right = await asApp(database, fixture.identityId, (q) =>
      queryCollection(q, itemsQuery(fixture.spaceId, rightId), fixture.identityId));

    expect(left.page.items).toHaveLength(0);
    expect(right.page.items.map((i) => i.id)).toEqual([fixture.taskAId]);
  });

  it('reports itemCount from membership, and counts nested collections as members', async () => {
    const collectionId = await newCollection('Counted');
    const nestedId = await newCollection('Nested child');
    await asApp(database, fixture.identityId, async (q) => {
      await q.rpc('set_collection_item', [collectionId, fixture.taskAId]);
      await q.rpc('set_collection_item', [collectionId, fixture.docId]);
      await q.rpc('set_collection_item', [collectionId, nestedId]);
    });

    const result = await asApp(database, fixture.identityId, (q) =>
      queryCollection(
        q,
        { spaceId: fixture.spaceId, kinds: ['collection'], sort: 'createdAt_desc' },
        fixture.identityId,
      ));
    const summary = result.page.items.find((i) => i.id === collectionId);
    expect(summary?.state).toMatchObject({ kind: 'collection', itemCount: 3 });
  });

  it('grants the new RPC to tm8_app and to nobody else', async () => {
    const rows = await database.query<{ app_exec: boolean; public_exec: boolean }>(
      `select has_function_privilege('tm8_app', p.oid, 'EXECUTE') app_exec,
              has_function_privilege('public', p.oid, 'EXECUTE') public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'unset_collection_item'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ app_exec: true, public_exec: false });
  });
});
