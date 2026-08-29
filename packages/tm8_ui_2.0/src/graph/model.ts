/**
 * Graph view model — the PURE computation behind GraphView (no DOM, no react),
 * mirroring the proven collab-v2 graph model's division of labor so vitest
 * exercises everything without a canvas.
 *
 * GRAPH-VIEW-PLAN §2 (P1 prototype scope):
 *  - connected components via union-find over the FILTERED edge set (the
 *    partition is per-filter by design — the dependency subgraph splits
 *    differently than the full edge set);
 *  - layered layout per component (longest-path ranks, one barycenter pass),
 *    then islands PACKED left-to-right so one island's arrivals never perturb
 *    another's layout;
 *  - singleton components go to the loose SHELF, not canvas scatter;
 *  - unresolved hard `depends_on` edges mark the blocked path (edge + both
 *    endpoints), and the edge label carries the WORD (color + word law);
 *  - recency heat is a bucket over `activityAt` vs. the caller's clock —
 *    a real field, honestly held; liveness is NOT computed here (it comes
 *    from the seam's snapshot, R-UI-5 — the view gates the pulse).
 */
import type { EdgeView, EntityId, EntitySummary } from '@tm8/contract';
import {
  DEFAULT_LENS,
  HUB_DEGREE,
  computeRelevance,
  foldLeaves,
  lensSpec,
  seedsFor,
  selectByInterest,
  type FoldedInto,
  type LensId,
} from './relevance';
import { heatOf, type Heat } from './heat';
import { grouperFor, type GroupAssignment, type GroupById } from './grouping';

// Re-exported so every existing `from './model'` import site still resolves —
// heat moved to its own module only to break the model↔grouping import cycle.
export { heatOf, type Heat };

export const NODE_W = 284;
export const NODE_H = 156;
const H_GAP = 44;
const V_GAP = 72;
const ISLAND_GAP = 96;
const MAX_ROW_W = 1900;
const MARGIN = 32;

/** Honest render budget: past this the model truncates AND SAYS SO. */
export const RENDER_CAP = 150;

const EMPTY_SET: ReadonlySet<string> = new Set();


// --------------------------------------------------------------------------
// The time window — WHICH entities are on the canvas at all.
// --------------------------------------------------------------------------

export interface WindowSpec {
  id: string;
  label: string;
  /** Age limit in ms, or null for "no limit". */
  ms: number | null;
  hint: string;
}

/**
 * A window is the answer to "why am I looking at three thousand things?", and
 * it is a different question from the lens. The LENS asks what KIND of interest
 * puts a node on screen (running, worked-on, anything); the WINDOW asks how
 * recently the space touched it. They are orthogonal and both apply.
 *
 * The measured distribution on this space (2026-08-16) is what makes a window
 * worth having at all: 1 hour selects 31 entities, 24 hours 195, 7 days 2,111,
 * all time 3,917. Two weeks earlier the same space held 435 entities of which
 * ~80% were inside a day — recency genuinely could not discriminate then, which
 * is why `seedsFor` still refuses to seed a lens on it. The space grew 9x; the
 * ruling did not rot, the data moved out from under it. Recency now separates
 * 5% from 95%, so it earns a control of its own.
 */
export const GRAPH_WINDOWS: readonly WindowSpec[] = [
  { id: '1h', label: 'Last hour', ms: 60 * 60_000, hint: 'What the space touched in the last hour.' },
  { id: '24h', label: 'Last day', ms: 24 * 60 * 60_000, hint: 'What the space touched in the last 24 hours.' },
  { id: '7d', label: 'Last week', ms: 7 * 24 * 60 * 60_000, hint: 'What the space touched in the last 7 days.' },
  { id: 'all', label: 'All time', ms: null, hint: 'Every entity this session has loaded, however old.' },
];

export const DEFAULT_WINDOW = '24h';

export function windowSpec(id: string): WindowSpec {
  return GRAPH_WINDOWS.find((w) => w.id === id) ?? GRAPH_WINDOWS[GRAPH_WINDOWS.length - 1];
}

