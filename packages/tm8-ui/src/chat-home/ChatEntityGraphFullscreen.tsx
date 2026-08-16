/**
 * CHAT ENTITY GRAPH — FULLSCREEN (plan 01a0094b step 4).
 *
 * OPENED BY THE ROUTE, not by local state (D2): the host maps `?graph=full`
 * to `open` and `onClose` navigates the param away, which is what buys
 * Back-to-close, reload-persistence and shareable links.
 *
 * Follows the CommandPalette/PromptsOverlay overlay contract — rendered
 * INSIDE the shell subtree (theming and UI scale hang off `.cv2-root`;
 * nothing in this codebase mounts on document.body), Esc handled on the
 * container with `stopPropagation`, scrim mousedown dismiss that ignores
 * drags merely ENDING on the scrim.
 *
 * PAN AND ZOOM are one SVG viewBox transform (step 4): wheel and `+`/`−`
 * zoom about the cursor/centre, drag pans, Fit restores the whole graph.
 * 0.25×–4× around fit. The wheel listener is attached natively with
 * `passive: false` — React 17+ delegates `onWheel` passively, so a JSX
 * handler could never `preventDefault` the page scroll behind the zoom.
 *
 * LAYOUT: the same first-seen grid (D4) at a column count derived ONCE per
 * mount from the viewport — constant within the mount, so settled cards
 * never move while the dialog is open (R9); a resize mid-dialog keeps the
 * mount's columns rather than reflowing settled cards.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { EntityId } from '@tm8/contract';
import type { ChatEntityRef } from './entity-refs';
import type { InducedGraph } from './induced-graph';
import { InducedGraphCanvas } from './InducedGraphCanvas';
import {
  CARD_W,
  GAP_X,
  PAD,
  layoutInducedGraph,
} from './induced-layout';

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
  graph: InducedGraph;
  /** The inline caption, reused as the dialog's accessible name. */
  caption: string;
  late?: ReadonlyMap<string, ChatEntityRef> | undefined;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** Navigates `?graph=full` away — never merely local state (D2). */
  onClose: () => void;
}

export function ChatEntityGraphFullscreen({
  graph,
  caption,
  late,
  onOpenEntity,
  onClose,
}: ChatEntityGraphFullscreenProps) {
  /* Columns are settled ONCE per mount (R9 within the dialog's life). */
  const [perRow] = useState(() => perRowForViewport(window.innerWidth));
  const placement = useMemo(() => layoutInducedGraph(graph, { perRow }), [graph, perRow]);

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

  /* Drag to pan. A drag under 4px stays a click, so cards keep opening. */
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
  const onClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    /* A pan that ended on a card must not open it. `moved` was cleared on
       pointerup, so remember it through the click via a one-shot flag. */
    if (suppressClick.current) {
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const rememberSuppression = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.moved && drag.current.pointerId === event.pointerId) {
      suppressClick.current = true;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomAbout(1.25, 0.5, 0.5);
      return;
    }
    if (event.key === '-' || event.key === '_') {
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
          <strong className="ceg-full__title">Entity graph</strong>
          <span className="ceg-full__caption">{caption}</span>
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
          />
        </div>
      </div>
    </div>
  );
}
