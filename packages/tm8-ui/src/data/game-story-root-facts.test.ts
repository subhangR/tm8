import { describe, expect, it, vi } from 'vitest';
import type { CollectionQuery, EntityDetail, EntitySummary } from '@tm8/contract';
import { createGameMapLoader } from './game-maps';
import type { Seam } from './seam';
import { buildMapModel, fromProjection } from '../story/game/map-model';

const SPACE = 'space';
const ROOT = 'root';
const CHILD = 'child';
const summary = (id: string, parentId: string | null, estimate: number | null,
  acceptance: { total: number; completed: number }, status: string, size: number): EntitySummary => ({
  id, kind: 'task', title: id, parentId, spaceId: SPACE, version: 7,
  updatedAt: '2026-10-08T12:00:00Z', category: status === 'done' ? 'done' : status === 'cancelled' ? 'cancelled' : 'in_progress',
  state: { kind: 'task', status, acceptance,
    progress: { percent: 25, size, own: acceptance.total ? acceptance.completed / acceptance.total : null, tent: estimate === null } },
  counters: { messages: 3 }, badges: { attention: { pendingCount: 0 } },
} as unknown as EntitySummary);

describe('canonical story root facts', () => {
  it.each([
    { name: 'unticked criteria and a shipped child', estimate: 3, total: 3, completed: 0, childStatus: 'done', expected: .25 },
    { name: 'a tent without criteria', estimate: null, total: 0, completed: 0, childStatus: 'done', expected: 1 },
    { name: 'all criteria ticked', estimate: 3, total: 3, completed: 3, childStatus: 'done', expected: 1 },
    { name: 'a cancelled child', estimate: 3, total: 3, completed: 0, childStatus: 'cancelled', expected: 0 },
  ])('keeps story and space construction in parity for $name', async ({ estimate, total, completed, childStatus, expected }) => {
    const acceptance = { total, completed };
    const rootSize = (estimate ?? 1) + (childStatus === 'cancelled' ? 0 : 1);
    const root = summary(ROOT, null, estimate, acceptance, 'working', rootSize);
    const child = summary(CHILD, ROOT, 1, { total: 0, completed: 0 }, childStatus, childStatus === 'cancelled' ? 0 : 1);
    const rootFacts = { id: ROOT, kind: 'task', title: ROOT, status: 'working',
      pointsEstimate: estimate, acceptance, version: root.version, updatedAt: root.updatedAt,
      weighted: { percent: 25, size: rootSize } };
    const seam = {
      spaces: vi.fn(async () => [{ id: SPACE, name: SPACE }]),
      entity: vi.fn(async () => ({ id: 'story', kind: 'story', spaceId: SPACE, title: 'Story', content: { kind: 'story', page: {
        nodes: [{ id: ROOT, kind: 'task', title: ROOT, status: 'working', counts: { messages: 3 } }],
        roots: [rootFacts], edges: [], sessions: [], team: [], childStories: [],
        follow: { depth: 3, limit: 500, truncated: false },
      } } } as unknown as EntityDetail)),
      query: vi.fn(async (q: CollectionQuery) => ({ page: { items: q.subtreeOf ? [child] : [root, child], nextCursor: null } })),
      graph: vi.fn(async () => ({ nodes: [root, child, summary('unrelated', null, 13, acceptance, 'working', 13)], edges: [], clusters: [] })),
      liveness: { statusOf: vi.fn(() => 'unknown') },
    };
    const load = createGameMapLoader(seam as unknown as Seam, SPACE);
    const space = (await load({ kind: 'space', id: SPACE }, undefined, 'taskland')).input;
    const story = (await load({ kind: 'story', id: 'story' }, undefined, 'taskland')).input;
    expect(story.entities.map(e => e.id)).toEqual([ROOT, CHILD]);
    expect(story.entities[0]).toMatchObject({ pointsEstimate: estimate, acceptance,
      version: 7, updatedAt: root.updatedAt, mailbox: { count: 3 } });
    const model = (input: typeof space) => buildMapModel(input, { type: 'taskland', scope: input.scope! });
    const facts = (input: typeof space) => model(input).places.map(p => ({ id: p.id, progress: p.progress,
      subtreeWeight: p.subtreeWeight, sizeBucket: p.sizeBucket, constructionStage: p.constructionStage,
      estimateMissing: p.estimateMissing }));
    expect(facts(story)).toEqual(facts(space));
    expect(model(story).places.find(p => p.id === ROOT)?.progress).toBe(expected);
    if (estimate === 3 && completed === 0 && childStatus === 'done') {
      const beforeInput = { ...story, entities: story.entities.map(e => e.id === CHILD ? { ...e, status: 'open' } : e) };
      const before = model(beforeInput);
      const after = buildMapModel(story, { type: 'taskland', scope: story.scope!, previous: before });
      const lot = (m: typeof before) => {
        const p = m.places.find(p => p.id === ROOT)!;
        return { x: p.x, z: p.z, radius: p.radius, sizeBucket: p.sizeBucket, estimateMissing: p.estimateMissing };
      };
      expect(lot(after)).toEqual(lot(before));
      expect(lot(after)).toMatchObject({ sizeBucket: 5, estimateMissing: false });
    }
    expect(seam.entity).toHaveBeenCalledTimes(1);
    expect(seam.query.mock.calls[1]![0]).toMatchObject({ subtreeOf: ROOT, kinds: ['task'], limit: 200 });
  });

  it('preserves node facts for older roots, and explicit nulls clear only supplied facts', () => {
    const node = { id: ROOT, kind: 'task', parentId: 'parent', status: 'cancelled', pointsEstimate: 8,
      acceptance: { total: 2, completed: 1 }, version: 4, updatedAt: '2026-10-08T12:00:00Z',
      statusChangedAt: '2026-10-08T10:00:00Z', live: true, outcome: 'completed', counts: { messages: 6 } };
    const project = (root: object) => fromProjection({ page: { nodes: [node], roots: [{ id: ROOT, kind: 'task', status: 'cancelled', ...root }], edges: [] } }).entities[0]!;
    expect(project({ pointsEstimate: undefined })).toMatchObject({ pointsEstimate: 8, acceptance: node.acceptance,
      version: 4, updatedAt: node.updatedAt, cancelledAt: node.statusChangedAt });
    expect(project({ pointsEstimate: null, acceptance: { total: 0, completed: 0 }, statusChangedAt: null, version: 7 })).toMatchObject({
      pointsEstimate: null, acceptance: { total: 0, completed: 0 }, cancelledAt: null, version: 7,
      parentId: 'parent', mailbox: { count: 6 }, live: true, outcome: 'completed', updatedAt: node.updatedAt,
    });
    expect(project({ statusChangedAt: '2026-10-08T11:00:00Z' }).cancelledAt).toBe('2026-10-08T11:00:00Z');
  });

  it('keeps old sparse roots unknown without substituting aggregate weight or an update clock', () => {
    const input = fromProjection({ id: 'story', kind: 'story', page: { nodes: [{ id: ROOT, kind: 'task', status: 'working' }], edges: [],
      roots: [{ id: ROOT, kind: 'task', status: 'working', updatedAt: '2026-10-08T12:00:00Z', weighted: { percent: 25, size: 13 } }],
      follow: { depth: 3, truncated: true },
    } });
    expect(input.entities[0]).toMatchObject({ pointsEstimate: null, subtreeWeight: 13, cancelledAt: null });
    expect(input.entities[0]?.acceptance).toBeUndefined();
    expect(input.entities[0]?.estimateTent).toBeUndefined();
    const model = buildMapModel(input, { type: 'taskland', scope: { kind: 'story', id: 'story' } });
    expect(model.places[0]?.estimateMissing).toBe(true);
    expect(input.warnings).toEqual(expect.arrayContaining([expect.stringContaining('depth 3'), expect.stringContaining('truncated')]));
  });
});
