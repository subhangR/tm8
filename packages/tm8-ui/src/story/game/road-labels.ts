/** Road destination signs: which road the player is on and where each end leads. No renderer dependencies. */
import { ROAD_WIDTH, ROAD_SHOULDER, distance, segmentDistance, type Point } from './roads';
import type { Road, World } from './world';

/** Signs show while the player stands on a road or on its verge. */
export const ROAD_LABEL_THRESHOLD = ROAD_WIDTH + ROAD_SHOULDER + .6;
/** One step is one world unit, roughly the chibi's stride. */
export const STEP_LENGTH = 1;

export interface RoadHit {
  road: Road;
  /** Index of the segment points[segmentIndex] → points[segmentIndex + 1]. */
  segmentIndex: number;
  distance: number;
  /** Position of the foot of the perpendicular along that segment, 0..1. */
  t: number;
}

export interface RoadLabel {
  placeId: string;
  title: string;
  kind: string;
  /** Which end of the road this sign points to. */
  end: 'from' | 'to';
  /** World-space heading along the road towards the destination, atan2(dx, dz) as the player's heading. */
  angle: number;
  /** Remaining road length to the destination, in steps. */
  steps: number;
  /** 1 on the road surface, falling to 0 at the threshold. */
  opacity: number;
}

const footT = (x: number, z: number, a: Point, b: Point): number => {
  const dx = b.x - a.x, dz = b.z - a.z;
  return Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
};

/** The closest road segment to a ground point, or null on a world without roads. */
export function nearestRoad(world: World, x: number, z: number): RoadHit | null {
  const at = scan(world, x, z);
  return at.road ? { road: at.road, segmentIndex: at.segmentIndex, distance: at.distance, t: at.t } : null;
}

/** Up to two signs, one per road end, for the road nearest the point; empty beyond the threshold. */
export function roadLabels(world: World, x: number, z: number, opts: { threshold?: number } = {}): RoadLabel[] {
  const out: [RoadLabel, RoadLabel] = [blankRoadLabel(), blankRoadLabel()];
  return out.slice(0, writeRoadLabels(world, x, z, out, opts.threshold));
}

/** Signs for an already found road hit; empty beyond the threshold. */
export function labelsFor(world: World, hit: RoadHit, x: number, z: number, threshold: number = ROAD_LABEL_THRESHOLD): RoadLabel[] {
  const out: [RoadLabel, RoadLabel] = [blankRoadLabel(), blankRoadLabel()];
  return out.slice(0, fill(world, hit.road, hit.segmentIndex, hit.t, hit.distance, x, z, out, threshold));
}

export const blankRoadLabel = (): RoadLabel => ({ placeId: '', title: '', kind: '', end: 'from', angle: 0, steps: 0, opacity: 0 });

/** Allocation-free form for the frame loop: writes into `out` and returns how many signs are live (0 or 2). */
export function writeRoadLabels(world: World, x: number, z: number, out: [RoadLabel, RoadLabel], threshold: number = ROAD_LABEL_THRESHOLD): number {
  const at = scan(world, x, z);
  return at.road ? fill(world, at.road, at.segmentIndex, at.t, at.distance, x, z, out, threshold) : 0;
}

// Module scratch keeps the per-frame scan allocation-free.
const found = { road: null as Road | null, segmentIndex: 0, distance: Infinity, t: 0 };
const probe: Point = { x: 0, z: 0 };
function scan(world: World, x: number, z: number): typeof found {
  found.road = null; found.distance = Infinity; found.segmentIndex = 0; found.t = 0;
  probe.x = x; probe.z = z;
  for (const road of world.roads) {
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i]!, b = road.points[i + 1]!;
      const d = segmentDistance(probe, a, b);
      if (d < found.distance) { found.road = road; found.segmentIndex = i; found.distance = d; found.t = footT(x, z, a, b); }
    }
  }
  return found;
}

function fill(world: World, road: Road, i: number, t: number, d: number, x: number, z: number, out: [RoadLabel, RoadLabel], threshold: number): number {
  if (d >= threshold) return 0;
  const surface = ROAD_WIDTH / 2;
  const opacity = d <= surface ? 1 : Math.max(0, Math.min(1, (threshold - d) / (threshold - surface)));
  const a = road.points[i]!, b = road.points[i + 1]!;
  const fx = a.x + (b.x - a.x) * t, fz = a.z + (b.z - a.z) * t;
  // Towards `from`: back through points[i..0]; towards `to`: on through points[i+1..].
  sign(world, out[0], 'from', road.fromId, road, fx, fz, i, -1, x, z, opacity);
  sign(world, out[1], 'to', road.toId, road, fx, fz, i + 1, 1, x, z, opacity);
  return 2;
}

function sign(world: World, label: RoadLabel, end: RoadLabel['end'], placeId: string, road: Road, fx: number, fz: number, first: number, step: 1 | -1, x: number, z: number, opacity: number): void {
  const place = world.byId.get(placeId);
  let length = 0, px = fx, pz = fz, angle = Number.NaN;
  for (let j = first; j >= 0 && j < road.points.length; j += step) {
    const q = road.points[j]!, len = Math.hypot(q.x - px, q.z - pz);
    if (Number.isNaN(angle) && len > 1e-6) angle = Math.atan2(q.x - px, q.z - pz);
    length += len; px = q.x; pz = q.z;
  }
  // Standing on the doorstep itself: point at the place.
  if (Number.isNaN(angle)) angle = place && distance({ x, z }, place) > 1e-6 ? Math.atan2(place.x - x, place.z - z) : 0;
  label.placeId = placeId; label.title = place?.title ?? placeId; label.kind = place?.kind ?? '';
  label.end = end; label.angle = angle; label.steps = Math.round(length / STEP_LENGTH); label.opacity = opacity;
}
