/**
 * GraphCanvas — any collection as an actual graph (@xyflow/react + dagre).
 *
 * Nodes are Z2 EntityCards (kind-shaped accents); edges are typed, labeled,
 * directional lines; hierarchy is collapsible containment clusters (dashed
 * boxes — never lines). Controls: subgraph switcher (saved graph views),
 * kind + edge-type filters, focus mode (entity + N hops), dependency mode
 * (topological LR, blocked path red). Hover dims the non-neighborhood;
 * click pushes a Z3 panel (the canvas stays); dragging node→node opens the
 * edge composer; node positions persist per saved view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, ReactFlow, ReactFlowProvider,
  type Connection, type Edge, type Node, type NodeChange, applyNodeChanges,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useFacade } from '../../entity';
import { useNavStore } from '../../stores/nav';
import { useCollectionsStore } from '../../stores/collections';
import type {
  EntityId, EntityKind, EntitySummary, GraphQuery, GraphResult, SavedView,
} from '../../types/contract';
import { collectionKey } from '../../stores/collections';
import { buildGraphView, collectLayout, type FlowEdgeModel } from './model';
import { EdgeComposer, type EdgeDraft } from './EdgeComposer';
import { NODE_TYPES } from './nodes';

const REFETCH_DEBOUNCE_MS = 30;

export interface GraphCanvasProps {
  query: GraphQuery;
  onOpenEntity?: (id: EntityId) => void;
  /** Seeds layout + enables “save layout” back onto the view. */
  savedView?: SavedView | null;
  /** Fires whenever node positions change (for save-view persistence). */
  onLayoutChange?: (layout: Record<EntityId, { x: number; y: number }>) => void;
  showControls?: boolean;
  height?: number | string;
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function toFlowEdge(e: FlowEdgeModel): Edge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    className: [
      'cv2-gedge',
      e.blocked ? 'cv2-gedge--blocked' : '',
      e.dimmed ? 'cv2-gedge--dimmed' : '',
      e.aggregated ? 'cv2-gedge--aggregated' : '',
      e.edgeType === 'depends_on' && !e.hard ? 'cv2-gedge--soft' : '',
    ].filter(Boolean).join(' '),
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    data: { edgeType: e.edgeType, blocked: e.blocked },
  };
}

