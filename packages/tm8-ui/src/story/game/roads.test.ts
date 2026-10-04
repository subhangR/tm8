import { describe, expect, it } from 'vitest';
import { pathClear, pathLength, routeRoad } from './roads';
describe('road routing', () => {
  it('goes around footprints even when both doorways face away from the edge', () => {
    const obstacles = [{ x: 0, z: 0, radius: 2.6 }, { x: 0, z: -16, radius: 2.6 }, { x: 1, z: -8, radius: 2.6 }];
    const start = { x: 0, z: 2.8 }, end = { x: 0, z: -13.2 };
    const points = routeRoad(start, end, obstacles);
    expect(points[0]).toEqual(start); expect(points.at(-1)).toEqual(end);
    expect(points.length).toBeGreaterThan(2);
    expect(points.slice(1).every((p, i) => pathClear(points[i]!, p, obstacles))).toBe(true);
    expect(pathLength(points)).toBeLessThan(35);
    expect(routeRoad(start, end, obstacles)).toEqual(points);
  });
  it('keeps open routes direct without unnecessary tessellation', () => {
    const start = { x: 0, z: 0 }, end = { x: 400, z: 0 };
    expect(routeRoad(start, end, [{ x: 20, z: 8, radius: 3 }])).toEqual([start, end]);
  });
});
