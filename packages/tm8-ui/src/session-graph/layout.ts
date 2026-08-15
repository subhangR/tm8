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
 * RADII ARE DERIVED FROM OCCUPANCY, NOT CONSTANT.
 *
 * A ring has to seat its cells side by side, so the radius a hop needs is
 * whatever makes its circumference hold them: r ≥ n·(NODE_W + gap) / 2π. Fixed
 * radii were survivable while cells were 148 wide and hops held four or five
 * things; at 216 wide, a hop holding a dozen peers overlaps them into an
 * unreadable stack — which is the same defect as the too-small card, arriving
 * from the other direction. Deriving the radius means a busy hop pushes its
 * ring out instead of piling up, and a quiet one stays compact.
 *
 * Monotonic by construction: a ring is never drawn inside the one before it.
 */
function radiiFor(countByHop: ReadonlyMap<number, number>, maxHop: number): number[] {
  const out: number[] = [];
  let previous = 0;
  for (let hop = 1; hop <= maxHop; hop += 1) {
    const needed = ((countByHop.get(hop) ?? 0) * (NODE_W + RING_GAP)) / (2 * Math.PI);
    const floor = hop === 1 ? R1_MIN : previous + R_STEP_MIN;
    previous = Math.max(floor, needed);
    out.push(previous);
  }
  return out;
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
  const countByHop = new Map<number, number>();
  for (const cell of graph.cells) {
    countByHop.set(cell.hop, (countByHop.get(cell.hop) ?? 0) + 1);
  }
  const radii = radiiFor(countByHop, maxHop);
  const radiusAt = (hop: number): number => (hop === 0 ? 0 : radii[hop - 1] ?? 0);
  const radius = maxHop === 0 ? 0 : radiusAt(maxHop);
  const half = radius + NODE_W / 2 + PAD;
  const width = half * 2;
  const height = half * 2;
  const centre = { x: half, y: half };

  const placed: PlacedCell[] = [];
  const angleOf = new Map<string, number>();

  const place = (id: string, from: number, to: number): void => {
    const cell = byId.get(id);
    if (!cell) return;
    const mid = (from + to) / 2;
    angleOf.set(id, mid);
    const r = radiusAt(cell.hop);
    placed.push({
      cell,
      x: centre.x + Math.cos(mid) * r,
      y: centre.y + Math.sin(mid) * r,
      angle: mid,
    });
    const kids = children.get(id) ?? [];
    if (kids.length === 0) return;
    const total = kids.reduce((sum, kid) => sum + weigh(kid), 0) || 1;
    let cursor = from;
    for (const kid of kids) {
      const span = ((to - from) * weigh(kid)) / total;
      place(kid, cursor, cursor + span);
      cursor += span;
    }
  };

  // Start at the top and sweep clockwise; the focus owns the whole circle.
  const START = -Math.PI / 2;
  place(graph.focusId, START, START + Math.PI * 2);

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

