/**
 * THE GRAPH SURFACE — the last chip on a work session, beside Terminal,
 * Transcript, Git and Debug.
 *
 * WHAT IT IS FOR. Terminal shows the bytes, Transcript shows what the agent
 * said, Debug shows what the agent was told and what it ran. None of them answers "what did
 * this session TOUCH" — which task it took, who runs it, what it created, who
 * it talked to, what it wrote. That answer already exists as edges; this
 * surface is the first place it is drawn.
 *
 * SELF-FETCHING, like the Debug body: it takes the seam and does its own reads,
 * and the switch mounts it ONLY while its chip is selected, so unmounting is
 * what stops the poll. `live` carries the other half — an exited session is
 * read once and never polled, because its footprint cannot change.
 *
 * HONESTY, the same law the Debug surface holds itself to and for the same
 * reason (a thin graph and a broken graph look identical unless the surface
 * says which it is):
 *   · a folded relation prints its exact count and never a rounded one;
 *   · a hub prints its degree and the number of branches NOT drawn through it,
 *     so a stopped traversal is visibly a decision rather than a missing link;
 *   · a neighbour whose edges could not be read is drawn with its branch ENDING
 *     and counted in the footer, never as a leaf;
 *   · a truncated canvas says how many cells it dropped;
 *   · switching a relation off is a viewer filter and is stated as one.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DurableWorkspaceEvent, EntityId, EntitySummary } from '@tm8/contract';
import { KindIcon, getKind } from '../domain';
import { Eyebrow, Pill, type PillTone } from '../kit';
import { renderBadge } from '../panels/list/tile-badges';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import { routePulsePath, type SessionPulse, type SessionPulseKind } from '../panels/list/message-pulse';
import { useMessagePulses } from '../panels/list/useMessagePulses';
import type { Seam } from '../data/seam';
import { loadSessionGraph, type LoadResult } from './load';
import {
  FOLD_AT,
  HUB_DEGREE,
  buildSessionGraph,
  foldId,
  summarize,
  type Cell,
  type SessionGraph,
} from './model';
import {
  cellSize,
  layoutSessionGraph,
  type PlacedLink,
  type Placement,
} from './layout';
import './session-graph.css';

const POLL_MS = 20_000;
const HOP_CHOICES: readonly number[] = [1, 2, 3];
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.2;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

interface GraphPulseEndpoint {
  role: 'from' | 'to';
  kind: SessionPulseKind;
  outcome?: 'exited' | 'failed';
}

interface GraphPulseLeg {
  key: string;
  placed: PlacedLink;
  travel: 'forward' | 'reverse';
  order: number;
  pulse: SessionPulse;
}

interface GraphPulsePresentation {
  legs: readonly GraphPulseLeg[];
  endpoints: ReadonlyMap<string, GraphPulseEndpoint>;
}

const NO_GRAPH_PULSES: GraphPulsePresentation = {
  legs: [],
  endpoints: new Map(),
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return reduced;
}

function knownEntitiesOf(focus: EntitySummary | null, state: State): EntitySummary[] {
  const byId = new Map<string, EntitySummary>();
  if (focus) byId.set(focus.id, focus);
  if (state.phase === 'ready') {
    for (const edges of state.result.edgesByNode.values()) {
      for (const edge of edges) {
        byId.set(edge.source.id, edge.source);
        byId.set(edge.target.id, edge.target);
      }
    }
  }
  return [...byId.values()];
}

function completionOutcome(pulse: SessionPulse): 'exited' | 'failed' | undefined {
  return pulse.kind === 'completion' ? pulse.outcome : undefined;
}

/** Resolve typed pulses over the graph's deterministic BFS tree. */
function resolveGraphPulses(
  graph: SessionGraph,
  placement: Placement,
  pulses: readonly SessionPulse[],
): GraphPulsePresentation {
  if (pulses.length === 0) return NO_GRAPH_PULSES;
  const cells = new Set(graph.cells.map((cell) => cell.id));
  const parents = new Map<string, string | null>();
  for (const cell of graph.cells) parents.set(cell.id, cell.parentId);
  const index = {
    parentOf: (id: string) => parents.get(id),
    isVisible: (id: string) => cells.has(id),
  };
  const linksByPair = new Map<string, PlacedLink>();
  for (const placed of placement.links) {
    linksByPair.set(`${placed.link.fromId}\u0000${placed.link.toId}`, placed);
    linksByPair.set(`${placed.link.toId}\u0000${placed.link.fromId}`, placed);
  }

  const legs: GraphPulseLeg[] = [];
  const endpoints = new Map<string, GraphPulseEndpoint>();
  for (const pulse of pulses) {
    const route = routePulsePath(pulse.fromId, pulse.toId, index);
    route.steps.forEach((step, order) => {
      const placed = linksByPair.get(`${step.fromId}\u0000${step.toId}`);
      if (!placed) return;
      legs.push({
        key: `${pulse.key}:${placed.link.id}:${order}`,
        placed,
        travel: placed.link.fromId === step.fromId ? 'forward' : 'reverse',
        order,
        pulse,
      });
    });
    const shared = {
      kind: pulse.kind,
      ...(completionOutcome(pulse) ? { outcome: completionOutcome(pulse) } : {}),
    };
    if (route.fromRowId !== null && !endpoints.has(route.fromRowId)) {
      endpoints.set(route.fromRowId, { role: 'from', ...shared });
    }
    if (route.toRowId !== null) endpoints.set(route.toRowId, { role: 'to', ...shared });
  }
  return { legs, endpoints };
}

