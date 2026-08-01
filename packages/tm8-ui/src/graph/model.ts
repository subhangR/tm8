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
  computeRelevance,
  foldLeaves,
  lensSpec,
  seedsFor,
  selectByInterest,
  type FoldedInto,
  type LensId,
} from './relevance';

export const NODE_W = 240;
export const NODE_H = 124;
const H_GAP = 44;
const V_GAP = 72;
const ISLAND_GAP = 96;
const MAX_ROW_W = 1900;
const MARGIN = 32;

/** Honest render budget: past this the model truncates AND SAYS SO. */
export const RENDER_CAP = 150;

const EMPTY_SET: ReadonlySet<string> = new Set();

export type Heat = 'fresh' | 'warm' | 'rest';

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
   * placed + shelf + folded + truncated + outOfLens === visibleTotal.
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

export function heatOf(activityAt: string, now: string): Heat {
  const delta = Date.parse(now) - Date.parse(activityAt);
  if (!Number.isFinite(delta)) return 'rest';
  if (delta <= 2 * 60_000) return 'fresh';
  if (delta <= 45 * 60_000) return 'warm';
  return 'rest';
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
  decorate: (entity: EntitySummary) => Pick<PlacedNode, 'interest'> & { folded?: FoldedInto },
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
      ...decorate(entity),
    };
  });
  return { placed, pendingRelayout: arrivals.length };
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
  // RELEVANCE PASS. Score, fold, then select — before any layout runs, so the
  // layout only ever sees the subgraph that earned the canvas. This replaces
  // the old behavior of laying out EVERYTHING and cutting by island order.
  // ------------------------------------------------------------------------
  const scopeEdges = input.edges.filter(
    (e) => edgeTypeFilter === null || edgeTypeFilter.has(e.type),
  );
  const relevance = computeRelevance({
    nodes: kindVisible,
    edges: scopeEdges,
    liveIds,
    matchIds,
    pinnedIds,
    focusId: input.focusId ?? null,
    now,
  });

  const fold = input.fold ?? true;
  const folds = fold
    ? foldLeaves(kindVisible, relevance)
    : { groups: new Map<string, FoldedInto>(), foldedIds: new Set<string>() };

  const unfolded = kindVisible.filter((n) => !folds.foldedIds.has(n.id));
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

  // Components over the filtered edge set.
  const uf = new UnionFind();
  const connected = new Set<EntityId>();
  for (const e of edges) {
    uf.union(e.sourceId, e.targetId);
    connected.add(e.sourceId);
    connected.add(e.targetId);
  }

  const shelf = visible
    .filter((n) => !connected.has(n.id))
    .sort((a, b) => a.title.localeCompare(b.title));

  const componentsByRoot = new Map<string, EntityId[]>();
  for (const n of visible) {
    if (!connected.has(n.id)) continue;
    const root = uf.find(n.id);
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

  // Position the placed nodes. With `frozen`, pinned ids hold and arrivals
  // slot in around them; otherwise pack whole islands into rows.
  // What every placed card carries beyond its geometry: the leaves that folded
  // onto it, and the interest that won it its place.
  const decorate = (entity: EntitySummary): Pick<PlacedNode, 'interest'> & { folded?: FoldedInto } => {
    const group = folds.groups.get(entity.id);
    return {
      interest: relevance.doi.get(entity.id) ?? 0,
      ...(group ? { folded: group } : {}),
    };
  };

  let placed: PlacedNode[];
  let pendingRelayout = 0;
  if (input.frozen) {
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
          ...decorate(entity),
        });
      }
      cursorX += layout.w + ISLAND_GAP;
      rowH = Math.max(rowH, layout.h);
    }
  }

  const placedIds = new Set(placed.map((p) => p.entity.id));
  const drawableEdges = edges.filter((e) => placedIds.has(e.sourceId) && placedIds.has(e.targetId));

  const width = Math.max(...placed.map((p) => p.x + NODE_W), 0) + MARGIN;
  const height = Math.max(...placed.map((p) => p.y + NODE_H), 0) + MARGIN;

  return {
    placed,
    edges: drawableEdges,
    shelf,
    width,
    height,
    componentCount: placedComponents.length,
    truncated,
    outOfLens,
    lensEmpty: selection.lensEmpty,
    foldedCount: folds.foldedIds.size,
    // The accounting law, asserted in model.test.ts: everything the filters let
    // through is either placed, shelved, folded onto a hub, cut by the budget
    // (`truncated`) or left outside the lens (`outOfLens`). Nothing is ever
    // dropped silently, and each bucket names the REASON it is in.
    visibleTotal: kindVisible.length,
    lens,
    pendingRelayout,
  };
}
