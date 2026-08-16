/**
 * CHAT ENTITY GRAPH — FULLSCREEN (plan 01a0094b steps 4–6).
 *
 * OPENED BY THE ROUTE, not by local state (D2): the host maps `?graph=full`
 * to `open` and `onClose` navigates the param away, which is what buys
 * Back-to-close, reload-persistence and shareable links. FILTERS ride the
 * URL the same way (`?gf=`, step 5) through `onFiltersChange` — the host
 * re-encodes and navigates, so a filtered view is a link. Search alone is
 * transient local state (see graph-view.ts on why it never hits the URL).
 *
 * Follows the CommandPalette/PromptsOverlay overlay contract — rendered
 * INSIDE the shell subtree (theming and UI scale hang off `.cv2-root`;
 * nothing in this codebase mounts on document.body), Esc handled on the
 * container with `stopPropagation`, scrim mousedown dismiss that ignores
 * drags merely ENDING on the scrim. Esc clears the SELECTION first and
 * closes only from an unselected state (step 6).
 *
 * COUNTS STAY HONEST (commitment 4): the summary line names what is shown,
 * what filters hid, and what the draw cap kept off canvas; kind chips carry
 * their undrawn counts from the WHOLE fold; relation-type chips are scoped
 * to the edges actually read and the rail says so.
 *
 * PAN AND ZOOM are one SVG viewBox transform (step 4): wheel and `+`/`−`
 * zoom about the cursor/centre, drag pans, Fit restores the whole graph.
 * 0.25×–4× around fit. The wheel listener is attached natively with
 * `passive: false` — React 17+ delegates `onWheel` passively, so a JSX
 * handler could never `preventDefault` the page scroll behind the zoom.
 *
 * LAYOUT: the same first-seen grid (D4) at a column count derived ONCE per
 * mount from the viewport — constant within the mount, so settled cards
 * never move while the dialog is open (R9). A FILTER change re-layouts and
 * cards move — that is a user act, not stream churn (commitment 2).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { EntityId } from '@tm8/contract';
import { getKind } from '../domain';
import { humanize } from '../session-graph/model';
import type { ChatEntityRef } from './entity-refs';
import type { GraphSeedFold } from './graph-seeds';
import type { InducedGraph } from './induced-graph';
import {
  anyGraphFilterActive,
  applyGraphFilters,
  emptyGraphFilters,
  graphFacets,
  type GraphFilterState,
} from './graph-view';
import { InducedGraphCanvas } from './InducedGraphCanvas';
import { CARD_W, GAP_X, PAD, layoutInducedGraph } from './induced-layout';

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
/** Fullscreen column range: never narrower than inline, never absurd. */
const MIN_PER_ROW = 4;
const MAX_PER_ROW = 12;

export function perRowForViewport(viewportWidth: number): number {
  const fit = Math.floor((viewportWidth - 2 * PAD) / (CARD_W + GAP_X));
  return Math.min(MAX_PER_ROW, Math.max(MIN_PER_ROW, fit));
}

interface ViewTransform {
  /** Zoom about fit: 1 shows the whole placement. */
  z: number;
  /** Top-left of the visible window, placement units. */
  x: number;
  y: number;
}

const FIT: ViewTransform = { z: 1, x: 0, y: 0 };

export interface ChatEntityGraphFullscreenProps {
  /** The UNFILTERED induced graph over the drawn seeds. */
  graph: InducedGraph;
  /** The whole fold — facet counts include undrawn seeds (D3). */
  fold: GraphSeedFold;
  /** The inline caption, reused as the dialog's accessible name. */
  caption: string;
  /** URL-decoded filter state (`search` always arrives blank — transient). */
  filters: GraphFilterState;
  /** Chip/toggle changes, for the host to encode back into `?gf=` (D2). */
  onFiltersChange: (next: GraphFilterState) => void;
  late?: ReadonlyMap<string, ChatEntityRef> | undefined;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** Navigates `?graph=full` away — never merely local state (D2). */
  onClose: () => void;
}

