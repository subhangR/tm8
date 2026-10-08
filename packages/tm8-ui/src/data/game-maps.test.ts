import { describe, expect, it, vi } from 'vitest';
import type { CollectionQuery, EdgeView, EntityDetail, EntitySummary, StoryPage } from '@tm8/contract';
import type { ConnectionOpts, Seam } from './seam';
import { createGameMapLoader } from './game-maps';

const SPACE = 'space-a';
const row = (id: string, kind = 'task', parentId: string | null = null): EntitySummary => ({
  id, kind, parentId, spaceId: SPACE, title: `Real ${id}`, category: 'in_progress',
  state: { kind, status: 'working', progress: { percent: 40, size: 5 } },
  counters: { messages: 3 }, badges: { attention: { pendingCount: 2 } },
} as unknown as EntitySummary);
const edge = (id: string, source: EntitySummary, target: EntitySummary, props = {}): EdgeView => ({
  id, type: 'depends_on', source, target, props,
} as EdgeView);
const page = (items: EntitySummary[], nextCursor: string | null = null) => ({ items, nextCursor });
function port() {
  return {
    spaces: vi.fn(async () => [{ id: SPACE, name: 'Real space' }]),
    query: vi.fn(async (_input: CollectionQuery) => ({ page: page([]) })),
    entity: vi.fn(async (_id: string): Promise<EntityDetail> => { throw new Error('not found'); }),
    connections: vi.fn(async (_id: string, _opts?: ConnectionOpts) => ({ items: [] as EdgeView[], nextCursor: null as string | null })),
    liveness: { statusOf: vi.fn(() => 'unknown' as const) },
  };
}
const load = (seam: ReturnType<typeof port>) => createGameMapLoader(seam as unknown as Seam, SPACE);
const story = (overrides: Partial<StoryPage> = {}): EntityDetail => ({
  ...row('story-a', 'story'),
  content: { kind: 'story', page: {
    roots: [{ id: 'root', kind: 'task', title: 'Root' }],
    nodes: [row('story-a', 'story'), row('root')], edges: [], sessions: [], team: [],
    childStories: [], follow: { depth: 3, limit: 500, truncated: false }, ...overrides,
  } },
} as unknown as EntityDetail);

