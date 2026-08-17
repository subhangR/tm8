/**
 * THE GRAPH SURFACE — the fourth chip on a work session, beside Terminal, Chat
 * and Debug.
 *
 * WHAT IT IS FOR. Terminal shows the bytes, Chat shows the conversation, Debug
 * shows what the agent was told and what it ran. None of them answers "what did
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId, EntitySummary } from '@tm8/contract';
import { KindIcon, getKind } from '../domain';
import { Pill, type PillTone } from '../kit';
import { renderBadge } from '../panels/list/tile-badges';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
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
import { cellSize, layoutSessionGraph } from './layout';
import './session-graph.css';

const POLL_MS = 20_000;
const HOP_CHOICES: readonly number[] = [1, 2, 3];
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.2;

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
  // Kept across polls so a refresh never throws a drawn canvas back to a spinner.
  const hasLoaded = useRef(false);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const load = useCallback(async () => {
    setReading(true);
    try {
      const result = await loadSessionGraph({
        read: (id, opts) => seam.connections(id, opts),
        focusId,
        hops,
        openFolds,
      });
      hasLoaded.current = true;
      setState({ phase: 'ready', result });
    } catch (err) {
      if (!hasLoaded.current) {
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'The session graph could not be read',
        });
      }
    } finally {
      setReading(false);
    }
  }, [seam, focusId, hops, openFolds]);

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
      {/* ONE BAR, FLOATING ON THE CANVAS.
          This surface used to open with a three-line masthead — an eyebrow, a
          serif headline naming each relation and its count, and a sub-line
          counting relations and entities — above a second row of relation
          chips. The headline and the chips stated the SAME fact ("Working on 1
          · Wrote 2"), so the price of saying it twice was two stacked bands
          that pushed the drawing itself below the fold, on the one surface
          whose entire job is the drawing. The chips survive because they are
          the reading you can ACT on: each one is the filter for its relation.
          Everything here now floats over the canvas, so the graph starts
          directly under the tab strip and owns the whole body. */}
      <div className="sg-bar" data-testid="session-graph-bar">
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
              {choice}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="sg-btn sg-btn--tight"
          onClick={() => void load()}
          aria-busy={reading}
          aria-label="Refresh"
          title={
            /* The depth control lost its "hop" words to fit one bar, so the
               tooltip that survives has to carry what the row is counting. */
            `Re-read these connections · showing ${summary.entityCount} ${
              summary.entityCount === 1 ? 'entity' : 'entities'
            } within ${maxHop} ${maxHop === 1 ? 'hop' : 'hops'}`
          }
        >
          {reading ? '⋯' : '↻'}
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
          viewBox={`${placement.view.x} ${placement.view.y} ${placement.view.w} ${placement.view.h}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Graph of ${graph.cells.length} entities around this session`}
        >
          {/* Zoom pivots on the middle of what is DRAWN, not on the layout's
              ring centre: the two differ once the view is the tight box, and
              pivoting on the old centre walked the cards off-screen. */}
          <g
            transform={`translate(${pan.x} ${pan.y}) translate(${placement.view.x + placement.view.w / 2} ${placement.view.y + placement.view.h / 2}) scale(${zoom}) translate(${-(placement.view.x + placement.view.w / 2)} ${-(placement.view.y + placement.view.h / 2)})`}
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

            {placement.links.map((placed) => (
              <path
                key={placed.link.id}
                className="sg-link"
                data-relation={placed.link.type}
                d={`M ${placed.x1} ${placed.y1} Q ${placed.cx} ${placed.cy} ${placed.x2} ${placed.y2}`}
              />
            ))}

            {placement.cells.map((placed) => (
              <CellNode
                key={placed.cell.id}
                cell={placed.cell}
                x={placed.x}
                y={placed.y}
                selected={placed.cell.id === selectedId}
                onSelect={() => {
                  if (placed.cell.sort === 'fold') toggleFold(placed.cell.id);
                  else setSelectedId(placed.cell.id);
                }}
              />
            ))}
          </g>
        </svg>
      </div>

      {/* Both of these belong to the bottom edge and only one of them is
          always there, so they stack in one floating foot rather than each
          claiming `bottom: 0` and landing on the other. */}
      <div className="sg-foot-stack">
        {selected ? (
          <SelectionCard
            cell={selected}
            onOpen={onOpenEntity}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
        <GraphFooter graph={graph} result={result} summary={summary} hiddenCount={hidden.size} />
      </div>
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
  onSelect,
}: {
  cell: Cell;
  x: number;
  y: number;
  selected: boolean;
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
