/**
 * GraphView — the ◉ Graph canvas (GRAPH-VIEW-PLAN §2 P1, prototype on fixture
 * data). Direction C's Structure lens: stable layered islands, realtime as a
 * restrained overlay. The active app hydrates this from `graph.query`; the
 * optional timeline remains only for explicitly scripted fixture previews.
 *
 * Laws honored here:
 *  - C1: a node click (canvas OR shelf) pushes the entity's Z3 panel — the
 *    caller wires `onSelect` to nav.push, so the panel is the real one.
 *  - Stability spine: the settled layout never moves on its own. Timeline
 *    arrivals materialize in place; layout only changes when the DATA changes
 *    the model, never on a timer.
 *  - Liveness honesty (R-UI-5): the pulse and the animated thread render ONLY
 *    when `livenessOf` says 'live'. A recorded-running-but-stale session gets
 *    wait + the word "stale", static. Heat comes from `activityAt` — a real
 *    field. Status is always color + word.
 *  - §15.2: no kind literals here — presentation resolves through the domain
 *    registry (`getKind`), status through the registry's chip spec, keyed by
 *    StatusSource, never by kind.
 *  - Scale honesty: the model's RENDER_CAP truncation renders as a banner,
 *    never a silent cut; filtered-to-nothing teaches, never blanks.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EdgeView, EntityId, EntitySummary } from '@tm8/contract';
import { KindIcon, getKind, type StatusSource } from '../domain';
import type { SessionLiveness } from '../data/seam';
import { useDismissable } from '../panels/useDismissable';
import { Avatar, Chip, Eyebrow, IconBtn, Pill, Timestamp, type PillTone } from '../kit';
import {
  DEFAULT_WINDOW,
  GRAPH_WINDOWS,
  NODE_H,
  NODE_W,
  RENDER_CAP,
  buildGraphModel,
  focusSubgraph,
  searchMatches,
  windowSpec,
  type GraphModel,
  type PlacedEdge,
  type PlacedNode,
} from './model';
import { DEFAULT_LENS, LENSES, lensSpec, type LensId } from './relevance';
import {
  GROUP_BYS,
  discriminatingGroupBys,
  groupSpec,
  type GroupById,
} from './grouping';
import { GraphSearch } from './GraphSearch';
import { Minimap } from './Minimap';

/** Structurally identical to the fixture's step type — no fixtures import. */
export type GraphTimelineStep =
  | { atMs: number; kind: 'edge'; edge: EdgeView; label: string }
  | { atMs: number; kind: 'activity'; entityId: EntityId; label: string }
  | { atMs: number; kind: 'note'; label: string };

export interface GraphViewProps {
  nodes: readonly EntitySummary[];
  edges: readonly EdgeView[];
  /** Scripted fixture replay (labeled in the toolbar). Optional. */
  timeline?: readonly GraphTimelineStep[];
  /** The heat clock — fixtures pass their frozen now. */
  now: string;
  /** C1 — wire to nav.push. */
  onSelect(id: EntityId): void;
  /** The seam's honest snapshot verdict; gates every live treatment. */
  livenessOf(id: string): SessionLiveness;
  /** The aside's current selection — the matching node wears a persistent ring. */
  selectedId?: EntityId | null;
  /**
   * The viewer, for the filter dock's "My Nodes" — nodes the viewer created or
   * is assigned to. Absent ⇒ the pill is not drawn (never enabled-and-inert).
   */
  viewerId?: string | null;
  /**
   * THE WINDOW IS A READ, SO ITS STATE LIVES ABOVE THIS COMPONENT.
   *
   * Choosing "last day" re-queries the space for entities active since then;
   * it does not filter the nodes already in hand. Owning the choice locally
   * would mean the label could describe a window the canvas never asked for —
   * exactly the failure this scope is meant to end. A host that passes nothing
   * gets a canvas that filters what it was handed, and says so.
   */
  window?: string;
  onChooseWindow?: (id: string) => void;
  /** The read's page filled: the window holds more than this canvas shows. */
  atCeiling?: boolean;
  /** Size of that page, so the count can be stated rather than implied. */
  nodeLimit?: number;
}

const ZOOM_MIN = 0.35;
const ZOOM_MAX = 1.75;
const PAN_STEP = 80;

/**
 * ONE lens vocabulary (AUDIT 2). The filter dock, the honesty banner and every
 * empty state must name a lens with the SAME words, or an instruction points at
 * a control that does not exist — the banner used to say "Switch to Everything"
 * over a dock whose button says "All Types" and an empty state whose escape
 * said "Show everything". The dock's words are the canon because the dock is
 * the control the reader will actually find.
 */
const LENS_WORDS: Record<LensId, string> = {
  live: 'Live',
  working: 'Active Only',
  all: 'All Types',
};

/**
 * StatusSource → the EntityState member it names (the chrome.tsx pattern —
 * keyed by SOURCE, never by kind; adding a kind touches neither).
 */
const STATUS_FIELD: Record<Exclude<StatusSource, 'none'>, string> = {
  status: 'status',
  sessionStatus: 'status',
  prState: 'state',
  profileStatus: 'status',
  memberRole: 'role',
  equipped: 'equipped',
};

function statusPill(entity: EntitySummary): { word: string; tone: PillTone } | null {
  const chip = getKind(entity.kind).chip;
  if (chip.tintBy === 'none') return null;
  const raw = (entity.state as unknown as Record<string, unknown>)[STATUS_FIELD[chip.tintBy]];
  const value =
    typeof raw === 'string' ? raw : typeof raw === 'boolean' ? (raw ? 'equipped' : 'library') : null;
  if (value === null) return null;
  return { word: value.replace(/_/g, ' '), tone: (chip.tones?.[value] ?? 'idle') as PillTone };
}

/**
 * "3 messages, 1 doc" — the fold badge's tooltip. Kind names arrive as DATA and
 * resolve through the registry (§15.2); nothing here knows what a message is.
 */
function foldSummary(byKind: Readonly<Record<string, number>>): string {
  return Object.entries(byKind)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, n]) => `${n} ${n === 1 ? getKind(kind).label : getKind(kind).labelPlural}`)
    .join(', ');
}

interface Transform {
  x: number;
  y: number;
  k: number;
}

interface TickerEntry {
  key: string;
  label: string;
  entityId?: EntityId;
}

function edgePath(e: PlacedEdge, pos: Map<EntityId, PlacedNode>): string | null {
  const s = pos.get(e.sourceId);
  const t = pos.get(e.targetId);
  if (!s || !t) return null;
  // Anchor by relative geometry: forward edges leave the bottom and enter the
  // top; everything else runs center-to-center with a gentle bow.
  if (t.y >= s.y + NODE_H) {
    const x1 = s.x + NODE_W / 2;
    const y1 = s.y + NODE_H;
    const x2 = t.x + NODE_W / 2;
    const y2 = t.y;
    const bend = Math.max(28, (y2 - y1) / 2);
    return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
  }
  const x1 = s.x + NODE_W / 2;
  const y1 = s.y + NODE_H / 2;
  const x2 = t.x + NODE_W / 2;
  const y2 = t.y + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  const bow = y1 === y2 ? -48 : 0;
  return `M ${x1} ${y1} Q ${mx} ${(y1 + y2) / 2 + bow}, ${x2} ${y2}`;
}

function edgeMid(e: PlacedEdge, pos: Map<EntityId, PlacedNode>): { x: number; y: number } | null {
  const s = pos.get(e.sourceId);
  const t = pos.get(e.targetId);
  if (!s || !t) return null;
  return {
    x: (s.x + t.x) / 2 + NODE_W / 2,
    y: (s.y + NODE_H / 2 + t.y + NODE_H / 2) / 2 + (t.y >= s.y + NODE_H ? 0 : -26),
  };
}