describe('real Game map reads', () => {
  it('pages space entities and connections, preserves progress/counts, and admits only scoped endpoints', async () => {
    const seam = port(), a = row('a'), b = row('b'), unrelated = row('unrelated');
    seam.query.mockImplementation(async (input?: unknown) => ({ page: (input as { cursor?: string }).cursor ? page([b]) : page([a], 'entities-2') }));
    seam.connections.mockImplementation(async (id?: unknown, input?: unknown) => {
      if (id !== 'a') return { items: [], nextCursor: null };
      return (input as { cursor?: string }).cursor
        ? { items: [edge('ended', a, b, { endedAt: '2026-10-08' })], nextCursor: null }
        : { items: [edge('road', a, b), edge('outside', a, unrelated)], nextCursor: 'edges-2' };
    });
    const result = await load(seam)({ kind: 'space', id: SPACE });
    expect(result.title).toBe('Real space');
    expect(result.input.scope).toEqual({ kind: 'space', id: SPACE });
    expect(result.input.entities.map(e => e.id)).toEqual(['a', 'b']);
    expect(result.input.entities[0]).toMatchObject({ progress: .4, subtreeWeight: 5, status: 'working',
      statusCategory: 'in_progress', pendingAttention: 2, mailbox: { count: 3 } });
    expect(result.input.edges.map(e => e.id)).toEqual(['road', 'ended']);
    expect(result.input.edges[1]?.endedAt).toBe('2026-10-08');
    expect(seam.query.mock.calls[1]?.[0]).toMatchObject({ spaceId: SPACE, cursor: 'entities-2', limit: 200 });
    expect(seam.connections.mock.calls[0]?.[1]).toMatchObject({ limit: 200, direction: 'outgoing' });
  });

  it('keeps authoritative story membership and completes only its root hierarchy and direct child-story pages', async () => {
    const seam = port();
    seam.entity.mockResolvedValue(story({ childStories: [{ id: 'child-a', title: 'Preview' }] } as Partial<StoryPage>) as never);
    seam.query.mockImplementation(async (input?: unknown) => {
      const q = input as { parentId?: string; subtreeOf?: string; cursor?: string; kinds?: string[] };
      if (q.parentId) return { page: q.cursor ? page([row('child-b', 'story', 'story-a')]) : page([row('child-a', 'story', 'story-a')], 'children-2') };
      expect(q).toMatchObject({ subtreeOf: 'root', kinds: ['task'] });
      return { page: q.cursor ? page([row('deep', 'task', 'descendant')]) : page([row('descendant', 'task', 'root')], 'hierarchy-2') };
    });
    const result = await load(seam)({ kind: 'story', id: 'story-a' });
    expect(result.input.scope).toEqual({ kind: 'story', id: 'story-a' });
    expect(result.input.entities.map(e => e.id)).toEqual(['story-a', 'root', 'child-a', 'child-b', 'descendant', 'deep']);
    expect(result.input.entities.find(e => e.id === 'child-a')?.parentId).toBe('story-a');
    expect(seam.spaces).not.toHaveBeenCalled();
    expect(seam.query.mock.calls.every(([q]) => (q as { parentId?: string; subtreeOf?: string }).parentId || (q as { subtreeOf?: string }).subtreeOf)).toBe(true);
  });

  it('retains explicit story follow and truncation warnings', async () => {
    const seam = port();
    seam.entity.mockResolvedValue(story({ follow: { depth: 3, limit: 500, truncated: true, edgeTypes: [] } }) as never);
    const { input } = await load(seam)({ kind: 'story', id: 'story-a' });
    expect(input.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('depth 3'), expect.stringContaining('truncated'), expect.stringContaining('depth 32'),
    ]));
  });

  it('rejects a mismatched space before reading and a foreign/non-story detail before querying', async () => {
    const seam = port();
    await expect(load(seam)({ kind: 'space', id: 'space-b' })).rejects.toThrow('scope');
    expect(seam.query).not.toHaveBeenCalled();
    seam.entity.mockResolvedValue({ ...story(), spaceId: 'space-b' } as never);
    await expect(load(seam)({ kind: 'story', id: 'story-a' })).rejects.toThrow('another space');
    seam.entity.mockResolvedValue({ ...story(), kind: 'task' } as never);
    await expect(load(seam)({ kind: 'story', id: 'story-a' })).rejects.toMatchObject({ code: 'not_found' });
    expect(seam.query).not.toHaveBeenCalled();
  });

  it('rejects unavailable or forbidden stories without falling back to whole-space data', async () => {
    const seam = port();
    for (const reason of ['not found', 'forbidden']) {
      seam.entity.mockRejectedValue(new Error(reason));
      await expect(load(seam)({ kind: 'story', id: 'story-a' })).rejects.toThrow(reason);
    }
    expect(seam.query).not.toHaveBeenCalled();
  });

  it('rejects foreign-space rows from the paged read', async () => {
    const seam = port();
    seam.query.mockResolvedValue({ page: page([{ ...row('foreign'), spaceId: 'space-b' }]) });
    await expect(load(seam)({ kind: 'space', id: SPACE })).rejects.toThrow('another space');
  });

  it('rejects repeated cursors and runaway paging instead of returning an incomplete map', async () => {
    const seam = port();
    seam.query.mockResolvedValue({ page: page([], 'repeated') });
    await expect(load(seam)({ kind: 'space', id: SPACE })).rejects.toThrow('repeated cursor');
    expect(seam.query).toHaveBeenCalledTimes(2);
    seam.query.mockClear();
    seam.query.mockImplementation(async () => ({ page: page([], `cursor-${seam.query.mock.calls.length}`) }));
    await expect(load(seam)({ kind: 'space', id: SPACE })).rejects.toThrow('pagination limit');
    expect(seam.query).toHaveBeenCalledTimes(100);
  });

  it('aborts immediately while a Seam read is pending and ignores its late response', async () => {
    const seam = port(), abort = new AbortController();
    let resolve!: (value: { id: string; name: string }[]) => void;
    seam.spaces.mockReturnValue(new Promise(done => { resolve = done; }));
    const result = load(seam)({ kind: 'space', id: SPACE }, abort.signal);
    await Promise.resolve();
    abort.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    resolve([{ id: SPACE, name: 'Late space' }]);
    await Promise.resolve();
    expect(seam.query).not.toHaveBeenCalled();
  });

  it('checks abort between pages and accepts a visible private row without inventing hidden peers', async () => {
    const seam = port(), abort = new AbortController();
    seam.query.mockImplementation(async () => { abort.abort(); return { page: page([row('private')], 'next') }; });
    await expect(load(seam)({ kind: 'space', id: SPACE }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(seam.query).toHaveBeenCalledTimes(1);
    seam.query.mockResolvedValue({ page: page([{ ...row('private'), visibility: 'private' }]) });
    expect((await load(seam)({ kind: 'space', id: SPACE })).input.entities.map(e => e.id)).toEqual(['private']);
  });
});
