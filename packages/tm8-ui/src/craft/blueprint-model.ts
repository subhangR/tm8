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
}

interface RawNode { key?: unknown; id?: unknown; spec?: { kind?: unknown; title?: unknown; hint?: unknown } }
interface RawEdge { src?: unknown; dst?: unknown; type?: unknown; note?: unknown }

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

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
    const refId = str(node.id);
    const key = str(node.key) ?? refId ?? `#${index}`;
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
  return { graphType, source, cards, lines, danglingEdgeCount: dangling, width, height };
}
