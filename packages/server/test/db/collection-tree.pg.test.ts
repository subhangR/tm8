/**
 * S5 (mobile LLD §5.1, §19 "Tree in one query"): `collections.query` with
 * `tree: {depth, perParent}` returns the page and up to two levels under it in
 * one trip. Pinned here:
 *   - one call returns the page plus each level, the parents each level read,
 *     and nothing deeper than `depth` (ac1);
 *   - on one fixture, the one-trip result EQUALS the three trips a list made
 *     before: the page, then `{kinds, filters: {parentIn}, sort, limit: 200}`
 *     for the children and again for theirs, summary for summary (ac2);
 *   - the bounds: `perParent` keeps the first n children of each parent in the
 *     page's order, a level stops at 200 rows and says `capped`, and a tree
 *     outside its bounds is refused (ac3).
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CollectionQuery, CollectionResult, EntitySummary } from '@tm8/contract';
import type { Querier } from '../../src/db/types.js';
import { queryCollection } from '../../src/facade/handlers/collections.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const IDENTITY = 'collection-tree-owner';

let database: W1ScratchDatabase;
const id: Record<string, string> = {};

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function asApp<T>(fn: (q: Querier) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true), set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true), set_config('tm8.auth_kind', 'browser', true),
              set_config('tm8.request_id', 'req-collection-tree', true)`,
      [IDENTITY],
    );
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
        (await client.query(sql, [...params])).rows as R[],
      rpc: async <R>(fnName: string, args: readonly unknown[] = []): Promise<R> => {
        if (!/^[a-z_][a-z0-9_]*$/.test(fnName)) throw new Error(`unsafe test RPC ${fnName}`);
        const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
        return (await client.query(`select public.${fnName}(${placeholders}) result`, [...args])).rows[0]?.result as R;
      },
    };
    return fn(q);
  });
}

const run = (query: CollectionQuery): Promise<CollectionResult> =>
  asApp((q) => queryCollection(q, query, IDENTITY));

const space = (name: string) => id[name]! as CollectionQuery['spaceId'];
const nameOf = (entityId: string) => Object.entries(id).find(([, value]) => value === entityId)?.[0] ?? entityId;
const names = (rows: readonly EntitySummary[]) => rows.map((row) => nameOf(row.id));
const parentsOf = (rows: readonly EntitySummary[]) => rows.filter((row) => (row.childCount ?? 0) > 0).map((row) => row.id);

/** The step query a list sends for one level (LLD §5.1, Depth 1 and Depth 2), written out by hand. */
const step = (page: CollectionQuery, parentIn: string[]): CollectionQuery => ({
  spaceId: page.spaceId,
  ...(page.kinds ? { kinds: page.kinds } : {}),
  filters: { parentIn: parentIn as never },
  ...(page.sort ? { sort: page.sort } : {}),
  limit: 200,
});

/** The three trips a list made before S5: the page, then each level from the rows above it with children. */
async function threeStep(page: CollectionQuery) {
  const roots = await run(page);
  const p1 = parentsOf(roots.page.items);
  const d1 = await run(step(page, p1));
  const p2 = parentsOf(d1.page.items);
  const d2 = await run(step(page, p2));
  return { roots, p1, d1, p2, d2 };
}

/** The first n rows of each parent, in the order given. */
function firstPerParent(rows: readonly EntitySummary[], n: number): EntitySummary[] {
  const seen = new Map<string | null, number>();
  return rows.filter((row) => {
    const shown = seen.get(row.parentId) ?? 0;
    seen.set(row.parentId, shown + 1);
    return shown < n;
  });
}