export interface GraphModelInput {
  nodes: EntitySummary[];
  edges: EdgeView[];
  /** null = no filter. Kind names are DATA here, never literals (§15.2). */
  kindFilter: ReadonlySet<string> | null;
  edgeTypeFilter: ReadonlySet<string> | null;
  /** The heat clock — fixtures pass FIXTURE_NOW, live passes wall time. */
  now: string;
  /**
   * Which lens seeds the relevance pass. Omitted = the default lens. Selection
   * is by DEGREE-OF-INTEREST (relevance.ts), not by island order, so the render
   * budget always buys the most relevant reachable subgraph.
   */
  lens?: LensId;
  /**
   * Age limit in ms against `now`: an entity whose `activityAt` is older is not
   * on this canvas, and is reported as `outOfWindow`. Omitted or null means no
   * limit — the model's own default is the whole space, because the model is
   * the honest computation and the product default belongs to the surface.
   *
   * Nodes the user is pointing at (live, searched, pinned, focused) are EXEMPT:
   * a window is about clearing away what nobody asked for, and it must never be
   * the reason a search hit is missing.
   */
  windowMs?: number | null;
  /**
   * Stop clustering AT hubs: a node of degree > HUB_DEGREE is drawn and linked
   * but never used to merge two clusters into one. Default true — see
   * HUB_DEGREE for the measurements. Set false to partition on the raw edge
   * set, which on this space yields one component holding 98% of it.
   */
  hubStop?: boolean;
  /** The liveness snapshot's verdict — the only honest source of "running". */
  liveIds?: ReadonlySet<string>;
  /** Search hits: they raise interest AND exempt a node from folding. */
  matchIds?: ReadonlySet<string>;
  /** Focus / selection — pinned interest, never folded, never truncated. */
  pinnedIds?: ReadonlySet<string>;
  /** Explicit focus node: adds the distance term to the ranking. */
  focusId?: EntityId | null;
  /**
   * Fold unprotected degree-1 leaves onto their hub (default ON — it is the
   * single largest declutter and it costs no meaning, since the hub carries the
   * count). Set false to draw every node as its own card.
   */
  fold?: boolean;
  /**
   * Layout stability spine. When present, any PLACED node whose id is a key
   * keeps EXACTLY that position — no re-layout, no packing shift. Placed nodes
   * absent from the map are ARRIVALS: positioned heuristically next to their
   * first frozen neighbor (or, lacking one, in a new-arrivals row beneath the
   * bounding box) WITHOUT ever moving a frozen node. A frozen id that is no
   * longer visible is simply ignored. Omit for a full re-layout.
   */
  frozen?: Readonly<Record<string, { x: number; y: number }>>;
  /**
   * CONTEXTUAL GROUPING — the partition the reader asked for, orthogonal to the
   * topological one. 'none' (the default) leaves every existing behavior exactly
   * as it was: islands packed left-to-right, singletons on the shelf.
   *
   * Any other value re-homes the canvas: nodes are partitioned by the signal
   * (grouping.ts), each band is laid out internally by the SAME layered
   * component code, and the bands stack down the canvas with a header each.
   * The topology does not go away — components still lay out within a band, and
   * every edge is still drawn, including the ones that cross bands. Grouping
   * changes WHERE a node sits, never whether it or its edges exist.
   */
  groupBy?: GroupById;
  /**
   * Group keys the reader has collapsed. A collapsed band draws its header and
   * nothing else; its nodes are reported as `collapsedCount` and are named in
   * the accounting law, never silently dropped. Ignored when `groupBy` is
   * 'none'.
   */
  collapsedGroups?: ReadonlySet<string>;
}

export interface PlacedNode {
  entity: EntitySummary;
  x: number;
  y: number;
  heat: Heat;
  onBlockedPath: boolean;
  /** Tombstone (deletedAt set) — renders as a ghost, never hidden silently. */
  ghost: boolean;
  componentId: number;
  /**
   * Leaves that folded onto this node, if any. The card renders the count — a
   * folded node is RELOCATED onto its hub, never dropped, and the totals below
   * account for every one of them.
   */
  folded?: FoldedInto;
  /** This node's degree-of-interest — what won it a place in the budget. */
  interest: number;
  /**
   * This node's observed degree over the filtered edge set. On a hub the card
   * shows it, because "27 things hang off this" is the reason the clusters
   * around it are drawn apart.
   */
  degree: number;
  /**
   * True when `degree > HUB_DEGREE` and hub-stopping is on: this node did not
   * merge the clusters it touches. It is drawn like anything else — the flag
   * exists so the card can SAY that, rather than leaving the reader to wonder
   * why two visibly linked groups sit apart.
   */
  hub: boolean;
  /**
   * The contextual band this node sits in, or null when `groupBy` is 'none'.
   * Carried on the node so a card can dim, and the minimap can tint, without
   * re-deriving the signal.
   */
  groupKey: string | null;
}

/**
 * One contextual band: a labelled rectangle enclosing every node the signal put
 * together. Geometry is in the same canvas space as `PlacedNode`, so the view
 * draws the frame with no second layout pass.
 */
export interface GraphGroup {
  key: string;
  label: string;
  /** Set when the band IS a kind — the view resolves icon + plural via the registry. */
  kindRef?: string;
  /** Set when the band IS an actor — the view draws the avatar. */
  actorRef?: string;
  /** The residual band ("Unassigned", "No status") — rendered quieter. */
  residual: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  /** How many nodes belong to this band, whether or not it is collapsed. */
  count: number;
  collapsed: boolean;
}

export interface PlacedEdge {
  id: string;
  type: string;
  label: string;
  sourceId: EntityId;
  targetId: EntityId;
  blocked: boolean;
}

