/**
 * Tile children (task 01a14b92): the two reads a list tree makes and the count
 * its subscript draws. Pinned here:
 *   - `filters.parentIn` lists the direct children of the given rows, whatever
 *     their status (a status tab filters the roots; children ride along);
 *   - `filters.idIn` lists exactly the given rows (a tab's context parents);
 *   - every summary carries `childCount`, the live direct-child count.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CollectionQuery } from '@tm8/contract';
import type { Querier } from '../../src/db/types.js';
import { queryCollection } from '../../src/facade/handlers/collections.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const IDENTITY = 'tile-children-owner';

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
              set_config('tm8.request_id', 'req-tile-children', true)`,
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

const names = () => new Map(Object.entries(id).map(([name, value]) => [value, name]));

async function list(filters: CollectionQuery['filters']) {
  const query: CollectionQuery = { spaceId: id['space']! as CollectionQuery['spaceId'], kinds: ['task'], filters, limit: 50 };
  const result = await asApp((q) => queryCollection(q, query, IDENTITY));
  const byId = names();
  return result.page.items.map((item) => ({ name: byId.get(item.id) ?? item.id, childCount: item.childCount }));
}

describe('tile children reads', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('tile_children');
    database.apply(migrationFiles());

    await asOwner(async (c) => {
      const all = ['space', 'member', 'parent', 'openKid', 'doneKid', 'other'];
      const ids = (await c.query<{ ids: string[] }>(
        `select array(select internal.new_id() from generate_series(1, $1)) ids`, [all.length])).rows[0]!.ids;
      all.forEach((n, i) => { id[n] = ids[i]!; });

      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'owner')`, [IDENTITY]);
      await c.query(`insert into public.accounts(id, identity_id, username) values ($1, $2, 'tile-children-owner')`,
        [randomUUID(), IDENTITY]);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'tile children', $2)`,
        [id['space'], IDENTITY]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                     values ($1, $2, 'member', $1, 'space')`, [id['member'], id['space']]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name)
                     values ($1, $2, $3, 'owner', 'Owner')`, [id['member'], id['space'], IDENTITY]);

      const task = async (name: string, parent: string | null, position: number) => {
        await c.query(`insert into public.entities(id, space_id, kind, parent_id, position, created_by)
                       values ($1, $2, 'task', $3, $4, $5)`, [id[name], id['space'], parent ? id[parent] : null, position, id['member']]);
        await c.query(`insert into public.tasks(entity_id, title) values ($1, $2)`, [id[name], name]);
      };
      await task('parent', null, 0);
      await task('openKid', 'parent', 1);
      await task('doneKid', 'parent', 2);
      await task('other', null, 3);
      await c.query(`update public.entities set status_category = 'done' where id = $1`, [id['doneKid']]);
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('parentIn lists the children of the given rows, whatever their status', async () => {
    const rows = await list({ parentIn: [id['parent']! as never] });
    expect(rows.map((r) => r.name).sort()).toEqual(['doneKid', 'openKid']);
  });

  it('idIn lists exactly the given rows', async () => {
    const rows = await list({ idIn: [id['parent']! as never, id['other']! as never] });
    expect(rows.map((r) => r.name).sort()).toEqual(['other', 'parent']);
  });

  it('every summary carries its live direct-child count', async () => {
    const rows = await list(undefined);
    const count = new Map(rows.map((r) => [r.name, r.childCount]));
    expect(count.get('parent')).toBe(2);
    expect(count.get('openKid')).toBe(0);
    expect(count.get('other')).toBe(0);
  });
});
