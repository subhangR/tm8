/**
 * BLUEPRINT CANVAS — draws a folded `graph` row (graphType 'entity') as a
 * flowchart: kind-shaped nodes, role-styled routed edges, swimlanes when the
 * view model has them.
 *
 * IT DRAWS; IT DOES NOT LAY OUT. Every coordinate, port, route, label slot,
 * rank and lane comes from the view model (`blueprint-types.ts`, folded by
 * Foundations' `blueprintView`). This file owns the camera, the emphasis
 * (selection, neighbourhood, find, diff marks) and the keyboard — never a
 * position. A layout decision made here would fork the one the Outline and
 * Table views read, and the three would disagree about the same plan.
 *
 * PRESCRIPTIVE, NOT DESCRIPTIVE: this is what SHOULD run. The one honesty
 * rule is existence — a SPEC is dashed and tagged so intent never passes as
 * fact (see `BlueprintNode`).
 *
 * THE CAMERA follows GRAPH.md's two rules, reused rather than re-derived:
 * the zoom the canvas CHOOSES for the reader is floored at legibility
 * (`FIT_FLOOR`), while ⤢ Fit, which the reader asks for, shows everything
 * however small; and below `LOD_FAR_BELOW` the canvas sheds what the scale
 * cannot carry (`data-lod="far"`).
 *
 * THE CANVAS CARRIES ITS OWN STYLES, defensively: the panel's blueprint block
 * mounts it outside the studio, and a component should not depend on an
 * unrelated screen's import graph for its CSS.
 */
import './craft.css';
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type PointerEvent,
} from 'react';
import type { EntityId } from '@tm8/contract';
import { Minimap } from '../graph/Minimap';
import type { BlueprintLane, BlueprintLine, BlueprintView } from './blueprint-types';
import { BlueprintNode, type NodeEmphasis } from './BlueprintNode';
import {
  boxOf, findCards, neighbourhood, pathMidpoint, readingOrder, stepSelection, type Box, type NavDirection,
} from './canvas-nav';
import { initials, legendRows, truncate } from './presentation';

/**
 * GRAPH.md §1: the opening zoom never goes below this (px per canvas unit).
 * Derived the same way GraphView derives its 0.72, from this canvas's own
 * type: the card title is 12.5px and must paint at ≥ 11px, so 11 / 12.5 ≈ 0.88.
 */
export const FIT_FLOOR = 0.88;
/**
 * …unless the WHOLE plan fits at this scale or better, in which case the
 * opening view shows all of it: a plan that nearly fits reads better whole
 * at 8.8px titles than clipped at 11px (coordinator review of #744).
 */
export const FIT_ACCEPT = 0.7;
/** GRAPH.md §1: below this the canvas drops hints and labels. Must stay < FIT_FLOOR. */
export const LOD_FAR_BELOW = 0.55;
const MIN_K = 0.2;
const MAX_K = 2.5;
/** Fit never magnifies past this — a three-node plan should not fill a wall. */
const FIT_CEIL = 1.15;
const ZOOM_STEP = 1.2;
const PAN_STEP = 80;
/**
 * What the overlays cover, in px: the find box across the top, the key and
 * the zoom cluster along the bottom. A fit that ignores them parks the first
 * lane's heading under the find box and the last row under the key.
 */
const INSET = { top: 52, bottom: 48, x: 16 };

interface Camera { x: number; y: number; k: number }
interface Size { w: number; h: number }

const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

export interface BlueprintCanvasProps {
  view: BlueprintView;
  ariaLabel: string;
  /** Id of an element describing the canvas and its text fallbacks (Outline, Table). */
  describedBy?: string | undefined;
  /** Controlled selection — a node key (card or attached assignee), or null. */
  selectedKey?: string | null | undefined;
  /** Present ⇒ cards select. Absent ⇒ a reference card opens its entity (the panel's read-only mount). */
  onSelect?: ((key: string | null) => void) | undefined;
  /** Enter / double-click on a selected node — the host's "look closer". */
  onActivate?: ((key: string) => void) | undefined;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** Nodes and lines the latest agent patch changed. */
  marked?: { cards: ReadonlySet<string>; lines: ReadonlySet<string> } | undefined;
  /** Full chrome (find, minimap, legend, focus). Off for the panel's inline block. */
  chrome?: boolean | undefined;
}