export interface GraphModel {
  placed: PlacedNode[];
  edges: PlacedEdge[];
  /** Singleton components — the loose shelf, in stable title order. */
  shelf: EntitySummary[];
  width: number;
  height: number;
  componentCount: number;
  /**
   * Nodes inside the lens that did not fit the RENDER BUDGET. Only these may be
   * explained by "the canvas is full" — see `outOfLens` for the other reason.
   */
  truncated: number;
  /**
   * Nodes the LENS never reached. A different fact from `truncated` with a
   * different remedy: widen the lens, not raise the cap. Reported apart because
   * conflating them made the banner blame the 150-node budget for exclusions the
   * budget never made.
   */
  outOfLens: number;
  /**
   * Nodes the TIME WINDOW excluded — a third reason, with a third remedy
   * (widen the window, not the lens and not the cap). Counted before the lens
   * ever ran, so these nodes appear in no other bucket.
   */
  outOfWindow: number;
  /**
   * How many PLACED nodes were treated as hubs. Nothing was hidden by this —
   * it is the count the toolbar needs to explain why the canvas is in pieces.
   */
  hubCount: number;
  /**
   * True when a seeded lens found no seeds — `Live` with nothing running. The
   * canvas must say so rather than silently showing the whole space.
   */
  lensEmpty: boolean;
  /**
   * Leaves folded onto a hub. Not hidden: each is counted on its hub's badge
   * and included in `visibleTotal` below. Reported separately so the toolbar can
   * say exactly what the declutter did.
   */
  foldedCount: number;
  /**
   * How many nodes the kind filter let through. The accounting law:
   * placed + shelf + folded + truncated + outOfLens + outOfWindow
   *   === visibleTotal.
   */
  visibleTotal: number;
  /** The lens this model was built under. */
  lens: LensId;
  /**
   * How many placed nodes were positioned heuristically this call — i.e. the
   * arrivals that landed beside a frozen neighbor or in the new-arrivals row.
   * 0 whenever `frozen` was omitted (a full re-layout moves everyone by design).
   */
  pendingRelayout: number;
  /**
   * The contextual bands, in display order. Empty when `groupBy` is 'none' —
   * the absence IS the statement that no contextual partition is in force.
   */
  groups: GraphGroup[];
  /** The dimension this model was grouped by. */
  groupBy: GroupById;
  /**
   * Nodes inside a COLLAPSED band. A fourth exclusion reason with a fourth
   * remedy (open the band), reported apart from `truncated` / `outOfLens` /
   * `outOfWindow` for exactly the reason those three are reported apart: they
   * read alike on a count and each has a different fix.
   */
  collapsedCount: number;
}

/** Ported from the proven model: humanized type, hard/soft suffix for deps. */
export function edgeLabel(e: EdgeView): string {
  const base = e.type.startsWith('x:') ? e.type.slice(2) : e.type;
  const words = base.replace(/_/g, ' ');
  if (e.type === 'depends_on') return e.hard === false ? `${words} · soft` : `${words} · hard`;
  return words;
}

export function isBlockedEdge(e: EdgeView): boolean {
  return e.type === 'depends_on' && e.hard !== false && e.resolved === false;
}

// --------------------------------------------------------------------------
// Union-find (per-filter, rebuilt per compute — cheap at this scale, and a
// rebuild is HONEST under edge deletion where incremental union is not).
// --------------------------------------------------------------------------

class UnionFind {
  private parent = new Map<string, string>();

  find(a: string): string {
    let root = this.parent.get(a) ?? a;
    if (root !== a) {
      root = this.find(root);
      this.parent.set(a, root);
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

interface ComponentLayout {
  order: EntityId[];
  pos: Map<EntityId, { x: number; y: number }>;
  w: number;
  h: number;
}

/**
 * Layered layout for one component: longest-path ranks over the component's
 * edges (cycle-tolerant — anything a topological pass cannot settle lands one
 * rank below its deepest settled neighbor), then a single barycenter pass to
 * reduce crossings. Deterministic for a given input.
 */
function layoutComponent(ids: EntityId[], edges: PlacedEdge[]): ComponentLayout {
  const inComponent = new Set(ids);
  const out = new Map<EntityId, EntityId[]>();
  const indegree = new Map<EntityId, number>();
  for (const id of ids) {
    out.set(id, []);
    indegree.set(id, 0);
  }
  for (const e of edges) {
    if (!inComponent.has(e.sourceId) || !inComponent.has(e.targetId)) continue;
    out.get(e.sourceId)!.push(e.targetId);
    indegree.set(e.targetId, (indegree.get(e.targetId) ?? 0) + 1);
  }

  // Kahn with longest-path ranks.
  const rank = new Map<EntityId, number>();
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  for (const id of queue) rank.set(id, 0);
  const pending = new Map(indegree);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of out.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1));
      const left = (pending.get(next) ?? 0) - 1;
      pending.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  // Cycle leftovers: settle below the deepest ranked neighbor, stable order.
  for (const id of ids) {
    if (!rank.has(id)) {
      let below = 0;
      for (const [src, targets] of out) {
        if (targets.includes(id) && rank.has(src)) below = Math.max(below, rank.get(src)! + 1);
      }
      rank.set(id, below);
    }
  }

  const rows = new Map<number, EntityId[]>();
  for (const id of ids) {
    const r = rank.get(id) ?? 0;
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r)!.push(id);
  }
  const rowKeys = [...rows.keys()].sort((a, b) => a - b);