describe('collections.query tree', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('collection_tree');
    database.apply(migrationFiles());

    await asOwner(async (c) => {
      const family: Array<[name: string, parent: string | null, status: string]> = [
        ['alpha', null, 'open'],
        ['a1', 'alpha', 'open'],
        ['a1x', 'a1', 'open'],
        ['a1x0', 'a1x', 'open'], // depth 3: never read, a1x's childCount says it is there
        ['a1y', 'a1', 'done'],
        ['a2', 'alpha', 'done'],
        ['a2x', 'a2', 'open'],
        ['a3', 'alpha', 'working'],
        ['aGone', 'alpha', 'open'], // soft-deleted below: not counted, not read
        ['beta', null, 'done'],
        ['b1', 'beta', 'open'],
        ['gamma', null, 'open'],
        ['delta', null, 'blocked'],
        ['dGone', 'delta', 'open'], // soft-deleted below: delta reads as childless
      ];
      const wide: Array<[name: string, parent: string | null, status: string]> = [
        ['wide', null, 'open'],
        ...Array.from({ length: 201 }, (_, i) => [`w${i}`, 'wide', 'open'] as [string, string, string]),
        ['narrow', null, 'open'],
        ['n0', 'narrow', 'open'],
        ['n1', 'narrow', 'done'],
      ];
      const all = ['space', 'wideSpace', 'member', 'wideMember', ...family.map(([n]) => n), ...wide.map(([n]) => n)];
      const ids = (await c.query<{ ids: string[] }>(
        `select array(select internal.new_id() from generate_series(1, $1)) ids`, [all.length])).rows[0]!.ids;
      all.forEach((n, i) => { id[n] = ids[i]!; });

      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'owner')`, [IDENTITY]);
      await c.query(`insert into public.accounts(id, identity_id, username) values ($1, $2, 'collection-tree-owner')`,
        [randomUUID(), IDENTITY]);
      for (const [spaceName, memberName] of [['space', 'member'], ['wideSpace', 'wideMember']] as const) {
        await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, $2, $3)`,
          [id[spaceName], `collection tree ${spaceName}`, IDENTITY]);
        await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                       values ($1, $2, 'member', $1, 'space')`, [id[memberName], id[spaceName]]);
        await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name)
                       values ($1, $2, $3, 'owner', 'Owner')`, [id[memberName], id[spaceName], IDENTITY]);
      }

      const insert = async (spaceName: string, memberName: string, rows: typeof family) => {
        for (const [position, [name, parent, status]] of rows.entries()) {
          await c.query(`insert into public.entities(id, space_id, kind, parent_id, position, created_by)
                         values ($1, $2, 'task', $3, $4, $5)`,
            [id[name], id[spaceName], parent ? id[parent] : null, position, id[memberName]]);
          await c.query(`insert into public.tasks(entity_id, title, work_status) values ($1, $2, $3)`,
            [id[name], name, status]);
        }
      };
      await insert('space', 'member', family);
      await insert('wideSpace', 'wideMember', wide);

      // Activity order is not insertion order, so a rank that ordered by id or
      // position instead of the page's sort would put the wrong rows first.
      await c.query(
        `update public.entities e
            set activity_at = timestamptz '2026-10-01 00:00:00+00' + (((x.n * 37) % 997) * interval '1 minute')
           from (select id, row_number() over (order by id) n from public.entities where kind = 'task') x
          where e.id = x.id`,
      );
      await c.query(`update public.entities set deleted_at = now() where id = any($1::uuid[])`, [[id['aGone'], id['dGone']]]);
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  const page: () => CollectionQuery = () => ({ spaceId: space('space'), kinds: ['task'], parentId: null, limit: 50 });

  it('returns the page and two levels under it in one call, and nothing deeper (ac1)', async () => {
    const one = await run({ ...page(), tree: { depth: 2, perParent: 20 } });

    expect(names(one.page.items).sort()).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    const [level1, level2] = one.tree!.levels;
    expect(one.tree!.levels).toHaveLength(2);

    expect(level1!.depth).toBe(1);
    expect(level1!.parentIds.map(nameOf).sort()).toEqual(['alpha', 'beta']); // delta's only child is deleted
    expect(names(level1!.items).sort()).toEqual(['a1', 'a2', 'a3', 'b1']); // done a2 rides along
    expect(level1!.capped).toBe(false);

    expect(level2!.depth).toBe(2);
    expect(level2!.parentIds.map(nameOf).sort()).toEqual(['a1', 'a2']);
    expect(names(level2!.items).sort()).toEqual(['a1x', 'a1y', 'a2x']);
    expect(level2!.capped).toBe(false);

    // a1x0 is depth 3: not read, but its parent says it is there.
    const a1x = level2!.items.find((row) => row.id === id['a1x']);
    expect(a1x?.childCount).toBe(1);
    expect(JSON.stringify(one)).not.toContain(id['a1x0']);

    // The echo is the query as resolved, so re-running it gives these rows.
    expect(one.query.tree).toEqual({ depth: 2, perParent: 20 });
    expect((await run({ ...page(), tree: { depth: 1 } })).query.tree).toEqual({ depth: 1, perParent: 200 });
  });

  it('depth 1 reads one level; a query without tree has no tree', async () => {
    const one = await run({ ...page(), tree: { depth: 1 } });
    expect(one.tree!.levels.map((level) => level.depth)).toEqual([1]);
    expect(names(one.tree!.levels[0]!.items).sort()).toEqual(['a1', 'a2', 'a3', 'b1']);

    const plain = await run(page());
    expect('tree' in plain).toBe(false);
    expect(plain.page).toEqual(one.page);
  });

  it('equals the three-step query on one fixture, row for row and summary for summary (ac2)', async () => {
    const cases: CollectionQuery[] = [
      page(),
      { ...page(), sort: 'position' },
      // A status tab filters the page; children ride along whatever their status.
      { ...page(), filters: { status: ['open', 'blocked'] } },
      { ...page(), sort: 'priority', filters: { category: ['to_do', 'in_progress'] } },
    ];
    for (const query of cases) {
      const three = await threeStep(query);
      for (const tree of [{ depth: 2 as const }, { depth: 2 as const, perParent: 20 }]) {
        const one = await run({ ...query, tree });
        const label = JSON.stringify({ sort: query.sort, filters: query.filters, tree });
        expect(one.page, label).toEqual(three.roots.page);
        expect(one.tree, label).toEqual({
          levels: [
            { depth: 1, parentIds: three.p1, items: three.d1.page.items, capped: false },
            { depth: 2, parentIds: three.p2, items: three.d2.page.items, capped: false },
          ],
        });
      }
      // Not a vacuous match: the fixture reaches depth 2 under every case.
      expect(three.d2.page.items.length, JSON.stringify(query)).toBeGreaterThan(0);
    }
  });

  it('perParent keeps the first n children of each parent, in the page order (ac3)', async () => {
    const three = await threeStep(page());
    const one = await run({ ...page(), tree: { depth: 2, perParent: 1 } });
    const [level1, level2] = one.tree!.levels;

    expect(level1!.items).toEqual(firstPerParent(three.d1.page.items, 1));
    expect(level1!.items.filter((row) => row.parentId === id['alpha'])).toHaveLength(1);

    // Level 2 hangs from the level-1 rows the cut kept, read the same way.
    const kept = parentsOf(level1!.items);
    expect(level2!.parentIds).toEqual(kept);
    const d2 = await run(step(page(), kept));
    expect(level2!.items).toEqual(firstPerParent(d2.page.items, 1));
    expect(level2!.capped).toBe(false);
  });

  it('a level holds at most 200 rows and says capped when that bound cut it (ac3)', async () => {
    const widePage: CollectionQuery = { spaceId: space('wideSpace'), kinds: ['task'], parentId: null };
    const d1 = await run(step(widePage, [id['wide']!, id['narrow']!]));
    expect(d1.page.items).toHaveLength(200);
    expect(d1.page.nextCursor).not.toBeNull();

    const one = await run({ ...widePage, tree: { depth: 2 } });
    const [level1, level2] = one.tree!.levels;
    expect(level1!.parentIds.map(nameOf).sort()).toEqual(['narrow', 'wide']);
    expect(level1!.items).toHaveLength(200);
    expect(level1!.items).toEqual(d1.page.items);
    expect(level1!.capped).toBe(true);
    // The next level's parents are bounded by this level's 200 rows; these have no children.
    expect(level2).toEqual({ depth: 2, parentIds: [], items: [], capped: false });

    // Under the bound nothing is capped: 150 of wide's children and both of narrow's.
    const cut = await run({ ...widePage, tree: { depth: 1, perParent: 150 } });
    expect(cut.tree!.levels[0]!.capped).toBe(false);
    expect(cut.tree!.levels[0]!.items).toHaveLength(152);
    expect(cut.tree!.levels[0]!.items.filter((row) => row.parentId === id['narrow'])).toHaveLength(2);
  });

  it('refuses a tree outside its bounds instead of clamping it (ac3)', async () => {
    for (const tree of [{ depth: 3 }, { depth: 0 }, { depth: 2, perParent: 0 }, { depth: 2, perParent: 201 }, { depth: 1, perParent: 1.5 }]) {
      await expect(run({ ...page(), tree: tree as never }), JSON.stringify(tree)).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });

  it('a cursor from a tree page continues the same query with or without tree', async () => {
    const first = await run({ ...page(), limit: 2, tree: { depth: 2, perParent: 20 } });
    expect(first.page.nextCursor).toBeTruthy();
    const cursor = first.page.nextCursor!;

    const plain = await run({ ...page(), limit: 2, cursor });
    const treed = await run({ ...page(), limit: 2, cursor, tree: { depth: 1, perParent: 5 } });
    expect(treed.page).toEqual(plain.page);
    expect(treed.tree!.levels[0]!.parentIds).toEqual(parentsOf(plain.page.items));
  });

  it('rides along with a grouped page', async () => {
    const grouped = await run({ ...page(), groupBy: 'status', tree: { depth: 1 } });
    expect(grouped.groups?.length).toBeGreaterThan(0);
    expect(names(grouped.tree!.levels[0]!.items).sort()).toEqual(['a1', 'a2', 'a3', 'b1']);
  });
});
