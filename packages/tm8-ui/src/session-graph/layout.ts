/**
 * RADIAL LAYOUT for the session ego-network.
 *
 * A ring per hop, because the hop IS the question the viewer asked. The layered
 * island layout the whole-space canvas uses reads structure across a flat
 * graph; here there is one distinguished node and everything else is at a
 * distance from it, which is exactly what concentric rings say and what a
 * force layout would blur.
 *
 * ANGLE BY SUBTREE WEIGHT, not by count. Each hop-1 relation receives a sector
 * proportional to the number of cells hanging off it, so the branch that
 * carries a task, its PR and its doc gets the room it needs while a lone
 * teammate takes a sliver. Sectors are then inherited downward, which keeps a
 * branch visually intact instead of interleaving two branches' children at the
 * same radius.
 *
 * DETERMINISTIC. Order comes from the model (relation priority, then recency,
 * then title) and nothing here consults a clock or a random source, so the same
 * graph lays out identically on every render — the "settled layout never moves
 * on its own" rule the graph canvas already holds.
 */
import type { Cell, Link, SessionGraph } from './model';

/**
 * Cell size. Sized to the TITLE, not to the diagram: at 148x40 a card held
 * seventeen characters of title, so a real task name became an ellipsis and the
 * picture said nothing without clicking every node. The whole-space canvas
 * settled on 240x124 for the same reason; these cards carry less (no avatar
 * row, no counters) so they need less height, but they must clear the width at
 * which titles stop being guesses.
 */
export const NODE_W = 216;
export const NODE_H = 62;
/** Clear space demanded between two cards sitting side by side on a ring. */
const RING_GAP = 26;
/**
 * Smallest first ring, and smallest step between rings. Both are NODE_W-derived
 * rather than chosen: a child inherits its parent's sector and is placed at the
 * sector's midpoint, so a lone child sits at EXACTLY its parent's angle — and
 * when that angle is horizontal the only thing separating the two cards is the
 * radius. Anything below a card's width therefore overlaps, which is what the
 * old constants did the moment the cards grew (caught by layout.test.ts, not by
 * eye). The floors clear a full card in the worst direction.
 */
const R1_MIN = NODE_W + RING_GAP;
const R_STEP_MIN = NODE_W + RING_GAP;
const PAD = 32;

/**
 * Separation two cards on the same ring must achieve between their CENTRES.
 *
 * A card is an axis-aligned rectangle, so the honest test is `|Δx| ≥ W` or
 * `|Δy| ≥ H` — never the arc length between them. Two cells near the top of the
 * circle can be a generous arc apart and still sit almost directly above one
 * another in x. Requiring the chord to clear `√2·(W + gap)` makes the weaker of
 * the two axes carry at least `W + gap` on its own, whatever the chord's
 * direction: one of |sin|, |cos| is always ≥ √2/2.
 */
const CHORD_CLEARANCE = Math.SQRT2 * (NODE_W + RING_GAP);

/**
 * PEER REVIEW, GPT 5.6, 2026-08-15 — `circumference ÷ count` is not a collision
 * test, and the first version of this file shipped it as one.
 *
 * A cell inherits its parent's sector, so a branch squeezed at hop 1 is still
 * squeezed at hop 2 no matter how empty that ring is overall. Reproduced: one
 * heavy branch of 26 and one light branch of 3 put `light-a` and `light-b`
 * 0.216 rad apart on a ring whose whole occupancy said 484 was plenty — and
 * they landed on top of each other. Averaging over a ring cannot see that,
 * because the crowding is inside ONE sector.
 *
 * So the ring is first given a floor on the angular gap it actually assigned,
 * and only then is a radius derived from that gap. Nothing here averages.
 */
const EPSILON = 1e-9;

