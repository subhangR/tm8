import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StoryStateSchema, type StoryProgress } from '@tm8/contract';
import type { Querier } from '../../src/db/types.js';
import { loadStoryPage } from '../../src/facade/story-page.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });
let database: W1ScratchDatabase;
const id: Record<string, string> = {};
async function owner<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    return fn(c);
  });
}
function querier(c: PoolClient): Querier {
  return { query: async <R>(sql: string, params: readonly unknown[] = []) =>
    (await c.query(sql, [...params])).rows as R[], rpc: async () => { throw new Error('unused'); } } as Querier;
}
async function tally(c: PoolClient, keys: string[]): Promise<StoryProgress> {
  return (await c.query('select internal.story_tally($1::uuid[]) as t', [keys.map((k) => id[k])])).rows[0].t;
}
async function edge(c: PoolClient, src: string, dst: string, type: string, props = {}): Promise<void> {
  await c.query(`insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values ($1,$2,$3,$4,$5,$6)`, [id.space, id[src], id[dst], type, props, id.member]);
}
const empty = { work: 0, done: 0, inProgress: 0, toDo: 0, blocked: 0, cancelled: 0, staleInProgress: 0 };

describe('story stale work signal and blocked bands', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('story_stale');
    database.apply(migrationFiles());
    await owner(async (c) => {
      const keys = ['space', 'member', 'story', 'child', 'other', 'task', 'review', 'blocked', 'hard', 'soft',
        'resolved', 'done', 'cancelled', 'open', 'foreign', 'session', 'dead', 'deleted', 'spawning', 'idle', 'exited', 'failed'];
      const ids = (await c.query('select array(select internal.new_id() from generate_series(1,$1)) ids', [keys.length])).rows[0].ids;
      keys.forEach((key, i) => { id[key] = ids[i]; });
      await c.query("insert into public.user_profiles(identity_id, display_name) values ('story-stale','probe')");
      await c.query("insert into public.spaces(id,name,created_by_identity) values ($1,'probe','story-stale')", [id.space]);
      let position = 0;
      const entity = async (key: string, kind: string, parent: string | null = null) => {
        await c.query(`insert into public.entities(id,space_id,kind,position,created_by,parent_id)
          values ($1,$2,$3,$4,$5,$6)`, [id[key], id.space, kind, position++, id.member, parent ? id[parent] : null]);
      };
      await entity('member', 'member');
      await c.query(`insert into public.members(entity_id,space_id,identity_id,role,display_name)
        values ($1,$2,'story-stale','owner','probe')`, [id.member, id.space]);
      for (const key of ['story', 'child', 'other']) {
        await entity(key, 'story', key === 'child' ? 'story' : null);
        await c.query('insert into public.stories(entity_id,title) values ($1,$2)', [id[key], key]);
      }
      for (const [key, status] of Object.entries({ task: 'working', review: 'in_review', blocked: 'blocked',
        hard: 'working', soft: 'working', resolved: 'working', done: 'done', cancelled: 'cancelled', open: 'open', foreign: 'working' })) {
        await entity(key, 'task');
        await c.query('insert into public.tasks(entity_id,title,work_status) values ($1,$2,$3)', [id[key], key, status]);
      }
      for (const key of ['session', 'dead', 'deleted', 'spawning', 'idle', 'exited', 'failed']) {
        await entity(key, 'work_session');
        await c.query(`insert into public.work_sessions(entity_id,title,status,workdir_mode,ended_kind)
          values ($1,$2,$3,'project',$4)`, [id[key], key, key === 'dead' ? 'failed' : ['session', 'deleted'].includes(key) ? 'running' : key, ['dead', 'failed'].includes(key) ? 'crashed' : null]);
      }
      await c.query('update public.entities set deleted_at = now() where id = $1', [id.deleted]);
      await edge(c, 'story', 'task', 'contains');
      await edge(c, 'child', 'task', 'contains'); // parent/child overlap counts once
      await edge(c, 'child', 'review', 'contains');
      await edge(c, 'other', 'foreign', 'contains');
      await edge(c, 'dead', 'task', 'working_on');
      await edge(c, 'deleted', 'task', 'working_on');
      await edge(c, 'session', 'foreign', 'working_on');
      await c.query(`select internal.w1_set_writer('entity_recorder')`);
      await edge(c, 'task', 'session', 'authored_from'); // sideways live evidence is insufficient
      await c.query(`select internal.w1_set_writer(null)`);
      await edge(c, 'hard', 'open', 'depends_on');
      await edge(c, 'soft', 'open', 'depends_on', { hard: false });
      await edge(c, 'resolved', 'done', 'depends_on');
      await edge(c, 'done', 'open', 'depends_on');
      await edge(c, 'cancelled', 'open', 'depends_on');
    });
  });
  afterAll(async () => { await database?.destroy(); });

  it('flags working/review tasks, ignores crashed/deleted/indirect sessions and duplicate ids', async () => {
    await owner(async (c) => {
      expect(await tally(c, ['task', 'review', 'task'])).toEqual({ ...empty, work: 2, inProgress: 2, staleInProgress: 2 });
      expect(await tally(c, ['foreign'])).toEqual({ ...empty, work: 1, inProgress: 1 });
      expect(await tally(c, [])).toEqual(empty);
    });
  });

  it.each(['spawning', 'running', 'idle'])('a direct %s session clears the flag without changing task status', async (status) => {
    await owner(async (c) => {
      await c.query('savepoint scenario');
      await edge(c, status === 'running' ? 'session' : status, 'task', 'working_on');
      expect(await tally(c, ['task'])).toEqual({ ...empty, work: 1, inProgress: 1 });
      expect((await c.query('select work_status from public.tasks where entity_id = $1', [id.task])).rows[0].work_status).toBe('working');
      await c.query('rollback to savepoint scenario');
    });
  });

  it.each(['exited', 'failed'])('a direct %s session does not clear the flag', async (status) => {
    await owner(async (c) => {
      await c.query('savepoint scenario');
      await edge(c, status === 'running' ? 'session' : status, 'task', 'working_on');
      expect((await tally(c, ['task'])).staleInProgress).toBe(1);
      await c.query('rollback to savepoint scenario');
    });
  });

  it('keeps blocked bands disjoint and ignores soft/resolved blockers', async () => {
    await owner(async (c) => {
      const t = await tally(c, ['blocked', 'hard', 'soft', 'resolved', 'done', 'cancelled', 'open']);
      expect(t).toEqual({ work: 6, done: 1, inProgress: 2, toDo: 1, blocked: 2, cancelled: 1, staleInProgress: 2 });
      expect(t.done + t.inProgress + t.toDo + t.blocked).toBe(t.work);
      await c.query('savepoint page_block');
      await edge(c, 'story', 'blocked', 'contains');
      const page = await loadStoryPage(querier(c), id.story!);
      expect(page.roots.find((r) => r.id === id.blocked)).toMatchObject({ blocked: true, taskProgress: { blocked: 1, staleInProgress: 0 } });
      expect(page.nodes.find((r) => r.id === id.blocked)?.blocked).toBe(true);
      await c.query('rollback to savepoint page_block');
    });
  });

  it('keeps security-invoker visibility and supports the app role', async () => {
    await database.transaction(async (c) => {
      const fn = (await c.query(`select p.prosecdef, pg_get_userbyid(p.proowner) owner
        from pg_proc p where p.oid = 'internal.story_tally(uuid[])'::regprocedure`)).rows[0];
      expect(fn).toMatchObject({ prosecdef: false, owner: 'tm8_graph_owner' });
      await c.query('set local role tm8_app');
      await c.query(`select set_config('tm8.identity_id','story-stale',true),
        set_config('tm8.actor_id','',true),set_config('tm8.node_admin','false',true)`);
      expect(await tally(c, ['task', 'foreign'])).toEqual({ ...empty, work: 2, inProgress: 2, staleInProgress: 1 });
      await c.query("select set_config('tm8.identity_id','unrelated-reader',true)");
      expect(await tally(c, ['task', 'foreign'])).toEqual(empty);
    });
  });

  it('propagates to root/child tallies, deduplicates rollup, preserves manual story status and old snapshots', async () => {
    await owner(async (c) => {
      const s = (await c.query('select internal.story_summary($1) s', [id.story])).rows[0].s;
      expect(StoryStateSchema.safeParse(s).success).toBe(true);
      expect(s.progress).toEqual({ ...empty, work: 2, inProgress: 1, toDo: 1, staleInProgress: 1 });
      expect(s.taskProgress).toEqual({ ...empty, work: 1, inProgress: 1, staleInProgress: 1 });
      expect(s.rollup).toEqual({ ...empty, work: 2, inProgress: 2, staleInProgress: 2 });
      const page = await loadStoryPage(querier(c), id.story!);
      expect(page.roots.find((r) => r.id === id.task)?.taskProgress).toEqual(s.taskProgress);
      expect(page.childStories.find((r) => r.id === id.child)?.rollup).toEqual(s.rollup);
      expect((await c.query('select status_category from public.entities where id = $1', [id.story])).rows[0].status_category).toBe('to_do');
      for (const key of ['progress', 'taskProgress', 'rollup']) delete s[key].staleInProgress;
      expect(StoryStateSchema.safeParse(s).success).toBe(true);
    });
  });
});
