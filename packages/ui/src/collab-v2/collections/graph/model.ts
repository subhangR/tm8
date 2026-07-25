/**
 * Graph view model — the PURE computation behind GraphCanvas.
 *
 * Turns a `GraphResult` into positioned flow nodes/edges:
 *  - hierarchy renders as CONTAINMENT: collapsible dashed cluster boxes
 *    (`cluster:<parentId>` containers holding the parent card + children) —
 *    visually distinct from edges, which stay drawn lines;
 *  - collapse hides a cluster's descendants and remaps their edges onto the
 *    parent card (deduped, marked aggregated);
 *  - dependency mode ranks left-to-right topologically (prerequisites left)
 *    and marks the blocked path red: every unresolved hard `depends_on`
 *    edge and both its endpoints;
 *  - a saved layout (per saved view) overrides dagre for the nodes it knows;
 *  - hover dims everything outside the hovered node's neighborhood.
 *
 * Pure and DOM-free so vitest exercises the whole thing without xyflow.
 */
import dagre from 'dagre';
import type {
  EdgeView, EntityId, EntitySummary, GraphResult,
} from '../../types/contract';

export const NODE_WIDTH = 260;
export const NODE_HEIGHT = 150;
export const CLUSTER_PADDING = 28;

export interface GraphViewOptions {
  mode: 'free' | 'dependency';
  collapsed?: EntityId[];
  savedLayout?: Record<EntityId, { x: number; y: number }> | null;
  hoverId?: EntityId | null;
}

export interface FlowNodeModel {
  id: string;
  type: 'cv2Entity' | 'cv2Cluster';
  position: { x: number; y: number };
  width: number;
  height: number;
  parentId?: string;
  extent?: 'parent';
  data: {
    entity?: EntitySummary;
    /** Cluster containers: the parent entity's title. */
    label?: string;
    /** Entity node that is a collapsed cluster parent. */
    collapsed?: boolean;
    hiddenCount?: number;
    /** Entity node that is an EXPANDED cluster parent (shows collapse ⊟). */
    clusterParent?: boolean;
    onBlockedPath?: boolean;
    dimmed?: boolean;
  };
}

export interface FlowEdgeModel {
  id: string;
  source: string;
  target: string;
  edgeType: string;
  label: string;
  hard: boolean;
  blocked: boolean;
  dimmed: boolean;
  /** Edge re-routed onto a collapsed cluster's parent card. */
  aggregated: boolean;
}

export interface GraphView {
  nodes: FlowNodeModel[];
  edges: FlowEdgeModel[];
  blockedNodeIds: Set<EntityId>;
}

export function edgeLabel(e: EdgeView): string {
  const base = e.type.startsWith('x:') ? e.type.slice(2) : e.type;
  const words = base.replace(/_/g, ' ');
  if (e.type === 'depends_on') return e.hard === false ? `${words} · soft` : `${words} · hard`;
  return words;
}

/** Unresolved hard dependency edges — the red path in dependency mode. */
export function blockedEdges(edges: EdgeView[]): EdgeView[] {
  return edges.filter((e) => e.type === 'depends_on' && e.hard !== false && e.resolved === false);
}

