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
export const NODE_H = 72;
/**
 * THE FOCUS IS BIGGER, because it is the one node the viewer named. Every other
 * card is a peer of every other card; drawing the subject the same size as its
 * neighbours made the picture say "here are twenty things", when what was asked
 * was "here is this thing and what it touches". The extra height carries the
 * fourth line — see `SessionGraphBody`'s facts row.
 */
export const FOCUS_W = 268;
export const FOCUS_H = 104;

/** The size a cell at this hop is drawn at. The only tier boundary is the centre. */
export function cellSize(hop: number): { w: number; h: number } {
  return hop === 0 ? { w: FOCUS_W, h: FOCUS_H } : { w: NODE_W, h: NODE_H };
}

/** Clear space demanded between two cards, in whichever axis ends up carrying it. */
const RING_GAP = 26;
const PAD = 32;

/**
 * The centre-to-centre distance two cards must reach, for cards of the given
 * half-extents summed.
 *
 * A card is an AXIS-ALIGNED rectangle, so the honest test is `|Δx| ≥ w` or
 * `|Δy| ≥ h` — never the distance between them, and never the arc. For a
 * separation of magnitude `d` at direction φ that reads `d·|cos φ| ≥ w` or
 * `d·|sin φ| ≥ h`; the worst φ is where the two are equal, and there
 * `d = hypot(w, h)`. So this is exact, not a bound with slack: any shorter
 * distance has a direction that overlaps, and no longer one is ever needed.
 */
function clearance(w: number, h: number): number {
  return Math.hypot(w + RING_GAP, h + RING_GAP);
}

/**
 * Two cards on the same ring, and a parent directly above its own child on the
 * next ring, are the same problem in different directions — both are a pair of
 * NODE-sized cards separated by one vector — so both take one number.
 */
const CHORD_CLEARANCE = clearance(NODE_W, NODE_H);
/**
 * The first ring clears the FOCUS, which is wider and taller than its children.
 * A lone child sits at exactly its parent's angle, so with the focus as parent
 * the radius is the only thing separating them.
 */
const R1_MIN = clearance((FOCUS_W + NODE_W) / 2, (FOCUS_H + NODE_H) / 2);
const R_STEP_MIN = CHORD_CLEARANCE;

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
   * THE BOX THE DRAWING ACTUALLY OCCUPIES, which is not the box it is laid out
   * in. A radial layout reserves the full circle — `2·(r + card + pad)` on both
   * axes — but the cells only ever stand on the ANGLES the sweep assigned, so a
   * graph with four branches leaves most of that square empty. Fitting the
   * square meant fitting the emptiness: at 100% the cards were drawn at a third
   * of the size the canvas had room for, and every viewer's first act was to
   * zoom. This is the union of the drawn cards' own rectangles, so 100% means
   * "as large as this canvas allows" rather than "as large as the circle allows".
   */
  view: { x: number; y: number; w: number; h: number };
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
  const half = Math.max(radius + NODE_W / 2, FOCUS_W / 2) + PAD;
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

  /* The union of what was drawn — see `Placement.view`. The focus is always
     placed, so there is always at least one rectangle to union. */
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of placed) {
    const { w, h } = cellSize(p.cell.hop);
    minX = Math.min(minX, p.x - w / 2);
    maxX = Math.max(maxX, p.x + w / 2);
    minY = Math.min(minY, p.y - h / 2);
    maxY = Math.max(maxY, p.y + h / 2);
  }
  const view =
    placed.length === 0
      ? { x: 0, y: 0, w: width, h: height }
      : {
          x: minX - PAD,
          y: minY - PAD,
          w: maxX - minX + PAD * 2,
          h: maxY - minY + PAD * 2,
        };

  return { cells: placed, links, width, height, centre, radii, view };
}

