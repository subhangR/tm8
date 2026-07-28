/**
 * GraphView — the ◉ Graph canvas (GRAPH-VIEW-PLAN §2 P1, prototype on fixture
 * data). Direction C's Structure lens: stable layered islands, realtime as a
 * restrained overlay.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EdgeView, EntityId, EntitySummary } from '@tm8/contract';
import { getKind, type StatusSource } from '../domain';
import type { SessionLiveness } from '../data/seam';
import { useDismissable } from '../panels/useDismissable';
import { Avatar, Chip, Eyebrow, IconBtn, Pill, type PillTone } from '../kit';
import {
  NODE_H,
  NODE_W,
  buildGraphModel,
  type GraphModel,
  type PlacedEdge,
  type PlacedNode,
} from './model';

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
}

const ZOOM_MIN = 0.35;
const ZOOM_MAX = 1.75;
const PAN_STEP = 80;

/**
 * StatusSource → the EntityState member it names (the chrome.tsx pattern —
 * keyed by SOURCE, never by kind; adding a kind touches neither).
 */
const STATUS_FIELD: Record<Exclude<StatusSource, 'none'>, string> = {
  workStatus: 'workStatus',
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

function timeAgo(iso: string, now: string): string {
  const mins = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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
  const { now, onSelect, livenessOf } = props;

  // Filters store the OFF sets, so kinds/types that appear later default ON.
  const [kindsOff, setKindsOff] = useState<ReadonlySet<string>>(new Set());
  const [typesOff, setTypesOff] = useState<ReadonlySet<string>>(new Set());

  // Timeline application — arrivals only ever ADD edges / touch activityAt.
  const [extraEdges, setExtraEdges] = useState<readonly EdgeView[]>([]);
  const [touched, setTouched] = useState<Readonly<Record<string, string>>>({});
  const [ticker, setTicker] = useState<readonly TickerEntry[]>([]);

  const [tf, setTf] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const [hoverId, setHoverId] = useState<EntityId | null>(null);
  const [flashId, setFlashId] = useState<EntityId | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fittedRef = useRef(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const effectiveNodes = useMemo(
    () => props.nodes.map((n) => (touched[n.id] ? { ...n, activityAt: touched[n.id] } : n)),
    [props.nodes, touched],
  );
  const allEdges = useMemo(() => [...props.edges, ...extraEdges], [props.edges, extraEdges]);

  const kindsPresent = useMemo(
    () => [...new Set(props.nodes.map((n) => n.kind))],
    [props.nodes],
  );
  const typesPresent = useMemo(() => [...new Set(allEdges.map((e) => e.type))], [allEdges]);

  const model: GraphModel = useMemo(
    () =>
      buildGraphModel({
        nodes: effectiveNodes,
        edges: allEdges as EdgeView[],
        kindFilter: kindsOff.size ? new Set(kindsPresent.filter((k) => !kindsOff.has(k))) : null,
        edgeTypeFilter: typesOff.size
          ? new Set(typesPresent.filter((t) => !typesOff.has(t)))
          : null,
        now,
      }),
    [effectiveNodes, allEdges, kindsOff, typesOff, kindsPresent, typesPresent, now],
  );

  const posById = useMemo(() => new Map(model.placed.map((p) => [p.entity.id, p])), [model]);

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
  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || model.width === 0) return;
    const rect = viewport.getBoundingClientRect();
    const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(rect.width / model.width, rect.height / model.height, 1)));
    setTf({
      x: (rect.width - model.width * k) / 2,
      y: Math.max(16, (rect.height - model.height * k) / 2),
      k,
    });
  }, [model.width, model.height]);

  useEffect(() => {
    if (fittedRef.current) return;
    if (model.placed.length === 0) return;
    fittedRef.current = true;
    fit();
  }, [fit, model.placed.length]);

  const panTo = useCallback(
    (id: EntityId) => {
      const node = posById.get(id);
      const viewport = viewportRef.current;
      if (!node || !viewport) return;
      const rect = viewport.getBoundingClientRect();
      setTf((prior) => ({
        ...prior,
        x: rect.width / 2 - (node.x + NODE_W / 2) * prior.k,
        y: rect.height / 2 - (node.y + NODE_H / 2) * prior.k,
      }));
      setFlashId(id);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashId(null), 1800);
    },
    [posById],
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
      // the hand grabbed nothing.
      if ((event.target as HTMLElement).closest('button')) return;
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

  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    setTf((prior) => {
      const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prior.k * Math.exp(-event.deltaY * 0.0016)));
      const ratio = k / prior.k;
      return { k, x: cx - (cx - prior.x) * ratio, y: cy - (cy - prior.y) * ratio };
    });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const viewport = viewportRef.current;
    const rect = viewport?.getBoundingClientRect();
    const cx = (rect?.width ?? 0) / 2;
    const cy = (rect?.height ?? 0) / 2;
    setTf((prior) => {
      const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prior.k * factor));
      const ratio = k / prior.k;
      return { k, x: cx - (cx - prior.x) * ratio, y: cy - (cy - prior.y) * ratio };
    });
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const pan = (dx: number, dy: number) =>
        setTf((prior) => ({ ...prior, x: prior.x + dx, y: prior.y + dy }));
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

  return (
    <div className="gv-root" data-testid="graph-view">
      <div className="gv-toolbar">
        <Eyebrow>Graph · fixture data</Eyebrow>
        <span className="gv-toolbar__count">
          {model.placed.length} nodes · {model.edges.length} edges · {model.componentCount}{' '}
          {model.componentCount === 1 ? 'island' : 'islands'}
        </span>
        <span className="gv-toolbar__spacer" />
        {/* USER RULING 2026-07-29 (live, brokered into the graph carve-out by
            the FE coordinator, dual attribution — graph seat's lane, disclosed
            at its next wake): per-kind and per-edge chips became two compact
            MULTI-SELECT dropdowns — with every kind and edge type inlined the
            toolbar wrapped to multiple rows and taxed the canvas. */}
        <FilterSelect
          label="Entities"
          options={kindsPresent.map((kind) => {
            const row = getKind(kind);
            return { id: kind, label: row.labelPlural, icon: row.icon as unknown as string };
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
        <div className="gv-toolbar__zoom">
          <IconBtn label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>−</IconBtn>
          <IconBtn label="Zoom in" onClick={() => zoomBy(1.2)}>+</IconBtn>
          <IconBtn label="Fit graph" onClick={fit}>⤢</IconBtn>
        </div>
      </div>

      {model.truncated > 0 && (
        <div className="gv-banner" role="status">
          Showing {model.placed.length} of {model.placed.length + model.truncated} — refine filters
          to see the rest. Nothing was dropped silently.
        </div>
      )}

      {nothingVisible ? (
        <div className="gv-empty">
          {filtered ? (
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
            <p className="gv-empty__title">The graph draws itself as work happens.</p>
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
          onKeyDown={onKeyDown}
        >
          <div
            className="gv-canvas"
            style={{
              width: model.width,
              height: model.height,
              transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.k})`,
            }}
          >
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
                const cls = [
                  'gv-edge',
                  e.blocked ? 'gv-edge--blocked' : '',
                  live ? 'gv-edge--live' : '',
                  dimmed ? 'gv-edge--dim' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <g key={e.id} className={cls}>
                    <path
                      d={d}
                      className="gv-edge__line"
                      markerEnd={`url(#${e.blocked ? 'gv-arrow-blocked' : 'gv-arrow'})`}
                    />
                    <text x={mid.x} y={mid.y} className="gv-edge__label" textAnchor="middle">
                      {e.label}
                    </text>
                  </g>
                );
              })}
            </svg>

            {model.placed.map((p) => {
              const liveness = livenessOf(p.entity.id);
              const pill = statusPill(p.entity);
              const row = getKind(p.entity.kind);
              const dimmed = neighborhood !== null && !neighborhood.has(p.entity.id);
              const cls = [
                'gv-node',
                `gv-node--${p.heat}`,
                p.onBlockedPath ? 'gv-node--blocked' : '',
                p.ghost ? 'gv-node--ghost' : '',
                dimmed ? 'gv-node--dim' : '',
                newIds.has(p.entity.id) ? 'gv-node--new' : '',
                flashId === p.entity.id ? 'gv-node--flash' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={p.entity.id}
                  type="button"
                  className={cls}
                  style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                  onClick={() => onSelect(p.entity.id)}
                  onMouseEnter={() => setHoverId(p.entity.id)}
                  onMouseLeave={() => setHoverId(null)}
                  onFocus={() => setHoverId(p.entity.id)}
                  onBlur={() => setHoverId(null)}
                >
                  <span className="gv-node__head">
                    <span className="gv-node__glyph" aria-hidden>
                      {row.icon}
                    </span>
                    <span className="gv-node__kind">{row.label}</span>
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
                  <span className="gv-node__foot">
                    <Avatar
                      provenance={p.entity.createdBy.isAgent ? 'agent' : 'human'}
                      label={p.entity.createdBy.displayName}
                      size={15}
                    />
                    <span className="gv-node__meta">{timeAgo(p.entity.activityAt, now)}</span>
                    {p.entity.counters.messages > 0 && (
                      <span className="gv-node__meta">✉ {p.entity.counters.messages}</span>
                    )}
                    {p.ghost && <span className="gv-node__meta gv-node__meta--ghost">deleted</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {model.shelf.length > 0 && (
        <div className="gv-shelf">
          <Eyebrow faint>Shelf · {model.shelf.length} unconnected</Eyebrow>
          <div className="gv-shelf__chips">
            {model.shelf.map((entity) => (
              <Chip
                key={entity.id}
                glyph={getKind(entity.kind).icon as string}
                title={`${entity.title} — no edges under the current filters`}
                onClick={() => onSelect(entity.id)}
              >
                {entity.title}
              </Chip>
            ))}
          </div>
        </div>
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
  );
}

/**
 * FilterSelect — a compact multi-select dropdown for the toolbar (user
 * ruling 2026-07-29): face shows `label · visible/total ▾`; the popover is a
 * checkbox list with a "show all" escape once anything is hidden. Esc and
 * outside-click dismiss (the panels' useDismissable, same behavior as every
 * popover in the app). All state stays the caller's off-set — this renders
 * and forwards, it decides nothing.
 */
function FilterSelect({
  label,
  options,
  offIds,
  onToggle,
  onShowAll,
}: {
  label: string;
  options: readonly { id: string; label: string; icon?: string }[];
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
        onClick={() => setOpen((o) => !o)}
      >
        {label} · {visible}/{options.length} <span aria-hidden>▾</span>
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