function GraphCanvasInner({
  query, onOpenEntity, savedView = null, onLayoutChange, showControls = true,
  height = 560,
}: GraphCanvasProps) {
  const facade = useFacade();

  // Canvas-owned query refinements layered over the incoming collection query.
  const [mode, setMode] = useState<'free' | 'dependency'>(query.mode ?? 'free');
  const [edgeTypes, setEdgeTypes] = useState<string[] | null>(query.edgeTypes ?? null);
  const [kinds, setKinds] = useState<EntityKind[] | null>(query.kinds ?? null);
  const [focus, setFocus] = useState<{ id: EntityId; hops: number } | null>(
    query.focusId ? { id: query.focusId, hops: query.hops ?? 2 } : null,
  );
  const [activeView, setActiveView] = useState<SavedView | null>(savedView);
  const [collapsed, setCollapsed] = useState<EntityId[]>([]);
  const [hoverId, setHoverId] = useState<EntityId | null>(null);
  const [selected, setSelected] = useState<EntityId | null>(null);
  const [draft, setDraft] = useState<EdgeDraft | null>(null);

  const effective: GraphQuery = useMemo(() => ({
    ...(activeView?.query ?? query),
    mode,
    edgeTypes: edgeTypes ?? undefined,
    kinds: kinds ?? (activeView?.query ?? query).kinds,
    focusId: focus?.id,
    hops: focus?.hops,
    layout: 'graph',
  }), [query, activeView, mode, edgeTypes, kinds, focus]);
  const effectiveKey = collectionKey(effective);

  const [result, setResult] = useState<GraphResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  const queryRef = useRef(effective);
  queryRef.current = effective;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    facade.queryGraph(queryRef.current).then(
      (r) => { if (alive) { setResult(r); setLoading(false); } },
      () => { if (alive) setLoading(false); },
    );
    return () => { alive = false; };
  }, [facade, effectiveKey, nonce]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = facade.subscribe(queryRef.current.spaceId, (event) => {
      if (event.type === 'entity.upsert' || event.type === 'entity.deleted'
        || event.type === 'edge.upsert' || event.type === 'edge.deleted') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; refetch(); }, REFETCH_DEBOUNCE_MS);
      }
    });
    return () => { if (timer) clearTimeout(timer); unsubscribe(); };
  }, [facade, refetch]);

  // Saved graph views of this space power the subgraph switcher.
  const [views, setViews] = useState<SavedView[]>([]);
  useEffect(() => {
    let alive = true;
    facade.listSavedViews(queryRef.current.spaceId).then(
      (all) => {
        if (!alive) return;
        // Any saved view is a subgraph here — the canvas forces layout:'graph'.
        setViews(all);
        useCollectionsStore.getState().setSavedViews(all);
      },
      () => { /* switcher just stays empty */ },
    );
    return () => { alive = false; };
  }, [facade]);

  const toggleCollapse = useCallback((id: string): void => {
    setCollapsed((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  }, []);

  const savedLayout = activeView?.graphLayout ?? result?.layout ?? null;

  const view = useMemo(() => (result
    ? buildGraphView(result, { mode, collapsed, savedLayout, hoverId })
    : { nodes: [], edges: [], blockedNodeIds: new Set<string>() }),
  [result, mode, collapsed, savedLayout, hoverId]);

  // xyflow owns positions after mount so drags stick; rebuild on model change.
  const [nodes, setNodes] = useState<Node[]>([]);
  useEffect(() => {
    setNodes(view.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      width: n.width,
      height: n.height,
      ...(n.parentId ? { parentId: n.parentId, extent: n.extent } : {}),
      draggable: n.type === 'cv2Entity',
      selectable: n.type === 'cv2Entity',
      data: { ...n.data, onToggleCollapse: toggleCollapse },
    })));
  }, [view.nodes, toggleCollapse]);
  const edges = useMemo(() => view.edges.map(toFlowEdge), [view.edges]);

  const onNodesChange = useCallback((changes: NodeChange[]): void => {
    setNodes((ns) => applyNodeChanges(changes, ns));
  }, []);

  const emitLayout = useCallback((ns: Node[]): void => {
    onLayoutChange?.(collectLayout(ns.map((n) => ({
      id: n.id, position: n.position, parentId: n.parentId,
    }))));
  }, [onLayoutChange]);

  const open = onOpenEntity ?? ((id: EntityId) => useNavStore.getState().pushPanel({ entityId: id }));

  const entityById = useMemo(() => {
    const m = new Map<string, EntitySummary>();
    for (const n of result?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [result]);

  const onConnect = useCallback((conn: Connection): void => {
    if (!conn.source || !conn.target || conn.source === conn.target) return;
    const source = entityById.get(conn.source);
    const target = entityById.get(conn.target);
    if (source && target) setDraft({ source, target });
  }, [entityById]);

  const confirmEdge = async (type: string, props?: Record<string, unknown>): Promise<void> => {
    if (!draft) return;
    try {
      await facade.createEdge({
        srcId: draft.source.id, dstId: draft.target.id, type, props,
        clientMutationId: `cv2g_${draft.source.id}_${draft.target.id}_${type}`,
      });
    } finally {
      setDraft(null);
      refetch();
    }
  };

  const saveLayout = async (): Promise<void> => {
    if (!activeView) return;
    const layout = collectLayout(nodes.map((n) => ({ id: n.id, position: n.position, parentId: n.parentId })));
    const updated = await facade.updateSavedView(activeView.id, { graphLayout: layout });
    setActiveView(updated);
    useCollectionsStore.getState().upsertSavedView(updated);
  };

  const presentKinds = useMemo(
    () => [...new Set((result?.nodes ?? []).map((n) => n.kind))],
    [result],
  );
  const presentEdgeTypes = useMemo(
    () => [...new Set((result?.edges ?? []).map((e) => e.type))],
    [result],
  );

  return (
    <div className="cv2-graph" style={{ height }} data-mode={mode}>
      {showControls && (
        <div className="cv2-graph__controls">
          <div className="cv2-collection__switcher" role="tablist" aria-label="Graph mode">
            <button
              type="button" role="tab" aria-selected={mode === 'free'}
              className={`cv2-collection__tab${mode === 'free' ? ' cv2-collection__tab--active' : ''}`}
              onClick={() => setMode('free')}
            >
              Free
            </button>
            <button
              type="button" role="tab" aria-selected={mode === 'dependency'}
              className={`cv2-collection__tab${mode === 'dependency' ? ' cv2-collection__tab--active' : ''}`}
              onClick={() => setMode('dependency')}
            >
              Dependency
            </button>
          </div>

          {views.length > 0 && (
            <select
              className="cv2-graph__viewselect"
              aria-label="Subgraph"
              value={activeView?.id ?? ''}
              onChange={(e) => {
                const v = views.find((x) => x.id === e.target.value) ?? null;
                setActiveView(v);
                setFocus(null);
                setKinds(null);
                setEdgeTypes(null);
              }}
            >
              <option value="">— subgraph —</option>
              {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          )}

          {mode === 'free' && presentKinds.length > 1 && (
            <div className="cv2-graph__filter" aria-label="Kind filter">
              {presentKinds.map((k) => {
                const active = !kinds || kinds.includes(k);
                return (
                  <button
                    key={k} type="button"
                    className={`cv2-collection__chip${active ? ' cv2-collection__chip--active' : ''}`}
                    aria-pressed={active}
                    onClick={() => setKinds((cur) => {
                      const base = cur ?? presentKinds;
                      const next = active ? base.filter((x) => x !== k) : [...base, k];
                      return next.length === 0 ? base : next;
                    })}
                  >
                    {k.replace('_', ' ')}
                  </button>
                );
              })}
            </div>
          )}

          {mode === 'free' && presentEdgeTypes.length > 1 && (
            <div className="cv2-graph__filter" aria-label="Edge filter">
              {presentEdgeTypes.map((t) => {
                const active = !edgeTypes || edgeTypes.includes(t);
                return (
                  <button
                    key={t} type="button"
                    className={`cv2-collection__chip${active ? ' cv2-collection__chip--active' : ''}`}
                    aria-pressed={active}
                    onClick={() => setEdgeTypes((cur) => {
                      const base = cur ?? presentEdgeTypes;
                      const next = active ? base.filter((x) => x !== t) : [...base, t];
                      return next.length === 0 ? base : next;
                    })}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          )}

          <span className="cv2-collection__spacer" />

          {selected && !focus && (
            <button
              type="button" className="cv2-collection__chip"
              onClick={() => setFocus({ id: selected, hops: 2 })}
            >
              focus · 2 hops
            </button>
          )}
          {focus && (
            <span className="cv2-graph__focus">
              focused
              <select
                aria-label="Hops"
                value={focus.hops}
                onChange={(e) => setFocus({ id: focus.id, hops: Number(e.target.value) })}
              >
                {[1, 2, 3].map((h) => <option key={h} value={h}>{h} hop{h > 1 ? 's' : ''}</option>)}
              </select>
              <button type="button" className="cv2-collection__chip" onClick={() => setFocus(null)}>clear</button>
            </span>
          )}

          {activeView && (
            <button type="button" className="cv2-collection__chip" onClick={() => void saveLayout()}>
              save layout
            </button>
          )}
        </div>
      )}

      <div className="cv2-graph__canvas">
        {loading && <div className="cv2-collection__loading" role="status">loading graph…</div>}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onNodeDragStop={() => emitLayout(nodes)}
          onNodeClick={(_, node) => {
            if (node.type !== 'cv2Entity') return;
            setSelected(node.id);
            open(node.id);
          }}
          onNodeMouseEnter={(_, node) => { if (node.type === 'cv2Entity') setHoverId(node.id); }}
          onNodeMouseLeave={() => setHoverId(null)}
          onConnect={onConnect}
          fitView
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
        </ReactFlow>
        {draft && (
          <EdgeComposer
            draft={draft}
            onConfirm={(type, props) => void confirmEdge(type, props)}
            onCancel={() => setDraft(null)}
          />
        )}
      </div>
    </div>
  );
}
