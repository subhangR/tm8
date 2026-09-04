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

export const NODE_W = 148;
export const NODE_H = 40;
/** Radius of the first ring, then one step per hop. */
const R1 = 150;
const R_STEP = 132;
const PAD = 28;

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
}

/**
 * Move a centre point to the rectangular node boundary in `toward`'s
 * direction. Links used to end underneath each node; that was harmless for a
 * bare line but hides an SVG marker completely. Trimming exposes arrowheads
 * without consulting a clock or perturbing a single node position.
 */
function boxBoundary(
  centre: { x: number; y: number },
  toward: { x: number; y: number },
): { x: number; y: number } {
  const dx = toward.x - centre.x;
  const dy = toward.y - centre.y;
  if (dx === 0 && dy === 0) return centre;
  const tx = dx === 0 ? Number.POSITIVE_INFINITY : (NODE_W / 2) / Math.abs(dx);
  const ty = dy === 0 ? Number.POSITIVE_INFINITY : (NODE_H / 2) / Math.abs(dy);
  const scale = Math.min(tx, ty);
  return { x: centre.x + dx * scale, y: centre.y + dy * scale };
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
  const radius = maxHop === 0 ? 0 : R1 + (maxHop - 1) * R_STEP;
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
    const r = cell.hop === 0 ? 0 : R1 + (cell.hop - 1) * R_STEP;
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
    const control = {
      x: mx + (dx / len) * 14,
      y: my + (dy / len) * 14,
    };
    const start = boxBoundary(from, control);
    const end = boxBoundary(to, control);
    links.push({
      link,
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      cx: control.x,
      cy: control.y,
    });
  }

  return { cells: placed, links, width, height, centre };
}

/** Ring radii, so the canvas can draw the hop guides the rings stand on. */
export function ringRadii(maxHop: number): number[] {
  const out: number[] = [];
  for (let hop = 1; hop <= maxHop; hop += 1) out.push(R1 + (hop - 1) * R_STEP);
  return out;
}
