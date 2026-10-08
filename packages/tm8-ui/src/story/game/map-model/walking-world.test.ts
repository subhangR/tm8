import { describe, expect, it } from 'vitest';
import { buildMapModel } from './build';
import { smallFixture, nestedFixture } from './fixtures';
import { mapWalkingWorld, walkingBounds, walkingEntrance, isWalkingPositionSafe } from './walking-world';
import { doorstep, roadObstacles } from '../world';
import { pathClear } from '../roads';

describe('typed map walking metadata', () => {
  it.each(['hub', 'taskland', 'office', 'library', 'factory', 'town'] as const)('uses supplied %s geometry and identities', type => {
    const model = buildMapModel(nestedFixture(), { type, scope: nestedFixture().scope! });
    const world = mapWalkingWorld(model);
    expect(world.places.map(p => p.id)).toEqual([...model.places, ...model.portals].map(p => p.id));
    for (const p of [...model.places, ...model.portals]) {
      expect(world.byId.get(p.id)).toMatchObject({ x: p.x, z: p.z, footprint: p.radius });
      expect(Math.hypot(p.x, p.z) + p.radius).toBeLessThan(world.extent);
    }
  });
  it('routes dependency travel between safe doorsteps and retains claim robots in the model', () => {
    const model = buildMapModel(smallFixture(), { type: 'taskland', scope: smallFixture().scope! });
    const world = mapWalkingWorld(model), road = world.roads[0]!;
    expect(road.points[0]).toEqual(doorstep(world.byId.get(road.fromId)!));
    expect(road.points.at(-1)).toEqual(doorstep(world.byId.get(road.toId)!));
    const obstacles = roadObstacles(world.places);
    for (let i = 1; i < road.points.length; i++) expect(pathClear(road.points[i - 1]!, road.points[i]!, obstacles)).toBe(true);
    expect(model.robots).toHaveLength(3);
  });
  it('includes the entrance and origin in the playable bounds', () => {
    const model = buildMapModel(smallFixture(), { type: 'taskland', scope: smallFixture().scope! });
    const b = walkingBounds(model);
    expect(b.minX).toBeLessThanOrEqual(-4); expect(b.minZ).toBeLessThanOrEqual(-4);
    expect(b.maxZ).toBeGreaterThanOrEqual(10);
    expect(b.maxX).toBeGreaterThanOrEqual(model.bounds.maxX + 4);
  });
  it.each(['hub', 'taskland', 'office', 'library', 'factory', 'town'] as const)('offers a free %s entrance and validates occupied/stale poses', type => {
    const model = buildMapModel(nestedFixture(), { type, scope: nestedFixture().scope! });
    expect(isWalkingPositionSafe(model, walkingEntrance(model))).toBe(true);
    expect(isWalkingPositionSafe(model, { x: 1e8, z: 1e8 })).toBe(false);
    const occupied = [...model.places, ...model.portals][0];
    if (occupied) expect(isWalkingPositionSafe(model, occupied)).toBe(false);
  });
  it('keeps hub paths decorative without inventing connections between unrelated portals', () => {
    const model = buildMapModel(smallFixture(), { type: 'hub', scope: smallFixture().scope! });
    expect(mapWalkingWorld(model).roads).toHaveLength(0);
    for (const p of model.portals) for (const other of model.portals) if (p.id !== other.id) expect(Math.hypot(p.x - other.x, p.z - other.z)).toBeGreaterThan(p.radius + other.radius);
  });
});
