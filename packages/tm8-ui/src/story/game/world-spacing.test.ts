import { describe, expect, it } from 'vitest';
import { LANDMARK_GAP, doorstep, layoutWorld, roadObstacles, roadPath, type WorldNode, type WorldSource } from './world';
import { pathClear } from './roads';
export function graphFixture(count: number): WorldSource {
  const node = (id: string, i = 0): WorldNode => ({ id, title: id, kind: 'thing', status: null, statusCategory: null, blocked: false, live: false, createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), activityAt: null, anchorId: null, rootIds: [], progress: null });
  const hub = node('hub'), landmarks = Array.from({ length: Math.min(5, count - 1) }, (_, i) => node(`root-${i}`));
  const nodes = Array.from({ length: count - landmarks.length - 1 }, (_, i) => ({ ...node(`place-${i}`, i), anchorId: landmarks[i % landmarks.length]!.id }));
  const edges = [...landmarks.map((n) => ({ fromId: hub.id, toId: n.id, family: 'story' as const, type: 'contains', cross: false })), ...nodes.map((n) => ({ fromId: n.anchorId!, toId: n.id, family: 'parent' as const, type: 'parent', cross: false }))];
  return { id: hub.id, hub, landmarks, nodes, portals: [], edges };
}
describe('adaptive world', () => {
  it.each([12, 50, 125])('gives all %i places six units between footprints and routes clear roads', (count) => {
    const world = layoutWorld(graphFixture(count)), obstacles = roadObstacles(world.places);
    expect(world.places).toHaveLength(count);
    for (const [i, a] of world.places.entries()) {
      expect(Math.hypot(a.x, a.z) + a.footprint + 5).toBeLessThan(world.extent * .959);
      for (const b of world.places.slice(i + 1)) expect(Math.hypot(a.x - b.x, a.z - b.z) - a.footprint - b.footprint).toBeGreaterThanOrEqual(LANDMARK_GAP - 1e-6);
    }
    for (const road of world.roads) {
      expect(road.points[0]).toEqual(doorstep(world.byId.get(road.fromId)!));
      expect(road.points.at(-1)).toEqual(doorstep(world.byId.get(road.toId)!));
      expect(road.points.slice(1).every((b, i) => pathClear(road.points[i]!, b, obstacles)), road.id).toBe(true);
    }
  });
  it('grows land area with occupancy and keeps geometry unchanged by status/feed updates', () => {
    const worlds = [12, 50, 125].map((n) => layoutWorld(graphFixture(n)));
    expect(worlds[1]!.extent).toBeGreaterThan(worlds[0]!.extent * 1.2);
    expect(worlds[2]!.extent).toBeGreaterThan(worlds[1]!.extent * 1.2);
    const src = graphFixture(125), original = layoutWorld(src);
    for (const n of [src.hub, ...src.landmarks, ...src.nodes]) { n.status = 'done'; n.statusCategory = 'done'; n.activityAt = new Date().toISOString(); n.progress = 1; n.live = true; }
    const changed = layoutWorld(src);
    expect(changed.places.map(({ id, x, z }) => ({ id, x, z }))).toEqual(original.places.map(({ id, x, z }) => ({ id, x, z })));
    expect(changed.roads).toEqual(original.roads);
    expect(changed.extent).toBe(original.extent);
  });
  it('does not turn placement hints into graph edges, and retains parallel dependencies', () => {
    const src = graphFixture(12); src.edges = [];
    const isolated = layoutWorld(src);
    expect(isolated.roads).toEqual([]);
    expect(roadPath(isolated, 'hub', src.nodes[0]!.id)).toBeNull();
    src.edges = [{ fromId: 'hub', toId: 'root-0', family: 'parent', type: 'parent', cross: false }, { fromId: 'hub', toId: 'root-0', family: 'blocks', type: 'depends_on', cross: false }];
    expect(layoutWorld(src).roads.map((r) => r.family)).toEqual(['parent', 'blocks']);
  });
  it('handles cycles and missing anchors without overlapping or dropping entities', () => {
    const src = graphFixture(50);
    src.nodes[0]!.anchorId = src.nodes[1]!.id; src.nodes[1]!.anchorId = src.nodes[0]!.id; src.nodes[2]!.anchorId = 'missing';
    expect(layoutWorld(src).places).toHaveLength(50);
  });
});
