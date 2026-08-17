/**
 * BLUEPRINT VIEW — the pure fold from a `graph` entity's ROW to a drawable
 * placement (Craft P1, rulings R1-R3).
 *
 * The row is the whole graph (R1): no per-node connections reads, no induced
 * edges, no cap — one content object in, one placement out. The content is
 * LEAN BY LAW (R2), so this parser is tolerant: a node with no key gets one
 * derived; an edge naming a key no node carries is COUNTED and skipped, never
 * silently dropped and never a crash (the no-silent-caps law); an unknown
 * member is ignored.
 *
 * LAYOUT: `layout[key] = {x, y}` is honored as the card's top-left in canvas
 * units (presentation only, exactly what the row stores); every node without
 * a layout entry falls back to the first-seen grid — the same
 * stable-under-insertion placement the induced graph uses, and for the same
 * R9/R10 reasons (see chat-home/induced-layout.ts' header).
 */
import type { EntityId } from '@tm8/contract';
import { CARD_H, CARD_W, GAP_X, GAP_Y, PAD, PER_ROW } from '../chat-home/induced-layout';
import { humanize } from '../session-graph/model';

export interface BlueprintCard {
  /** Row-local key — the edge namespace. Derived (`#i` / the ref id) when absent. */
  key: string;
  /** The referenced entity, when this node is a reference. */
  refId: EntityId | null;
  kind: string;
  title: string;
  /** True ⇒ a SPEC (does not exist yet); drawn dashed so intent never passes as fact. */
  isSpec: boolean;
  hint: string | null;
  /** Top-left. */
  x: number;
  y: number;
}

export interface BlueprintLine {
  key: string;
  src: string;
  dst: string;
  /** Humanised relation type — the edge vocabulary as intent. */
  label: string;
  note: string | null;
  x1: number; y1: number; x2: number; y2: number;
  cx: number; cy: number;
  lx: number; ly: number;
}

export interface BlueprintView {
  graphType: string;
  source: string | null;
  cards: readonly BlueprintCard[];
  lines: readonly BlueprintLine[];
  /** Edges whose src/dst named no node — surfaced, never silently dropped. */
  danglingEdgeCount: number;
  width: number;
  height: number;
  /**
   * What is actually DRAWN, as a box — the placement's true extent.
   *
   * `width`/`height` above are a MAX EXTENT measured from a pinned 0,0
   * origin, which is not the same thing and was the whole bug: a row whose
   * `layout` puts one card far right (or at any negative coordinate — a
   * legal thing for a row to store, and the fallback grid is only one of
   * several writers) inflated the extent while every other card stayed near
   * the origin. Fitting to that box drew a mostly-empty canvas with the
   * blueprint shrunk into its top-left corner, which is precisely what the
   * screenshot showed.
   *
   * Bows and their labels are folded in too. For cards sitting in the
   * fallback grid the curve stays inside the union of the two cards, so this
   * usually changes nothing — but `layout` is whatever the row stores, and
   * once two connected cards are placed far apart or off the grid the apex
   * and its label swing outside every card rectangle. Fitting to the cards
   * alone would then clip the one piece of text saying what the blueprint
   * MEANS, and it would do it only on the irregular rows, which is the worst
   * way for a bug to behave.
   */
  bounds: { minX: number; minY: number; width: number; height: number };
}

/** The bow's label sits above its apex; leave room for it and the second line. */
const LABEL_PAD = 18;

interface RawNode {
  key?: unknown; id?: unknown; ref?: unknown; entityId?: unknown;
  spec?: { kind?: unknown; title?: unknown; hint?: unknown };
}
interface RawEdge { src?: unknown; dst?: unknown; type?: unknown; note?: unknown }

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const ENTITY_ID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE PINNED SHAPE, resolved in ONE place (see `GraphNode` in contract.ts).
 *
 * A node is a REFERENCE iff it carries `ref` (or its legacy alias `entityId`).
 * Otherwise it is a SPEC. Entity-hood is NEVER inferred from `id` — `id` is
 * the row-local key, which is what every writer actually uses it for, and
 * reading it as an entity id is what made every spec card render as a broken
 * reference.
 *
 * Exported because `CraftScreen` resolves reference titles from the same
 * answer: if these two ever disagree about what a reference is, the canvas
 * draws one thing and the network fetches another — which is the bug, again.
 */
export function nodeRefId(node: RawNode): EntityId | null {
  const ref = str(node.ref) ?? str(node.entityId);
  if (ref) return ref as EntityId;
  /* A spec is a spec. The legacy branch below never overrides an explicit one. */
  if (node.spec && typeof node.spec === 'object') return null;
  /* LEGACY (pre-pin rows): bare `id` in entity-id form meant the reference. */
  const bare = str(node.id) ?? str(node.key);
  return bare && ENTITY_ID_FORM.test(bare) ? (bare as EntityId) : null;
}

/**
 * The row-local key edges name. `key` wins when present — it is the key old
 * edges were written against — otherwise `id`, the pinned spelling.
 */
