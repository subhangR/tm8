/**
 * 307 against a real Postgres: points-weighted task and story progress (task
 * 01a111b4, spec doc 01a111ba). The worked examples E1-E9 are the spec's,
 * numbered the same; D3 is E2 — a done root with an open 8-point child is
 * 1/9, not 100%, while its own completion stays 1.
 */
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const IDENTITY = 'task-progress-probe';

let database: W1ScratchDatabase;
const id: Record<string, string> = {};

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function task(key: string): Promise<Record<string, any>> {
  return asOwner(async (c) => (await c.query(`select internal.task_progress($1) p`, [id[key]])).rows[0]!.p);
}

async function story(key: string): Promise<Record<string, any>> {
  return asOwner(async (c) => (await c.query(`select internal.story_summary($1) s`, [id[key]])).rows[0]!.s['weighted']);
}

const criteria = (ticked: number, total: number) =>
  JSON.stringify(Array.from({ length: total }, (_, i) => ({ id: `ac${i + 1}`, text: `c${i + 1}`, done: i < ticked })));

const NAMES = ['space', 'anchor',
  'e1', 'd3root', 'd3child', 'e3p', 'e3a', 'e3b', 'e4p', 'e4a', 'e4b', 'e5p', 'e5x',
  'r', 't', 'e7', 'e8', 'e9', 'f1', 'f2', 'cx', 'cxChild', 'live1', 'live2', 'live3', 'liveCx',
  'storyD3', 'storyS', 'storyS2', 'storyEmpty', 'storyCx', 'storyLive', 'storyLiveParent', 'storyLate', 'storyF'];

/** Event ids emitted after `mark`, as `<event_type>:<key>` with `derived` noted. */
async function eventsSince(mark: string): Promise<string[]> {
  const keyOf = new Map(Object.entries(id).map(([k, v]) => [v, k]));
  return asOwner(async (c) => (await c.query<{ id: string; event_type: string; derived: string | null }>(
    `select payload->>'id' id, event_type, payload->>'derived' derived
       from public.workspace_events where space_id = $1 and seq > $2::bigint order by seq`,
    [id['space'], mark])).rows.map((r) => `${r.event_type}:${keyOf.get(r.id) ?? r.id}${r.derived ? `(${r.derived})` : ''}`));
}

async function seqMark(): Promise<string> {
  return asOwner(async (c) => (await c.query<{ s: string | null }>(
    'select max(seq)::text s from public.workspace_events where space_id = $1', [id['space']])).rows[0]!.s ?? '0');
}