/**
 * How far past the evenly-spaced radius a ring may push before it gives its
 * sectors up. Sectors are worth paying for — they put a branch's children near
 * their parent — but not without limit: a sector narrow enough would demand a
 * radius that fits the ring on screen only by shrinking every card back to the
 * unreadable size this whole change exists to end. Beyond this multiple, the
 * ring spreads evenly instead and the LINKS carry the parentage, which is what
 * they were always doing anyway.
 */
const SPREAD_MAX = 2.5;

/** Smallest gap between any two angles on a ring, measured around the circle. */
function minGap(angles: readonly number[]): number {
  if (angles.length < 2) return Math.PI * 2;
  const sorted = [...angles].sort((a, b) => a - b);
  let smallest = sorted[0]! + Math.PI * 2 - sorted[sorted.length - 1]!;
  for (let i = 1; i < sorted.length; i += 1) {
    smallest = Math.min(smallest, sorted[i]! - sorted[i - 1]!);
  }
  return smallest;
}

/**
 * The radius a ring needs, given the gap it actually has.
 *
 * `chord = 2r·sin(δ/2)`, and the chord must clear `CHORD_CLEARANCE`, so
 * `r ≥ CHORD_CLEARANCE / (2·sin(δ/2))`. Note what is NOT here: any count. The
 * ring is sized by its tightest pair, which is the only pair that can collide.
 */
function radiusFor(gap: number, floor: number): number {
  const half = Math.sin(Math.max(gap, EPSILON) / 2);
  return Math.max(floor, CHORD_CLEARANCE / (2 * half));
}

/** The same angles, spread evenly around the circle in their existing order. */
function evenly(angles: readonly number[]): number[] {
  const n = angles.length;
  const step = (Math.PI * 2) / n;
  const order = angles
    .map((angle, index) => ({ angle, index }))
    .sort((a, b) => a.angle - b.angle);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) out[order[i]!.index] = order[0]!.angle + i * step;
  return out;
}

/**
 * One ring's final angles and radius.
 *
 * Sectors first, evenness only if sectors cost too much — see `SPREAD_MAX`. The
 * even arrangement is always seatable, because `2π/n` is the largest minimum
 * gap any `n` angles can have, so this can never fail to return a placement.
 */
function seatRing(angles: readonly number[], floor: number): { angles: number[]; radius: number } {
  const kept = radiusFor(minGap(angles), floor);
  const even = evenly(angles);
  const spread = radiusFor(minGap(even), floor);
  if (kept <= spread * SPREAD_MAX) return { angles: [...angles], radius: kept };
  return { angles: even, radius: spread };
}

export interface PlacedCell {
  cell: Cell;
  x: number;
  y: number;
  /** Radians from the top, for edge trimming and label side. */
  angle: number;
}

export interface PlacedLink {
  link: Link;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Quadratic control point — a gentle bow so parallel relations separate. */
  cx: number;
  cy: number;
}

export interface Placement {
  cells: readonly PlacedCell[];
  links: readonly PlacedLink[];
  width: number;
  height: number;
  centre: { x: number; y: number };
  /**
   * The radius actually used for each hop, so the canvas draws its hop guides
   * on the rings the cells are standing on. Returned rather than recomputed by
   * the caller — the radii now depend on how many cells a hop holds, so a
   * caller deriving them from the hop count alone would draw guides that miss.
   */
  radii: readonly number[];
}