export function nodeKey(node: RawNode, index: number): string {
  return str(node.key) ?? str(node.id) ?? nodeRefId(node) ?? `#${index}`;
}

/** Resolved titles for reference nodes, keyed by entity id (the host reads them). */
export type RefTitles = ReadonlyMap<string, { kind: string; title: string }>;

export function blueprintView(content: unknown, refTitles?: RefTitles): BlueprintView {
  const c = (content ?? {}) as Record<string, unknown>;
  const graphType = str(c['graphType']) ?? 'entity';
  const source = str(c['source']);
  const rawNodes: RawNode[] = Array.isArray(c['nodes']) ? (c['nodes'] as RawNode[]) : [];
  const rawEdges: RawEdge[] = Array.isArray(c['edges']) ? (c['edges'] as RawEdge[]) : [];
  const layout = (c['layout'] ?? {}) as Record<string, { x?: unknown; y?: unknown }>;

  const cards: BlueprintCard[] = rawNodes.map((node, index) => {
    const refId = nodeRefId(node);
    const key = nodeKey(node, index);
    const spec = node.spec && typeof node.spec === 'object' ? node.spec : null;
    const resolved = refId ? refTitles?.get(refId) : undefined;
    const placed = layout[key];
    const hasLayout = placed !== undefined
      && typeof placed.x === 'number' && Number.isFinite(placed.x)
      && typeof placed.y === 'number' && Number.isFinite(placed.y);
    const col = index % PER_ROW;
    const row = Math.floor(index / PER_ROW);
    return {
      key,
      refId: (refId as EntityId | null),
      kind: resolved?.kind ?? str(spec?.kind) ?? 'entity',
      /* An unresolved reference shows its truncated id, honestly — the host
         resolves titles asynchronously and re-folds. */
      title: resolved?.title ?? str(spec?.title) ?? (refId ? `${refId.slice(0, 8)}…` : 'Untitled'),
      isSpec: refId === null,
      hint: str(spec?.hint),
      x: hasLayout ? PAD + (placed.x as number) : PAD + col * (CARD_W + GAP_X),
      y: hasLayout ? PAD + (placed.y as number) : PAD + row * (CARD_H + GAP_Y),
    };
  });

  const byKey = new Map(cards.map((card) => [card.key, card]));
  const lines: BlueprintLine[] = [];
  let dangling = 0;
  rawEdges.forEach((edge, index) => {
    const srcKey = str(edge.src);
    const dstKey = str(edge.dst);
    const from = srcKey ? byKey.get(srcKey) : undefined;
    const to = dstKey ? byKey.get(dstKey) : undefined;
    if (!from || !to) {
      dangling += 1;
      return;
    }
    const x1 = from.x + CARD_W / 2;
    const y1 = from.y + CARD_H / 2;
    const x2 = to.x + CARD_W / 2;
    const y2 = to.y + CARD_H / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    /* The induced graph's bow, verbatim: left normal, fixed side (R10). */
    const bow = 26;
    const nx = -dy / len;
    const ny = dx / len;
    const cx = (x1 + x2) / 2 + nx * bow;
    const cy = (y1 + y2) / 2 + ny * bow;
    lines.push({
      key: `${srcKey}:${dstKey}:${str(edge.type) ?? ''}:${index}`,
      src: from.key,
      dst: to.key,
      label: humanize(str(edge.type) ?? 'relates to'),
      note: str(edge.note),
      x1, y1, x2, y2, cx, cy,
      lx: (x1 + x2) / 2 + (nx * bow) / 2,
      ly: (y1 + y2) / 2 + (ny * bow) / 2,
    });
  });

  const width = Math.max(...cards.map((card) => card.x + CARD_W), PAD) + PAD;
  const height = Math.max(...cards.map((card) => card.y + CARD_H), PAD) + PAD;

  /* THE TRUE BOX. Every drawn x and y, min AND max — the cards, the bows'
     control points (a quadratic never leaves its hull, so the control point
     bounds the curve), and the label anchors with room for two lines of it.
     An empty placement answers the origin box rather than ±Infinity: with no
     cards there is nothing to fit to, and a canvas that renders the empty
     state never reads this. */
  const xs: number[] = [];
  const ys: number[] = [];
  cards.forEach((card) => {
    xs.push(card.x, card.x + CARD_W);
    ys.push(card.y, card.y + CARD_H);
  });
  lines.forEach((line) => {
    xs.push(line.x1, line.x2, line.cx, line.lx);
    ys.push(line.y1, line.y2, line.cy, line.ly - LABEL_PAD, line.ly + LABEL_PAD);
  });
  const minX = xs.length > 0 ? Math.min(...xs) - PAD : 0;
  const minY = ys.length > 0 ? Math.min(...ys) - PAD : 0;
  const bounds = {
    minX,
    minY,
    width: xs.length > 0 ? Math.max(...xs) + PAD - minX : width,
    height: ys.length > 0 ? Math.max(...ys) + PAD - minY : height,
  };

  return { graphType, source, cards, lines, danglingEdgeCount: dangling, width, height, bounds };
}