export function GraphView(props: GraphViewProps) {
  const { now, onSelect, livenessOf, selectedId = null } = props;

  // Filters store the OFF sets, so kinds/types that appear later default ON.
  const [kindsOff, setKindsOff] = useState<ReadonlySet<string>>(new Set());
  const [typesOff, setTypesOff] = useState<ReadonlySet<string>>(new Set());

  // The relevance lens. This is the answer to "the graph shows too much": the
  // canvas opens on active work rather than on every entity the session has
  // ever ingested, and `Everything` is one click away and clearly labeled.
  const [lens, setLens] = useState<LensId>(DEFAULT_LENS);
  // The time window — orthogonal to the lens and the other half of the same
  // answer. The lens says what KIND of interest earns a place; the window says
  // how recently the space touched it. It opens on a day because that is what
  // separates on this space (24h selects 195 of 3,917) — see GRAPH_WINDOWS.
  //
  // The host owns it when the host can act on it, i.e. when choosing a window
  // re-reads the space. The local fallback keeps this component usable from a
  // fixture harness; there the window can only filter the nodes handed in, and
  // the footer says so rather than claiming the space was searched.
  const [localWindowId, setLocalWindowId] = useState<string>(DEFAULT_WINDOW);
  const readBacked = props.window !== undefined && props.onChooseWindow !== undefined;
  const windowId = props.window ?? localWindowId;
  // Folding is ON by default (it is the largest declutter and costs no meaning)
  // but the user can always ask to see every leaf as its own card.
  const [fold, setFold] = useState(true);
  // Hubs the user has explicitly expanded — their folded leaves come back as
  // real cards without turning folding off everywhere.
  const [expandedHubs, setExpandedHubs] = useState<ReadonlySet<string>>(new Set());

  // CONTEXTUAL GROUPING — orthogonal to the lens, the window and the filters,
  // and the third question this canvas can be asked. The lens picks what KIND
  // of interest earns a place; the window picks how recent; grouping picks how
  // what is already here should be ARRANGED. Off by default: the topological
  // picture is still the one the graph is for, and a partition the reader did
  // not ask for would silently re-home every card on first paint.
  const [groupBy, setGroupBy] = useState<GroupById>('none');
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());

  // Timeline application — arrivals only ever ADD edges / touch activityAt.
  const [extraEdges, setExtraEdges] = useState<readonly EdgeView[]>([]);
  const [touched, setTouched] = useState<Readonly<Record<string, string>>>({});
  const [ticker, setTicker] = useState<readonly TickerEntry[]>([]);

  const [tf, setTf] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const [hoverId, setHoverId] = useState<EntityId | null>(null);
  const [flashId, setFlashId] = useState<EntityId | null>(null);

  // W2 search + W1 focus + layout-freeze state.
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState<{ id: EntityId; hops: number } | null>(null);
  // A bump forces one UNFROZEN model compute (explicit re-layout); the freeze
  // ref then re-snapshots and stability resumes.
  const [relayoutTick, setRelayoutTick] = useState(0);
  const [vpSize, setVpSize] = useState<{ w: number; h: number } | null>(null);
  // Eases the canvas transform ONLY during a programmatic reveal-pan (aside
  // open / resize). Manual drag/zoom clear it so those stay instant.
  const [panEase, setPanEase] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fittedRef = useRef(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The previous compute's placed positions — fed back as `frozen` so settled
  // nodes never move (Stability spine). null = the next compute is a full,
  // unfrozen re-layout (first mount, explicit re-layout, focus change).
  const frozenRef = useRef<Readonly<Record<string, { x: number; y: number }>> | null>(null);
  const panEaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* "My Nodes" (filter dock): the viewer's own slice — created-by or assigned.
     Structural read of `state.assignees`; kinds without assignees simply match
     on creator, no kind is named. */
  const [myOnly, setMyOnly] = useState(false);
  const effectiveNodes = useMemo(() => {
    const base = props.nodes.map((n) => (touched[n.id] ? { ...n, activityAt: touched[n.id] } : n));
    if (!myOnly || !props.viewerId) return base;
    return base.filter((n) => {
      if (n.createdBy.id === props.viewerId) return true;
      const assignees = (n.state as { assignees?: readonly { id: string }[] } | undefined)?.assignees;
      return Array.isArray(assignees) && assignees.some((a) => a.id === props.viewerId);
    });
  }, [props.nodes, touched, myOnly, props.viewerId]);
  const allEdges = useMemo(() => [...props.edges, ...extraEdges], [props.edges, extraEdges]);

  const kindsPresent = useMemo(
    () => [...new Set(props.nodes.map((n) => n.kind))],
    [props.nodes],
  );
  const typesPresent = useMemo(() => [...new Set(allEdges.map((e) => e.type))], [allEdges]);

  // W2 search — matched ids for the current query (empty query → empty set).
  const matches = useMemo(() => searchMatches(effectiveNodes, query), [effectiveNodes, query]);

  // W1 focus — the undirected 2-hop subgraph around the focused node; we filter
  // BEFORE the model so the subgraph lays out cleanly on its own.
  const focusIds = useMemo(
    () => (focus ? focusSubgraph(effectiveNodes, allEdges, focus.id, focus.hops) : null),
    [focus, effectiveNodes, allEdges],
  );
  const modelNodes = useMemo(
    () => (focusIds ? effectiveNodes.filter((n) => focusIds.has(n.id)) : effectiveNodes),
    [effectiveNodes, focusIds],
  );

  // INTEGRATION(W1): frozen-layout + re-layout chip wired here. `frozenRef`
  // carries the previous compute's placed positions; buildGraphModel pins them
  // and slots only arrivals in, reporting model.pendingRelayout. null → a full
  // unfrozen re-layout (first mount / explicit re-layout / focus change).
  // relayoutTick is a dep so the re-layout chip can force one recompute.
  // Liveness as a SET, for the model's relevance pass. Derived from the seam's
  // snapshot verdict — never from recency, which is a different fact (R-UI-5).
  const liveIds = useMemo(
    () => new Set(modelNodes.filter((n) => livenessOf(n.id) === 'live').map((n) => n.id)),
    [modelNodes, livenessOf],
  );

  // Ids the user has pinned interest to: the selection, the focus, and every
  // neighbor of an expanded hub (those are exactly the leaves that would have
  // folded onto it, so protecting them is what "expand" means).
  const pinnedIds = useMemo(() => {
    const pins = new Set<string>();
    if (selectedId) pins.add(selectedId);
    if (focus) pins.add(focus.id);
    if (expandedHubs.size > 0) {
      for (const e of allEdges) {
        if (expandedHubs.has(e.source.id)) pins.add(e.target.id);
        if (expandedHubs.has(e.target.id)) pins.add(e.source.id);
      }
    }
    return pins;
  }, [selectedId, focus, expandedHubs, allEdges]);

  const model: GraphModel = useMemo(
    () =>
      buildGraphModel({
        nodes: modelNodes,
        edges: allEdges as EdgeView[],
        kindFilter: kindsOff.size ? new Set(kindsPresent.filter((k) => !kindsOff.has(k))) : null,
        edgeTypeFilter: typesOff.size
          ? new Set(typesPresent.filter((t) => !typesOff.has(t)))
          : null,
        now,
        lens,
        windowMs: windowSpec(windowId).ms,
        liveIds,
        matchIds: matches,
        pinnedIds,
        focusId: focus?.id ?? null,
        fold,
        // Grouping owns placement outright, so a frozen snapshot from the
        // previous partition would strand cards outside their own band's frame.
        // The model ignores `frozen` when grouping; not passing it here keeps
        // that contract visible at the call site too.
        frozen: groupBy === 'none' ? (frozenRef.current ?? undefined) : undefined,
        groupBy,
        collapsedGroups,
      }),
    // frozenRef is read intentionally without being a dep (the same idiom as
    // prevCanvasIds below): it is refreshed by the snapshot effect after commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modelNodes, allEdges, kindsOff, typesOff, kindsPresent, typesPresent, now, relayoutTick,
     lens, windowId, liveIds, matches, pinnedIds, focus, fold, groupBy, collapsedGroups],
  );

  // Snapshot placed positions AFTER each compute — the next compute freezes on
  // this (unless a re-layout / focus change nulled the ref first).
  useEffect(() => {
    const snap: Record<string, { x: number; y: number }> = {};
    for (const p of model.placed) snap[p.entity.id] = { x: p.x, y: p.y };
    frozenRef.current = snap;
  }, [model]);

  const posById = useMemo(() => new Map(model.placed.map((p) => [p.entity.id, p])), [model]);

  // Which dimensions would actually SPLIT what is on screen. Offering
  // "Priority" on a canvas of nothing but sessions is offering a partition of
  // one band, and the reader finds that out only by spending a click.
  const groupOptions = useMemo(
    () =>
      discriminatingGroupBys(modelNodes, { now, edges: allEdges as EdgeView[], nodes: modelNodes }),
    [modelNodes, allEdges, now],
  );

  // A dimension can stop discriminating while it is selected (a filter narrows
  // the canvas to one kind). Falling back to 'none' keeps the control honest
  // rather than leaving it naming a partition that is no longer in force.
  useEffect(() => {
    if (groupBy !== 'none' && !groupOptions.includes(groupBy)) setGroupBy('none');
  }, [groupOptions, groupBy]);

  const chooseGroupBy = useCallback((id: GroupById) => {
    // A band key from the old dimension means nothing in the new one.
    setCollapsedGroups(new Set());
    setGroupBy(id);
    // Grouping re-homes every card, so the next compute must be a full layout.
    frozenRef.current = null;
  }, []);

  const toggleGroupCollapsed = useCallback((key: string) => {
    setCollapsedGroups((prior) => {
      const next = new Set(prior);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  // Latest-value mirrors so the size-change reveal effect can read them while
  // depending ONLY on vpSize (a selection or pan change must not re-trigger it).
  const tfRef = useRef(tf);
  tfRef.current = tf;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const posByIdRef = useRef(posById);
  posByIdRef.current = posById;

  // Materialize grammar: a node whose id was not on canvas last render enters
  // with the brass ring. The very first render staggers everything in.
  const prevCanvasIds = useRef<ReadonlySet<string>>(new Set());
  const newIds = useMemo(() => {
    const prev = prevCanvasIds.current;
    return new Set(model.placed.filter((p) => !prev.has(p.entity.id)).map((p) => p.entity.id));
  }, [model]);
  useEffect(() => {
    prevCanvasIds.current = new Set(model.placed.map((p) => p.entity.id));
  }, [model]);

  // Hover neighborhood (the proven dimming behavior).
  const neighborhood = useMemo(() => {
    if (!hoverId) return null;
    const near = new Set<EntityId>([hoverId]);
    for (const e of model.edges) {
      if (e.sourceId === hoverId) near.add(e.targetId);
      if (e.targetId === hoverId) near.add(e.sourceId);
    }
    return near;
  }, [hoverId, model.edges]);

  // ------------------------------------------------------------------------
  // Scripted timeline — the fixture replay, labeled as such in the toolbar.
  // ------------------------------------------------------------------------
  useEffect(() => {
    const steps = props.timeline ?? [];
    const timers = steps.map((step) =>
      setTimeout(() => {
        if (step.kind === 'edge') setExtraEdges((prior) => [...prior, step.edge]);
        if (step.kind === 'activity')
          setTouched((prior) => ({ ...prior, [step.entityId]: now }));
        setTicker((prior) => [
          {
            key: `${step.atMs}-${step.label}`,
            label: step.label,
            entityId:
              step.kind === 'edge'
                ? step.edge.source.id
                : step.kind === 'activity'
                  ? step.entityId
                  : undefined,
          },
          ...prior.slice(0, 4),
        ]);
      }, step.atMs),
    );
    return () => timers.forEach(clearTimeout);
    // The scripted replay runs once per mount, by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------------
  // Pan / zoom — pointer drag, wheel-to-cursor, keyboard (T3-6 requires
  // keyboard access), one initial fit. NEVER an uninvoked move afterward.
  // ------------------------------------------------------------------------

  // Viewport metrics — width/height prefer the OBSERVED size (correct the very
  // moment the aside opens/closes, so the initial fit is right in the aside-open
  // state too), with the live rect supplying the page offset cursor math needs.
  const vpMetrics = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return {
      w: vpSize?.w ?? rect?.width ?? 0,
      h: vpSize?.h ?? rect?.height ?? 0,
      left: rect?.left ?? 0,
      top: rect?.top ?? 0,
    };
  }, [vpSize]);

  const fit = useCallback(() => {
    if (model.width === 0) return;
    const { w, h } = vpMetrics();
    if (w === 0) return;
    const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(w / model.width, h / model.height, 1)));
    setTf({
      x: (w - model.width * k) / 2,
      y: Math.max(16, (h - model.height * k) / 2),
      k,
    });
  }, [model.width, model.height, vpMetrics]);

  useEffect(() => {
    if (fittedRef.current) return;
    if (model.placed.length === 0) return;
    fittedRef.current = true;
    fit();
  }, [fit, model.placed.length]);

  // Measure the viewport so the minimap can draw the visible-window frame in
  // canvas space. Re-attaches when the viewport (un)mounts with the empty state.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setVpSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [model.placed.length === 0 && model.shelf.length === 0]);

  // ADDENDUM: when the viewport SIZE changes (aside open/close, window resize)
  // and a node is selected, pan MINIMALLY so its rect stays fully visible with a
  // 24px margin — same zoom k, no refit, and nothing moves when no node is
  // selected (stability spine: a response to a user-invoked layout change, never
  // an uninvoked drift). Depends on vpSize only; current tf/selection/positions
  // come from refs so a selection or pan never re-fires this.
  const prevVpRef = useRef(vpSize);
  useEffect(() => {
    const prev = prevVpRef.current;
    prevVpRef.current = vpSize;
    if (!vpSize) return;
    if (prev && prev.w === vpSize.w && prev.h === vpSize.h) return;
    const id = selectedIdRef.current;
    if (id == null) return;
    const node = posByIdRef.current.get(id);
    if (!node) return;
    const m = 24;
    const t = tfRef.current;
    const left = t.x + node.x * t.k;
    const top = t.y + node.y * t.k;
    const right = left + NODE_W * t.k;
    const bottom = top + NODE_H * t.k;
    let dx = 0;
    let dy = 0;
    if (left < m) dx = m - left;
    else if (right > vpSize.w - m) dx = vpSize.w - m - right;
    if (top < m) dy = m - top;
    else if (bottom > vpSize.h - m) dy = vpSize.h - m - bottom;
    if (dx === 0 && dy === 0) return;
    setPanEase(true);
    if (panEaseTimer.current) clearTimeout(panEaseTimer.current);
    panEaseTimer.current = setTimeout(() => setPanEase(false), 320);
    setTf((prior) => ({ ...prior, x: prior.x + dx, y: prior.y + dy }));
  }, [vpSize]);

  useEffect(() => () => {
    if (panEaseTimer.current) clearTimeout(panEaseTimer.current);
  }, []);

  const panTo = useCallback(
    (id: EntityId) => {
      const node = posById.get(id);
      if (!node) return;
      const { w, h } = vpMetrics();
      setTf((prior) => ({
        ...prior,
        x: w / 2 - (node.x + NODE_W / 2) * prior.k,
        y: h / 2 - (node.y + NODE_H / 2) * prior.k,
      }));
      setFlashId(id);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashId(null), 1800);
    },
    [posById, vpMetrics],
  );

  const dragState = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null);
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      // Interactive children (node cards, shelf chips, ticker rows) keep their
      // clicks; EVERYTHING else — viewport, the transformed canvas div, edge
      // svg — starts a drag. The first guard here required the target to be
      // the viewport itself, which the canvas div covers almost entirely (the
      // edge svg is pointer-events:none, so hits land on the canvas div), so
      // the hand grabbed nothing. The node card is now a role=button DIV, so
      // guard on .gv-node too — otherwise a card press would start a pan.
      if ((event.target as HTMLElement).closest('button, summary, .gv-node')) return;
      setPanEase(false); // dragging must track the pointer with no transition lag
      dragState.current = { startX: event.clientX, startY: event.clientY, tx: tf.x, ty: tf.y };
      (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
    },
    [tf.x, tf.y],
  );
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag) return;
    setTf((prior) => ({
      ...prior,
      x: drag.tx + (event.clientX - drag.startX),
      y: drag.ty + (event.clientY - drag.startY),
    }));
  }, []);
  const onPointerUp = useCallback(() => {
    dragState.current = null;
  }, []);

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      // The Legend moved inside the viewport so its top edge follows the
      // variable-height honesty banner. Keep its own scroll wheel: canvas zoom
      // has no claim on chrome positioned over the canvas.
      if ((event.target as HTMLElement).closest('.gv-legend')) return;
      event.preventDefault();
      setPanEase(false); // manual zoom is instant, never eased
      const { left, top } = vpMetrics();
      const cx = event.clientX - left;
      const cy = event.clientY - top;
      setTf((prior) => {
        const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prior.k * Math.exp(-event.deltaY * 0.0016)));
        const ratio = k / prior.k;
        return { k, x: cx - (cx - prior.x) * ratio, y: cy - (cy - prior.y) * ratio };
      });
    },
    [vpMetrics],
  );

  // Double-click the background to zoom 1.5× toward the cursor (shift → out
  // 1/1.5×), reusing onWheel's zoom-to-cursor math. Guard on the node card
  // (role=button div) and any real button so it never fires over a card, shelf
  // chip, or ticker row — single-click selection and pointer-drag are untouched.
  const onDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest('button, summary, .gv-node')) return;
      setPanEase(false); // discrete zoom, instant
      const { left, top } = vpMetrics();
      const cx = event.clientX - left;
      const cy = event.clientY - top;
      const factor = event.shiftKey ? 1 / 1.5 : 1.5;
      setTf((prior) => {
        const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prior.k * factor));
        const ratio = k / prior.k;
        return { k, x: cx - (cx - prior.x) * ratio, y: cy - (cy - prior.y) * ratio };
      });
    },
    [vpMetrics],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      setPanEase(false);
      const { w, h } = vpMetrics();
      const cx = w / 2;
      const cy = h / 2;
      setTf((prior) => {
        const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prior.k * factor));
        const ratio = k / prior.k;
        return { k, x: cx - (cx - prior.x) * ratio, y: cy - (cy - prior.y) * ratio };
      });
    },
    [vpMetrics],
  );

  // Center the canvas on a CANVAS-space point at the current zoom — the panTo
  // math without the flash. Used by the minimap's onJump.
  const jumpTo = useCallback(
    (cx: number, cy: number) => {
      setPanEase(false);
      const { w, h } = vpMetrics();
      setTf((prior) => ({ ...prior, x: w / 2 - cx * prior.k, y: h / 2 - cy * prior.k }));
    },
    [vpMetrics],
  );

  // Explicit re-layout: drop the freeze, force one unfrozen compute; the
  // snapshot effect re-freezes on the fresh positions afterward.
  const relayout = useCallback(() => {
    frozenRef.current = null;
    setRelayoutTick((t) => t + 1);
  }, []);

  // Focus / clear-focus both allow one unfrozen compute so the changed node set
  // lays out cleanly, then re-freeze resumes.
  const focusOn = useCallback((id: EntityId) => {
    frozenRef.current = null;
    setFocus({ id, hops: 2 });
  }, []);
  const clearFocus = useCallback(() => {
    frozenRef.current = null;
    setFocus(null);
  }, []);

  // A lens or fold change replaces the node set wholesale, so freezing the old
  // positions would strand survivors in a layout computed for a different
  // graph. Both drop the freeze for exactly one compute, like focus above.
  const chooseLens = useCallback((next: LensId) => {
    frozenRef.current = null;
    setLens(next);
  }, []);
  const chooseWindow = useCallback(
    (next: string) => {
      frozenRef.current = null;
      // Both, always: the host re-reads, and the local value keeps the buttons
      // honest in a harness that passes no handler.
      setLocalWindowId(next);
      props.onChooseWindow?.(next);
    },
    [props],
  );
  const toggleFold = useCallback(() => {
    frozenRef.current = null;
    setFold((f) => !f);
  }, []);
  const expandHub = useCallback((hubId: EntityId) => {
    frozenRef.current = null;
    setExpandedHubs((prior) => {
      const next = new Set(prior);
      if (next.has(hubId)) next.delete(hubId);
      else next.add(hubId);
      return next;
    });
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        (event.target as HTMLElement).closest('.gv-legend, .gv-filterdock, .gv-zoomdock')
      ) return;
      const pan = (dx: number, dy: number) => {
        setPanEase(false);
        setTf((prior) => ({ ...prior, x: prior.x + dx, y: prior.y + dy }));
      };
      switch (event.key) {
        case 'ArrowUp': pan(0, PAN_STEP); break;
        case 'ArrowDown': pan(0, -PAN_STEP); break;
        case 'ArrowLeft': pan(PAN_STEP, 0); break;
        case 'ArrowRight': pan(-PAN_STEP, 0); break;
        case '+': case '=': zoomBy(1.2); break;
        case '-': case '_': zoomBy(1 / 1.2); break;
        case '0': fit(); break;
        default: return;
      }
      event.preventDefault();
    },
    [fit, zoomBy],
  );

  const toggle = (set: ReadonlySet<string>, value: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const filtered = kindsOff.size > 0 || typesOff.size > 0;
  const nothingVisible = model.placed.length === 0 && model.shelf.length === 0;

  const searching = query.trim().length > 0;
  // Enter pans to the FIRST placed match (an unplaced match can't be centered).
  const onSearchSubmit = () => {
    const first = model.placed.find((p) => matches.has(p.entity.id));
    if (first) panTo(first.entity.id);
  };

  const focusTitle = focus ? effectiveNodes.find((n) => n.id === focus.id)?.title ?? '' : '';
  const showMinimap = model.placed.length >= 8;
  const minimapNodes = useMemo(
    () =>
      model.placed.map((p) => ({
        id: p.entity.id,
        x: p.x,
        y: p.y,
        w: NODE_W,
        h: NODE_H,
        tone: (p.onBlockedPath
          ? 'blocked'
          : livenessOf(p.entity.id) === 'live'
            ? 'live'
            : 'default') as 'default' | 'blocked' | 'live',
      })),
    [model.placed, livenessOf],
  );
  const minimapViewport =
    vpSize && tf.k > 0
      ? { x: -tf.x / tf.k, y: -tf.y / tf.k, w: vpSize.w / tf.k, h: vpSize.h / tf.k }
      : null;

  return (
    <div className="gv-root" data-testid="graph-view">
      <div className="gv-toolbar">
        {/* THE LENS moved to the canvas's filter dock (bottom-left) — the bar
            keeps the window, the search and the counts. */}
        {/* THE WINDOW, beside the lens because they are two halves of one
            question and neither is a refinement of the other: the lens picks
            the KIND of interest, the window picks HOW RECENT. Kept as its own
            control rather than folded into the lens list so that "Live, last
            week" is expressible — collapsing them would silently remove
            combinations the reader can currently ask for. */}
        <div className="gv-lens" role="group" aria-label="Graph time window">
          {GRAPH_WINDOWS.map((spec) => (
            <button
              key={spec.id}
              type="button"
              className={spec.id === windowId ? 'gv-lens__opt gv-lens__opt--on' : 'gv-lens__opt'}
              aria-pressed={spec.id === windowId}
              title={spec.hint}
              onClick={() => chooseWindow(spec.id)}
            >
              {spec.label}
            </button>
          ))}
        </div>
        <span
          className="gv-toolbar__count"
          aria-label={`${model.placed.length} nodes, ${model.edges.length} edges, ${model.componentCount} ${model.componentCount === 1 ? 'island' : 'islands'}${model.hubCount > 0 ? `, ${model.hubCount} ${model.hubCount === 1 ? 'hub' : 'hubs'} not merging` : ''}`}
          title={`${model.placed.length} nodes · ${model.edges.length} edges · ${model.componentCount} ${model.componentCount === 1 ? 'island' : 'islands'}${model.hubCount > 0 ? ` · ${model.hubCount} ${model.hubCount === 1 ? 'hub' : 'hubs'} not merging` : ''}`}
        >
          {/* At rest the toolbar names the primary thing and stops. Edge,
              island and hub counts remain in the accessible label + tooltip;
              action-bearing exceptions below stay visible because they carry
              their own remedy. The name wins the width budget. */}
          {model.placed.length} nodes
          {/* The declutter states its own price, always. A number nobody can
              account for is the thing this whole change exists to remove. */}
          {model.foldedCount > 0 && (
            <button
              type="button"
              className="gv-toolbar__fold"
              onClick={toggleFold}
              title="Leaves with a single connection are folded onto their neighbor, which carries the count. Click to draw every one as its own card."
            >
              · {model.foldedCount} folded
            </button>
          )}
          {!fold && (
            <button type="button" className="gv-toolbar__fold" onClick={toggleFold}>
              · re-fold leaves
            </button>
          )}
          {/* The fourth exclusion says its own name and its own remedy, exactly
              as truncation and the lens and the window do. */}
          {model.collapsedCount > 0 && (
            <button
              type="button"
              className="gv-toolbar__fold"
              onClick={() => setCollapsedGroups(new Set())}
              title="Nodes inside bands you collapsed. Click to open every band."
            >
              · {model.collapsedCount} in collapsed{' '}
              {model.groups.filter((g) => g.collapsed).length === 1 ? 'band' : 'bands'}
            </button>
          )}
        </span>
        <span className="gv-toolbar__spacer" />
        {/* INTEGRATION(W2): GraphSearch mounted here — before the filter selects
            so search reads left-to-right first. matchCount is null when the query
            is blank (nothing to say); Enter pans to the first match. */}
        <GraphSearch
          value={query}
          onChange={setQuery}
          matchCount={searching ? matches.size : null}
          onSubmit={onSearchSubmit}
        />
        {focus ? (
          <button
            type="button"
            className="gv-filter gv-filter--action"
            onClick={clearFocus}
            title="Clear focus — show the whole graph"
          >
            ⌖ focused: {focusTitle} · {focus.hops} hops · show all
          </button>
        ) : null}
        {model.pendingRelayout > 0 ? (
          <button
            type="button"
            className="gv-filter gv-filter--action"
            onClick={relayout}
            title="Re-layout the graph — new arrivals were placed beside their neighbors"
          >
            ⟳ re-layout ({model.pendingRelayout} new)
          </button>
        ) : null}
        {/* USER RULING 2026-07-29 (live, brokered into the graph carve-out by
            the FE coordinator, dual attribution — graph seat's lane, disclosed
            at its next wake): per-kind and per-edge chips became two compact
            MULTI-SELECT dropdowns — with every kind and edge type inlined the
            toolbar wrapped to multiple rows and taxed the canvas. */}
        {/* GROUPING sits with the filters because it is the same class of
            control — it changes the ARRANGEMENT of what the lens and window
            already admitted, and never what is admitted. Only dimensions that
            would actually split this canvas are offered. */}
        {groupOptions.length > 1 ? (
          <GroupSelect value={groupBy} options={groupOptions} onChoose={chooseGroupBy} />
        ) : null}
        <FilterSelect
          label="Entities"
          options={kindsPresent.map((kind) => {
            const row = getKind(kind);
            return { id: kind, label: row.labelPlural, icon: <KindIcon kind={kind} /> };
          })}
          offIds={kindsOff}
          onToggle={(id) => setKindsOff((prior) => toggle(prior, id))}
          onShowAll={() => setKindsOff(new Set())}
        />
        <FilterSelect
          label="Edges"
          options={typesPresent.map((type) => ({ id: type, label: type.replace(/_/g, ' ') }))}
          offIds={typesOff}
          onToggle={(id) => setTypesOff((prior) => toggle(prior, id))}
          onShowAll={() => setTypesOff(new Set())}
        />
      </div>

      {/* THREE EXCLUSIONS, THREE SENTENCES. `outOfWindow` means it is older than
          the window; `outOfLens` means this lens never reached it; `truncated`
          means the canvas filled up. Three different facts with three different
          remedies — widen the window, widen the lens, raise the cap — and saying
          "the canvas holds 150" over either of the other two is a false
          explanation, the exact failure this banner exists to remove. */}
      {(model.truncated > 0 || model.outOfLens > 0 || model.outOfWindow > 0 ||
        props.atCeiling === true) && (
        <div className="gv-banner" role="status">
          {/* A FOURTH, DIFFERENT FACT: the READ filled its page. The window was
              asked of the whole space and the space had more to say than one
              page holds. There is no count-by-query read, so a full page is the
              only evidence available — which is why this says "at least", and
              why its remedy is a narrower window rather than a bigger canvas. */}
          {props.atCeiling === true && (
            <>
              This is the {props.nodeLimit ?? model.visibleTotal} most recently active in{' '}
              {windowSpec(windowId).label.toLowerCase()}; the window holds at least that many.
              Narrow the window to see a complete picture of a shorter period.{' '}
            </>
          )}
          {model.outOfWindow > 0 && (
            <>
              {model.outOfWindow} of {model.visibleTotal} are older than{' '}
              {windowSpec(windowId).label.toLowerCase()} and are not on this canvas. Running,
              searched and selected entities are shown however old they are.{' '}
              {/* WHICH WINDOW THIS IS. A host that owns the choice re-queries the
                  space, so the sentence above is about the space. Without one the
                  window can only sieve the nodes this canvas was handed, and
                  saying nothing would let the same words claim a search that
                  never happened. */}
              {readBacked ? '' : 'This window sieves the nodes already loaded; it does not re-read the space. '}
            </>
          )}
          {model.outOfLens > 0 && (
            <>
              {model.outOfLens} of {model.visibleTotal} outside this lens —{' '}
              {LENS_WORDS[lens]} shows {lensSpec(lens).hint.toLowerCase()}{' '}
              {/* AUDIT 2: the instruction IS the control — the sentence stays,
                  and its verb performs the switch it names (role=status may
                  contain a button). Same words as the filter dock, always. */}
              <button type="button" className="gv-banner__act" onClick={() => chooseLens('all')}>
                Switch to {LENS_WORDS.all}
              </button>{' '}
              to see them.{' '}
            </>
          )}
          {model.truncated > 0 && (
            <>
              {model.truncated} more did not fit — the canvas holds {RENDER_CAP} and spends
              them on the most relevant work first. Live, searched and selected entities are
              never among them.
            </>
          )}
        </div>
      )}

      {nothingVisible ? (
        <div className="gv-empty">
          {model.lensEmpty ? (
            /* THE HONEST EMPTY LENS. This used to fall through to scoping the
               whole space, so "Live" on a workspace with nothing running drew
               every node and called it live — the opposite of the promise. An
               empty answer is the true one; the escape sits right under it. */
            <>
              <p className="gv-empty__title">
                Nothing matches the {LENS_WORDS[lens]} lens right now.
              </p>
              <p className="gv-empty__detail">
                {lensSpec(lens).hint} {model.visibleTotal} entities are in this space.
              </p>
              {/* AUDIT 1: switching the lens alone kept the narrow time window,
                  which landed the reader on a SECOND empty state — the escape
                  widens both in one act, and says both. */}
              <button
                type="button"
                className="gv-filter"
                onClick={() => {
                  chooseLens('all');
                  chooseWindow('all');
                }}
              >
                Switch to {LENS_WORDS.all}
                {windowId === 'all' ? '' : ', all time'}
              </button>
            </>
          ) : model.outOfWindow === model.visibleTotal && model.visibleTotal > 0 ? (
            /* A QUIET SPACE IS NOT AN EMPTY ONE. Everything here fell out of the
               window, which is a fact about the clock, not about the filters —
               blaming the filters would send the reader to the wrong control. */
            <>
              <p className="gv-empty__title">
                Nothing has been touched in {windowSpec(windowId).label.toLowerCase()}.
              </p>
              <p className="gv-empty__detail">
                {model.visibleTotal} entities are loaded; all of them are older than that.
              </p>
              <button type="button" className="gv-filter" onClick={() => chooseWindow('all')}>
                Show all time
              </button>
            </>
          ) : filtered ? (
            <>
              <p className="gv-empty__title">Nothing matches these filters.</p>
              <button
                type="button"
                className="gv-filter"
                onClick={() => {
                  setKindsOff(new Set());
                  setTypesOff(new Set());
                }}
              >
                Clear filters
              </button>
            </>
          ) : (
            /* THE TERMINAL RUNG (AUDIT 1). Reachable when a narrower the other
               escapes never touch emptied the canvas — "My Nodes" matching
               nothing, a focus whose node left the data — so it carries its own
               way out: reset every narrower this component owns and re-read the
               widest window. The ladder never dead-ends. When the host handed
               us no entities at all there is nothing an escape could show, and
               drawing one would be a button that does nothing. */
            <>
              <p className="gv-empty__title">The graph draws itself as work happens.</p>
              {props.nodes.length > 0 ? (
                <>
                  <p className="gv-empty__detail">
                    {props.nodes.length} entities are loaded; none are in this view.
                  </p>
                  <button
                    type="button"
                    className="gv-filter"
                    title={`${LENS_WORDS.all}, all time, everyone's — every narrower reset`}
                    onClick={() => {
                      setMyOnly(false);
                      clearFocus();
                      chooseLens('all');
                      chooseWindow('all');
                    }}
                  >
                    Show the whole space
                  </button>
                </>
              ) : null}
            </>
          )}
        </div>
      ) : (
        <div
          className="gv-viewport"
          ref={viewportRef}
          tabIndex={0}
          role="application"
          aria-label="Entity graph canvas. Arrow keys pan, plus and minus zoom, zero fits the graph."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onDoubleClick={onDoubleClick}
          onKeyDown={onKeyDown}
        >
          <div
            className={panEase ? 'gv-canvas gv-canvas--ease' : 'gv-canvas'}
            style={{
              width: model.width,
              height: model.height,
              transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.k})`,
            }}
          >
            {/* THE CONTEXTUAL BANDS, drawn UNDER the edges and cards: a frame
                is a backdrop the reader looks past, never a thing that
                intercepts a click meant for a card. The header is the one part
                that is interactive, and it lifts itself back above. */}
            {model.groups.map((g) => {
              const kindRow = g.kindRef ? getKind(g.kindRef) : null;
              const label = kindRow ? kindRow.labelPlural : g.label;
              return (
                <div
                  key={g.key}
                  className={[
                    'gv-band',
                    g.residual ? 'gv-band--residual' : '',
                    g.collapsed ? 'gv-band--collapsed' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
                >
                  <button
                    type="button"
                    className="gv-band__head"
                    aria-expanded={!g.collapsed}
                    onClick={() => toggleGroupCollapsed(g.key)}
                    title={
                      g.collapsed
                        ? `Show the ${g.count} in ${label}`
                        : `Collapse ${label} — its ${g.count} stay counted on the header`
                    }
                  >
                    <span className="gv-band__caret" aria-hidden>
                      {g.collapsed ? '▸' : '▾'}
                    </span>
                    {kindRow ? (
                      <span className="gv-band__icon" aria-hidden>
                        <KindIcon kind={g.kindRef!} />
                      </span>
                    ) : null}
                    <span className="gv-band__label">{label}</span>
                    <span className="gv-band__count">{g.count}</span>
                  </button>
                </div>
              );
            })}

            <svg className="gv-edges" width={model.width} height={model.height} aria-hidden>
              <defs>
                <marker id="gv-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 8 4 L 0 8 z" className="gv-arrowhead" />
                </marker>
                <marker id="gv-arrow-blocked" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 8 4 L 0 8 z" className="gv-arrowhead gv-arrowhead--blocked" />
                </marker>
              </defs>
              {model.edges.map((e) => {
                const d = edgePath(e, posById);
                const mid = edgeMid(e, posById);
                if (!d || !mid) return null;
                const live = e.type === 'working_on' && livenessOf(e.sourceId) === 'live';
                const dimmed =
                  neighborhood !== null &&
                  !(e.sourceId === hoverId || e.targetId === hoverId);
                // The active-path emphasis: an edge touching the hovered or
                // selected node is the one the viewer is reading, and it says
                // so — brass, wider, above the hairline crowd. Blocked keeps
                // its own color regardless (honesty outranks emphasis).
                const touchesFocus =
                  (hoverId !== null && (e.sourceId === hoverId || e.targetId === hoverId)) ||
                  (selectedId !== null && (e.sourceId === selectedId || e.targetId === selectedId));
                const cls = [
                  'gv-edge',
                  e.blocked ? 'gv-edge--blocked' : '',
                  live ? 'gv-edge--live' : '',
                  dimmed ? 'gv-edge--dim' : '',
                  touchesFocus ? 'gv-edge--hot' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                // Declutter: labels are noise at fit zoom. Show one only when the
                // canvas is legible (k ≥ 0.9), when its edge touches the hovered
                // or selected node, or when it is BLOCKED — the word "blocked"
                // never disappears (honesty law), whatever the zoom.
                const showLabel = tf.k >= 0.9 || touchesFocus || e.blocked;
                return (
                  <g key={e.id} className={cls}>
                    <path
                      d={d}
                      className="gv-edge__line"
                      markerEnd={`url(#${e.blocked ? 'gv-arrow-blocked' : 'gv-arrow'})`}
                    />
                    {showLabel && (
                      <text x={mid.x} y={mid.y} className="gv-edge__label" textAnchor="middle">
                        {e.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>

            {model.placed.map((p) => {
              const liveness = livenessOf(p.entity.id);
              const pill = statusPill(p.entity);
              const row = getKind(p.entity.kind);
              const dimmed = neighborhood !== null && !neighborhood.has(p.entity.id);
              const selected = selectedId != null && selectedId === p.entity.id;
              // Search: matched nodes get a subtle brass outline; everything else
              // is dimmed like a hover-neighborhood miss. The two dims compose;
              // selected still outranks both (handled in CSS).
              const matched = searching && matches.has(p.entity.id);
              const unmatched = searching && !matches.has(p.entity.id);
              const cls = [
                'gv-node',
                `gv-node--${p.heat}`,
                p.onBlockedPath ? 'gv-node--blocked' : '',
                p.ghost ? 'gv-node--ghost' : '',
                dimmed ? 'gv-node--dim' : '',
                unmatched ? 'gv-node--unmatched' : '',
                matched ? 'gv-node--match' : '',
                newIds.has(p.entity.id) ? 'gv-node--new' : '',
                flashId === p.entity.id ? 'gv-node--flash' : '',
                selected ? 'gv-node--selected' : '',
              ]
                .filter(Boolean)
                .join(' ');
              const focused = focus?.id === p.entity.id;
              return (
                // A role=button div (not a <button>) so the focus affordance can
                // be a REAL nested button — nested <button>s are invalid HTML.
                // Keyboard: Enter/Space select, matching the old card button.
                <div
                  key={p.entity.id}
                  role="button"
                  tabIndex={0}
                  className={cls}
                  aria-current={selected ? 'true' : undefined}
                  data-family={row.graphFamily ?? 'gray'}
                  style={{ left: p.x, top: p.y, width: NODE_W, minHeight: NODE_H }}
                  onClick={() => onSelect(p.entity.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(p.entity.id);
                    }
                  }}
                  onMouseEnter={() => setHoverId(p.entity.id)}
                  onMouseLeave={() => setHoverId(null)}
                  onFocus={() => setHoverId(p.entity.id)}
                  onBlur={() => setHoverId(null)}
                >
                  <button
                    type="button"
                    className={focused ? 'gv-node__focus gv-node__focus--on' : 'gv-node__focus'}
                    aria-label="Focus on this node"
                    aria-pressed={focused}
                    onClick={(event) => {
                      // Never let the focus verb also select the card.
                      event.stopPropagation();
                      if (focused) clearFocus();
                      else focusOn(p.entity.id);
                    }}
                  >
                    ⌖
                  </button>
                  <span className="gv-node__head">
                    <span className="gv-node__glyph" aria-hidden>
                      <KindIcon kind={p.entity.kind} />
                    </span>
                    <span className="gv-node__kind">{row.label}</span>
                    {/* The mono ref — the id's own tail, never invented. It is
                        what turns "a task card" into "THIS task", the way a
                        ticket number does, and it echoes the detail panel's id
                        chip so the two surfaces corroborate each other. */}
                    <span className="gv-node__ref" aria-hidden>
                      {p.entity.id.slice(-4)}
                    </span>
                    <span className="gv-node__pills">
                      {pill && <Pill tone={pill.tone}>{pill.word}</Pill>}
                      {liveness === 'live' && (
                        <Pill tone="run" dot="pulse">
                          live
                        </Pill>
                      )}
                      {liveness === 'stale' && <Pill tone="wait">stale</Pill>}
                    </span>
                  </span>
                  <span className="gv-node__title">{p.entity.title}</span>
                  {/* THE BODY SLOT — structural, kind-blind: whatever facts the
                      summary carries are drawn; absent facts draw nothing.
                      Acceptance → a real progress bar; a LIVE session's model →
                      the mono activity line; a due date → the overdue-aware
                      chip. No kind is named (§15.2). */}
                  {(() => {
                    const st = p.entity.state as Partial<{
                      acceptance: { total: number; completed: number };
                      dueDate: string | null;
                      model: string;
                    }> | undefined;
                    const acc = st?.acceptance;
                    if (acc && acc.total > 0) {
                      const pct = Math.round((acc.completed / acc.total) * 100);
                      return (
                        <span className="gv-node__body gv-node__body--progress">
                          <span className="gv-node__bar" aria-hidden>
                            <i style={{ width: `${pct}%` }} />
                          </span>
                          <span className="gv-node__bodymeta">
                            {acc.completed} of {acc.total} criteria
                          </span>
                        </span>
                      );
                    }
                    if (liveness === 'live' && st?.model) {
                      return (
                        <span className="gv-node__body gv-node__body--snippet">
                          <span className="gv-node__snippet">▸ running · {st.model}</span>
                        </span>
                      );
                    }
                    if (st?.dueDate) {
                      const over = new Date(st.dueDate).getTime() < new Date(now).getTime();
                      return (
                        <span className="gv-node__body">
                          <span className={over ? 'gv-node__due gv-node__due--over' : 'gv-node__due'}>
                            due <Timestamp at={st.dueDate} now={now} />
                          </span>
                        </span>
                      );
                    }
                    return null;
                  })()}
                  <span className="gv-node__foot">
                    <Avatar
                      actorId={p.entity.createdBy.id}
                      provenance={p.entity.createdBy.isAgent ? 'agent' : 'human'}
                      label={p.entity.createdBy.displayName}
                      size={15}
                    />
                    <Timestamp className="gv-node__meta" at={p.entity.activityAt} now={now} title="last activity" />
                    {p.ghost && <span className="gv-node__meta gv-node__meta--ghost">deleted</span>}
                    {/* THE HUB BADGE. Nothing is hidden behind it — it is the
                        answer to "why are these two groups drawn apart when I
                        can see an edge between them?". A node this connected is
                        shared context, so it is not evidence that the work on
                        either side of it is the same work. */}
                    {p.hub && (
                      <span
                        className="gv-node__meta gv-node__meta--hub"
                        title={`${p.degree} connections — drawn and linked, but not used to merge the groups it touches`}
                      >
                        hub · {p.degree}
                      </span>
                    )}
                    {/* THE FOLD BADGE. What collapsed onto this card, said in
                        kinds and counts, and clickable to bring it back. A
                        folded leaf is relocated here — never dropped — and this
                        is where it is accounted for. */}
                    {p.folded && (
                      <button
                        type="button"
                        className="gv-node__folded"
                        title={`${foldSummary(p.folded.byKind)} folded in — click to expand`}
                        aria-label={`Expand ${p.folded.nodes.length} folded neighbors`}
                        onClick={(event) => {
                          event.stopPropagation();
                          expandHub(p.entity.id);
                        }}
                      >
                        {p.folded.nodes.length} folded
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          {model.placed.length > 0 && (
            <>
              {/* Canvas chrome belongs to the viewport, not the graph root.
                  The honesty banner is a normal-flow sibling above this
                  viewport, so variable-length truth can never grow underneath
                  the Legend again. The Legend is closed at rest: its NAME is
                  always present while its twenty toggles appear on request. */}
              <details
                className="gv-legend"
                role="group"
                aria-label="Legend — click a kind to filter"
              >
                <summary className="gv-legend__title">Legend</summary>
            {kindsPresent.map((k) => {
              const row = getKind(k);
              const off = kindsOff.has(k);
              return (
                <button
                  key={k}
                  type="button"
                  className={off ? 'gv-legend__row gv-legend__row--off' : 'gv-legend__row'}
                  aria-pressed={!off}
                  onClick={() =>
                    setKindsOff((current) => {
                      const next = new Set(current);
                      if (next.has(k)) next.delete(k);
                      else next.add(k);
                      return next;
                    })
                  }
                >
                  {/* The kind's DRAWN mark, family-tinted — the same registry
                      artwork the card eyebrow wears, so the legend teaches the
                      exact symbol the canvas uses instead of a bare color dot. */}
                  <span className="gv-legend__mark" data-family={row.graphFamily ?? 'gray'} aria-hidden>
                    <KindIcon kind={k} size={13} />
                  </span>
                  {row.label}
                </button>
              );
            })}
              </details>

              {/* FILTER DOCK — bottom-left. The lens lives here now: All Types /
                  Active Only, plus My Nodes when a viewer is known. */}
              <div className="gv-filterdock" role="group" aria-label="Filters">
                <span className="gv-filterdock__label">Filters</span>
                <button
                  type="button"
                  className={lens === 'all' && !myOnly ? 'gv-filterdock__opt gv-filterdock__opt--on' : 'gv-filterdock__opt'}
                  aria-pressed={lens === 'all' && !myOnly}
                  onClick={() => { chooseLens('all'); setMyOnly(false); }}
                >
                  {LENS_WORDS.all}
                </button>
                <button
                  type="button"
                  className={lens !== 'all' && !myOnly ? 'gv-filterdock__opt gv-filterdock__opt--on' : 'gv-filterdock__opt'}
                  aria-pressed={lens !== 'all' && !myOnly}
                  title={lensSpec('working').hint}
                  onClick={() => { chooseLens('working'); setMyOnly(false); }}
                >
                  {LENS_WORDS.working}
                </button>
                {props.viewerId ? (
                  <button
                    type="button"
                    className={myOnly ? 'gv-filterdock__opt gv-filterdock__opt--on' : 'gv-filterdock__opt'}
                    aria-pressed={myOnly}
                    title="Only what you created or are assigned to"
                    onClick={() => setMyOnly((v) => !v)}
                  >
                    My Nodes
                  </button>
                ) : null}
              </div>

              {/* ZOOM DOCK — bottom-right, off the toolbar so the canvas controls
                  sit where the hand already is. */}
              <div className="gv-zoomdock" role="group" aria-label="Canvas zoom">
                <IconBtn label="Zoom in" onClick={() => zoomBy(1.2)}>+</IconBtn>
                <IconBtn label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>−</IconBtn>
                <IconBtn label="Fit graph" onClick={fit}>⤢</IconBtn>
              </div>
            </>
          )}
        </div>
      )}

      {model.shelf.length > 0 && (
        <div className="gv-shelf">
          <Eyebrow faint>Shelf · {model.shelf.length} unconnected</Eyebrow>
          <div className="gv-shelf__chips">
            {model.shelf.map((entity) => (
              <Chip
                key={entity.id}
                glyph={<KindIcon kind={entity.kind} />}
                title={`${entity.title} — no edges under the current filters`}
                onClick={() => onSelect(entity.id)}
              >
                {entity.title}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {/* INTEGRATION(W2): Minimap mounted here — a right-side rail stacks the
          overview ABOVE the event ticker (both stay visible, column-gapped).
          Hidden below 8 nodes: an overview of nothing is noise. onJump gives
          CANVAS-space coords → jumpTo centers the transform at the current k. */}
      {(showMinimap || ticker.length > 0) && (
        <div className="gv-rail">
          {showMinimap && (
            <Minimap
              width={model.width}
              height={model.height}
              nodes={minimapNodes}
              viewport={minimapViewport}
              onJump={jumpTo}
            />
          )}
          {ticker.length > 0 && (
            <div className="gv-ticker" role="log" aria-label="Recent graph events">
              {ticker.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className="gv-ticker__row"
                  onClick={entry.entityId ? () => panTo(entry.entityId!) : undefined}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * FilterSelect — a compact multi-select dropdown for the toolbar. The face
 * shows its label at rest and adds `visible/total` only after filtering; the
 * popover is a checkbox list with a "show all" escape once anything is hidden. Esc and
 * outside-click dismiss (the panels' useDismissable, same behavior as every
 * popover in the app). All state stays the caller's off-set — this renders
 * and forwards, it decides nothing.
 */
/**
 * The grouping dimension — SINGLE-select, unlike the filter dropdowns beside
 * it, because a node has one home and two partitions at once is not a picture.
 * Each row carries the dimension's hint: the control teaches what the band will
 * mean before the reader spends a click finding out.
 */
function GroupSelect({
  value,
  options,
  onChoose,
}: {
  value: GroupById;
  options: readonly GroupById[];
  onChoose(id: GroupById): void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissable(open, rootRef, () => setOpen(false));
  const active = value !== 'none';

  return (
    <div className="gv-select" ref={rootRef}>
      <button
        type="button"
        className={active ? 'gv-select__face gv-select__face--filtered' : 'gv-select__face'}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={groupSpec(value).hint}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="gv-select__name">Group</span>
        {' '}
        <span className="gv-select__state">· {active ? groupSpec(value).label : 'off'}</span>
        {' '}
        <span className="gv-select__chevron" aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="gv-select__pop" role="listbox" aria-label="Group the graph by">
          {GROUP_BYS.filter((spec) => options.includes(spec.id)).map((spec) => (
            <button
              key={spec.id}
              type="button"
              role="option"
              aria-selected={spec.id === value}
              className={
                spec.id === value ? 'gv-select__opt gv-select__opt--on' : 'gv-select__opt'
              }
              onClick={() => {
                onChoose(spec.id);
                setOpen(false);
              }}
            >
              <span className="gv-select__label">{spec.label}</span>
              <span className="gv-select__hint">{spec.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FilterSelect({
  label,
  options,
  offIds,
  onToggle,
  onShowAll,
}: {
  label: string;
  options: readonly { id: string; label: string; icon?: ReactNode }[];
  offIds: ReadonlySet<string>;
  onToggle(id: string): void;
  onShowAll(): void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissable(open, rootRef, () => setOpen(false));

  const visible = options.length - offIds.size;
  const filtered = offIds.size > 0;

  return (
    <div className="gv-select" ref={rootRef}>
      <button
        type="button"
        className={filtered ? 'gv-select__face gv-select__face--filtered' : 'gv-select__face'}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={filtered ? `${label}: ${visible} of ${options.length} shown` : label}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="gv-select__name">{label}</span>
        {filtered ? (
          <>
            {' '}
            <span className="gv-select__state">· {visible}/{options.length}</span>
          </>
        ) : null}
        {' '}
        <span className="gv-select__chevron" aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="gv-select__pop" role="listbox" aria-label={`${label} filter`} aria-multiselectable>
          {filtered ? (
            <button type="button" className="gv-select__all" onClick={onShowAll}>
              show all
            </button>
          ) : null}
          {options.map((opt) => {
            const on = !offIds.has(opt.id);
            return (
              <label key={opt.id} className="gv-select__row">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onToggle(opt.id)}
                  aria-label={`${on ? 'Hide' : 'Show'} ${opt.label}`}
                />
                {opt.icon ? <span aria-hidden>{opt.icon}</span> : null}
                <span className="gv-select__label">{opt.label}</span>
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