  // One barycenter pass: order each row by the mean column of its ranked-above
  // neighbors (predecessors), keeping insertion order as the tiebreak.
  const col = new Map<EntityId, number>();
  for (const [i, id] of (rows.get(rowKeys[0] ?? 0) ?? []).entries()) col.set(id, i);
  const preds = new Map<EntityId, EntityId[]>();
  for (const e of edges) {
    if (!inComponent.has(e.sourceId) || !inComponent.has(e.targetId)) continue;
    if (!preds.has(e.targetId)) preds.set(e.targetId, []);
    preds.get(e.targetId)!.push(e.sourceId);
  }
  for (const key of rowKeys.slice(1)) {
    const row = rows.get(key)!;
    const scored = row.map((id, i) => {
      const above = (preds.get(id) ?? []).filter((p) => col.has(p));
      const score = above.length
        ? above.reduce((sum, p) => sum + (col.get(p) ?? 0), 0) / above.length
        : i;
      return { id, score, i };
    });
    scored.sort((a, b) => a.score - b.score || a.i - b.i);
    rows.set(key, scored.map((s) => s.id));
    for (const [i, s] of scored.entries()) col.set(s.id, i);
  }

  const widest = Math.max(...rowKeys.map((k) => rows.get(k)!.length), 1);
  const w = widest * NODE_W + (widest - 1) * H_GAP;
  const pos = new Map<EntityId, { x: number; y: number }>();
  for (const key of rowKeys) {
    const row = rows.get(key)!;
    const rowW = row.length * NODE_W + (row.length - 1) * H_GAP;
    const x0 = (w - rowW) / 2;
    for (const [i, id] of row.entries()) {
      pos.set(id, { x: x0 + i * (NODE_W + H_GAP), y: key * (NODE_H + V_GAP) });
    }
  }
  const h = rowKeys.length * NODE_H + (rowKeys.length - 1) * V_GAP;
  return { order: ids, pos, w, h };
}

// --------------------------------------------------------------------------
// Layout stability: freeze known positions, place arrivals around them without
// perturbing anyone frozen. The collision grid is NODE_W/NODE_H rectangles
// snapped to the existing NODE_W+H_GAP / NODE_H+V_GAP spacing.
// --------------------------------------------------------------------------

function rectsOverlap(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + NODE_H && b.y < a.y + NODE_H;
}

/**
 * First non-overlapping grid cell anchored at (ax, ay), scanning outward by
 * Manhattan distance and preferring BELOW over to-the-right within each ring.
 * (0,0) — the anchor itself — is skipped, so a neighbor's own slot is never
 * reused.
 */
function findSpot(ax: number, ay: number, occupied: { x: number; y: number }[]): { x: number; y: number } {
  const stepX = NODE_W + H_GAP;
  const stepY = NODE_H + V_GAP;
  for (let d = 1; d < 1000; d += 1) {
    for (let row = d; row >= 0; row -= 1) {
      const col = d - row;
      const cand = { x: ax + col * stepX, y: ay + row * stepY };
      if (!occupied.some((o) => rectsOverlap(cand, o))) return cand;
    }
  }
  return { x: ax, y: ay + 1000 * stepY };
}

/**
 * Position the placed nodes with frozen ids pinned and arrivals slotted in.
 * Returns the placed list and the arrival count (`pendingRelayout`).
 */
function placeWithFrozen(
  placedComponents: EntityId[][],
  edges: PlacedEdge[],
  byId: Map<EntityId, EntitySummary>,
  blockedIds: Set<EntityId>,
  frozen: Readonly<Record<string, { x: number; y: number }>>,
  now: string,
  decorate: (
    entity: EntitySummary,
  ) => Pick<PlacedNode, 'interest' | 'degree' | 'hub'> & { folded?: FoldedInto },
): { placed: PlacedNode[]; pendingRelayout: number } {
  const placedIds: EntityId[] = [];
  const componentOf = new Map<EntityId, number>();
  for (const [ci, component] of placedComponents.entries()) {
    for (const id of component) {
      placedIds.push(id);
      componentOf.set(id, ci);
    }
  }
  const placedSet = new Set(placedIds);

  // Undirected adjacency among placed nodes — arrivals cling to a placed
  // frozen neighbor, so only placed endpoints carry positions.
  const adj = new Map<EntityId, EntityId[]>();
  for (const id of placedIds) adj.set(id, []);
  for (const e of edges) {
    if (!placedSet.has(e.sourceId) || !placedSet.has(e.targetId)) continue;
    adj.get(e.sourceId)!.push(e.targetId);
    adj.get(e.targetId)!.push(e.sourceId);
  }

  const pos = new Map<EntityId, { x: number; y: number }>();
  const occupied: { x: number; y: number }[] = [];
  for (const id of placedIds) {
    const f = frozen[id];
    if (f) {
      const p = { x: f.x, y: f.y };
      pos.set(id, p);
      occupied.push(p);
    }
  }

  const arrivals = placedIds.filter((id) => frozen[id] === undefined);
  const withoutNeighbor: EntityId[] = [];
  for (const id of arrivals) {
    const neighbor = (adj.get(id) ?? []).find((n) => frozen[n] !== undefined);
    if (neighbor === undefined) {
      withoutNeighbor.push(id);
      continue;
    }
    const anchor = pos.get(neighbor)!;
    const spot = findSpot(anchor.x, anchor.y, occupied);
    pos.set(id, spot);
    occupied.push(spot);
  }

  // The rest land in a fresh row beneath the current bounding box.
  let baselineY = occupied.length
    ? Math.max(...occupied.map((o) => o.y + NODE_H)) + V_GAP
    : MARGIN;
  let cursorX = MARGIN;
  for (const id of withoutNeighbor) {
    if (cursorX > MARGIN && cursorX + NODE_W > MAX_ROW_W) {
      cursorX = MARGIN;
      baselineY += NODE_H + V_GAP;
    }
    let cand = { x: cursorX, y: baselineY };
    while (occupied.some((o) => rectsOverlap(cand, o))) {
      cand = { x: cand.x + (NODE_W + H_GAP), y: cand.y };
    }
    pos.set(id, cand);
    occupied.push(cand);
    cursorX = cand.x + NODE_W + H_GAP;
  }

  const placed: PlacedNode[] = placedIds.map((id) => {
    const entity = byId.get(id)!;
    const p = pos.get(id)!;
    return {
      entity,
      x: p.x,
      y: p.y,
      heat: heatOf(entity.activityAt, now),
      onBlockedPath: blockedIds.has(id),
      ghost: entity.deletedAt !== null,
      componentId: componentOf.get(id) ?? 0,
      groupKey: null,
      ...decorate(entity),
    };
  });
  return { placed, pendingRelayout: arrivals.length };
}