export function ChatEntityGraphFullscreen({
  graph,
  fold,
  caption,
  filters,
  onFiltersChange,
  late,
  onOpenEntity,
  onClose,
}: ChatEntityGraphFullscreenProps) {
  /* Columns are settled ONCE per mount (R9 within the dialog's life). */
  const [perRow] = useState(() => perRowForViewport(window.innerWidth));
  const [railOpen, setRailOpen] = useState(true);
  /* Search is transient (graph-view.ts): local, gone when the dialog goes. */
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const facets = useMemo(() => graphFacets(fold, graph), [fold, graph]);
  const effective = useMemo<GraphFilterState>(() => ({ ...filters, search }), [filters, search]);
  const filtered = useMemo(() => applyGraphFilters(graph, effective), [graph, effective]);
  const placement = useMemo(
    () => layoutInducedGraph(filtered.graph, { perRow }),
    [filtered.graph, perRow],
  );

  /* A selection the filters removed is no selection (step 6). */
  useEffect(() => {
    if (selectedId && !filtered.graph.nodes.some((node) => node.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, filtered.graph]);

  const selected = selectedId
    ? (filtered.graph.nodes.find((node) => node.id === selectedId) ?? null)
    : null;

  const [view, setView] = useState<ViewTransform>(FIT);
  /** Zoom by `factor` about the fraction (fx, fy) of the visible window. */
  const zoomAbout = (factor: number, fx: number, fy: number) => {
    setView((prev) => {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.z * factor));
      if (z === prev.z) return prev;
      const w = placement.width;
      const h = placement.height;
      const ax = prev.x + fx * (w / prev.z);
      const ay = prev.y + fy * (h / prev.z);
      return { z, x: ax - fx * (w / z), y: ay - fy * (h / z) };
    });
  };

  const panelRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const downOnScrim = useRef(false);

  /* Focus in on mount so Esc and Tab land here, not the shell behind. */
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  /* Wheel zoom about the cursor — native non-passive, see the docblock. */
  useEffect(() => {
    const host = canvasRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      const fx = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
      const fy = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
      zoomAbout(Math.exp(-event.deltaY * 0.0015), fx, fy);
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement.width, placement.height]);

  /* Drag to pan. A drag under 4px stays a click, so cards keep selecting. */
  const drag = useRef<{ pointerId: number; lastX: number; lastY: number; moved: boolean } | null>(
    null,
  );
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, moved: false };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    const dx = event.clientX - d.lastX;
    const dy = event.clientY - d.lastY;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      /* Optional-called: jsdom has no pointer capture. */
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    d.lastX = event.clientX;
    d.lastY = event.clientY;
    const host = canvasRef.current;
    const rect = host?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    setView((prev) => ({
      ...prev,
      x: prev.x - dx * (placement.width / prev.z / rect.width),
      y: prev.y - dy * (placement.height / prev.z / rect.height),
    }));
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const suppressClick = useRef(false);
  const rememberSuppression = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.moved && drag.current.pointerId === event.pointerId) {
      suppressClick.current = true;
    }
  };
  const onClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    /* A pan that ended on a card must not select it. */
    if (suppressClick.current) {
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      /* Step 6: Esc clears the selection BEFORE it may close the dialog. */
      if (selectedId) setSelectedId(null);
      else onClose();
      return;
    }
    const typing = event.target instanceof HTMLInputElement;
    if (!typing && (event.key === '+' || event.key === '=')) {
      event.preventDefault();
      zoomAbout(1.25, 0.5, 0.5);
      return;
    }
    if (!typing && (event.key === '-' || event.key === '_')) {
      event.preventDefault();
      zoomAbout(0.8, 0.5, 0.5);
      return;
    }
    if (event.key !== 'Tab') return;
    /* FOCUS TRAP: cycle within the dialog. */
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = [
      ...panel.querySelectorAll<HTMLElement | SVGElement>(
        'button, [href], input, [tabindex]:not([tabindex="-1"])',
      ),
    ];
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      (first as HTMLElement).focus();
    } else if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      (last as HTMLElement).focus();
    }
  };

  /* Chip/toggle edits go to the HOST, which encodes them into `?gf=` (D2). */
  const toggleMember = (key: 'kinds' | 'edgeTypes', member: string) => {
    const current = filters[key];
    const next = new Set(current);
    if (next.has(member)) next.delete(member);
    else next.add(member);
    onFiltersChange({ ...filters, [key]: next });
  };
  const toggleFlag = (key: 'mutatedOnly' | 'hideIsolated' | 'hideUnread') => {
    onFiltersChange({ ...filters, [key]: !filters[key] });
  };
  const reset = () => {
    setSearch('');
    onFiltersChange(emptyGraphFilters());
  };

  const summary = [
    `Showing ${filtered.graph.nodes.length} of ${graph.nodes.length} drawn`,
    `${filtered.graph.relationCount} ${filtered.graph.relationCount === 1 ? 'relation' : 'relations'}`,
    ...(filtered.hiddenNodes > 0 ? [`${filtered.hiddenNodes} hidden by filter`] : []),
    ...(fold.overflow > 0 ? [`${fold.overflow} not drawn`] : []),
  ].join(' · ');

  const searchActive = search.trim() !== '';
  const anyFilter = anyGraphFilterActive(effective);
  const viewBox = `${view.x} ${view.y} ${placement.width / view.z} ${placement.height / view.z}`;

  return (
    <div
      className="ceg-full__scrim"
      ref={scrimRef}
      data-testid="chat-entity-graph-fullscreen"
      onMouseDown={(e) => {
        downOnScrim.current = e.target === scrimRef.current;
      }}
      onMouseUp={(e) => {
        if (downOnScrim.current && e.target === scrimRef.current) onClose();
        downOnScrim.current = false;
      }}
    >
      <div
        className="ceg-full"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Entity graph — ${caption}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="ceg-full__bar">
          <button
            type="button"
            className="ceg-full__btn"
            aria-expanded={railOpen}
            onClick={() => setRailOpen((value) => !value)}
          >
            Filters
          </button>
          <strong className="ceg-full__title">Entity graph</strong>
          <span className="ceg-full__caption" data-testid="ceg-full-summary">
            {summary}
          </span>
          <div className="ceg-full__controls" role="group" aria-label="Zoom">
            <button type="button" className="ceg-full__btn" aria-label="Zoom out" onClick={() => zoomAbout(0.8, 0.5, 0.5)}>
              −
            </button>
            <span className="ceg-full__zoom" aria-live="polite">{`${Math.round(view.z * 100)}%`}</span>
            <button type="button" className="ceg-full__btn" aria-label="Zoom in" onClick={() => zoomAbout(1.25, 0.5, 0.5)}>
              +
            </button>
            <button type="button" className="ceg-full__btn" onClick={() => setView(FIT)}>
              Fit
            </button>
          </div>
          <button type="button" className="ceg-full__btn ceg-full__close" aria-label="Close fullscreen graph" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="ceg-full__body">
          {railOpen ? (
            <aside className="ceg-full__rail" aria-label="Graph filters">
              <input
                type="search"
                className="ceg-full__search"
                placeholder="Search — highlights, never hides"
                aria-label="Search entities"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <fieldset className="ceg-full__facet">
                <legend>Kinds</legend>
                {facets.kinds.map((facet) => (
                  <label key={facet.kind} className="ceg-full__chip">
                    <input
                      type="checkbox"
                      checked={filters.kinds.has(facet.kind)}
                      onChange={() => toggleMember('kinds', facet.kind)}
                    />
                    <span>{`${getKind(facet.kind).labelPlural} ${facet.drawn}${
                      facet.undrawn > 0 ? ` (+${facet.undrawn} not drawn)` : ''
                    }`}</span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="ceg-full__facet">
                {/* Scoped honestly: relations exist only where edges were read. */}
                <legend>Relations (among edges read)</legend>
                {facets.edgeTypes.map((facet) => (
                  <label key={facet.type} className="ceg-full__chip">
                    <input
                      type="checkbox"
                      checked={filters.edgeTypes.has(facet.type)}
                      onChange={() => toggleMember('edgeTypes', facet.type)}
                    />
                    <span>{`${humanize(facet.type)} ${facet.count}`}</span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="ceg-full__facet">
                <legend>Show</legend>
                <label className="ceg-full__chip">
                  <input type="checkbox" checked={filters.mutatedOnly} onChange={() => toggleFlag('mutatedOnly')} />
                  <span>Edited here only</span>
                </label>
                <label className="ceg-full__chip">
                  <input type="checkbox" checked={filters.hideIsolated} onChange={() => toggleFlag('hideIsolated')} />
                  <span>Hide isolated</span>
                </label>
                <label className="ceg-full__chip">
                  <input type="checkbox" checked={filters.hideUnread} onChange={() => toggleFlag('hideUnread')} />
                  <span>Hide not-read</span>
                </label>
              </fieldset>
              {anyFilter ? (
                <button type="button" className="ceg-full__btn ceg-full__reset" onClick={reset}>
                  Reset
                </button>
              ) : null}
            </aside>
          ) : null}
          <div
            className="ceg-full__canvas"
            ref={canvasRef}
            data-testid="ceg-full-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUpCapture={rememberSuppression}
            onPointerUp={onPointerUp}
            onClickCapture={onClickCapture}
          >
            <InducedGraphCanvas
              placement={placement}
              ariaLabel={`Entity graph: ${caption}`}
              late={late}
              onOpenEntity={onOpenEntity}
              viewBox={viewBox}
              matches={searchActive ? filtered.matches : undefined}
              selectedId={selectedId}
              onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
            />
          </div>
          {selected ? (
            <aside className="ceg-full__detail" aria-label="Selected entity" data-testid="ceg-full-detail">
              <strong className="ceg-full__detail-title">
                {selected.resolvedTitle ? selected.title : (late?.get(selected.id)?.title ?? selected.title)}
              </strong>
              <span className="ceg-full__detail-kind">{getKind(selected.kind).label}</span>
              <dl className="ceg-full__detail-facts">
                <div>
                  <dt>Edges</dt>
                  <dd>
                    {selected.edgesRead
                      ? `${selected.degree}${selected.pageCapped ? '+' : ''} in the graph`
                      : 'not read'}
                  </dd>
                </div>
                <div>
                  <dt>In this conversation</dt>
                  <dd>{selected.mutated ? 'edited' : 'read'}</dd>
                </div>
              </dl>
              <ul className="ceg-full__detail-relations">
                {filtered.graph.edges
                  .filter((edge) => edge.a === selected.id || edge.b === selected.id)
                  .flatMap((edge) =>
                    edge.relations.map((relation) => {
                      const outbound = relation.from === selected.id;
                      const peerId = outbound ? relation.to : relation.from;
                      const peerNode = filtered.graph.nodes.find((node) => node.id === peerId);
                      const peer = peerNode?.title ?? late?.get(peerId)?.title ?? peerId;
                      return (
                        <li key={`${relation.type}:${relation.from}:${relation.to}`}>
                          {outbound ? `${relation.label} ⟶ ${peer}` : `⟵ ${relation.label} — ${peer}`}
                        </li>
                      );
                    }),
                  )}
              </ul>
              {onOpenEntity ? (
                <button
                  type="button"
                  className="ceg-full__btn"
                  onClick={() => onOpenEntity(selected.id as EntityId)}
                >
                  Open entity
                </button>
              ) : null}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}