describe('307 task and story progress', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('task_progress');
    database.apply(migrationFiles());

    await asOwner(async (c) => {
      const rows = (await c.query<{ ids: string[] }>(
        `select array(select internal.new_id() from generate_series(1, $1)) ids`, [NAMES.length])).rows[0]!.ids;
      NAMES.forEach((n, i) => { id[n] = rows[i]!; });

      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'probe')`, [IDENTITY]);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'probe', $2)`,
        [id['space'], IDENTITY]);
      let pos = 0;
      const entity = async (key: string, kind: string, parent: string | null) => {
        await c.query(
          `insert into public.entities(id, space_id, kind, position, created_by, parent_id)
           values ($1, $2, $3, $4, $5, $6)`,
          [id[key], id['space'], kind, pos++, key === 'anchor' ? id[key] : id['anchor'], parent ? id[parent] : null],
        );
      };
      const mk = async (key: string, o: { status?: string; parent?: string; points?: number | null; crit?: [number, number] } = {}) => {
        await entity(key, 'task', o.parent ?? null);
        await c.query(
          `insert into public.tasks(entity_id, title, work_status, points_estimate, acceptance_criteria)
           values ($1, $2, $3, $4, $5::jsonb)`,
          [id[key], key, o.status ?? 'open', o.points ?? null, o.crit ? criteria(...o.crit) : '[]'],
        );
      };
      const st = async (key: string, parent: string | null = null) => {
        await entity(key, 'story', parent);
        await c.query(`insert into public.stories(entity_id, title) values ($1, $2)`, [id[key], key]);
      };
      const contains = async (s: string, dst: string) => {
        await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'contains', $4)`,
          [id['space'], id[s], id[dst], id['anchor']]);
      };

      await mk('anchor');
      await mk('e1', { points: 2, crit: [3, 4] });
      await mk('d3root', { status: 'done' });
      await mk('d3child', { parent: 'd3root', points: 8 });
      await mk('e3p', { crit: [1, 2] });
      await mk('e3a', { parent: 'e3p', status: 'done' });
      await mk('e3b', { parent: 'e3p', points: 3, crit: [0, 3] });
      await mk('e4p');
      await mk('e4a', { parent: 'e4p', points: 2, status: 'done' });
      await mk('e4b', { parent: 'e4p', points: 2, crit: [1, 2] });
      await mk('e5p', { points: 1, crit: [1, 1] });
      await mk('e5x', { parent: 'e5p', points: 5, status: 'cancelled' });
      await mk('r', { points: 2, crit: [1, 2] });
      await mk('t', { points: 1, status: 'done' });
      await mk('e7', { points: 0, crit: [1, 2] });
      // The completion gate refuses done with unticked criteria, so E8 is a
      // task whose criteria were added after it was done.
      await mk('e8', { status: 'done' });
      await c.query(`update public.tasks set acceptance_criteria = $2::jsonb where entity_id = $1`, [id['e8'], criteria(1, 3)]);
      await mk('e9', { status: 'working' });
      await mk('f1', { crit: [1, 3] });
      await mk('f2', { crit: [2, 3] });
      await mk('cx', { status: 'cancelled' });
      await mk('cxChild', { parent: 'cx', points: 4 });
      await mk('live1', { points: 2 });
      await mk('live2', { parent: 'live1', points: 3, crit: [0, 2] });
      await mk('live3', { parent: 'live2', crit: [0, 1] });
      await mk('liveCx', { parent: 'live1', points: 1 });

      await st('storyD3');
      await contains('storyD3', 'd3root');
      await st('storyS');
      await st('storyS2', 'storyS');
      await contains('storyS', 'r');
      await contains('storyS2', 'r');
      await contains('storyS2', 't');
      await st('storyEmpty');
      await st('storyCx');
      await contains('storyCx', 'cx');
      await contains('storyCx', 'e1');
      await st('storyLiveParent');
      await st('storyLive', 'storyLiveParent');
      await contains('storyLive', 'live1');
      await st('storyLate');
      await st('storyF');
      await contains('storyF', 'f1');
      await contains('storyF', 'f2');
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('E1: a leaf is its criteria ratio', async () => {
    expect(await task('e1')).toMatchObject({ percent: 75, earned: 1.5, total: 2, size: 2, own: 0.75, tent: false, openSubtasks: 0 });
  });

  it('E2 (D3): a done root with an open 8-point child is 1/9, its own completion stays 1', async () => {
    expect(await task('d3root')).toMatchObject({ percent: 11, earned: 1, total: 9, size: 9, own: 1, tent: true, openSubtasks: 1 });
    expect(await story('storyD3')).toMatchObject({ percent: 11, earned: 1, total: 9, tasks: 2, open: 1 });
  });

  it('E3: missing estimates weigh 1 and are counted as tents', async () => {
    expect(await task('e3p')).toMatchObject({ percent: 30, earned: 1.5, total: 5, own: 0.5, tent: true, tents: 2 });
  });

  it('E4: a container without criteria is counted with no progress until done (form 01a111fd)', async () => {
    expect(await task('e4p')).toMatchObject({ percent: 60, earned: 3, total: 5, size: 5, own: 0, openSubtasks: 1 });
  });

  it('E5: a cancelled child drops out with its weight', async () => {
    expect(await task('e5p')).toMatchObject({ percent: 100, total: 1, size: 1, openSubtasks: 0 });
  });

  it('E6: a story weighs the distinct tasks of itself and its child stories', async () => {
    expect(await story('storyS')).toMatchObject({ percent: 66, earned: 2, total: 3, tasks: 2 });
    expect(await story('storyS2')).toMatchObject({ percent: 66, earned: 2, total: 3, tasks: 2 });
  });

  it('E7: an estimate of 0 reads as missing', async () => {
    expect(await task('e7')).toMatchObject({ percent: 50, total: 1, tent: true });
  });

  it('E8: done wins over criteria added later and unticked', async () => {
    expect(await task('e8')).toMatchObject({ percent: 100, own: 1 });
  });

  it('E9: an open leaf without criteria is 0% whatever its status', async () => {
    expect(await task('e9')).toMatchObject({ percent: 0, own: 0 });
  });

  it('rounds down, but 1/3 + 2/3 is a whole 50%', async () => {
    expect(await story('storyF')).toMatchObject({ percent: 50, earned: 1, total: 2 });
    expect(await task('f1')).toMatchObject({ percent: 33 });
  });

  it('a story with no tasks has no percent; a cancelled root takes its subtree out', async () => {
    expect((await story('storyEmpty'))['percent']).toBeNull();
    expect(await story('storyCx')).toMatchObject({ percent: 75, total: 2, tasks: 1 });
  });

  describe('live fan-out', () => {
    it('a tick re-emits each ancestor and containing story once, marked derived', async () => {
      const mark = await seqMark();
      await asOwner(async (c) => {
        await c.query(`update public.tasks set acceptance_criteria = $2::jsonb where entity_id = $1`, [id['live3'], criteria(1, 1)]);
        await c.query(`update public.tasks set points_estimate = 5 where entity_id = $1`, [id['live3']]);
      });
      const derived = (await eventsSince(mark)).filter((e) => e.endsWith('(progress)'));
      expect(derived.sort()).toEqual([
        'entity.upsert:live1(progress)', 'entity.upsert:live2(progress)', 'entity.upsert:live3(progress)',
        'entity.upsert:storyLive(progress)', 'entity.upsert:storyLiveParent(progress)',
      ]);
      // live1 0·2, live2 0·3, live3 1·5, liveCx 0·1.
      expect(await task('live1')).toMatchObject({ earned: 5, total: 11, size: 11 });
    });

    it('cancelling a subtask re-emits its parent and story but not itself', async () => {
      const mark = await seqMark();
      await asOwner(async (c) => {
        await c.query(`update public.tasks set work_status = 'cancelled' where entity_id = $1`, [id['liveCx']]);
      });
      const derived = (await eventsSince(mark)).filter((e) => e.endsWith('(progress)'));
      expect(derived).toContain('entity.upsert:live1(progress)');
      expect(derived).toContain('entity.upsert:storyLive(progress)');
      expect(derived).not.toContain('entity.upsert:liveCx(progress)');
    });

    it('a story gaining a root is re-emitted', async () => {
      const mark = await seqMark();
      await asOwner(async (c) => {
        await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'contains', $4)`,
          [id['space'], id['storyLate'], id['e1'], id['anchor']]);
      });
      expect(await eventsSince(mark)).toContain('entity.upsert:storyLate(progress)');
      expect(await story('storyLate')).toMatchObject({ percent: 75 });
    });
  });
});
