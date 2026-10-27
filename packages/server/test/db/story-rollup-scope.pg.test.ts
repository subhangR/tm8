/**
 * 289 against a real Postgres: a story counts what it CONTAINS — its roots,
 * their hierarchy, its child stories — never what the trail reaches sideways
 * (issues #26 #27 #29 #40, task 01a0fe62).
 *
 * The leak this pins: story A's root task is `attached_to` a doc that a task
 * of story B is also attached to. The trail walks A1 -> doc -> B1, exactly
 * the shape of root -> session -> coordinator -> other story's task, and
 * 283's summary counted B1 in A's taskProgress.
 */
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Querier } from '../../src/db/types.js';
import { loadStoryPage } from '../../src/facade/story-page.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const IDENTITY = 'story-rollup-probe';

let database: W1ScratchDatabase;
const id: Record<string, string> = {};

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

function querierOf(client: PoolClient): Querier {
  return {
    query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
      (await client.query(sql, [...params])).rows as R[],
    rpc: async () => { throw new Error('not used'); },
  } as Querier;
}

async function summary(storyId: string): Promise<Record<string, any>> {
  return asOwner(async (c) => (await c.query(`select internal.story_summary($1) s`, [storyId])).rows[0]!.s);
}

describe('289 story rollup scope', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('story_rollup');
    database.apply(migrationFiles());

    await asOwner(async (c) => {
      const names = ['space', 'anchor', 'storyA', 'storyB', 'storyC', 'a1', 'a2', 'a3', 'a4', 'a5', 'aX',
        'hub', 'b1', 'b2', 'c1'];
      const rows = (await c.query<{ ids: string[] }>(
        `select array(select internal.new_id() from generate_series(1, $1)) ids`, [names.length])).rows[0]!.ids;
      names.forEach((n, i) => { id[n] = rows[i]!; });

      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'probe')`, [IDENTITY]);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'probe', $2)`,
        [id['space'], IDENTITY]);
      let pos = 0;
      const entity = async (key: string, kind: string, parent: string | null = null) => {
        await c.query(
          `insert into public.entities(id, space_id, kind, position, created_by, parent_id)
           values ($1, $2, $3, $4, $5, $6)`,
          [id[key], id['space'], kind, pos++, key === 'anchor' ? id[key] : id['anchor'], parent ? id[parent] : null],
        );
      };
      const task = async (key: string, status = 'open', parent: string | null = null) => {
        await entity(key, 'task', parent);
        await c.query(`insert into public.tasks(entity_id, title, work_status) values ($1, $2, $3)`,
          [id[key], key, status]);
      };
      const doc = async (key: string) => {
        await entity(key, 'doc');
        await c.query(`insert into public.documents(entity_id, title, body, format) values ($1, $2, 'x', 'markdown')`,
          [id[key], key]);
      };
      const story = async (key: string, parent: string | null = null) => {
        await entity(key, 'story', parent);
        await c.query(`insert into public.stories(entity_id, title) values ($1, $2)`, [id[key], key]);
      };
      const edge = async (src: string, dst: string, type: string) => {
        await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, $4, $5)`,
          [id['space'], id[src], id[dst], type, id['anchor']]);
      };

      await task('anchor');
      await story('storyA');
      await story('storyB');
      await story('storyC', 'storyA');
      // A's root a1 holds a chain deeper than the trail's depth 3 and a
      // cancelled subtask.
      await task('a1', 'working');
      await task('a2', 'done', 'a1');
      await task('a3', 'open', 'a2');
      await task('a4', 'open', 'a3');
      await task('a5', 'open', 'a4');
      await task('aX', 'cancelled', 'a1');
      // B's tasks, reachable from a1 only sideways through a shared hub.
      await task('b1', 'working');
      await task('b2', 'open', 'b1');
      await doc('hub');
      await edge('a1', 'hub', 'attached_to');
      await edge('b1', 'hub', 'attached_to');
      // Child story C (parent_id = A) holds c1, which also leaks toward A.
      await task('c1', 'open');
      await edge('c1', 'hub', 'attached_to');

      await edge('storyA', 'a1', 'contains');
      await edge('storyB', 'b1', 'contains');
      await edge('storyC', 'c1', 'contains');
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('the trail still reaches the other stories (shown, not counted)', async () => {
    const trail = await asOwner(async (c) =>
      (await c.query<{ entity_id: string }>(`select entity_id from internal.story_trail($1)`, [id['storyA']])).rows);
    expect(trail.map((r) => r.entity_id)).toEqual(expect.arrayContaining([id['b1'], id['c1']]));
  });

  it('taskProgress counts only the root and its hierarchy, at any depth', async () => {
    const s = await summary(id['storyA']!);
    // a1..a5 work (a1 working, a2 done, a3-a5 open), aX cancelled; b1/b2/c1 never.
    expect(s['taskProgress']).toEqual({ work: 5, done: 1, inProgress: 1, toDo: 3, blocked: 0, cancelled: 1, staleInProgress: 1 });
  });

  it('progress counts tasks and child stories, never the hub doc', async () => {
    const s = await summary(id['storyA']!);
    // 5 working tasks + child story C (to_do at birth).
    expect(s['progress']['work']).toBe(6);
    expect(s['progress']['cancelled']).toBe(1);
  });

  it('rollup adds the child story tasks once, not the sibling story', async () => {
    const s = await summary(id['storyA']!);
    expect(s['rollup']['work']).toBe(6);
    expect(s['rollup']['cancelled']).toBe(1);
  });

  it('a story whose tasks leak toward another counts only its own', async () => {
    expect((await summary(id['storyC']!))['taskProgress']['work']).toBe(1);
    expect((await summary(id['storyB']!))['taskProgress']['work']).toBe(2);
  });

  it('the page root agrees with entity_tree (what --subtree reads)', async () => {
    const { page, subtree } = await asOwner(async (c) => ({
      page: await loadStoryPage(querierOf(c), id['storyA']!),
      subtree: (await c.query<{ n: number; tasks: number }>(
        `select count(*)::int n, count(*) filter (where kind = 'task')::int tasks
           from public.entity_tree($1, 32) where depth > 0`, [id['a1']])).rows[0]!,
    }));
    const root = page.roots.find((r) => r.id === id['a1'])!;
    expect(root.descendantCount).toBe(subtree.n); // a2..a5, aX
    expect(subtree.n).toBe(5);
    // root (a task) + subtree tasks = work + cancelled
    expect(root.taskProgress.work + root.taskProgress.cancelled).toBe(1 + subtree.tasks);
    expect(root.taskProgress.work).toBe(5);
  });
});
