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

export const NODE_W = 240;
export const NODE_H = 124;
const H_GAP = 44;
const V_GAP = 72;
const ISLAND_GAP = 96;
const MAX_ROW_W = 1900;
const MARGIN = 32;

/** Honest render budget: past this the model truncates AND SAYS SO. */
export const RENDER_CAP = 150;

export type Heat = 'fresh' | 'warm' | 'rest';

export interface GraphModelInput {
  nodes: EntitySummary[];
  edges: EdgeView[];
  /** null = no filter. Kind names are DATA here, never literals (§15.2). */
  kindFilter: ReadonlySet<string> | null;
  edgeTypeFilter: ReadonlySet<string> | null;
  /** The heat clock — fixtures pass FIXTURE_NOW, live passes wall time. */
  now: string;
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
  /** Nodes beyond RENDER_CAP that were NOT placed (0 = everything shown). */
  truncated: number;
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

export function buildGraphModel(input: GraphModelInput): GraphModel {
  const { kindFilter, edgeTypeFilter, now } = input;

  const visible = input.nodes.filter((n) => kindFilter === null || kindFilter.has(n.kind));
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

  // Honest cap: place whole islands until the budget runs out; report the rest.
  let budget = RENDER_CAP;
  const placedComponents: EntityId[][] = [];
  let truncated = 0;
  for (const component of components) {
    if (component.length <= budget) {
      placedComponents.push(component);
      budget -= component.length;
    } else {
      truncated += component.length;
    }
  }

  // Pack islands into rows.
  const placed: PlacedNode[] = [];
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
      });
    }
    cursorX += layout.w + ISLAND_GAP;
    rowH = Math.max(rowH, layout.h);
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
  };
}