export function BlueprintCanvas({
  view,
  ariaLabel,
  describedBy,
  selectedKey = null,
  onSelect,
  onActivate,
  onOpenEntity,
  marked,
  chrome = true,
}: BlueprintCanvasProps) {
  const uid = useId().replace(/:/g, '');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [camera, setCamera] = useState<Camera | null>(null);
  /** True once the reader moved the camera — live patches then stop refitting it. */
  const touched = useRef(false);
  const [hoverLine, setHoverLine] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const drag = useRef<{ id: number; x: number; y: number; from: Camera; moved: boolean } | null>(null);
  const [panning, setPanning] = useState(false);

  /* Selection in a panel mount (no `onSelect`) is local; in the studio it is the host's. */
  const [localSel, setLocalSel] = useState<string | null>(null);
  const selected = onSelect ? selectedKey : localSel;
  const select = useCallback(
    (key: string | null) => {
      if (onSelect) onSelect(key);
      else setLocalSel(key);
    },
    [onSelect],
  );

  /* ---- measurement ------------------------------------------------------ */
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const read = () => {
      const rect = node.getBoundingClientRect();
      setSize((was) => (was.w === rect.width && was.h === rect.height ? was : { w: rect.width, h: rect.height }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const bounds = view.bounds;
  const usable = useMemo(
    () => ({
      w: Math.max(1, size.w - INSET.x * 2),
      h: Math.max(1, size.h - (chrome ? INSET.top + INSET.bottom : 24)),
      top: chrome ? INSET.top : 12,
    }),
    [size, chrome],
  );
  const fitK = useCallback(
    (box: Box) => (size.w > 0 && size.h > 0
      ? Math.min(usable.w / Math.max(box.width, 1), usable.h / Math.max(box.height, 1), FIT_CEIL)
      : 1),
    [size, usable],
  );

  /**
   * Fit a box. `floor` is the legibility floor: when fitting everything would
   * paint type too small to read, the camera holds the floor and starts at the
   * flow's BEGINNING (the box's left edge, vertically centred when it fits) —
   * a flowchart is read from its first stage, not from its middle.
   */
  const fitTo = useCallback(
    (box: Box, floor: number): Camera | null => {
      if (size.w <= 0 || size.h <= 0) return null;
      const k0 = fitK(box);
      const k = clampK(floor > 0 && k0 >= FIT_ACCEPT ? k0 : Math.max(k0, Math.min(floor, FIT_CEIL)));
      /* Solve in the USABLE band (between the overlays), then express the
         camera's corner in full-pane terms. */
      const viewW = usable.w / k;
      const viewH = usable.h / k;
      const left = box.width <= viewW ? box.minX + box.width / 2 - viewW / 2 : box.minX;
      const top = box.height <= viewH ? box.minY + box.height / 2 - viewH / 2 : box.minY;
      return { x: left - INSET.x / k, y: top - usable.top / k, k };
    },
    [fitK, size, usable],
  );

  /* The opening fit, and a refit whenever the drawing changes shape — unless
     the reader has taken the camera, which a live patch must never yank. */
  const boxKey = `${bounds.minX}:${bounds.minY}:${bounds.width}:${bounds.height}:${size.w}:${size.h}`;
  useEffect(() => {
    if (touched.current && camera) return;
    setCamera(fitTo(bounds, FIT_FLOOR));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxKey]);

  const move = useCallback((next: Camera | null) => {
    touched.current = true;
    setCamera(next);
  }, []);

  const zoomAbout = useCallback(
    (factor: number, at?: { x: number; y: number }) => {
      setCamera((current) => {
        if (!current || size.w <= 0) return current;
        const k = clampK(current.k * factor);
        if (k === current.k) return current;
        const anchor = at ?? { x: current.x + size.w / current.k / 2, y: current.y + size.h / current.k / 2 };
        touched.current = true;
        return {
          k,
          x: anchor.x - (anchor.x - current.x) * (current.k / k),
          y: anchor.y - (anchor.y - current.y) * (current.k / k),
        };
      });
    },
    [size],
  );

  const toCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect || !camera) return null;
      return { x: camera.x + (clientX - rect.left) / camera.k, y: camera.y + (clientY - rect.top) / camera.k };
    },
    [camera],
  );

  /* Wheel: pinch / ctrl-wheel zooms about the cursor; a plain wheel or a
     two-finger scroll PANS — the convention every design canvas uses, and
     the one that stops a trackpad scroll from lurching the zoom. Non-passive,
     because React registers `onWheel` passive and preventDefault there is
     ignored. */
  useEffect(() => {
    const node = svgRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const at = toCanvas(event.clientX, event.clientY);
        zoomAbout(Math.exp(-event.deltaY * 0.01), at ?? undefined);
        return;
      }
      setCamera((current) => {
        if (!current) return current;
        touched.current = true;
        return { ...current, x: current.x + event.deltaX / current.k, y: current.y + event.deltaY / current.k };
      });
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [toCanvas, zoomAbout]);

  /* ---- emphasis ------------------------------------------------------------ */
  const hood = useMemo(() => neighbourhood(view, selected), [view, selected]);
  const matches = useMemo(() => findCards(view, query), [view, query]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const focusActive = focusMode && selected !== null && hood.nodes.size > 0;

  const emphasisOf = (key: string): NodeEmphasis => {
    if (selected === key) return 'selected';
    if (selected === null) return 'none';
    if (hood.nodes.has(key)) return 'neighbour';
    return focusActive ? 'hidden' : 'dim';
  };

  /** Pan (not zoom) so a card is in view; a card already visible does not move the camera. */
  const reveal = useCallback(
    (key: string) => {
      const card = view.cards.find((c) => c.key === key);
      if (!card || !camera || size.w <= 0) return;
      const viewW = size.w / camera.k;
      const viewH = size.h / camera.k;
      const margin = 24 / camera.k;
      const inside = card.x >= camera.x + margin && card.y >= camera.y + margin
        && card.x + card.width <= camera.x + viewW - margin && card.y + card.height <= camera.y + viewH - margin;
      if (inside) return;
      move({ ...camera, x: card.x + card.width / 2 - viewW / 2, y: card.y + card.height / 2 - viewH / 2 });
    },
    [view, camera, size, move],
  );

  /* Focus mode fits the neighbourhood; leaving it fits everything again. */
  useEffect(() => {
    if (!focusActive) return;
    const box = boxOf(view, hood.nodes, 48);
    if (box) move(fitTo(box, 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusActive, selected]);

  const fitAll = useCallback(() => {
    setFocusMode(false);
    touched.current = false;
    setCamera(fitTo(bounds, 0));
  }, [bounds, fitTo]);

  const jumpToMatch = useCallback(
    (step: number) => {
      if (matches.length === 0) return;
      const next = (matchIndex + step + matches.length) % matches.length;
      setMatchIndex(next);
      const key = matches[next]!;
      select(key);
      reveal(key);
    },
    [matches, matchIndex, select, reveal],
  );

  /* ---- keyboard ------------------------------------------------------------ */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    const arrows: Record<string, NavDirection> = {
      ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    };
    const dir = arrows[event.key];
    if (dir) {
      event.preventDefault();
      if (event.shiftKey && camera) {
        const d = PAN_STEP / camera.k;
        move({
          ...camera,
          x: camera.x + (dir === 'left' ? -d : dir === 'right' ? d : 0),
          y: camera.y + (dir === 'up' ? -d : dir === 'down' ? d : 0),
        });
        return;
      }
      const next = stepSelection(view, selected, dir);
      if (next) {
        select(next);
        reveal(next);
        focusCard(next);
      }
      return;
    }
    switch (event.key) {
      case 'Enter':
        if (selected) {
          event.preventDefault();
          onActivate?.(selected);
        }
        return;
      case 'Escape':
        if (focusMode) {
          event.preventDefault();
          setFocusMode(false);
          fitAll();
        } else if (selected) {
          event.preventDefault();
          select(null);
        }
        return;
      case 'f':
      case '/':
        if (!chrome) return;
        event.preventDefault();
        findRef.current?.focus();
        return;
      case '.':
        if (!chrome || !selected) return;
        event.preventDefault();
        setFocusMode((on) => !on);
        return;
      case '0':
        event.preventDefault();
        fitAll();
        return;
      case '+':
      case '=':
        event.preventDefault();
        zoomAbout(ZOOM_STEP);
        return;
      case '-':
      case '_':
        event.preventDefault();
        zoomAbout(1 / ZOOM_STEP);
        return;
      default:
    }
  };

  const focusCard = (key: string) => {
    /* `CSS.escape` is absent in some DOMs (jsdom); keys are row-local ids,
       so escaping quotes and backslashes is the whole job there. */
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/["\\]/g, '\\$&');
    const el = svgRef.current?.querySelector<SVGGElement>(`[data-key="${escaped}"]`);
    el?.focus({ preventScroll: true });
  };

  /* ---- pan ------------------------------------------------------------------ */
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !camera) return;
    if ((event.target as Element).closest?.('.crf-node, .crf-avatar')) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, from: camera, moved: false };
    setPanning(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 3) return;
    start.moved = true;
    move({ k: start.from.k, x: start.from.x - dx / start.from.k, y: start.from.y - dy / start.from.k });
  };
  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    /* A press that did not move is a click on the empty canvas: deselect. */
    if (!start.moved && selected) select(null);
  };

  /* ---- render --------------------------------------------------------------- */
  const k = camera?.k ?? 1;
  const viewBox = camera && size.w > 0
    ? `${camera.x} ${camera.y} ${size.w / camera.k} ${size.h / camera.k}`
    : `${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`;
  const lod = camera && camera.k < LOD_FAR_BELOW ? 'far' : 'near';
  const everythingVisible = !camera || (
    bounds.minX >= camera.x - 1 && bounds.minY >= camera.y - 1
    && bounds.minX + bounds.width <= camera.x + size.w / camera.k + 1
    && bounds.minY + bounds.height <= camera.y + size.h / camera.k + 1
  );
  /* The clip is INTENTIONAL at the legible zoom — say so at the edge it
     happened on, with a fade and a nudge that pans toward the rest. */
  const viewRight = camera ? camera.x + size.w / camera.k : 0;
  const moreRight = !!camera && bounds.minX + bounds.width > viewRight + 8;
  const moreLeft = !!camera && bounds.minX < camera.x - 8;
  const nudge = (dir: 1 | -1) => {
    if (!camera) return;
    move({ ...camera, x: camera.x + dir * (size.w / camera.k) * 0.7 });
  };
  const firstKey = readingOrder(view)[0]?.key ?? null;
  const tabKey = selected && view.cards.some((c) => c.key === selected) ? selected : firstKey;

  const lineState = (line: BlueprintLine) => {
    if (hoverLine === line.key) return 'active';
    if (selected === null) return 'none';
    if (hood.lines.has(line.key)) return 'active';
    return focusActive ? 'hidden' : 'dim';
  };
  /* Active lines paint last, so a highlighted path is never under a dim one. */
  const orderedLines = [...view.lines].sort(
    (a, b) => Number(lineState(a) === 'active') - Number(lineState(b) === 'active'),
  );

  return (
    <div
      ref={rootRef}
      className="crf-viewport"
      data-testid="crf-viewport"
      data-lod={lod}
      data-focus={focusActive || undefined}
      data-selected={selected ?? undefined}
      tabIndex={0}
      role="group"
      aria-roledescription="blueprint canvas"
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      onKeyDown={onKeyDown}
    >
      <svg
        ref={svgRef}
        className="crf-svg"
        viewBox={viewBox}
        preserveAspectRatio="xMinYMin meet"
        data-testid="crf-canvas"
        data-panning={panning || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          {(['flow', 'dependency', 'context', 'unknown', 'back', 'active'] as const).map((name) => (
            <marker
              key={name}
              id={`${uid}-arrow-${name}`}
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={9}
              markerHeight={9}
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <path className={`crf-arrow crf-arrow--${name}`} d="M0 1 L10 5 L0 9 z" />
            </marker>
          ))}
        </defs>

        {view.lanes.map((lane, index) => (
          <Lane key={lane.key} lane={lane} index={index} onPress={onSelect ? select : undefined} />
        ))}

        <g className="crf-edges">
          {orderedLines.map((line) => {
            const state = lineState(line);
            return (
              <Edge
                key={line.key}
                line={line}
                uid={uid}
                state={state}
                marked={marked?.lines.has(line.key) ?? false}
                showFloatingLabel={state === 'active' && line.labelBox === null}
                onHover={setHoverLine}
              />
            );
          })}
        </g>

        <g className="crf-nodes">
          {view.cards.map((card) => (
            <BlueprintNode
              key={card.key}
              card={card}
              emphasis={emphasisOf(card.key)}
              marked={marked?.cards.has(card.key) ?? false}
              matched={matchSet.has(card.key)}
              tabbable={card.key === tabKey}
              onPress={(key) => {
                if (!onSelect && card.refId && onOpenEntity) {
                  onOpenEntity(card.refId as EntityId);
                  return;
                }
                select(selected === key && !onSelect ? null : key);
              }}
              onActivate={(key) => {
                if (onActivate) onActivate(key);
                else if (card.refId && onOpenEntity) onOpenEntity(card.refId as EntityId);
              }}
              onPressAssignee={onSelect ? (key) => select(key) : undefined}
            />
          ))}
        </g>
      </svg>

      {chrome ? (
        <div className="crf-find" role="search">
          <span className="crf-find__glyph" aria-hidden>⌕</span>
          <input
            ref={findRef}
            type="search"
            className="crf-find__input"
            data-testid="crf-find"
            placeholder="Find a node"
            aria-label="Find a node on the blueprint"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatchIndex(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                jumpToMatch(event.shiftKey ? -1 : 1);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setQuery('');
                rootRef.current?.focus();
              }
            }}
          />
          {query.trim() ? (
            <span className="crf-find__count" aria-live="polite" data-testid="crf-find-count">
              {matches.length === 0 ? 'none' : `${Math.max(0, matchIndex) + 1}/${matches.length}`}
            </span>
          ) : (
            <kbd className="crf-find__key" aria-hidden>f</kbd>
          )}
        </div>
      ) : null}

      {chrome && moreLeft ? (
        <button type="button" className="crf-more crf-more--left" data-testid="crf-more-left" aria-label="Show more of the plan to the left" onClick={() => nudge(-1)}>
          <span aria-hidden>‹</span>
        </button>
      ) : null}
      {chrome && moreRight ? (
        <button type="button" className="crf-more crf-more--right" data-testid="crf-more-right" aria-label="Show more of the plan to the right" onClick={() => nudge(1)}>
          <span className="crf-more__word">more</span>
          <span aria-hidden>›</span>
        </button>
      ) : null}

      {chrome ? <Legend /> : null}

      <div className="crf-nav" role="group" aria-label="Blueprint view controls">
        {chrome && selected ? (
          <button
            type="button"
            className="crf-nav__btn crf-nav__focus"
            data-testid="crf-focus"
            aria-pressed={focusActive}
            title="Focus: show only the selected node and its neighbours (.)"
            onClick={() => setFocusMode((on) => !on)}
          >
            {focusActive ? 'Show all' : 'Focus'}
          </button>
        ) : null}
        <button
          type="button"
          className="crf-nav__btn"
          data-testid="crf-zoom-out"
          aria-label="Zoom out"
          title="Zoom out (−)"
          disabled={k <= MIN_K}
          onClick={() => zoomAbout(1 / ZOOM_STEP)}
        >
          <span aria-hidden>−</span>
        </button>
        <span className="crf-nav__zoom" aria-hidden>{`${Math.round(k * 100)}%`}</span>
        <button
          type="button"
          className="crf-nav__btn"
          data-testid="crf-zoom-in"
          aria-label="Zoom in"
          title="Zoom in (+)"
          disabled={k >= MAX_K}
          onClick={() => zoomAbout(ZOOM_STEP)}
        >
          <span aria-hidden>＋</span>
        </button>
        <button
          type="button"
          className="crf-nav__btn crf-nav__fit"
          data-testid="crf-zoom-fit"
          aria-label="Fit the whole blueprint"
          title="Fit the whole blueprint (0)"
          disabled={everythingVisible && !focusActive}
          onClick={fitAll}
        >
          Fit
        </button>
      </div>

      {chrome && camera && !everythingVisible ? (
        <div className="crf-minimap" data-testid="crf-minimap">
          <Minimap
            width={bounds.width}
            height={bounds.height}
            nodes={view.cards.map((card) => ({
              id: card.key,
              x: card.x - bounds.minX,
              y: card.y - bounds.minY,
              w: card.width,
              h: card.height,
              tone: card.live ? 'live' : card.severity === 'error' ? 'blocked' : 'default',
            }))}
            viewport={{
              x: camera.x - bounds.minX,
              y: camera.y - bounds.minY,
              w: size.w / camera.k,
              h: size.h / camera.k,
            }}
            onJump={(cx, cy) => move({
              ...camera,
              x: bounds.minX + cx - size.w / camera.k / 2,
              y: bounds.minY + cy - size.h / camera.k / 2,
            })}
          />
        </div>
      ) : null}
    </div>
  );
}

