/**
 * Story progress counts work, not furniture (issues #3 #15, task 01a0fe59).
 *
 * #3: team_members, docs and forms carry status_category to_do, so a story
 * whose tasks were all done read 2/40. 289's `story_work` counts tasks and
 * stories only; this pins that for roots of every non-work kind AND their
 * (same-kind, per 001) hierarchy children, in progress, taskProgress, rollup
 * and the page's per-root tallies.
 *
 * #15: a crashed session (status failed, ended_kind crashed) keeps
 * status_category in_progress — 174's board ruling, so Resume is offered —
 * and the story showed it as in progress beside liveSessionCount 0. On the
 * story a session whose runtime ended is not live work, and it never reaches
 * a tally. Since 302 (Spec D1) it is not `done` either — its work is open — so
 * the story files it under no category until it is completed or stopped.
 */
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Querier } from '../../src/db/types.js';
import { loadStoryPage } from '../../src/facade/story-page.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const IDENTITY = 'story-kinds-probe';

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

describe('story progress counts only work-bearing kinds', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('story_kinds');
    database.apply(migrationFiles());

    await asOwner(async (c) => {
      const names = ['space', 'member', 'anchor', 'story', 'child',
        't1', 't2', 't3', 'd1', 'd2', 'd3', 'f1', 'f2', 'tm', 'ws1', 'ws2', 'ws3'];
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
          [id[key], id['space'], kind, pos++, key === 'member' ? id[key] : id['member'], parent ? id[parent] : null],
        );
      };
      await entity('member', 'member');
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name)
         values ($1, $2, $3, 'owner', 'probe')`,
        [id['member'], id['space'], IDENTITY],
      );
      const task = async (key: string, status: string, parent: string | null = null) => {
        await entity(key, 'task', parent);
        await c.query(`insert into public.tasks(entity_id, title, work_status) values ($1, $2, $3)`,
          [id[key], key, status]);
      };
      const doc = async (key: string, parent: string | null = null) => {
        await entity(key, 'doc', parent);
        await c.query(`insert into public.documents(entity_id, title, body, format) values ($1, $2, 'x', 'markdown')`,
          [id[key], key]);
      };
      const form = async (key: string, parent: string | null = null) => {
        await entity(key, 'form', parent);
        await c.query(`insert into public.forms(entity_id, title, status, settings) values ($1, $2, 'open', '{}'::jsonb)`,
          [id[key], key]);
      };
      const crashed = async (key: string, parent: string | null = null) => {
        await entity(key, 'work_session', parent);
        await c.query(
          `insert into public.work_sessions(entity_id, title, status, workdir_mode, ended_kind)
           values ($1, $2, 'failed', 'project', 'crashed')`,
          [id[key], key],
        );
      };
      const story = async (key: string, parent: string | null = null) => {
        await entity(key, 'story', parent);
        await c.query(`insert into public.stories(entity_id, title) values ($1, $2)`, [id[key], key]);
      };
      const contains = async (dst: string, src = 'story') => {
        await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'contains', $4)`,
          [id['space'], id[src], id[dst], id['member']]);
      };

      await task('anchor', 'open');
      await story('story');
      await story('child', 'story');
      // Root t1 (open) holds a done subtask.
      await task('t1', 'open');
      await task('t2', 'done', 't1');
      // Non-work roots: a teammate, a doc, a form, a crashed session. Hierarchy
      // is same-kind (001), so their children (d1, f1, ws1) are non-work too.
      await entity('tm', 'team_member');
      await c.query(
        `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
         values ($1, $2, 'Runner', '', 'persona')`,
        [id['tm'], id['member']],
      );
      await doc('d2');
      await doc('d1', 'd2');
      await form('f2');
      await form('f1', 'f2');
      await crashed('ws2');
      await crashed('ws1', 'ws2');
      // The child story: one working task, a doc and a crashed session.
      await task('t3', 'working');
      await doc('d3');
      await crashed('ws3');

      for (const r of ['t1', 'tm', 'd2', 'f2', 'ws2']) await contains(r);
      for (const r of ['t3', 'd3', 'ws3']) await contains(r, 'child');
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('the fixture reproduces both reports: to_do furniture, an in_progress crashed session', async () => {
    const cats = await asOwner(async (c) =>
      (await c.query<{ id: string; status_category: string }>(
        `select id, status_category from public.entities where id = any($1::uuid[])`,
        [[id['tm'], id['d2'], id['f2'], id['ws2']]])).rows);
    const of = new Map(cats.map((r) => [r.id, r.status_category]));
    expect(of.get(id['d2']!)).toBe('to_do');
    expect(of.get(id['f2']!)).toBe('to_do');
    expect(of.get(id['tm']!)).toBe('to_do');
    // 174 still files it under in_progress for the board; the story must not.
    expect(of.get(id['ws2']!)).toBe('in_progress');
  });

  it('progress counts the tasks and child story only', async () => {
    const s = await summary(id['story']!);
    // t1 open, t2 done, child story (to_do at birth). No doc, form, teammate or session.
    expect(s['progress']).toEqual({ work: 3, done: 1, inProgress: 0, toDo: 2, blocked: 0, cancelled: 0, staleInProgress: 0 });
    expect(s['taskProgress']).toEqual({ work: 2, done: 1, inProgress: 0, toDo: 1, blocked: 0, cancelled: 0, staleInProgress: 0 });
  });

  it('a crashed session never inflates inProgress in progress or rollup', async () => {
    const s = await summary(id['story']!);
    expect(s['liveSessionCount']).toBe(0);
    expect(s['progress']['inProgress']).toBe(0);
    // rollup: t1, t2 and the child's t3 (working) — the child's crashed ws3 is not counted.
    expect(s['rollup']).toEqual({ work: 3, done: 1, inProgress: 1, toDo: 1, blocked: 0, cancelled: 0, staleInProgress: 1 });
    const child = await summary(id['child']!);
    expect(child['liveSessionCount']).toBe(0);
    expect(child['progress']).toEqual({ work: 1, done: 0, inProgress: 1, toDo: 0, blocked: 0, cancelled: 0, staleInProgress: 1 });
  });

  it('the page tallies no non-work root and shows a crashed session as terminal', async () => {
    const page = await asOwner(async (c) => loadStoryPage(querierOf(c), id['story']!));
    const root = (key: string) => page.roots.find((r) => r.id === id[key])!;

    expect(root('t1').progress).toEqual({ work: 2, done: 1, inProgress: 0, toDo: 1, blocked: 0, cancelled: 0, staleInProgress: 0 });
    for (const key of ['tm', 'd2', 'f2', 'ws2']) {
      expect(root(key).progress.work).toBe(0);
      expect(root(key).taskProgress.work).toBe(0);
    }

    // Spec D1 §5.7 (302): a crashed session's WORK is still open, so it is not
    // done; and its process ended, so it is not in progress either (#15). On
    // the story page it counts toward nothing: no category.
    expect(root('ws2').statusCategory).toBeNull();
    const node = (key: string) => page.nodes.find((n) => n.id === id[key]);
    for (const key of ['ws1', 'ws2']) {
      const n = node(key);
      expect(n?.live).toBe(false);
      expect(n?.statusCategory).toBeNull();
    }
    // Other kinds keep their own category.
    expect(node('t1')?.statusCategory).toBe('to_do');
  });
});
