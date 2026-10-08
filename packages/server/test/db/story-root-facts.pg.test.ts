import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Querier } from '../../src/db/types.js';
import { loadStoryPage } from '../../src/facade/story-page.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });
let database: W1ScratchDatabase;
const ids: Record<string, string> = {};
const criteria = [
  { id: 'a', text: 'Private criterion text', done: false },
  { id: 'b', text: 'Second criterion', done: false },
  { id: 'c', text: 'Third criterion', done: false },
];
const owner = <T>(fn: (c: PoolClient) => Promise<T>) => database.transaction(async c => {
  await c.query('set local role tm8_graph_owner');
  return fn(c);
});
const querier = (c: PoolClient, log: string[] = []): Querier => ({
  query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => {
    log.push(sql);
    return (await c.query(sql, [...params])).rows as R[];
  },
  rpc: async () => { throw new Error('not used'); },
} as Querier);

describe('StoryPage canonical own root facts', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('story_root_facts');
    database.apply(migrationFiles());
    await owner(async c => {
      const names = ['space', 'member', 'story', 'root', 'child', 'sideways', 'zero', 'missing'];
      const generated = (await c.query<{ ids: string[] }>(
        'select array(select internal.new_id() from generate_series(1, $1)) ids', [names.length])).rows[0]!.ids;
      names.forEach((name, i) => { ids[name] = generated[i]!; });
      const identity = 'story-root-facts-probe';
      await c.query('insert into public.user_profiles(identity_id, display_name) values ($1, $1)', [identity]);
      await c.query('insert into public.spaces(id, name, created_by_identity) values ($1, $2, $2)', [ids.space, identity]);
      let position = 0;
      const entity = async (name: string, kind: string, parent: string | null = null) => c.query(
        `insert into public.entities(id, space_id, kind, position, created_by, parent_id)
         values ($1, $2, $3, $4, $5, $6)`,
        [ids[name], ids.space, kind, position++, ids.member, parent ? ids[parent] : null]);
      await entity('member', 'member');
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name)
        values ($1, $2, $3, 'owner', $3)`, [ids.member, ids.space, identity]);
      await entity('story', 'story');
      await c.query('insert into public.stories(entity_id, title) values ($1, $2)', [ids.story, 'Story']);
      for (const [name, estimate, parent, status] of [
        ['root', 3, null, 'working'], ['child', 1, 'root', 'done'],
        ['zero', 0, null, 'open'], ['missing', null, null, 'open'],
      ] as const) {
        await entity(name, 'task', parent);
        await c.query(`insert into public.tasks(entity_id, title, points_estimate, acceptance_criteria, work_status)
          values ($1, $2, $3, $4::jsonb, $5)`, [ids[name], name, estimate, JSON.stringify(name === 'root' ? criteria : []), status]);
      }
      await entity('sideways', 'doc');
      await c.query('insert into public.documents(entity_id, title) values ($1, $2)', [ids.sideways, 'Sideways output']);
      for (const name of ['root', 'zero', 'missing']) await c.query(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'contains', $4)`,
        [ids.space, ids.story, ids[name], ids.member]);
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by)
        values ($1, $2, $3, 'produces', $4)`, [ids.space, ids.root, ids.sideways, ids.member]);
    });
  });
  afterAll(async () => { await database?.destroy(); });

  it('projects the own estimate and acceptance tally from the canonical row without exposing criterion text', async () => {
    await owner(async c => {
      const log: string[] = [];
      const page = await loadStoryPage(querier(c, log), ids.story!);
      const row = (await c.query(`select e.version, e.updated_at, t.points_estimate, t.acceptance_criteria
        from public.entities e join public.tasks t on t.entity_id = e.id where e.id = $1`, [ids.root])).rows[0]!;
      const root = page.roots.find(r => r.id === ids.root)!;
      expect(root).toMatchObject({ pointsEstimate: row.points_estimate, version: row.version,
        updatedAt: row.updated_at.toISOString(), acceptance: { total: row.acceptance_criteria.length, completed: 0 } });
      expect(root.weighted).toMatchObject({ percent: 25, size: 4 });
      expect(root.pointsEstimate).not.toBe(root.weighted?.size);
      expect(root).not.toHaveProperty('acceptanceCriteria');
      expect(JSON.stringify(root)).not.toContain(criteria[0]!.text);
      // The existing bounded entity-title query is reused, with no per-root read.
      expect(log.filter(sql => sql.includes('t.acceptance_criteria'))).toHaveLength(1);
      expect(page.roots.map(r => r.id)).toEqual(expect.arrayContaining([ids.root, ids.zero, ids.missing]));
      expect(page.roots).toHaveLength(3);
      expect(page.nodes.some(n => n.id === ids.sideways)).toBe(true);
      expect(page.roots.some(r => r.id === ids.sideways)).toBe(false);
    });
  });

  it('keeps zero and null estimates distinct and derives acceptance from canonical done flags', async () => {
    await owner(async c => {
      await c.query('update public.tasks set acceptance_criteria = $2::jsonb where entity_id = $1',
        [ids.root, JSON.stringify(criteria.map((criterion, i) => ({ ...criterion, done: i < 2 })))]);
      const page = await loadStoryPage(querier(c), ids.story!);
      expect(page.roots.find(r => r.id === ids.root)?.acceptance).toEqual({ total: 3, completed: 2 });
      expect(page.roots.find(r => r.id === ids.zero)?.pointsEstimate).toBe(0);
      expect(page.roots.find(r => r.id === ids.missing)?.pointsEstimate).toBeNull();
      expect(page.roots.find(r => r.id === ids.missing)?.acceptance).toEqual({ total: 0, completed: 0 });
    });
  });
});
