import { describe, expect, it } from 'vitest';
import { STORY_FIXTURE } from '../fixture';
import { MIN_DISTANCE, buildWorld, layoutWorld, nearestPlace, roadPath, type WorldNode, type WorldSource } from './world';

describe('buildWorld', () => {
  const world = buildWorld(STORY_FIXTURE);

  it('places the story at the hub and every node and child story once', () => {
    const hub = world.byId.get(STORY_FIXTURE.id)!;
    expect(hub.shape).toBe('hub');
    expect([hub.x, hub.z]).toEqual([0, 0]);
    const ids = world.places.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of STORY_FIXTURE.page.nodes) expect(world.byId.has(n.id)).toBe(true);
    for (const c of STORY_FIXTURE.page.childStories) expect(world.byId.get(c.id)?.portal).toBe(true);
    for (const r of STORY_FIXTURE.page.roots) expect(world.byId.get(r.id)?.root).toBe(true);
  });

  it('keeps every two places apart', () => {
    for (let i = 0; i < world.places.length; i++) {
      for (let j = i + 1; j < world.places.length; j++) {
        const a = world.places[i]!;
        const b = world.places[j]!;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(MIN_DISTANCE - 0.05);
      }
    }
  });

  it('is deterministic and stable under a status change', () => {
    const again = buildWorld(STORY_FIXTURE);
    expect(again.places.map((p) => [p.id, p.x, p.z])).toEqual(world.places.map((p) => [p.id, p.x, p.z]));
    const first = STORY_FIXTURE.page.nodes[1]!;
    const bumped = {
      ...STORY_FIXTURE,
      page: {
        ...STORY_FIXTURE.page,
        nodes: STORY_FIXTURE.page.nodes.map((n) => (n.id === first.id ? { ...n, status: 'done', statusCategory: 'done' as const } : n)),
      },
    };
    const moved = buildWorld(bumped);
    expect(moved.places.map((p) => [p.id, p.x, p.z])).toEqual(world.places.map((p) => [p.id, p.x, p.z]));
    expect(moved.byId.get(first.id)?.tone).toBe('done');
  });

  it('roads reach source-connected places from the hub', () => {
    for (const p of world.places.filter((p) => world.roads.some((r) => r.fromId === p.id || r.toId === p.id))) {
      const path = roadPath(world, world.hubId, p.id);
      expect(path, p.title).not.toBeNull();
      expect(path![0]).toBe(world.hubId);
      expect(path![path!.length - 1]).toBe(p.id);
    }
  });

  it('colours a blocking edge as a bridge, not a gate', () => {
    const bridges = world.roads.filter((r) => r.family === 'blocks');
    const inPage = STORY_FIXTURE.page.edges.filter((e) => e.family === 'blocks');
    expect(bridges.length).toBe(inPage.length);
  });

  it('finds the nearest place within reach', () => {
    const root = world.places.find((p) => p.root)!;
    expect(nearestPlace(world, root.x + 0.3, root.z - 0.2, 1)?.id).toBe(root.id);
    expect(nearestPlace(world, 1000, 1000, 1)).toBeNull();
  });
});