export function buildGraphView(result: GraphResult, opts: GraphViewOptions): GraphView {
  const collapsed = new Set(opts.collapsed ?? []);
  const savedLayout = opts.savedLayout ?? null;
  // Containment applies in free mode; dependency mode is the untangling view
  // (pure LR ranks), and a hand-arranged saved layout is deliberately flat.
  const clustering = opts.mode === 'free' && !savedLayout && result.clusters.length > 0;

  const parentOf = new Map<EntityId, EntityId>();
  const childrenOf = new Map<EntityId, EntityId[]>();
  if (clustering) {
    for (const c of result.clusters) {
      childrenOf.set(c.parentId, [...c.childIds]);
      for (const child of c.childIds) parentOf.set(child, c.parentId);
    }
  }

  // --- collapse: hide all descendants of collapsed parents --------------------
  const hidden = new Set<EntityId>();
  const hideDescendants = (id: EntityId): void => {
    for (const child of childrenOf.get(id) ?? []) {
      if (!hidden.has(child)) {
        hidden.add(child);
        hideDescendants(child);
      }
    }
  };
  for (const id of collapsed) if (clustering) hideDescendants(id);

  const hiddenCountOf = (id: EntityId): number => {
    let n = 0;
    const walk = (cur: EntityId): void => {
      for (const child of childrenOf.get(cur) ?? []) { n += 1; walk(child); }
    };
    walk(id);
    return n;
  };

  const visible = result.nodes.filter((n) => !hidden.has(n.id));
  const visibleIds = new Set(visible.map((n) => n.id));

  const nearestVisible = (id: EntityId): EntityId | null => {
    let cur: EntityId | undefined = id;
    let guard = 0;
    while (cur && guard < 100) {
      if (visibleIds.has(cur)) return cur;
      cur = parentOf.get(cur);
      guard += 1;
    }
    return null;
  };

  // --- edges: remap hidden endpoints onto their collapsed parent --------------
  const blocked = blockedEdges(result.edges);
  const blockedIds = new Set(blocked.map((e) => e.id));
  const blockedNodeIds = new Set<EntityId>();
  for (const e of blocked) { blockedNodeIds.add(e.source.id); blockedNodeIds.add(e.target.id); }

  const seen = new Map<string, FlowEdgeModel>();
  for (const e of result.edges) {
    const source = nearestVisible(e.source.id);
    const target = nearestVisible(e.target.id);
    if (!source || !target || source === target) continue;
    const aggregated = source !== e.source.id || target !== e.target.id;
    const key = `${source}→${target}·${e.type}`;
    const prior = seen.get(key);
    if (prior) {
      prior.aggregated = prior.aggregated || aggregated;
      prior.blocked = prior.blocked || blockedIds.has(e.id);
      continue;
    }
    seen.set(key, {
      id: aggregated ? `agg_${key}` : e.id,
      source,
      target,
      edgeType: e.type,
      label: edgeLabel(e),
      hard: e.type === 'depends_on' ? e.hard !== false : false,
      blocked: blockedIds.has(e.id),
      dimmed: false,
      aggregated,
    });
  }
  const edges = [...seen.values()];

  // --- clusters that survive collapse ----------------------------------------
  interface Cluster { parentId: EntityId; childIds: EntityId[] }
  const activeClusters: Cluster[] = clustering
    ? result.clusters
      .filter((c) => visibleIds.has(c.parentId) && !collapsed.has(c.parentId))
      .map((c) => ({ parentId: c.parentId, childIds: c.childIds.filter((id) => visibleIds.has(id)) }))
      .filter((c) => c.childIds.length > 0)
    : [];
  const clusterIdOf = (entityId: EntityId): string => `cluster:${entityId}`;
  const clusterByParent = new Map(activeClusters.map((c) => [c.parentId, c]));

  /** The xyflow/dagre container an entity node lives in (its own cluster if
   *  it parents one, else its entity-parent's cluster). */
  const containerOf = (id: EntityId): string | undefined => {
    if (clusterByParent.has(id)) return clusterIdOf(id);
    const p = parentOf.get(id);
    return p && clusterByParent.has(p) ? clusterIdOf(p) : undefined;
  };
  /** Nesting: cluster X sits inside the container its parent entity would. */
  const clusterContainerOf = (parentEntityId: EntityId): string | undefined => {
    const p = parentOf.get(parentEntityId);
    return p && clusterByParent.has(p) ? clusterIdOf(p) : undefined;
  };

  // --- layout ------------------------------------------------------------------
  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({
    rankdir: opts.mode === 'dependency' ? 'LR' : 'TB',
    nodesep: 48,
    ranksep: opts.mode === 'dependency' ? 110 : 80,
    marginx: 24,
    marginy: 24,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of visible) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const c of activeClusters) {
    g.setNode(clusterIdOf(c.parentId), {});
    const outer = clusterContainerOf(c.parentId);
    if (outer) g.setParent(clusterIdOf(c.parentId), outer);
  }
  for (const n of visible) {
    const container = containerOf(n.id);
    if (container) g.setParent(n.id, container);
  }
  for (const e of edges) {
    // Dependency mode ranks prerequisites LEFT of their dependents: the
    // depends_on SOURCE is the blocked task, so rank target → source.
    if (opts.mode === 'dependency' && e.edgeType === 'depends_on') g.setEdge(e.target, e.source);
    else g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  const abs = new Map<string, { x: number; y: number; w: number; h: number }>();
  const read = (id: string): { x: number; y: number; w: number; h: number } => {
    const n = g.node(id) as { x?: number; y?: number; width?: number; height?: number } | undefined;
    const w = n?.width ?? NODE_WIDTH;
    const h = n?.height ?? NODE_HEIGHT;
    return { x: (n?.x ?? 0) - w / 2, y: (n?.y ?? 0) - h / 2, w, h };
  };
  for (const n of visible) abs.set(n.id, read(n.id));
  for (const c of activeClusters) {
    const box = read(clusterIdOf(c.parentId));
    abs.set(clusterIdOf(c.parentId), {
      x: box.x - CLUSTER_PADDING / 2,
      y: box.y - CLUSTER_PADDING,
      w: box.w + CLUSTER_PADDING,
      h: box.h + CLUSTER_PADDING * 1.5,
    });
  }
  if (savedLayout) {
    for (const [id, pos] of Object.entries(savedLayout)) {
      if (abs.has(id)) abs.set(id, { ...abs.get(id)!, x: pos.x, y: pos.y });
    }
  }

  // --- hover neighborhood -------------------------------------------------------
  const hover = opts.hoverId ?? null;
  const neighborhood = new Set<string>();
  if (hover) {
    neighborhood.add(hover);
    for (const e of edges) {
      if (e.source === hover) neighborhood.add(e.target);
      if (e.target === hover) neighborhood.add(e.source);
    }
    const p = parentOf.get(hover);
    if (p) neighborhood.add(p);
    for (const child of childrenOf.get(hover) ?? []) if (visibleIds.has(child)) neighborhood.add(child);
  }

  // --- emit: containers first (xyflow needs parents before children) ------------
  const nodes: FlowNodeModel[] = [];
  const containerAbs = (id: string | undefined) =>
    (id ? abs.get(id) ?? { x: 0, y: 0, w: 0, h: 0 } : { x: 0, y: 0, w: 0, h: 0 });

  const clusterOrder = [...activeClusters].sort((a, b) =>
    (clusterContainerOf(a.parentId) ? 1 : 0) - (clusterContainerOf(b.parentId) ? 1 : 0));
  for (const c of clusterOrder) {
    const id = clusterIdOf(c.parentId);
    const box = abs.get(id)!;
    const outer = clusterContainerOf(c.parentId);
    const base = containerAbs(outer);
    const parent = result.nodes.find((n) => n.id === c.parentId);
    nodes.push({
      id,
      type: 'cv2Cluster',
      position: { x: box.x - base.x, y: box.y - base.y },
      width: box.w,
      height: box.h,
      ...(outer ? { parentId: outer } : {}),
      data: {
        label: parent?.title ?? c.parentId,
        hiddenCount: c.childIds.length,
        dimmed: hover != null && !neighborhood.has(c.parentId),
      },
    });
  }

  for (const n of visible) {
    const box = abs.get(n.id)!;
    const container = containerOf(n.id);
    const base = containerAbs(container);
    const isCollapsedParent = clustering && collapsed.has(n.id) && (childrenOf.get(n.id) ?? []).length > 0;
    nodes.push({
      id: n.id,
      type: 'cv2Entity',
      position: { x: box.x - base.x, y: box.y - base.y },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      ...(container ? { parentId: container, extent: 'parent' as const } : {}),
      data: {
        entity: n,
        collapsed: isCollapsedParent,
        hiddenCount: isCollapsedParent ? hiddenCountOf(n.id) : undefined,
        clusterParent: clusterByParent.has(n.id),
        onBlockedPath: blockedNodeIds.has(n.id),
        dimmed: hover != null && !neighborhood.has(n.id),
      },
    });
  }

  for (const e of edges) {
    e.dimmed = hover != null && !(e.source === hover || e.target === hover);
  }

  return { nodes, edges, blockedNodeIds };
}

/** Collect current node positions (absolute) for layout persistence. */
export function collectLayout(
  nodes: Array<{ id: string; position: { x: number; y: number }; parentId?: string }>,
): Record<EntityId, { x: number; y: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const absOf = (n: { id: string; position: { x: number; y: number }; parentId?: string }): { x: number; y: number } => {
    if (!n.parentId) return n.position;
    const parent = byId.get(n.parentId);
    if (!parent) return n.position;
    const p = absOf(parent);
    return { x: p.x + n.position.x, y: p.y + n.position.y };
  };
  const out: Record<EntityId, { x: number; y: number }> = {};
  for (const n of nodes) {
    if (n.id.startsWith('cluster:')) continue;
    out[n.id] = absOf(n);
  }
  return out;
}