function pulseMarkerId(prefix: string, kind: SessionPulseKind): string {
  return `${prefix}-pulse-${kind}`;
}

export interface SessionGraphBodyProps {
  seam: Seam;
  /**
   * THE CENTRE, WHATEVER KIND IT IS. This was `sessionId` while sessions were
   * the only mount; the surface is now the Connections tab's graph view for
   * every kind, and a name that says "session" would have told the next reader
   * that a task centred here was a misuse rather than the point.
   */
  focusId: EntityId;
  /** The centre's own summary, so it draws before any read resolves. */
  focus?: EntitySummary | null;
  /** Still able to grow edges ⇒ poll; finished ⇒ one read. */
  live: boolean;
  /** Absent ⇒ the selection card refuses "open" with a reason, never hides it. */
  onOpenEntity?: (id: string) => void;
}

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; result: LoadResult };

export function SessionGraphBody({
  seam,
  focusId,
  focus = null,
  live,
  onOpenEntity,
}: SessionGraphBodyProps) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [hops, setHops] = useState(2);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(new Set());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [reading, setReading] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const markerPrefix = `sg-${useId().replace(/:/g, '')}`;
  // Kept across polls so a refresh never throws a drawn canvas back to a spinner.
  const hasLoaded = useRef(false);
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadRequest.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    if (!mounted.current) return;
    setReading(true);
    try {
      const result = await loadSessionGraph({
        read: (id, opts) => seam.connections(id, opts),
        focusId,
        hops,
        openFolds,
        cancelled: () => !mounted.current || request !== loadRequest.current,
      });
      if (!mounted.current || request !== loadRequest.current) return;
      hasLoaded.current = true;
      setState({ phase: 'ready', result });
    } catch (err) {
      if (!mounted.current || request !== loadRequest.current) return;
      if (!hasLoaded.current) {
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'The session graph could not be read',
        });
      }
    } finally {
      if (mounted.current && request === loadRequest.current) setReading(false);
    }
  }, [seam, focusId, hops, openFolds]);

  const knownEntities = useMemo(() => knownEntitiesOf(focus, state), [focus, state]);
  const knownIds = useRef<ReadonlySet<string>>(new Set([focusId]));
  knownIds.current = new Set([focusId, ...knownEntities.map((entity) => entity.id)]);

  const onPulseEvent = useCallback(
    (event: DurableWorkspaceEvent, pulse: SessionPulse | null) => {
      const known = knownIds.current;
      const pulseTouchesGraph =
        pulse !== null &&
        (known.has(pulse.fromId) || known.has(pulse.toId));
      const corroboratingEdgeTouchesGraph =
        event.type === 'edge.upsert' &&
        (event.edge.type === 'dispatched_by' || event.edge.type === 'messaged') &&
        (known.has(event.edge.source.id) || known.has(event.edge.target.id));
      if (pulseTouchesGraph || corroboratingEdgeTouchesGraph) void load();
    },
    [load],
  );

  // The hook is the same bounded event-stream consumer as the session tree.
  // Its callback turns the stream into the liveness path; polling below stays
  // the correctness backstop.
  const pulses = useMessagePulses(seam, { knownEntities, onEvent: onPulseEvent });

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  // A different session is a different graph: drop the viewer's folds, filters
  // and viewport rather than carrying one session's expansions onto another's.
  useEffect(() => {
    setOpenFolds(new Set());
    setHidden(new Set());
    setSelectedId(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    hasLoaded.current = false;
    setState({ phase: 'loading' });
  }, [focusId]);

  const graph: SessionGraph | null = useMemo(() => {
    if (state.phase !== 'ready') return null;
    const edges = state.result.edgesByNode.get(focusId) ?? [];
    // The centre must exist even before the panel hands us a summary: any edge
    // touching the session carries the session's own summary on one end.
    const self =
      focus ??
      edges.map((e) => (e.source.id === focusId ? e.source : e.target)).find((e) => e.id === focusId) ??
      null;
    if (!self) return null;
    return buildSessionGraph({
      focusId,
      edgesByNode: state.result.edgesByNode,
      focus: self,
      hops,
      openFolds,
      hiddenRelations: hidden,
    });
  }, [state, focusId, focus, hops, openFolds, hidden]);

  const placement = useMemo(() => (graph ? layoutSessionGraph(graph) : null), [graph]);
  const summary = useMemo(() => (graph ? summarize(graph) : null), [graph]);
  const graphPulses = useMemo(() => {
    if (!graph || !placement) return NO_GRAPH_PULSES;
    const visible = new Set(graph.cells.map((cell) => cell.id));
    const relevant = pulses.filter(
      (pulse) => visible.has(pulse.fromId) || visible.has(pulse.toId),
    );
    return resolveGraphPulses(graph, placement, relevant);
  }, [graph, placement, pulses]);

  const toggleFold = (id: string) => {
    setOpenFolds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleRelation = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (state.phase === 'loading') {
    return (
      <div className="sg-root" data-testid="session-graph-body">
        <p className="sg-loading" role="status">
          Reading this session&rsquo;s connections&hellip;
        </p>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="sg-root" data-testid="session-graph-body">
        <div className="sg-empty" data-testid="session-graph-error">
          <DisabledAction
            label="Session graph"
            reason={{ cause: 'The session graph could not be read', remedy: state.message }}
          >
            Graph unavailable
          </DisabledAction>
        </div>
      </div>
    );
  }

  if (!graph || !placement || !summary) {
    return (
      <div className="sg-root" data-testid="session-graph-body">
        <div className="sg-empty" data-testid="session-graph-unresolved">
          <DisabledAction
            label="Session graph"
            reason={{
              cause: 'This session is not on the graph yet',
              remedy: 'It holds no edges, so there is nothing to place around it.',
            }}
          >
            Nothing linked yet
          </DisabledAction>
        </div>
      </div>
    );
  }

  const { result } = state;
  const selected = selectedId
    ? graph.cells.find((cell) => cell.id === selectedId) ?? null
    : null;
  const maxHop = graph.cells.reduce((max, cell) => Math.max(max, cell.hop), 0);

  return (
    <div className="sg-root" data-testid="session-graph-body">
      <header className="sg-head">
        <div className="sg-head__facts">
          <Eyebrow faint>WHAT THIS SESSION TOUCHED</Eyebrow>
          <p className="sg-head__line" data-testid="session-graph-headline">
            {summary.headline.length === 0
              ? 'No connections recorded yet.'
              : summary.headline.map((item, index) => (
                  <span key={item.key}>
                    {index > 0 ? <span className="sg-head__sep"> · </span> : null}
                    <span className="sg-head__label">{item.label}</span>{' '}
                    <span className="sg-head__count">{item.count}</span>
                  </span>
                ))}
          </p>
          <p className="sg-head__sub">
            {summary.relationCount} direct {summary.relationCount === 1 ? 'relation' : 'relations'} ·{' '}
            {summary.entityCount} {summary.entityCount === 1 ? 'entity' : 'entities'} drawn within{' '}
            {maxHop} {maxHop === 1 ? 'hop' : 'hops'}
          </p>
        </div>

        <div className="sg-head__controls">
          <div className="sg-hops" role="group" aria-label="Graph depth">
            {HOP_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                className={choice === hops ? 'sg-hops__opt sg-hops__opt--on' : 'sg-hops__opt'}
                aria-pressed={choice === hops}
                onClick={() => setHops(choice)}
                title={`Walk ${choice} ${choice === 1 ? 'hop' : 'hops'} out from this session`}
              >
                {choice} hop{choice === 1 ? '' : 's'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="sg-btn"
            onClick={() => void load()}
            aria-busy={reading}
            title="Re-read this session's connections"
          >
            {reading ? 'reading…' : '↻ refresh'}
          </button>
          <div className="sg-zoom" role="group" aria-label="Zoom">
            <button
              type="button"
              className="sg-btn sg-btn--tight"
              onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Number((z - 0.2).toFixed(2))))}
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              className="sg-btn sg-btn--tight"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              title="Fit"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="sg-btn sg-btn--tight"
              onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Number((z + 0.2).toFixed(2))))}
              aria-label="Zoom in"
            >
              +
            </button>
          </div>
        </div>
      </header>

      {graph.relations.length > 0 ? (
        <div className="sg-relations" role="group" aria-label="Relations from this session">
          {graph.relations.map((relation) => {
            const off = hidden.has(relation.key);
            return (
              <button
                key={relation.key}
                type="button"
                className={off ? 'sg-rel sg-rel--off' : 'sg-rel'}
                aria-pressed={!off}
                onClick={() => toggleRelation(relation.key)}
                title={
                  off
                    ? `${relation.label} is hidden — this is your filter, not a fact about the session`
                    : `Hide ${relation.label.toLowerCase()}`
                }
              >
                <span className="sg-rel__dot" data-relation={relation.type} aria-hidden="true" />
                {relation.label}
                <span className="sg-rel__n">{relation.peers.length}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div
        className="sg-canvas"
        data-testid="session-graph-canvas"
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          setPan({
            x: start.panX + (event.clientX - start.x),
            y: start.panY + (event.clientY - start.y),
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerLeave={() => {
          drag.current = null;
        }}
      >
        <svg
          className="sg-svg"
          viewBox={`0 0 ${placement.width} ${placement.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Graph of ${graph.cells.length} entities around this session`}
        >
          <defs>
            <marker
              id={`${markerPrefix}-arrow`}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" className="sg-arrowhead" />
            </marker>
            <marker
              id={pulseMarkerId(markerPrefix, 'message')}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" className="sg-pulse-arrow sg-pulse-arrow--message" />
            </marker>
            <marker
              id={pulseMarkerId(markerPrefix, 'delegation')}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="8"
              markerHeight="8"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8" className="sg-pulse-arrow sg-pulse-arrow--delegation" />
            </marker>
            <marker
              id={pulseMarkerId(markerPrefix, 'completion')}
              viewBox="0 0 9 8"
              refX="8"
              refY="4"
              markerWidth="9"
              markerHeight="8"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 7 4 L 0 8 M 8 0 L 8 8" className="sg-pulse-arrow sg-pulse-arrow--completion" />
            </marker>
          </defs>
          <g
            transform={`translate(${pan.x} ${pan.y}) translate(${placement.centre.x} ${placement.centre.y}) scale(${zoom}) translate(${-placement.centre.x} ${-placement.centre.y})`}
          >
            {placement.radii.map((r, index) => (
              <circle
                key={r}
                className="sg-ring"
                cx={placement.centre.x}
                cy={placement.centre.y}
                r={r}
                data-hop={index + 1}
              />
            ))}

            {placement.links.map((placed) => {
              const marker = `url(#${markerPrefix}-arrow)`;
              return (
                <path
                  key={placed.link.id}
                  className="sg-link"
                  data-relation={placed.link.type}
                  data-direction={placed.link.direction}
                  markerStart={placed.link.direction === 'in' ? marker : undefined}
                  markerEnd={placed.link.direction === 'out' ? marker : undefined}
                  d={`M ${placed.x1} ${placed.y1} Q ${placed.cx} ${placed.cy} ${placed.x2} ${placed.y2}`}
                />
              );
            })}

            {graphPulses.legs.map((leg) => {
              const marker = `url(#${pulseMarkerId(markerPrefix, leg.pulse.kind)})`;
              return (
                <path
                  key={leg.key}
                  className="sg-link sg-link--pulse"
                  data-pulse-kind={leg.pulse.kind}
                  data-pulse-outcome={completionOutcome(leg.pulse)}
                  data-travel={leg.travel}
                  data-pulse-motion={reducedMotion ? 'static' : 'travel'}
                  markerStart={leg.travel === 'reverse' ? marker : undefined}
                  markerEnd={leg.travel === 'forward' ? marker : undefined}
                  style={{
                    '--sg-pulse-delay': `calc(var(--pn-dur-fast) * ${leg.order})`,
                  } as React.CSSProperties}
                  d={`M ${leg.placed.x1} ${leg.placed.y1} Q ${leg.placed.cx} ${leg.placed.cy} ${leg.placed.x2} ${leg.placed.y2}`}
                />
              );
            })}

            {placement.cells.map((placed) => (
              <CellNode
                key={placed.cell.id}
                cell={placed.cell}
                x={placed.x}
                y={placed.y}
                selected={placed.cell.id === selectedId}
                pulse={graphPulses.endpoints.get(placed.cell.id)}
                onSelect={() => {
                  if (placed.cell.sort === 'fold') toggleFold(placed.cell.id);
                  else setSelectedId(placed.cell.id);
                }}
              />
            ))}
          </g>
        </svg>
      </div>

      {selected ? (
        <SelectionCard
          cell={selected}
          onOpen={onOpenEntity}
          onClose={() => setSelectedId(null)}
        />
      ) : null}

      <GraphFooter graph={graph} result={result} summary={summary} hiddenCount={hidden.size} />
    </div>
  );
}

/**
 * WHAT A CARD SAYS ABOUT ITSELF — from the registry, never from a switch here.
 *
 * A node drawn with only a title and its kind tells you a task exists, which
 * you already knew from asking. The facts that make it worth looking at — the
 * work status, the priority, the model a session runs, a PR's state — are
 * ALREADY declared per kind as `list.tile.badges` and already resolved by
 * `renderBadge`, which the list rows use. Reusing both means a kind that gains
 * a fact gains it on this canvas in the same edit, and `HANDLED_SOURCES`'
 * coverage test keeps every declared source resolving to something.
 *
 * The `avatar` slot is flattened to its label: a face at this size is a smudge,
 * but the NAME on it is one of the facts most worth carrying.
 */
function cardFacts(entity: EntitySummary): {
  status: { word: string; tone: PillTone } | null;
  facts: string;
} {
  let status: { word: string; tone: PillTone } | null = null;
  const parts: string[] = [];
  for (const badge of getKind(entity.kind).list.tile.badges) {
    const slot = renderBadge(badge.source, entity);
    if (slot === null) continue;
    if (slot.slot === 'status') {
      // First status wins; a kind declaring two would be declaring a conflict.
      status ??= { word: slot.word, tone: slot.tone };
    } else if (slot.slot === 'meta') parts.push(slot.text);
    else if (slot.slot === 'tag') parts.push(slot.label);
    else parts.push(slot.label);
  }
  return { status, facts: parts.join(' · ') };
}

/** "3 messages, 1 doc" — kind names arrive as DATA and resolve through the registry. */
function foldSummary(byKind: Readonly<Record<string, number>>): string {
  return Object.entries(byKind)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, n]) => `${n} ${n === 1 ? getKind(kind).label : getKind(kind).labelPlural}`)
    .join(', ');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function CellNode({
  cell,
  x,
  y,
  selected,
  pulse,
  onSelect,
}: {
  cell: Cell;
  x: number;
  y: number;
  selected: boolean;
  pulse?: GraphPulseEndpoint;
  onSelect: () => void;
}) {
  const { w, h } = cellSize(cell.hop);
  const left = x - w / 2;
  const top = y - h / 2;

  if (cell.sort === 'fold') {
    const detail = foldSummary(cell.byKind);
    return (
      <g
        className="sg-cell sg-cell--fold"
        transform={`translate(${left} ${top})`}
        role="button"
        tabIndex={0}
        aria-label={`${cell.label} — ${cell.count} folded: ${detail}. Activate to expand.`}
        data-pulse-role={pulse?.role}
        data-pulse-kind={pulse?.kind}
        data-pulse-outcome={pulse?.outcome}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect();
          }
        }}
      >
        <rect className="sg-box sg-box--fold" width={w} height={h} rx={h / 2} />
        <text className="sg-title" x={26} y={h / 2 - 3}>
          {cell.label}
        </text>
        <text className="sg-meta" x={26} y={h / 2 + 15}>
          {truncate(detail, 28)}
        </text>
        <text className="sg-count" x={w - 22} y={h / 2 + 5} textAnchor="end">
          {cell.count}
        </text>
      </g>
    );
  }

  const { entity } = cell;
  const config = getKind(entity.kind);
  const { status, facts } = cardFacts(entity);
  const focused = cell.sort === 'focus';
  /* The focus is the taller card, so its rows sit lower and it has one more of
     them. Written as offsets from the box rather than as two hard-coded
     ladders — a card is a stack of rows and only its top row is anchored. */
  const row1 = focused ? 32 : 26;
  const gap = focused ? 20 : 17;

  return (
    <g
      className={`sg-cell${focused ? ' sg-cell--focus' : ''}${selected ? ' sg-cell--selected' : ''}`}
      transform={`translate(${left} ${top})`}
      role="button"
      tabIndex={0}
      aria-label={`${config.label}: ${entity.title}${cell.hub ? ` — hub, ${cell.degree ?? 0} connections` : ''}`}
      data-pulse-role={pulse?.role}
      data-pulse-kind={pulse?.kind}
      data-pulse-outcome={pulse?.outcome}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <rect
        className="sg-box"
        width={w}
        height={h}
        rx={10}
        data-hop={cell.hop}
        data-hub={cell.hub ? 'true' : 'false'}
        data-unread={cell.degree === null ? 'true' : 'false'}
      />
      <g className="sg-icon" transform={`translate(14 ${row1 - 12})`}>
        {config.iconArt.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      {/* FOUR ROWS: what it is called, what it IS, what state it is in, and the
          facts its kind says matter. The old card had room for a title and one
          more thing, so it chose the state — and a card reading "waiting" told
          you nothing about what was waiting. The status word carries the kind's
          own tone, so a blocked task and a running session do not read alike. */}
      <text className="sg-title" x={40} y={row1}>
        {truncate(entity.title, focused ? 28 : 25)}
      </text>
      <text className="sg-meta" x={40} y={row1 + gap}>
        {config.label}
        {status ? (
          <>
            {' · '}
            <tspan className={`sg-state sg-state--${status.tone}`}>
              {truncate(status.word, 18)}
            </tspan>
          </>
        ) : null}
      </text>
      {facts ? (
        <text className="sg-facts" x={40} y={row1 + gap * 2}>
          {truncate(facts, focused ? 34 : 30)}
        </text>
      ) : null}
      {/* The focus paid for a fourth row with its extra height; this is what
          fills it. Its own degree is the one number that says whether the
          picture around it is the whole footprint or a slice of one. */}
      {focused ? (
        <text className="sg-facts sg-facts--faint" x={40} y={row1 + gap * 3}>
          {cell.degree === null
            ? 'connections not read'
            : `${cell.degree} connection${cell.degree === 1 ? '' : 's'}`}
        </text>
      ) : null}
      {cell.hub ? (
        <text className="sg-badge" x={w - 12} y={22} textAnchor="end">
          ◈{cell.degree}
        </text>
      ) : null}
      {!cell.hub && cell.withheld > 0 ? (
        <text className="sg-badge sg-badge--faint" x={w - 12} y={22} textAnchor="end">
          +{cell.withheld}
        </text>
      ) : null}
      {cell.degree === null ? (
        <text className="sg-badge sg-badge--faint" x={w - 12} y={h - 12} textAnchor="end">
          ⋯
        </text>
      ) : null}
    </g>
  );
}

function SelectionCard({
  cell,
  onOpen,
  onClose,
}: {
  cell: Cell;
  onOpen?: (id: string) => void;
  onClose: () => void;
}) {
  if (cell.sort === 'fold') return null;
  const { entity } = cell;
  const config = getKind(entity.kind);
  const { status, facts } = cardFacts(entity);
  return (
    <aside className="sg-card" data-testid="session-graph-selection">
      <span className="sg-card__kind">
        <KindIcon kind={entity.kind} />
        {config.label}
      </span>
      <span className="sg-card__title" title={entity.title}>
        {entity.title}
      </span>
      {status ? <Pill tone={status.tone}>{status.word}</Pill> : null}
      {facts ? <span className="sg-card__facts">{facts}</span> : null}
      <span className="sg-card__facts">
        {cell.hop === 0 ? 'the centre' : `${cell.hop} hop${cell.hop === 1 ? '' : 's'} out`}
        {cell.degree !== null ? ` · ${cell.degree} connections` : ' · connections not read'}
        {cell.hub ? ` · hub, not expanded past ${HUB_DEGREE}` : ''}
      </span>
      <span className="sg-card__actions">
        {onOpen ? (
          <button type="button" className="sg-btn" onClick={() => onOpen(entity.id)}>
            open ↗
          </button>
        ) : (
          <DisabledAction
            label="Open entity"
            reason={{
              cause: 'This view cannot open another entity',
              remedy: 'Its host did not wire navigation into the graph surface.',
            }}
          >
            open ↗
          </DisabledAction>
        )}
        <button type="button" className="sg-btn sg-btn--tight" onClick={onClose} aria-label="Clear selection">
          ✕
        </button>
      </span>
    </aside>
  );
}

/**
 * Every way this canvas is INCOMPLETE, named. Each line has a different remedy
 * — expand a fold, raise the depth, un-hide a relation, or nothing at all
 * because the server refused — and collapsing them into one "some items hidden"
 * would make all four unactionable.
 */
function GraphFooter({
  graph,
  result,
  summary,
  hiddenCount,
}: {
  graph: SessionGraph;
  result: LoadResult;
  summary: ReturnType<typeof summarize>;
  hiddenCount: number;
}) {
  const folds = graph.cells.filter((cell) => cell.sort === 'fold');
  const foldedTotal = folds.reduce((sum, cell) => sum + (cell.sort === 'fold' ? cell.count : 0), 0);
  const hubs = graph.cells.filter((cell) => cell.sort !== 'fold' && cell.hub).length;
  const notes: string[] = [];

  if (foldedTotal > 0) {
    notes.push(
      `${foldedTotal} in ${folds.length} folded ${folds.length === 1 ? 'group' : 'groups'} — a relation folds past ${FOLD_AT}; click one to open it`,
    );
  }
  if (hubs > 0) {
    notes.push(
      `${hubs} ${hubs === 1 ? 'node is a hub' : 'nodes are hubs'} (over ${HUB_DEGREE} connections) — drawn, never expanded through, so depth stays meaningful`,
    );
  }
  if (summary.unreadBoundary > 0) {
    notes.push(
      `${summary.unreadBoundary} ${summary.unreadBoundary === 1 ? 'branch ends' : 'branches end'} at the read budget — marked ⋯, not leaves`,
    );
  }
  if (graph.truncated > 0) {
    notes.push(`${graph.truncated} dropped at the canvas cap`);
  }
  if (result.failed > 0) {
    notes.push(
      `${result.failed} neighbour ${result.failed === 1 ? 'read' : 'reads'} failed — those branches are missing, not empty`,
    );
  }
  if (result.focusPaged) {
    notes.push('this session holds more edges than one page returned');
  }
  if (hiddenCount > 0) {
    notes.push(`${hiddenCount} ${hiddenCount === 1 ? 'relation' : 'relations'} hidden by your filter`);
  }

  if (notes.length === 0) return null;
  return (
    <footer className="sg-foot" data-testid="session-graph-footer">
      {notes.map((note) => (
        <p className="sg-foot__note" key={note}>
          {note}
        </p>
      ))}
    </footer>
  );
}