export function layoutSessionGraph(graph: SessionGraph): Placement {
  const byId = new Map(graph.cells.map((cell) => [cell.id, cell]));
  const children = new Map<string, string[]>();
  for (const cell of graph.cells) {
    const parentId = cell.sort === 'fold' ? cell.parentId : cell.parentId;
    if (!parentId) continue;
    const list = children.get(parentId);
    if (list) list.push(cell.id);
    else children.set(parentId, [cell.id]);
  }

  /** Leaves carried by a subtree — the sector weight. */
  const weight = new Map<string, number>();
  const weigh = (id: string): number => {
    const cached = weight.get(id);
    if (cached !== undefined) return cached;
    const kids = children.get(id) ?? [];
    // Seed at 1 so a childless branch still claims a slot of its own.
    const total = kids.length === 0 ? 1 : kids.reduce((sum, kid) => sum + weigh(kid), 0);
    weight.set(id, total);
    return total;
  };
  weigh(graph.focusId);

  const maxHop = graph.cells.reduce((max, cell) => Math.max(max, cell.hop), 0);

  /* PASS ONE — ANGLES ONLY. The radii now depend on the angles a ring ends up
     with, so nothing can be placed until every angle is known. Sweeping and
     placing in one recursion is what forced the old code to size a ring from
     its count, which is the average that let a squeezed sector through. */
  const angleOf = new Map<string, number>();
  const sweep = (id: string, from: number, to: number): void => {
    if (!byId.has(id)) return;
    angleOf.set(id, (from + to) / 2);
    const kids = children.get(id) ?? [];
    if (kids.length === 0) return;
    const total = kids.reduce((sum, kid) => sum + weigh(kid), 0) || 1;
    let cursor = from;
    for (const kid of kids) {
      const span = ((to - from) * weigh(kid)) / total;
      sweep(kid, cursor, cursor + span);
      cursor += span;
    }
  };
  // Start at the top and sweep clockwise; the focus owns the whole circle.
  const START = -Math.PI / 2;
  sweep(graph.focusId, START, START + Math.PI * 2);

  /* PASS TWO — SEAT EACH RING, outward, so a ring's floor is the ring before
     it. The floors are what keep the rings ordered and keep a lone child from
     landing on its own parent when both sit at the same angle. */
  const ringOf = new Map<number, string[]>();
  for (const cell of graph.cells) {
    if (cell.hop === 0) continue;
    const list = ringOf.get(cell.hop);
    if (list) list.push(cell.id);
    else ringOf.set(cell.hop, [cell.id]);
  }
  const radii: number[] = [];
  let previous = 0;
  for (let hop = 1; hop <= maxHop; hop += 1) {
    const ids = ringOf.get(hop) ?? [];
    const floor = hop === 1 ? R1_MIN : previous + R_STEP_MIN;
    if (ids.length === 0) {
      previous = floor;
      radii.push(floor);
      continue;
    }
    const seated = seatRing(ids.map((id) => angleOf.get(id) ?? 0), floor);
    ids.forEach((id, index) => angleOf.set(id, seated.angles[index]!));
    previous = seated.radius;
    radii.push(seated.radius);
  }
  const radiusAt = (hop: number): number => (hop === 0 ? 0 : radii[hop - 1] ?? 0);
  const radius = maxHop === 0 ? 0 : radiusAt(maxHop);
  const half = radius + NODE_W / 2 + PAD;
  const width = half * 2;
  const height = half * 2;
  const centre = { x: half, y: half };

  /* PASS THREE — PLACE. */
  const placed: PlacedCell[] = [];
  for (const cell of graph.cells) {
    const angle = angleOf.get(cell.id);
    if (angle === undefined) continue;
    const r = radiusAt(cell.hop);
    placed.push({
      cell,
      x: centre.x + Math.cos(angle) * r,
      y: centre.y + Math.sin(angle) * r,
      angle,
    });
  }

  const positions = new Map(placed.map((p) => [p.cell.id, p]));
  const links: PlacedLink[] = [];
  for (const link of graph.links) {
    const from = positions.get(link.fromId);
    const to = positions.get(link.toId);
    if (!from || !to) continue;
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    // Bow away from the centre so two edges between adjacent rings do not
    // overlap into one line.
    const dx = mx - centre.x;
    const dy = my - centre.y;
    const len = Math.hypot(dx, dy) || 1;
    links.push({
      link,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      cx: mx + (dx / len) * 14,
      cy: my + (dy / len) * 14,
    });
  }

  return { cells: placed, links, width, height, centre, radii };
}

