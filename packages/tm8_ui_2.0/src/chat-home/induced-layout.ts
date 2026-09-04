/**
 * LAYOUT for the induced entity graph — deterministic, clearance-correct,
 * stable under insertion (R9/R10). There is NO focus and NO centre (R1), so
 * the radial ego layout next door is the wrong instrument here.
 *
 * WHY A FIRST-SEEN GRID, AND NOT DAGRE (the R9 rubric, applied):
 *
 *   1. DETERMINISTIC — both qualify. Dagre is deterministic; so is this.
 *   2. AXIS-ALIGNED CLEARANCE — both qualify. A grid clears by construction:
 *      same row ⇒ |Δx| = CARD_W + GAP_X, different row ⇒ |Δy| = CARD_H +
 *      GAP_Y, which is exactly `layout.ts`'s honest test for axis-aligned
 *      rectangles (|Δx| ≥ w OR |Δy| ≥ h) with real slack, never the
 *      circumference-÷-count average that let the star's cards overlap.
 *   3. STABLE UNDER INSERTION — dagre FAILS. It re-ranks and re-orders the
 *      whole graph per input, so one arriving node mid-stream can move every
 *      settled card. Worse, ANY edge-aware placement fails here jointly with
 *      R10: edges arrive asynchronously AFTER both endpoints settle (a new
 *      seed's read discovers relations among OLD nodes), and a pure function
 *      that consults edges must therefore move settled cards when a read
 *      lands. The only placement family that is simultaneously pure (R10)
 *      and stream-stable (R9) is `position = f(first-seen index)` — and the
 *      wrapping grid is its readable member. Structure is carried by the
 *      LINES, which is what they are for.
 *
 * So: no dependency bought, and the two rejections above are the receipt.
 */
import { NODE_H, NODE_W } from '../session-graph/layout';
import type { InducedEdge, InducedGraph, InducedNode } from './induced-graph';

export const CARD_W = NODE_W;
export const CARD_H = NODE_H;
/** Columns are CONSTANT PER HOST — deriving them from the COUNT would move
 *  every settled card the moment the count crossed the threshold. A host may
 *  pass its own `perRow` (fullscreen derives one from viewport width); within
 *  a mount it must hold that value steady for the same stability reason. */
export const PER_ROW = 4;
export const GAP_X = 56;
/** Rows leave room for the relation labels that travel between them. */
export const GAP_Y = 84;
export const PAD = 24;

export interface PlacedCard {
  node: InducedNode;
  /** Top-left corner. */
  x: number;
  y: number;
}

export interface PlacedLine {
  edge: InducedEdge;
  /** Card centres, `1` = the edge's `a` endpoint. Drawn beneath the cards. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Quadratic control point — a bow so coincident pairs of lines separate. */
  cx: number;
  cy: number;
  /** The curve's apex — where the relation labels sit. */
  lx: number;
  ly: number;
}

export interface InducedPlacement {
  cards: readonly PlacedCard[];
  lines: readonly PlacedLine[];
  width: number;
  height: number;
}

/** Centre of the card at first-seen index `i` — the whole stability story. */
function centreAt(index: number, perRow: number): { x: number; y: number } {
  const col = index % perRow;
  const row = Math.floor(index / perRow);
  return {
    x: PAD + col * (CARD_W + GAP_X) + CARD_W / 2,
    y: PAD + row * (CARD_H + GAP_Y) + CARD_H / 2,
  };
}

export function layoutInducedGraph(
  graph: InducedGraph,
  opts?: { perRow?: number },
): InducedPlacement {
  const perRow = Math.max(1, opts?.perRow ?? PER_ROW);
  const indexOf = new Map<string, number>();
  graph.nodes.forEach((node, index) => indexOf.set(node.id, index));

  const cards: PlacedCard[] = graph.nodes.map((node, index) => {
    const centre = centreAt(index, perRow);
    return { node, x: centre.x - CARD_W / 2, y: centre.y - CARD_H / 2 };
  });

  const lines: PlacedLine[] = [];
  for (const edge of graph.edges) {
    const ai = indexOf.get(edge.a);
    const bi = indexOf.get(edge.b);
    if (ai === undefined || bi === undefined) continue;
    const from = centreAt(ai, perRow);
    const to = centreAt(bi, perRow);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    /* Bow to the LEFT normal of a→b — a fixed, input-derived side, so the
       same graph always bows the same way (R10). */
    const bow = 26;
    const nx = -dy / len;
    const ny = dx / len;
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const cx = mx + nx * bow;
    const cy = my + ny * bow;
    lines.push({
      edge,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      cx,
      cy,
      // Quadratic bezier at t = 0.5: midpoint pulled halfway to the control.
      lx: mx + (nx * bow) / 2,
      ly: my + (ny * bow) / 2,
    });
  }

  const n = graph.nodes.length;
  const cols = Math.min(Math.max(n, 1), perRow);
  const rows = Math.max(Math.ceil(n / perRow), 1);
  return {
    cards,
    lines,
    width: PAD * 2 + cols * CARD_W + (cols - 1) * GAP_X,
    height: PAD * 2 + rows * CARD_H + (rows - 1) * GAP_Y,
  };
}