function Edge({
  line,
  uid,
  state,
  marked,
  showFloatingLabel,
  onHover,
}: {
  line: BlueprintLine;
  uid: string;
  state: 'none' | 'active' | 'dim' | 'hidden';
  marked: boolean;
  showFloatingLabel: boolean;
  onHover: (key: string | null) => void;
}) {
  const style = line.back ? 'back' : line.role;
  const marker = state === 'active' ? 'active' : style;
  const d = line.path || polyline(line.points);
  const mid = showFloatingLabel ? pathMidpoint(line.points) : null;
  const tip = [line.sentence, line.note].filter(Boolean).join(' — ');
  return (
    <g
      className={['crf-edge', `crf-edge--${style}`, ...(marked ? ['crf-edge--marked'] : [])].join(' ')}
      data-state={state === 'none' ? undefined : state}
      data-testid="crf-edge"
      data-edge={line.key}
      onPointerEnter={() => onHover(line.key)}
      onPointerLeave={() => onHover(null)}
    >
      <title>{tip}</title>
      <path className="crf-edge__hit" d={d} />
      <path className="crf-edge__path" d={d} markerEnd={`url(#${uid}-arrow-${marker})`} />
      {line.labelBox ? (
        <g className="crf-edge__label">
          <rect
            x={line.labelBox.x}
            y={line.labelBox.y}
            width={line.labelBox.width}
            height={line.labelBox.height}
            rx={line.labelBox.height / 2}
          />
          <text
            x={line.labelBox.x + line.labelBox.width / 2}
            y={line.labelBox.y + line.labelBox.height / 2}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {line.label}
          </text>
        </g>
      ) : mid ? (
        <g className="crf-edge__label crf-edge__label--floating">
          <rect x={mid.x - line.label.length * 3 - 6} y={mid.y - 8} width={line.label.length * 6 + 12} height={16} rx={8} />
          <text x={mid.x} y={mid.y} textAnchor="middle" dominantBaseline="central">{line.label}</text>
        </g>
      ) : null}
    </g>
  );
}

