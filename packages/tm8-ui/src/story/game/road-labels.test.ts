import { describe, expect, it } from 'vitest';
import { STORY_FIXTURE } from '../fixture';
import { ROAD_LABEL_THRESHOLD, STEP_LENGTH, blankRoadLabel, labelsFor, nearestRoad, roadLabels, writeRoadLabels } from './road-labels';
import { ROAD_WIDTH, pathLength, segmentDistance } from './roads';
import { buildWorld, type Road } from './world';

const world = buildWorld(STORY_FIXTURE, 0);
// The segment midpoint farthest from every other road keeps probes clear of junctions and crossings.
const clearance = (r: Road, p: { x: number; z: number }) => Math.min(...world.roads.filter((o) => o !== r).flatMap((o) => o.points.slice(1).map((q, i) => segmentDistance(p, o.points[i]!, q))));
const { road, seg } = world.roads.flatMap((r) => r.points.slice(1).map((q, i) => ({ road: r, seg: i, len: Math.hypot(q.x - r.points[i]!.x, q.z - r.points[i]!.z), room: clearance(r, { x: (q.x + r.points[i]!.x) / 2, z: (q.z + r.points[i]!.z) / 2 }) })))
  .filter((s) => s.len > 4).sort((x, y) => y.room - x.room)[0]!;
const a = road.points[seg]!, b = road.points[seg + 1]!;
const len = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
/** A point `side` units to the left of the segment midpoint. */
const beside = (side: number) => ({ x: mid.x - uz * side, z: mid.z + ux * side });
const remaining = (r: Road, i: number, p: { x: number; z: number }) => ({
  from: pathLength([p, ...r.points.slice(0, i + 1).reverse()]),
  to: pathLength([p, ...r.points.slice(i + 1)]),
});

describe('nearestRoad', () => {
  it('finds the road and segment under a point on the road', () => {
    expect(clearance(road, mid)).toBeGreaterThan(ROAD_LABEL_THRESHOLD * 2);
    expect(len).toBeGreaterThan(4);
    const hit = nearestRoad(world, mid.x, mid.z)!;
    expect(hit.road.id).toBe(road.id);
    expect(hit.segmentIndex).toBe(seg);
    expect(hit.distance).toBeCloseTo(0, 6);
    expect(hit.t).toBeCloseTo(.5, 6);
  });

  it('measures the perpendicular distance for a point beside the road', () => {
    const p = beside(1.2);
    const hit = nearestRoad(world, p.x, p.z)!;
    expect(hit.road.id).toBe(road.id);
    expect(hit.segmentIndex).toBe(seg);
    expect(hit.distance).toBeCloseTo(1.2, 6);
  });

  it('still names the closest road from far away, and none on a roadless world', () => {
    const p = { x: world.extent * 3, z: world.extent * 3 };
    const hit = nearestRoad(world, p.x, p.z)!;
    const best = Math.min(...world.roads.flatMap((r) => r.points.slice(1).map((q, i) => segmentDistance(p, r.points[i]!, q))));
    expect(hit.distance).toBeCloseTo(best, 6);
    expect(nearestRoad({ ...world, roads: [] }, 0, 0)).toBeNull();
  });
});

describe('roadLabels', () => {
  it('names both ends of the road with their remaining road length in steps', () => {
    const labels = roadLabels(world, mid.x, mid.z);
    expect(labels.map((l) => [l.end, l.placeId])).toEqual([['from', road.fromId], ['to', road.toId]]);
    const left = remaining(road, seg, mid);
    expect(labels[0]!.steps).toBe(Math.round(left.from / STEP_LENGTH));
    expect(labels[1]!.steps).toBe(Math.round(left.to / STEP_LENGTH));
    expect(labels[0]!.steps + labels[1]!.steps).toBeGreaterThanOrEqual(Math.round(road.length) - 1);
    for (const l of labels) {
      const place = world.byId.get(l.placeId)!;
      expect(l.title).toBe(place.title);
      expect(l.kind).toBe(place.kind);
      expect(l.opacity).toBe(1);
    }
  });

  it('points each sign along the road towards its end', () => {
    const [from, to] = roadLabels(world, mid.x, mid.z);
    expect(to!.angle).toBeCloseTo(Math.atan2(ux, uz), 6);
    expect(Math.cos(from!.angle - to!.angle)).toBeCloseTo(-1, 6);
  });

  it('fades across the verge and disappears beyond the threshold', () => {
    const surface = ROAD_WIDTH / 2;
    const at = (side: number) => roadLabels(world, beside(side).x, beside(side).z);
    expect(at(surface * .9)[0]!.opacity).toBe(1);
    const halfway = at((surface + ROAD_LABEL_THRESHOLD) / 2)[0]!.opacity;
    expect(halfway).toBeCloseTo(.5, 6);
    expect(at(ROAD_LABEL_THRESHOLD - .05)[0]!.opacity).toBeGreaterThan(0);
    expect(at(ROAD_LABEL_THRESHOLD - .05)[0]!.opacity).toBeLessThan(halfway);
    expect(at(ROAD_LABEL_THRESHOLD + .05)).toEqual([]);
    expect(roadLabels(world, world.extent * 3, world.extent * 3)).toEqual([]);
    expect(roadLabels(world, beside(2).x, beside(2).z, { threshold: 3 })).toHaveLength(2);
  });

  it('agrees with labelsFor and the allocation-free writer', () => {
    const hit = nearestRoad(world, mid.x, mid.z)!;
    const out: [ReturnType<typeof blankRoadLabel>, ReturnType<typeof blankRoadLabel>] = [blankRoadLabel(), blankRoadLabel()];
    expect(writeRoadLabels(world, mid.x, mid.z, out)).toBe(2);
    expect(out).toEqual(roadLabels(world, mid.x, mid.z));
    expect(labelsFor(world, hit, mid.x, mid.z)).toEqual(out);
    expect(writeRoadLabels(world, world.extent * 3, 0, out)).toBe(0);
  });

  it('points at the place when standing on its doorstep', () => {
    const end = road.points.at(-1)!;
    // A shared apron can hand the doorstep to a neighbouring road, so look at this road alone.
    const sign = roadLabels({ ...world, roads: [road] }, end.x, end.z)[1]!;
    const place = world.byId.get(road.toId)!;
    expect(sign.steps).toBe(0);
    expect(sign.angle).toBeCloseTo(Math.atan2(place.x - end.x, place.z - end.z), 6);
  });
});
