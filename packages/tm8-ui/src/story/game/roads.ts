/** Ground-plane routing shared by roads, foliage clearance and walking. No renderer dependencies. */
export interface Point { x: number; z: number }
export interface Obstacle extends Point { radius: number }
export const ROAD_WIDTH = 1.25;
export const ROAD_SHOULDER = .2;
const GRID = 2;
export const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.z - a.z);
export function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
}
export const pathLength = (points: readonly Point[]): number => points.slice(1).reduce((sum, p, i) => sum + distance(points[i]!, p), 0);
export const pathClear = (a: Point, b: Point, obstacles: readonly Obstacle[]): boolean => obstacles.every((o) => segmentDistance(o, a, b) >= o.radius - 1e-6);

/** A* on a world-aligned grid, then line-of-sight simplification and safe rounded corners.
 * Only obstructed edges need the grid. A route can never cut through an occupied footprint. */
export function routeRoad(start: Point, end: Point, obstacles: readonly Obstacle[]): Point[] {
  if (pathClear(start, end, obstacles)) return [start, end];
  const bound = Math.ceil(Math.max(...obstacles.map((o) => Math.max(Math.abs(o.x), Math.abs(o.z)) + o.radius), Math.abs(start.x), Math.abs(start.z), Math.abs(end.x), Math.abs(end.z)) / GRID) + 4;
  type Step = { point: Point; g: number; f: number; prev: Step | null };
  const open: Step[] = [], best = new Map<string, number>();
  const key = (p: Point) => `${p.x}/${p.z}`;
  const add = (point: Point, g: number, prev: Step | null) => {
    if (g >= (best.get(key(point)) ?? Infinity)) return;
    best.set(key(point), g);
    const step = { point, g, f: g + distance(point, end), prev };
    // A binary min-heap keeps large worlds from turning each expansion into a full sort.
    let i = open.length; open.push(step);
    while (i > 0) { const parent = (i - 1) >> 1; if (open[parent]!.f <= step.f) break; open[i] = open[parent]!; i = parent; }
    open[i] = step;
  };
  const pop = (): Step => {
    const first = open[0]!, last = open.pop()!;
    if (open.length) {
      let i = 0;
      while (i * 2 + 1 < open.length) {
        let child = i * 2 + 1;
        if (child + 1 < open.length && open[child + 1]!.f < open[child]!.f) child++;
        if (last.f <= open[child]!.f) break;
        open[i] = open[child]!; i = child;
      }
      open[i] = last;
    }
    return first;
  };
  const sx = Math.round(start.x / GRID), sz = Math.round(start.z / GRID);
  for (let x = sx - 2; x <= sx + 2; x++) for (let z = sz - 2; z <= sz + 2; z++) {
    const p = { x: x * GRID, z: z * GRID };
    if (pathClear(start, p, obstacles)) add(p, distance(start, p), null);
  }
  let found: Step | null = null;
  while (open.length) {
    const step = pop();
    if (step.g !== best.get(key(step.point))) continue;
    if (pathClear(step.point, end, obstacles)) { found = step; break; }
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue;
      const next = { x: step.point.x + dx * GRID, z: step.point.z + dz * GRID };
      if (Math.max(Math.abs(next.x), Math.abs(next.z)) > bound * GRID || !pathClear(step.point, next, obstacles)) continue;
      add(next, step.g + Math.hypot(dx, dz) * GRID, step);
    }
  }
  if (!found) throw new Error('No clear route between world doorsteps');
  const raw = [end];
  for (let at: Step | null = found; at; at = at.prev) raw.unshift(at.point);
  raw.unshift(start);
  const simple = [start];
  for (let i = 0; i < raw.length - 1;) {
    let j = raw.length - 1;
    while (j > i + 1 && !pathClear(raw[i]!, raw[j]!, obstacles)) j--;
    simple.push(raw[j]!); i = j;
  }
  // Chaikin corner cuts are accepted only when the resulting chord remains clear.
  let rounded = simple;
  for (let pass = 0; pass < 2; pass++) {
    const cut = [start];
    for (let i = 0; i < rounded.length - 1; i++) {
      const a = rounded[i]!, b = rounded[i + 1]!;
      cut.push({ x: a.x * .75 + b.x * .25, z: a.z * .75 + b.z * .25 }, { x: a.x * .25 + b.x * .75, z: a.z * .25 + b.z * .75 });
    }
    cut.push(end);
    if (cut.slice(1).every((p, i) => pathClear(cut[i]!, p, obstacles))) rounded = cut;
  }
  return rounded;
}