function polyline(points: readonly { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
}

function Lane({
  lane,
  index,
  onPress,
}: {
  lane: BlueprintLane;
  index: number;
  onPress?: ((key: string) => void) | undefined;
}) {
  const { x, y, width, height } = lane.box;
  const assignee = lane.assignee;
  return (
    <g className="crf-lane" data-alt={index % 2 === 1 || undefined} data-testid="crf-lane">
      <rect className="crf-lane__band" x={x} y={y} width={width} height={height} rx={8} />
      <g
        className="crf-lane__head"
        transform={`translate(${x + 12} ${y + 16})`}
        onClick={assignee && onPress ? () => onPress(assignee.key) : undefined}
      >
        {assignee ? (
          <g className="crf-avatar" transform="translate(8 0)">
            <circle r={9} />
            <text textAnchor="middle" dominantBaseline="central">{initials(assignee.title)}</text>
          </g>
        ) : null}
        <text className="crf-lane__label" x={assignee ? 24 : 0} y={0} dominantBaseline="central">
          {truncate(lane.label, 32)}
        </text>
      </g>
    </g>
  );
}

/**
 * THE LEGEND, from the vocabulary: one chip per line role, drawn in the style
 * the canvas uses, its title listing the canonical labels it covers. One row,
 * so it never sits on top of the plan it explains. Assignment has no line —
 * it is the docked avatar, and says so.
 */
function Legend() {
  const rows = legendRows();
  return (
    <ul className="crf-legend" data-testid="crf-legend" aria-label="Key">
      {rows.map((row) => (
        <li key={row.role} className={`crf-legend__row crf-legend__row--${row.role}`} title={`${row.name}: ${row.labels.join(', ')}`}>
          <svg width={26} height={8} aria-hidden>
            <line x1={1} y1={4} x2={20} y2={4} />
            <path d="M19 1 L25 4 L19 7 z" />
          </svg>
          <span className="crf-legend__name">{row.name}</span>
          <span className="crf-sr">{row.labels.join(', ')}</span>
        </li>
      ))}
      <li className="crf-legend__row crf-legend__row--assignment" title="Assigned: the teammate's avatar docked on the task">
        <svg width={12} height={12} aria-hidden>
          <circle cx={6} cy={6} r={5} />
        </svg>
        <span className="crf-legend__name">Assigned</span>
      </li>
      <li className="crf-legend__row crf-legend__row--spec" title="Spec: dashed — not created yet">
        <svg width={20} height={12} aria-hidden>
          <rect x={1} y={1} width={18} height={10} rx={3} />
        </svg>
        <span className="crf-legend__name">Spec</span>
      </li>
    </ul>
  );
}
