import { describe, expect, it, vi } from 'vitest';
import type { CollectionQuery, GraphEdgeView, EntityDetail, EntitySummary, StoryPage } from '@tm8/contract';
import type { Seam } from './seam';
import { createGameMapLoader } from './game-maps';
import { buildMapModel } from '../story/game/map-model';
import type { GamePort } from '../game/port';

const SPACE = 'space-a';
const row = (id: string, kind = 'task', parentId: string | null = null): EntitySummary => ({
  id, kind, parentId, spaceId: SPACE, title: `Real ${id}`, category: 'in_progress',
  state: { kind, status: 'working', acceptance: { total: 5, completed: 2 },
    progress: { percent: 40, size: 5, own: .4, tent: false } },
  counters: { messages: 3 }, badges: { attention: { pendingCount: 2 } },
} as unknown as EntitySummary);
const edge = (id: string, source: EntitySummary, target: EntitySummary, props = {}): GraphEdgeView => ({
  id, type: 'depends_on', sourceId: source.id, targetId: target.id, props,
} as GraphEdgeView);
const page = (items: EntitySummary[], nextCursor: string | null = null) => ({ items, nextCursor });
function port() {
  return {
    spaces: vi.fn(async () => [{ id: SPACE, name: 'Real space' }]),
    query: vi.fn(async (_input: CollectionQuery) => ({ page: page([]) })),
    entity: vi.fn(async (_id: string): Promise<EntityDetail> => { throw new Error('not found'); }),
    graph: vi.fn(async (_input: unknown) => ({ nodes: [] as EntitySummary[], edges: [] as GraphEdgeView[], clusters: [] })),
    connections: vi.fn(),
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
  it('projects task criteria/tent truth and status-changed cancellation evidence without treating row updates as cancellation', async () => {
    const seam = port();
    const current = { ...row('cancelled'), version: 8, updatedAt: '2026-10-08T12:00:00Z',
      state: { ...row('cancelled').state, status: 'cancelled', statusChangedAt: '2026-10-08T10:00:00Z' } } as EntitySummary;
    const legacy = { ...row('legacy'), state: { ...row('legacy').state, status: 'cancelled' } } as EntitySummary;
    seam.query.mockResolvedValue({ page: page([current, legacy]) });
    const { input } = await load(seam)({ kind: 'space', id: SPACE }, undefined, 'taskland');
    expect(input.taskHierarchyComplete).toBe(true);
    expect(input.entities[0]).toMatchObject({ acceptance: { total: 5, completed: 2 }, estimateTent: false,
      ownProgress: .4, cancelledAt: '2026-10-08T10:00:00Z', version: 8, updatedAt: '2026-10-08T12:00:00Z', mailbox: { basis: 'messages' } });
    expect(input.entities[1]?.cancelledAt).toBeNull();
  });
  it('shows a real story claim from admitted session rows, and resumes it after completion', async () => {
    const seam = port(), root = row('root');
    const session = { ...row('session', 'work_session'), state: { kind: 'work_session', status: 'running', outcome: 'open', endedKind: 'completed' } } as EntitySummary;
    seam.entity.mockResolvedValue(story({ nodes: [root, session] } as unknown as Partial<StoryPage>));
    seam.liveness.statusOf.mockReturnValue('live' as never);
    seam.graph.mockResolvedValue({ nodes: [root, session], edges: [{ ...edge('claim', session, root), type: 'working_on', props: { status: 'working' } }], clusters: [] });
    const scope = { kind: 'story' as const, id: 'story-a' };
    const { input } = await load(seam)(scope, undefined, 'taskland');
    expect(input.taskHierarchyComplete).toBe(false);
    expect(input.entities.find(n => n.id === 'session')).toMatchObject({ processState: 'running', outcome: 'open', live: true });
    const before = buildMapModel(input, { type: 'taskland', scope });
    expect(before.robots).toHaveLength(1);
    expect(before.robots[0]).toMatchObject({ id: 'robot:claim', taskId: 'root', sessionId: 'session' });
    const completed = { ...input, entities: input.entities.map(n => n.id === 'session' ? { ...n, outcome: 'completed' } : n) };
    expect(buildMapModel(completed, { type: 'taskland', scope, previous: before }).robots).toEqual([]);
    expect(buildMapModel(input, { type: 'taskland', scope }).robots[0]?.id).toBe('robot:claim');
    seam.liveness.statusOf.mockReturnValue('unknown' as never);
    const ghost = await load(seam)(scope, undefined, 'taskland');
    expect(buildMapModel(ghost.input, { type: 'taskland', scope }).robots).toEqual([]);
  });
  it('overlaps Town placement storage with the primary read and filters only after the admitted graph is ready', async () => {
    const seam = port();
    let finish!: (value: Awaited<ReturnType<typeof seam.query>>) => void;
    seam.query.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const map = { id: 'durable-town', spaceId: SPACE, title: 'Town', type: 'town' as const, scope: { kind: 'space' as const, id: SPACE } };
    const game = { open: vi.fn(async () => map), context: vi.fn(async () => ({ map, nextCursor: null, terrain: [], terrainTruncated: false,
      placements: [{ itemId: 'item', entityId: 'late-task', kind: 'ref', x: 3, z: 4, rotation: 0, spec: {}, layer: 'human', byActor: 'member', version: 1, expiresAt: null }] })) } as unknown as GamePort;
    const loading = createGameMapLoader({ ...seam, game } as unknown as Seam, SPACE)({ kind: 'space', id: SPACE }, undefined, 'town');
    await vi.waitFor(() => expect(game.context).toHaveBeenCalledTimes(1));
    finish({ page: page([row('late-task')]) });
    expect((await loading).input.townPlacements).toEqual([{ entityId: 'late-task', x: 3, z: 4, actorId: 'member', layer: 'human' }]);
  });

  it('ensures fresh Office and story hub identities without placement context reads', async () => {
    const seam = port(); seam.entity.mockResolvedValue(story());
    const game = { open: vi.fn(async (spaceId, selection) => ({ ...selection, id: 'map-id', spaceId, title: 'Map' })), context: vi.fn() } as unknown as GamePort;
    const loading = createGameMapLoader({ ...seam, game } as unknown as Seam, SPACE);
    await loading({ kind: 'space', id: SPACE }, undefined, 'office');
    await loading({ kind: 'story', id: 'story-a' }, undefined, 'hub');
    expect(game.open).toHaveBeenNthCalledWith(1, SPACE, { type: 'office', scope: { kind: 'space', id: SPACE } }, undefined);
    expect(game.open).toHaveBeenNthCalledWith(2, SPACE, { type: 'hub', scope: { kind: 'story', id: 'story-a' } }, undefined);
    expect(game.context).not.toHaveBeenCalled();
  });
  it('joins persisted Town coordinates without changing graph status/progress or admitting ghost buildings', async () => {
    const seam = port(), task = row('shipped');
    task.state = { ...task.state, status: 'done' } as EntitySummary['state'];
    seam.query.mockResolvedValue({ page: page([task]) });
    const map = { id: 'durable-town', spaceId: SPACE, title: 'Town', type: 'town' as const, scope: { kind: 'space' as const, id: SPACE } };
    const game = { open: vi.fn(async () => map), context: vi.fn(async () => ({ map, nextCursor: null, terrain: [], terrainTruncated: false,
      placements: ['shipped', 'ghost'].map((entityId, index) => ({ itemId: `item-${index}`, entityId, kind: 'ref' as const,
        x: 30 + index, z: 50, rotation: 0, spec: {}, layer: 'human' as const, byActor: 'member', version: 1, expiresAt: null })) })) } as unknown as GamePort;
    const result = await createGameMapLoader({ ...seam, game } as unknown as Seam, SPACE)({ kind: 'space', id: SPACE }, undefined, 'town');
    expect(result.input.townPlacements).toEqual([{ entityId: 'shipped', x: 30, z: 50, actorId: 'member', layer: 'human' }]);
    expect(result.input.entities).toHaveLength(1);
    expect(result.input.entities[0]).toMatchObject({ id: 'shipped', status: 'done', progress: .4 });
    expect(game.open).toHaveBeenCalledWith(SPACE, { scope: { kind: 'space', id: SPACE }, type: 'town' }, undefined);
  });

  it('keeps the derived Town readable when placement storage fails, with a generic notice', async () => {
    const seam = port(); seam.query.mockResolvedValue({ page: page([row('live-task')]) });
    const game = { open: vi.fn(async () => { throw new Error('Private placement payload'); }) } as unknown as GamePort;
    const result = await createGameMapLoader({ ...seam, game } as unknown as Seam, SPACE)({ kind: 'space', id: SPACE }, undefined, 'town');
    expect(result.input.entities[0]?.id).toBe('live-task');
    expect(result.input.warnings).toContain('Saved placements could not be loaded. Showing the derived layout.');
    expect(JSON.stringify(result.input)).not.toContain('Private placement payload');
  });

  it('opens persisted hub identity without relation reads or map identity graph admission', async () => {
    const seam = port(); seam.query.mockResolvedValue({ page: page([row('real-story', 'story')]) });
    const map = { id: 'durable-hub', spaceId: SPACE, title: 'Hub', type: 'hub' as const, scope: { kind: 'space' as const, id: SPACE } };
    const game = { open: vi.fn(async () => map), context: vi.fn(async () => ({ map, placements: [], nextCursor: null, terrain: [], terrainTruncated: false })) } as unknown as GamePort;
    await createGameMapLoader({ ...seam, game } as unknown as Seam, SPACE)({ kind: 'space', id: SPACE }, undefined, 'hub');
    expect(seam.graph).not.toHaveBeenCalled();
    expect(seam.query.mock.calls[0]?.[0].kinds).toEqual(['story']);
    expect(game.open).toHaveBeenCalledWith(SPACE, { type: 'hub', scope: { kind: 'space', id: SPACE } }, undefined);
    expect(game.context).not.toHaveBeenCalled();
  });
  it('pages primary entities, reads one bounded graph, preserves progress/counts and admits only scoped endpoints', async () => {
    const seam = port(), a = row('a'), b = row('b'), unrelated = row('unrelated');
    seam.query.mockImplementation(async (input?: unknown) => ({ page: (input as { cursor?: string }).cursor ? page([b]) : page([a], 'entities-2') }));
    const foreign = { ...unrelated, spaceId: 'space-b' };
    seam.graph.mockResolvedValue({ nodes: [a, b, foreign], edges: [edge('road', a, b), edge('outside', a, unrelated),
      edge('foreign', a, foreign), edge('ended', a, b, { endedAt: '2026-10-08' })], clusters: [] });
    const result = await load(seam)({ kind: 'space', id: SPACE });
    expect(result.title).toBe('Real space');
    expect(result.input.scope).toEqual({ kind: 'space', id: SPACE });
    expect(result.input.entities.map(e => e.id)).toEqual(['a', 'b']);
    expect(result.input.entities[0]).toMatchObject({ progress: .4, subtreeWeight: 5, status: 'working',
      statusCategory: 'in_progress', pendingAttention: 2, mailbox: { count: 3 } });
    expect(result.input.edges.map(e => e.id)).toEqual(['road', 'ended']);
    expect(result.input.edges[1]?.endedAt).toBe('2026-10-08');
    expect(seam.query.mock.calls[1]?.[0]).toMatchObject({ spaceId: SPACE, cursor: 'entities-2', limit: 200 });
    expect(seam.graph).toHaveBeenCalledTimes(1);
    expect(seam.graph.mock.calls[0]?.[0]).toMatchObject({ spaceId: SPACE, limit: 200 });
    expect(seam.connections).not.toHaveBeenCalled();
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
    expect(result.input.warnings?.some(w => w.includes('depth 32'))).toBe(false);
  });

  it('retains explicit story follow and truncation warnings', async () => {
    const seam = port();
    seam.entity.mockResolvedValue(story({ follow: { depth: 3, limit: 500, truncated: true, edgeTypes: [] } }) as never);
    const { input } = await load(seam)({ kind: 'story', id: 'story-a' });
    expect(input.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('depth 3'), expect.stringContaining('truncated'),
    ]));
  });

  it('warns at the hierarchy boundary and skips connection reads for records without map edges', async () => {
    const seam = port();
    seam.entity.mockResolvedValue(story() as never);
    const deep = Array.from({ length: 32 }, (_, index) => row(`deep-${index + 1}`, 'task', index ? `deep-${index}` : 'root'));
    seam.query.mockImplementation(async input => ({ page: page(input.subtreeOf ? deep : []) }));
    expect((await load(seam)({ kind: 'story', id: 'story-a' })).input.warnings).toContain('Contained hierarchy reaches depth 32; deeper descendants may be absent');
    seam.graph.mockClear();
    seam.query.mockResolvedValue({ page: page([row('story', 'story'), row('doc', 'doc'), row('project', 'project')]) });
    const result = await load(seam)({ kind: 'space', id: SPACE }, undefined, 'hub');
    expect(result.input.entities).toHaveLength(3);
    await load(seam)({ kind: 'space', id: SPACE }, undefined, 'hub');
    expect(seam.graph).not.toHaveBeenCalled();
    expect(seam.connections).not.toHaveBeenCalled();
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

  it('keeps a 3,000-record load to paged primary queries and one relation read, with an explicit graph budget warning', async () => {
    const seam = port();
    const records = Array.from({ length: 3000 }, (_, index) => row(`row-${index}`));
    seam.query.mockImplementation(async input => {
      const offset = Number(input.cursor ?? 0);
      return { page: page(records.slice(offset, offset + 200), offset + 200 < records.length ? String(offset + 200) : null) };
    });
    seam.graph.mockResolvedValue({ nodes: records.slice(0, 200), edges: [], clusters: [] });
    const result = await load(seam)({ kind: 'space', id: SPACE }, undefined, 'taskland');
    expect(result.input.entities).toHaveLength(3000);
    expect(seam.query).toHaveBeenCalledTimes(15);
    expect(seam.graph).toHaveBeenCalledTimes(1);
    expect(seam.connections).not.toHaveBeenCalled();
    expect(result.input.warnings).toContain('Map relations reached their read budget; some roads, workers or deliverables may be absent');
  });

  it('uses relevant primary kinds and makes no relation reads for space/story hubs and non-relational maps', async () => {
    const seam = port();
    await load(seam)({ kind: 'space', id: SPACE }, undefined, 'hub');
    expect(seam.query.mock.calls[0]?.[0].kinds).toEqual(['story']);
    seam.entity.mockResolvedValue(story() as never);
    await load(seam)({ kind: 'story', id: 'story-a' }, undefined, 'hub');
    expect(seam.query.mock.calls[1]?.[0]).toMatchObject({ kinds: ['story'], parentId: 'story-a' });
    for (const type of ['office', 'library', 'factory'] as const) await load(seam)({ kind: 'space', id: SPACE }, undefined, type);
    expect(seam.query.mock.calls.map(([query]) => query.kinds)).toEqual([
      ['story'], ['story'], ['member', 'team_member', 'work_session', 'skill'],
      ['doc', 'drawing', 'artifact', 'file'], ['project', 'pull_request', 'commit', 'worktree'],
    ]);
    expect(seam.graph).not.toHaveBeenCalled();
    expect(seam.connections).not.toHaveBeenCalled();
  });

  it('warns a story about a full graph window only when it omits an admitted peer, or reaches the edge cap', async () => {
    const seam = port();
    seam.entity.mockResolvedValue(story());
    const peers = [row('root'), ...Array.from({ length: 199 }, (_, index) => row(`other-${index}`))];
    seam.graph.mockResolvedValue({ nodes: peers, edges: [], clusters: [] });
    const readStory = () => load(seam)({ kind: 'story', id: 'story-a' }, undefined, 'taskland');
    expect((await readStory()).input.warnings?.some(w => w.includes('read budget'))).toBe(false);
    seam.query.mockResolvedValue({ page: page([row('missing', 'task', 'root')]) });
    expect((await readStory()).input.warnings?.some(w => w.includes('read budget'))).toBe(true);
    seam.query.mockResolvedValue({ page: page([]) });
    seam.graph.mockResolvedValue({ nodes: peers, edges: Array.from({ length: 1000 }, (_, index) => edge(`edge-${index}`, peers[0]!, peers[0]!)), clusters: [] });
    expect((await readStory()).input.warnings?.some(w => w.includes('read budget'))).toBe(true);
  });

  it('includes output kinds in the town graph so produced documents become shipped places', async () => {
    const seam = port(), task = row('done-task'), doc = row('delivered-doc', 'doc');
    task.category = 'done';
    if (task.state.kind === 'task') task.state.status = 'done';
    seam.query.mockResolvedValue({ page: page([task, doc]) });
    seam.graph.mockImplementation(async input => {
      expect((input as CollectionQuery).kinds).toEqual(expect.arrayContaining(['task', 'doc', 'artifact', 'drawing', 'file']));
      return { nodes: [task, doc], edges: [{ ...edge('delivery', task, doc), type: 'produces' }], clusters: [] };
    });
    const scope = { kind: 'space' as const, id: SPACE };
    const { input } = await load(seam)(scope, undefined, 'town');
    expect(buildMapModel(input, { scope, type: 'town' }).places.map(place => place.entityId)).toContain(doc.id);
  });

  it('retains primary places with a warning if relations fail and cancels a pending graph read', async () => {
    const seam = port();
    seam.query.mockResolvedValue({ page: page([row('task')]) });
    seam.graph.mockRejectedValue(new Error('Graph unavailable'));
    const result = await load(seam)({ kind: 'space', id: SPACE }, undefined, 'taskland');
    expect(result.input.entities[0]?.id).toBe('task');
    expect(result.input.warnings).toContain('Map relations could not be loaded; places and their hierarchy remain available');
    const abort = new AbortController();
    seam.graph.mockImplementation(() => new Promise(() => {}));
    const pending = load(seam)({ kind: 'space', id: SPACE }, abort.signal, 'taskland');
    await vi.waitFor(() => expect(seam.graph).toHaveBeenCalledTimes(2));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
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
