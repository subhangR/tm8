/**
 * CANVAS NAVIGATION — the pure questions every Craft view asks of a folded
 * blueprint: which way does this line run, what touches this node, where do
 * the arrow keys go from here, what does the find box match.
 *
 * NO LAYOUT HERE. Positions, ports, ranks and lanes are the view model's
 * (`blueprint-model.ts`, Foundations); this module only reads them. Keeping
 * it separate from the canvas is what lets the Outline and Table views share
 * one selection model with the drawing, and lets jsdom test the keyboard.
 */
import type { BlueprintCard, BlueprintLine, BlueprintView } from './blueprint-types';

/**
 * The line's ends AS DRAWN. `consumes` and `depends_on` are stored
 * "task consumes doc" / "task depends_on prerequisite" but drawn in flow
 * order, so the arrow's tail is the stored `dst`. The model says which with
 * `drawnReversed`; this is the one place that flips it.
 */
export function drawnEnds(line: BlueprintLine): { from: string; to: string } {
  return line.drawnReversed ? { from: line.dst, to: line.src } : { from: line.src, to: line.dst };
}

export interface Neighbourhood {
  /** The node itself plus every node one drawn line away. */
  nodes: ReadonlySet<string>;
  /** Lines touching the node. */
  lines: ReadonlySet<string>;
  /** Lines arriving at the node (its inputs, in flow terms). */
  incoming: readonly BlueprintLine[];
  /** Lines leaving the node (its outputs). */
  outgoing: readonly BlueprintLine[];
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export function neighbourhood(view: BlueprintView, key: string | null): Neighbourhood {
  if (!key) return { nodes: EMPTY_SET, lines: EMPTY_SET, incoming: [], outgoing: [] };
  const nodes = new Set<string>([key]);
  const lines = new Set<string>();
  const incoming: BlueprintLine[] = [];
  const outgoing: BlueprintLine[] = [];
  for (const line of view.lines) {
    const { from, to } = drawnEnds(line);
    if (from === key) {
      outgoing.push(line);
      nodes.add(to);
      lines.add(line.key);
    } else if (to === key) {
      incoming.push(line);
      nodes.add(from);
      lines.add(line.key);
    }
  }
  /* An assignee is drawn ON its tasks, not joined to them by a line — but it
     is still their neighbour, and the task is still the assignee's. */
  const attached = view.attached.find((node) => node.key === key);
  if (attached) attached.tasks.forEach((task) => nodes.add(task));
  for (const card of view.cards) {
    if (card.key === key) card.assignees.forEach((assignee) => nodes.add(assignee.key));
  }
  return { nodes, lines, incoming, outgoing };
}

export type NavDirection = 'left' | 'right' | 'up' | 'down';

const centre = (card: BlueprintCard) => ({ x: card.x + card.width / 2, y: card.y + card.height / 2 });

/**
 * Where an arrow key goes from `key`.
 *
 * GEOMETRIC, not topological, on purpose: the reader presses → because they
 * are LOOKING at something to the right, and the drawing — flow, lanes, LR or
 * TB, pinned outliers — is what they see. The nearest card in that half-plane
 * wins, with off-axis distance weighted double so → stays on its row rather
 * than diving to a closer card two rows down. No card there ⇒ stay put.
 * No selection ⇒ the first card in reading order.
 */
export function stepSelection(view: BlueprintView, key: string | null, dir: NavDirection): string | null {
  const cards = view.cards;
  if (cards.length === 0) return null;
  const current = key ? cards.find((card) => card.key === key) : undefined;
  if (!current) return readingOrder(view)[0]?.key ?? null;
  const from = centre(current);
  let best: { key: string; score: number } | null = null;
  for (const card of cards) {
    if (card.key === current.key) continue;
    const to = centre(card);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1) continue;
    const score = along + across * 2;
    if (!best || score < best.score) best = { key: card.key, score };
  }
  return best?.key ?? current.key;
}

/** Cards in the order a reader meets them: by flow stage, then top to bottom. */
export function readingOrder(view: BlueprintView): readonly BlueprintCard[] {
  return [...view.cards].sort((a, b) => (a.rank - b.rank) || (a.y - b.y) || (a.x - b.x));
}

/**
 * The find box. Case-insensitive; a card matches when its title, kind label
 * or row key CONTAINS the query (titles are sentences, and the word you
 * remember is rarely the first). Results come back in reading order so
 * Enter walks the plan the way it is drawn.
 */
export function findCards(view: BlueprintView, query: string): readonly string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return readingOrder(view)
    .filter((card) =>
      card.title.toLowerCase().includes(q)
      || card.kindLabel.toLowerCase().includes(q)
      || card.key.toLowerCase().includes(q)
      || card.assignees.some((assignee) => assignee.title.toLowerCase().includes(q)))
    .map((card) => card.key);
}

export interface Box { minX: number; minY: number; width: number; height: number }

/** The box around a set of cards, padded — what focus mode fits to. Null when none are drawn. */
export function boxOf(view: BlueprintView, keys: ReadonlySet<string>, pad = 32): Box | null {
  const cards = view.cards.filter((card) => keys.has(card.key));
  if (cards.length === 0) return null;
  const minX = Math.min(...cards.map((card) => card.x)) - pad;
  const minY = Math.min(...cards.map((card) => card.y)) - pad;
  const maxX = Math.max(...cards.map((card) => card.x + card.width)) + pad;
  const maxY = Math.max(...cards.map((card) => card.y + card.height)) + pad;
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The midpoint ALONG a polyline — where a label with no reserved slot is
 * shown on hover. Walks the segments by length rather than averaging the
 * points, so a long first leg does not drag the label onto a corner.
 */
export function pathMidpoint(points: readonly { x: number; y: number }[]): { x: number; y: number } | null {
  if (points.length === 0) return null;
  if (points.length === 1) return points[0]!;
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const len = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    lengths.push(len);
    total += len;
  }
  let remaining = total / 2;
  for (let i = 1; i < points.length; i += 1) {
    const len = lengths[i - 1]!;
    if (remaining <= len && len > 0) {
      const t = remaining / len;
      const a = points[i - 1]!;
      const b = points[i]!;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= len;
  }
  return points[points.length - 1]!;
}

/** A card or an attached assignee, by key — what the inspector shows. */
export function nodeByKey(view: BlueprintView, key: string | null) {
  if (!key) return null;
  const card = view.cards.find((c) => c.key === key);
  if (card) return { type: 'card' as const, card };
  const attached = view.attached.find((a) => a.key === key);
  if (attached) return { type: 'attached' as const, attached };
  return null;
}

/** Title for any drawn key — cards, attached assignees, or the key itself when unknown. */
export function titleOf(view: BlueprintView, key: string): string {
  return view.cards.find((c) => c.key === key)?.title
    ?? view.attached.find((a) => a.key === key)?.title
    ?? key;
}