// --------------------------------------------------------------------------
// Contextual band layout.
//
// A band is laid out with the SAME layered component code the ungrouped canvas
// uses — grouping re-homes islands, it does not replace the way an island is
// drawn. Inside a band the islands pack left-to-right and wrap; the band is
// then as wide as its widest row and as tall as its content plus a header.
// --------------------------------------------------------------------------

const GROUP_HEADER = 52;
const GROUP_PAD = 24;
const GROUP_GAP = 40;
const GROUP_MIN_W = 320;

/**
 * Place one band's islands relative to the band's CONTENT origin (0,0 = just
 * inside the padding, below the header). Islands are packed in the order given,
 * wrapping at MAX_ROW_W, exactly as the ungrouped canvas packs them.
 */
function layoutBand(
  islands: EntityId[][],
  edges: PlacedEdge[],
): { pos: Map<EntityId, { x: number; y: number }>; w: number; h: number } {
  const pos = new Map<EntityId, { x: number; y: number }>();
  let cursorX = 0;
  let cursorY = 0;
  let rowH = 0;
  let widest = 0;
  for (const island of islands) {
    const layout = layoutComponent(island, edges);
    if (cursorX > 0 && cursorX + layout.w > MAX_ROW_W) {
      cursorX = 0;
      cursorY += rowH + ISLAND_GAP;
      rowH = 0;
    }
    for (const id of island) {
      const p = layout.pos.get(id)!;
      pos.set(id, { x: cursorX + p.x, y: cursorY + p.y });
    }
    cursorX += layout.w + ISLAND_GAP;
    rowH = Math.max(rowH, layout.h);
    widest = Math.max(widest, cursorX - ISLAND_GAP);
  }
  return { pos, w: widest, h: cursorY + rowH };
}

/**
 * Undirected n-hop neighborhood of `focusId`. Accepts PlacedEdge-shaped
 * (`sourceId`/`targetId`) OR EdgeView-shaped (`source.id`/`target.id`) edges,
 * so both the model's output and the raw contract feed work. Traversal stays
 * within the given node set; an unknown `focusId` yields just `{focusId}`.
 * Deterministic, never throws.
 */