describe('layoutWorld (generic)', () => {
  const node = (id: string, createdAt: string, anchorId: string | null = null): WorldNode => ({
    id, kind: 'thing', title: id, status: null, statusCategory: null, blocked: false, live: false,
    createdAt, activityAt: null, progress: null, anchorId, rootIds: [],
  });
  const src: WorldSource = {
    id: 'hub',
    hub: { ...node('hub', '2026-01-01T00:00:00Z'), progress: 0.5 },
    landmarks: [node('L1', '2026-01-02T00:00:00Z', 'hub'), node('L2', '2026-01-03T00:00:00Z', 'hub')],
    nodes: [
      node('old', '2026-01-04T00:00:00Z', 'L1'),
      node('mid', '2026-02-04T00:00:00Z', 'L1'),
      node('new', '2026-03-04T00:00:00Z', 'L1'),
      node('loose', '2026-03-05T00:00:00Z', null),
    ],
    portals: [node('other-world', '2026-01-01T00:00:00Z', 'hub')],
    edges: [{ fromId: 'loose', toId: 'L2', type: 'about', family: 'story', cross: false }, { fromId: 'hub', toId: 'L2', type: 'contains', family: 'story', cross: false }],
  };
  const world = layoutWorld(src, Date.parse('2026-03-06T00:00:00Z'));

  it('lays any graph out: hub, landmarks, anchored nodes, portals on the rim', () => {
    expect(world.byId.get('hub')?.shape).toBe('hub');
    expect(world.byId.get('L1')?.root).toBe(true);
    expect(world.byId.get('other-world')?.portal).toBe(true);
    expect(Math.hypot(world.byId.get('other-world')!.x, world.byId.get('other-world')!.z)).toBeGreaterThan(Math.hypot(world.byId.get('L1')!.x, world.byId.get('L1')!.z));
    // An unanchored node hangs off the neighbour its edge names.
    expect(world.byId.get('loose')?.anchorId).toBe('L2');
    expect(roadPath(world, 'hub', 'loose')).toEqual(['hub', 'L2', 'loose']);
  });

  it('time is distance: the newest sibling stands nearest its anchor', () => {
    const l1 = world.byId.get('L1')!;
    const d = (id: string): number => { const p = world.byId.get(id)!; return Math.hypot(p.x - l1.x, p.z - l1.z); };
    expect(d('new')).toBeLessThan(d('mid'));
    expect(d('mid')).toBeLessThan(d('old'));
  });

  it('marks what moved in the last hour as recent', () => {
    const now = Date.parse('2026-03-06T00:00:00Z');
    const warm = layoutWorld({ ...src, nodes: [{ ...node('new', '2026-03-04T00:00:00Z', 'L1'), activityAt: '2026-03-05T23:30:00Z' }] }, now);
    expect(warm.byId.get('new')?.recent).toBe(true);
    expect(world.byId.get('new')?.recent).toBe(false);
  });
});

describe('graph-driven encounters', () => {
  it('attaches the same live trainer to its session and tasks, with model and relevant messages', () => {
    const session = STORY_FIXTURE.page.sessions.find((s) => s.live && s.taskIds.length)!;
    const view = { ...STORY_FIXTURE, page: { ...STORY_FIXTURE.page, sessions: [{ ...session, model: 'test-model' }] } };
    const world = buildWorld(view);
    const encounter = world.byId.get(session.id)!.encounters[0]!;
    expect(encounter.name).toBe(STORY_FIXTURE.people[session.teamMemberId!]!.name);
    expect(encounter.model).toBe('test-model');
    expect(encounter.phase).toBe('active');
    expect(encounter.total).toBe(session.taskIds.length);
    for (const id of session.taskIds) expect(world.byId.get(id)!.encounters).toContainEqual(encounter);
    for (const row of encounter.activity) {
      const message = view.feed.find((m) => m.id === row.id);
      if (message) expect([session.id, ...session.taskIds]).toContain(message.anchorId);
    }
  });

  it('shows failed and completed work honestly and keeps location fixed across runtime updates', () => {
    const session = STORY_FIXTURE.page.sessions.find((s) => s.taskIds.length)!;
    const make = (failed: boolean) => buildWorld({ ...STORY_FIXTURE, page: {
      ...STORY_FIXTURE.page,
      sessions: [{ ...session, live: false, runtimeStatus: failed ? 'failed' : 'exited' }],
      nodes: STORY_FIXTURE.page.nodes.map((n) => session.taskIds.includes(n.id) ? { ...n, statusCategory: 'done' as const } : n),
    } });
    const failed = make(true), done = make(false);
    expect(failed.byId.get(session.id)!.encounters[0]!.phase).toBe('fainted');
    expect(done.byId.get(session.id)!.encounters[0]!.phase).toBe('victory');
    expect(done.byId.get(session.id)!.encounters[0]!.completed).toBe(session.taskIds.length);
    expect(done.places.map((p) => [p.id, p.x, p.z])).toEqual(failed.places.map((p) => [p.id, p.x, p.z]));
  });
});