export function focusSubgraph(
  nodes: readonly { id: string }[],
  edges: readonly { sourceId?: string; targetId?: string; source?: { id: string }; target?: { id: string } }[],
  focusId: string,
  hops: number,
): Set<string> {
  const known = new Set(nodes.map((n) => n.id));
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push(b);
  };
  for (const e of edges) {
    const s = e.sourceId ?? e.source?.id;
    const t = e.targetId ?? e.target?.id;
    if (s === undefined || t === undefined) continue;
    link(s, t);
    link(t, s);
  }

  const result = new Set<string>([focusId]);
  let frontier = [focusId];
  for (let h = 0; h < hops && frontier.length > 0; h += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adj.get(id) ?? []) {
        if (!known.has(n) || result.has(n)) continue;
        result.add(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return result;
}

/**
 * Ids whose title OR kind contains `query` (trimmed, case-insensitive
 * substring). An empty or whitespace-only query matches nothing.
 */
export function searchMatches(nodes: readonly EntitySummary[], query: string): Set<string> {
  const q = query.trim().toLowerCase();
  const out = new Set<string>();
  if (q === '') return out;
  for (const n of nodes) {
    if (n.title.toLowerCase().includes(q) || n.kind.toLowerCase().includes(q)) out.add(n.id);
  }
  return out;
}

export function buildGraphModel(input: GraphModelInput): GraphModel {
  const { kindFilter, edgeTypeFilter, now } = input;
  const lens = input.lens ?? DEFAULT_LENS;
  const liveIds = input.liveIds ?? EMPTY_SET;
  const matchIds = input.matchIds ?? EMPTY_SET;
  const pinnedIds = input.pinnedIds ?? EMPTY_SET;

  const kindVisible = input.nodes.filter((n) => kindFilter === null || kindFilter.has(n.kind));

  // ------------------------------------------------------------------------
  // TIME WINDOW. Applied before scoring, because it is a question about
  // MEMBERSHIP, not about rank: an entity nobody has touched this week is not
  // a low-scoring member of today's picture, it is not in it. Everything the
  // user is actively pointing at survives regardless — a window must never be
  // the reason a search hit or a running session is missing.
  // ------------------------------------------------------------------------
  const windowMs = input.windowMs ?? null;
  const nowMs = Date.parse(now);
  const exempt = (id: string): boolean =>
    liveIds.has(id) || matchIds.has(id) || pinnedIds.has(id) || id === input.focusId;
  const inWindow =
    windowMs === null || !Number.isFinite(nowMs)
      ? kindVisible
      : kindVisible.filter((n) => {
          if (exempt(n.id)) return true;
          const age = nowMs - Date.parse(n.activityAt);
          // An unparseable timestamp is not evidence of staleness — keep it.
          return !Number.isFinite(age) || age <= windowMs;
        });
  const outOfWindow = kindVisible.length - inWindow.length;

  // ------------------------------------------------------------------------
  // RELEVANCE PASS. Score, fold, then select — before any layout runs, so the
  // layout only ever sees the subgraph that earned the canvas. This replaces
  // the old behavior of laying out EVERYTHING and cutting by island order.
  // ------------------------------------------------------------------------
  const scopeEdges = input.edges.filter(
    (e) => edgeTypeFilter === null || edgeTypeFilter.has(e.type),
  );
  const relevance = computeRelevance({
    nodes: inWindow,
    edges: scopeEdges,
    liveIds,
    matchIds,
    pinnedIds,
    focusId: input.focusId ?? null,
    now,
  });

  const fold = input.fold ?? true;
  const folds = fold
    ? foldLeaves(inWindow, relevance)
    : { groups: new Map<string, FoldedInto>(), foldedIds: new Set<string>() };

  const unfolded = inWindow.filter((n) => !folds.foldedIds.has(n.id));
  const seeds = seedsFor(lens, unfolded, liveIds);
  const selection = selectByInterest(
    unfolded.map((n) => n.id),
    seeds,
    relevance,
    RENDER_CAP,
    lensSpec(lens).radius,
  );
  const selectedIds = new Set(selection.selected);

  const visible = unfolded.filter((n) => selectedIds.has(n.id));
  const visibleIds = new Set(visible.map((n) => n.id));
  const byId = new Map(visible.map((n) => [n.id, n]));

  const activeEdges = input.edges.filter(
    (e) =>
      (edgeTypeFilter === null || edgeTypeFilter.has(e.type)) &&
      visibleIds.has(e.source.id) &&
      visibleIds.has(e.target.id) &&
      e.source.id !== e.target.id,
  );

  const blockedIds = new Set<EntityId>();
  const edges: PlacedEdge[] = activeEdges.map((e) => {
    const blocked = isBlockedEdge(e);
    if (blocked) {
      blockedIds.add(e.source.id);
      blockedIds.add(e.target.id);
    }
    return {
      id: e.id,
      type: e.type,
      label: blocked ? `${edgeLabel(e)} · blocked` : edgeLabel(e),
      sourceId: e.source.id,
      targetId: e.target.id,
      blocked,
    };
  });

  // ------------------------------------------------------------------------
  // COMPONENTS, WITH HUBS AS BRIDGES RATHER THAN WELDS.
  //
  // Union over the filtered edge set, EXCEPT that an edge incident to a hub
  // does not merge — otherwise the teammate everyone reports to and the project
  // everything was created in fuse the whole space into one blob (measured: one
  // component holding 98% of it). Hub edges are still DRAWN; they simply stop
  // being evidence that two threads are the same thread.
  //
  // The hub itself is then attached to its most interesting neighbor's cluster,
  // so it is never left floating on the shelf and the picture still shows who
  // owns the work.
  //
  // A NODE THE VIEWER NAMED IS NEVER A HUB. Degree alone cannot tell a shared
  // connector (the project everything hangs off) from a busy thing the viewer
  // is looking AT (a task with thirty sessions, a searched session). Both have
  // high degree; only one should stop being an anchor. Without this, focusing a
  // degree-38 task demotes it and `rootFor` re-parents it into an arbitrary
  // neighbor's island — the picture loses the very thing that was asked for.
  // The exemption is the naming sets, NOT `liveIds`: liveness is the space's
  // opinion, and a live session is the archetypal connector here.
  // ------------------------------------------------------------------------
  const hubStop = input.hubStop ?? true;
  const degreeOf = (id: EntityId): number => relevance.degree.get(id) ?? 0;
  const named = (id: string): boolean =>
    id === input.focusId || matchIds.has(id) || pinnedIds.has(id);
  const isHub = (id: EntityId): boolean =>
    hubStop && !named(id) && degreeOf(id) > HUB_DEGREE;

  const uf = new UnionFind();
  const connected = new Set<EntityId>();
  for (const e of edges) {
    connected.add(e.sourceId);
    connected.add(e.targetId);
    if (isHub(e.sourceId) || isHub(e.targetId)) continue;
    uf.union(e.sourceId, e.targetId);
  }

  const shelf = visible
    .filter((n) => !connected.has(n.id))
    .sort((a, b) => a.title.localeCompare(b.title));

  // A hub joins the cluster of its highest-interest non-hub neighbor. Ties and
  // hub-only neighborhoods fall back to the hub's own root, which gives it an
  // island of its own rather than a silent disappearance.
  const rootFor = (id: EntityId): string => {
    if (!isHub(id)) return uf.find(id);
    const best = (relevance.adjacency.get(id) ?? [])
      .filter((n) => visibleIds.has(n) && !isHub(n))
      .sort(
        (a, b) =>
          (relevance.doi.get(b) ?? 0) - (relevance.doi.get(a) ?? 0) || (a < b ? -1 : 1),
      )[0];
    return best === undefined ? uf.find(id) : uf.find(best);
  };

  const componentsByRoot = new Map<string, EntityId[]>();
  for (const n of visible) {
    if (!connected.has(n.id)) continue;
    const root = rootFor(n.id);
    if (!componentsByRoot.has(root)) componentsByRoot.set(root, []);
    componentsByRoot.get(root)!.push(n.id);
  }
  // Deterministic island order: size desc, then first-member title.
  const components = [...componentsByRoot.values()].sort(
    (a, b) => b.length - a.length || (byId.get(a[0])!.title < byId.get(b[0])!.title ? -1 : 1),
  );

  // The budget was already spent by the relevance pass, which admitted nodes in
  // descending interest rather than by island size — so every island reaching
  // this point is drawn whole, and truncation is what the DOI ranking left out.
  const placedComponents: EntityId[][] = components;
  const truncated = selection.omitted.length;
  const outOfLens = selection.outOfLens.length;

  // Island index, kept available under grouping too: a band re-homes a node but
  // does not change which topological island it belongs to, and the card still
  // reports that.
  const componentIndex = new Map<EntityId, number>();
  for (const [ci, component] of components.entries()) {
    for (const id of component) componentIndex.set(id, ci);
  }
  const componentIndexOf = (id: EntityId): number => componentIndex.get(id) ?? 0;

  // Position the placed nodes. With `frozen`, pinned ids hold and arrivals
  // slot in around them; otherwise pack whole islands into rows.
  // What every placed card carries beyond its geometry: the leaves that folded
  // onto it, and the interest that won it its place.
  const decorate = (
    entity: EntitySummary,
  ): Pick<PlacedNode, 'interest' | 'degree' | 'hub'> & { folded?: FoldedInto } => {
    const group = folds.groups.get(entity.id);
    return {
      interest: relevance.doi.get(entity.id) ?? 0,
      degree: degreeOf(entity.id),
      hub: isHub(entity.id),
      ...(group ? { folded: group } : {}),
    };
  };

  // ------------------------------------------------------------------------
  // THE CONTEXTUAL PARTITION.
  //
  // Runs over every VISIBLE node, not just the connected ones: with a band to
  // belong to, a singleton is no longer loose, so the shelf empties into the
  // bands and the reader stops having to look in two places for one entity.
  //
  // Grouping forces a FULL layout — a frozen position is a promise about where
  // a node sits, and changing the partition is precisely the event that
  // invalidates it. Freezing across a group change would strand cards outside
  // their own band's frame, which is worse than the movement it avoids.
  // ------------------------------------------------------------------------
  const groupBy = input.groupBy ?? 'none';
  const grouping = groupBy !== 'none';
  const collapsedGroups = input.collapsedGroups ?? EMPTY_SET;

  let placed: PlacedNode[];
  let pendingRelayout = 0;
  let groups: GraphGroup[] = [];
  let collapsedCount = 0;
  let groupedShelf: EntitySummary[] | null = null;

  if (grouping) {
    const grouper = grouperFor(groupBy, { now, edges: input.edges, nodes: input.nodes });
    const assign = new Map<EntityId, GroupAssignment>();
    const members = new Map<string, EntityId[]>();
    for (const n of visible) {
      const a = grouper(n);
      assign.set(n.id, a);
      if (!members.has(a.key)) members.set(a.key, []);
      members.get(a.key)!.push(n.id);
    }

    // Band order: the dimension's own rank first (workflow order, priority
    // order, signal precedence), then the biggest band, then the label — and
    // the residual band last whatever its size, because "nothing to say about
    // these" is a footnote even when it is the largest footnote.
    const keys = [...members.keys()].sort((a, b) => {
      const A = assign.get(members.get(a)![0])!;
      const B = assign.get(members.get(b)![0])!;
      if (A.residual !== B.residual) return A.residual ? 1 : -1;
      return (
        A.rank - B.rank ||
        members.get(b)!.length - members.get(a)!.length ||
        A.label.localeCompare(B.label)
      );
    });

    placed = [];
    let bandY = MARGIN;
    for (const key of keys) {
      const ids = members.get(key)!;
      const meta = assign.get(ids[0])!;
      const collapsed = collapsedGroups.has(key);
      if (collapsed) {
        collapsedCount += ids.length;
        groups.push({
          key,
          label: meta.label,
          ...(meta.kindRef ? { kindRef: meta.kindRef } : {}),
          ...(meta.actorRef ? { actorRef: meta.actorRef } : {}),
          residual: meta.residual,
          x: MARGIN,
          y: bandY,
          w: GROUP_MIN_W,
          h: GROUP_HEADER,
          count: ids.length,
          collapsed: true,
        });
        bandY += GROUP_HEADER + GROUP_GAP;
        continue;
      }

      // Islands WITHIN the band: the same roots the topological pass found,
      // restricted to this band's members. A node whose island straddles two
      // bands simply appears in each band as the part that belongs there — the
      // edge between the parts is still drawn, now crossing the frames, which
      // is the honest picture of a thread that spans two statuses.
      const byRoot = new Map<string, EntityId[]>();
      for (const id of ids) {
        const root = connected.has(id) ? rootFor(id) : `solo:${id}`;
        if (!byRoot.has(root)) byRoot.set(root, []);
        byRoot.get(root)!.push(id);
      }
      const islands = [...byRoot.values()].sort(
        (a, b) => b.length - a.length || (byId.get(a[0])!.title < byId.get(b[0])!.title ? -1 : 1),
      );

      const laid = layoutBand(islands, edges);
      const contentX = MARGIN + GROUP_PAD;
      const contentY = bandY + GROUP_HEADER;
      for (const id of ids) {
        const p = laid.pos.get(id)!;
        const entity = byId.get(id)!;
        placed.push({
          entity,
          x: contentX + p.x,
          y: contentY + p.y,
          heat: heatOf(entity.activityAt, now),
          onBlockedPath: blockedIds.has(id),
          ghost: entity.deletedAt !== null,
          componentId: componentIndexOf(id),
          groupKey: key,
          ...decorate(entity),
        });
      }
      const bandW = Math.max(laid.w + GROUP_PAD * 2, GROUP_MIN_W);
      const bandH = GROUP_HEADER + laid.h + GROUP_PAD;
      groups.push({
        key,
        label: meta.label,
        ...(meta.kindRef ? { kindRef: meta.kindRef } : {}),
        ...(meta.actorRef ? { actorRef: meta.actorRef } : {}),
        residual: meta.residual,
        x: MARGIN,
        y: bandY,
        w: bandW,
        h: bandH,
        count: ids.length,
        collapsed: false,
      });
      bandY += bandH + GROUP_GAP;
    }
    // Every visible node now lives in a band, so nothing is loose.
    groupedShelf = [];
  } else if (input.frozen) {
    const r = placeWithFrozen(placedComponents, edges, byId, blockedIds, input.frozen, now, decorate);
    placed = r.placed;
    pendingRelayout = r.pendingRelayout;
  } else {
    placed = [];
    let cursorX = MARGIN;
    let cursorY = MARGIN;
    let rowH = 0;
    for (const [componentId, component] of placedComponents.entries()) {
      const layout = layoutComponent(component, edges);
      if (cursorX > MARGIN && cursorX + layout.w > MAX_ROW_W) {
        cursorX = MARGIN;
        cursorY += rowH + ISLAND_GAP;
        rowH = 0;
      }
      for (const id of component) {
        const p = layout.pos.get(id)!;
        const entity = byId.get(id)!;
        placed.push({
          entity,
          x: cursorX + p.x,
          y: cursorY + p.y,
          heat: heatOf(entity.activityAt, now),
          onBlockedPath: blockedIds.has(id),
          ghost: entity.deletedAt !== null,
          componentId,
          groupKey: null,
          ...decorate(entity),
        });
      }
      cursorX += layout.w + ISLAND_GAP;
      rowH = Math.max(rowH, layout.h);
    }
  }

  const placedIds = new Set(placed.map((p) => p.entity.id));
  const drawableEdges = edges.filter((e) => placedIds.has(e.sourceId) && placedIds.has(e.targetId));

  // The canvas must enclose the BAND FRAMES too — a collapsed band holds no
  // node, so sizing on nodes alone would clip the very header that says how to
  // get its contents back.
  const width =
    Math.max(...placed.map((p) => p.x + NODE_W), ...groups.map((g) => g.x + g.w), 0) + MARGIN;
  const height =
    Math.max(...placed.map((p) => p.y + NODE_H), ...groups.map((g) => g.y + g.h), 0) + MARGIN;

  return {
    placed,
    edges: drawableEdges,
    shelf: groupedShelf ?? shelf,
    width,
    height,
    componentCount: placedComponents.length,
    truncated,
    outOfLens,
    outOfWindow,
    hubCount: placed.filter((p) => p.hub).length,
    lensEmpty: selection.lensEmpty,
    foldedCount: folds.foldedIds.size,
    // The accounting law, asserted in model.test.ts: everything the KIND filter
    // let through is either placed, shelved, folded onto a hub, cut by the
    // budget (`truncated`), left outside the lens (`outOfLens`), older than
    // the window (`outOfWindow`), or inside a band the reader collapsed
    // (`collapsedCount`). Nothing is ever dropped silently, and each bucket
    // names the REASON it is in — four exclusions that read alike on a count
    // and have four different remedies.
    visibleTotal: kindVisible.length,
    lens,
    pendingRelayout,
    groups,
    groupBy,
    collapsedCount,
  };
}
