import { forwardRef, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { IconBtn } from './IconBtn';
import { VectorIcon } from './VectorIcon';
import './zoomable-figure.css';

/**
 * ZOOMABLE FIGURE — the escape hatch for a drawing that is bigger than the
 * column it was rendered into.
 *
 * WHAT IT IS FOR. `kit/markdown.css` argues, correctly, that a shrunk flowchart
 * with unreadable labels is worse than one you pan, and so a diagram scrolls
 * sideways in a doc column rather than being scaled to fit. That reasoning is
 * kept verbatim — it is right about the RESTING state. What it never gave the
 * reader was a way out of the column for a genuinely big graph, which in a chat
 * lane is most of them. This is that way out, and it is deliberately a SHELL
 * around any svg-bearing child rather than a mermaid feature: the chat
 * `explain_graph` card had the same squeeze in its own stylesheet
 * (`.tch-xgraph__stage` + a 620px `min-width` inside a chat lane), and two
 * one-off implementations of expand/zoom/pan would be two keyboard contracts,
 * two sets of controls and two things to fix.
 *
 * SIX THINGS THIS FILE IS CAREFUL ABOUT:
 *
 * 1. THE CONTROLS LIVE OUTSIDE THE CHILD'S SUBTREE, AND THAT IS A TRUST
 *    BOUNDARY, NOT A LAYOUT CHOICE. The first caller injects mermaid's output
 *    through `dangerouslySetInnerHTML` — viewer-authored markup rendered in
 *    other members' browsers, which is exactly why `kit/Mermaid` pins
 *    `securityLevel: 'strict'`. So no handler this component owns is ever
 *    attached inside `children`: the buttons are SIBLINGS of the viewport, and
 *    the pointer/wheel/key handlers sit on the viewport and canvas — elements
 *    this file constructs — with the untrusted subtree strictly below them as
 *    inert content. Nothing here needs the security level lowered, and nothing
 *    here should ever be a reason to lower it.
 *
 * 2. EXPANDED IS A CSS STATE, NOT THE BROWSER FULLSCREEN API. The artifact
 *    viewer settled this one (`panels/bodies/GenericBody`, `panels.css` →
 *    `.pn-preview--fullscreen`): `position: fixed; inset: 0; z-index: 60` on
 *    the SAME element, Escape to exit, and the exit button riding along. Same
 *    element matters twice. There, it stops the preview iframe reloading; here,
 *    it stops the mermaid SVG re-rendering — `requestFullscreen` reparents into
 *    a top-layer element, and a remount would cost a fresh ~800KB mermaid
 *    render and lose the reader's zoom. It also keeps us inside the app's own
 *    stacking and theming instead of the UA's fullscreen backdrop, and it works
 *    in an iframe with no `allow-fullscreen`. The one thing the real API buys —
 *    hiding browser chrome — is not worth any of that for a figure.
 *
 *    The element leaves document flow while expanded, so the doc reflows behind
 *    the overlay. That is invisible (the overlay covers it) and exactly
 *    reversible on exit, which is the trade `position: fixed` always makes.
 *
 * 3. ZOOM IS A TRANSFORM ON A WRAPPER, NOT AN ATTRIBUTE ON THE SVG. The canvas
 *    div carries `translate(x, y) scale(k)`; the child is untouched. It stays
 *    crisp because it is vector, it costs no re-render, and — the reason it
 *    beats every CSS approach — an SVG mermaid emits carries its own INLINE
 *    `max-width`, which no stylesheet rule of ours can outrank. A transform on
 *    the ancestor is not in that fight at all.
 *
 * 4. WHEEL DOES NOT STEAL THE PAGE'S SCROLL. A figure that swallows every wheel
 *    event is the thing readers hate about embedded maps: the cursor crosses a
 *    diagram mid-scroll and the page stops. So plain wheel is left to the page,
 *    and zoom takes the wheel only when there is nothing behind to scroll
 *    (expanded) or when the reader asks with a modifier. Ctrl/Cmd is the right
 *    modifier for free: a trackpad pinch IS a ctrl+wheel event, so laptop
 *    pinch-to-zoom works without a gesture library. The listener is attached
 *    natively with `{ passive: false }` rather than through React's `onWheel`,
 *    because React registers wheel at the root as passive and `preventDefault`
 *    there is a no-op with a console warning.
 *
 * 5. AT REST IT IS BYTE-FOR-BYTE THE OLD BEHAVIOUR. No transform is written
 *    while the figure sits at fit, the viewport keeps `overflow: auto`, and the
 *    host's own frame styles it as before — a reader who never touches a control
 *    sees the doc column exactly as it shipped. Only once the figure is zoomed
 *    or expanded does this component take over scrolling and pointer gestures.
 *    Panning is likewise only armed past fit: at fit there is nothing to pan to,
 *    and arming a drag would break text selection over the diagram.
 *
 * 6. THE BUTTONS ARE THE ACCESSIBLE CONTRACT; THE KEYS ARE AN ACCELERATOR. The
 *    controls are revealed on hover AND on `:focus-within` and are never
 *    `display: none`, so they stay in the tab order and a keyboard reader can
 *    Tab into them — hover-only chrome is unreachable by keyboard and invisible
 *    on touch, where there is no hover at all (the stylesheet pins them visible
 *    under `@media (hover: none)` for exactly that). Unlike `graph/GraphView`
 *    this does NOT claim `role="application"`: that is right for a canvas that
 *    IS the screen and wrong for a figure inside prose, where it would take the
 *    virtual cursor away from a reader who only wants to read the diagram.
 */

/**
 * The zoom clamp. Deliberately NOT `graph/GraphView`'s 0.35–1.75: that canvas
 * is laid out at full size and mostly needs to zoom OUT to fit, while a figure
 * starts life squeezed into a column and needs to magnify hard — which is the
 * complaint this component answers. Below fit is nearly useless for a figure,
 * so the floor sits just under 1.
 */
export const FIGURE_ZOOM_MIN = 0.5;
export const FIGURE_ZOOM_MAX = 6;

/** Per-press and per-keystroke zoom factor. */
const ZOOM_STEP = 1.3;
/** Double-click zoom, matching GraphView's discrete step. */
const DOUBLE_CLICK_STEP = 1.5;
/** Wheel→zoom rate, lifted verbatim from `graph/GraphView`'s `onWheel`. */
const WHEEL_ZOOM_RATE = 0.0016;
/** Arrow-key pan, in unscaled px. */
const PAN_STEP = 48;
/** Pointer travel past which a press is a pan, not a click on the child. */
const CLICK_SLOP = 3;

/** `translate(0,0) scale(1)` — the resting state, and what "fit" resets to. */
const IDENTITY: Transform = { x: 0, y: 0, k: 1 };

interface Transform {
  x: number;
  y: number;
  k: number;
}

/** Exported for the guard test: no control may drive `k` outside the clamp. */
export function clampFigureZoom(k: number): number {
  return Math.min(FIGURE_ZOOM_MAX, Math.max(FIGURE_ZOOM_MIN, k));
}

/* 16×16 geometry, per `kit/VectorIcon`: a path in a square viewBox centres
   exactly in every font, where a text character sits on its own baseline. */
const ICON_ZOOM_IN = ['M8 3.5 V12.5', 'M3.5 8 H12.5'];
const ICON_ZOOM_OUT = ['M3.5 8 H12.5'];
const ICON_FIT = ['M2.5 2.5 H13.5 V13.5 H2.5 Z', 'M6 6 H10 V10 H6 Z'];
const ICON_EXPAND = ['M9.5 2.5 H13.5 V6.5', 'M13.5 2.5 L9.5 6.5', 'M6.5 13.5 H2.5 V9.5', 'M2.5 13.5 L6.5 9.5'];
const ICON_COLLAPSE = ['M13.5 6.5 H9.5 V2.5', 'M9.5 6.5 L13.5 2.5', 'M2.5 9.5 H6.5 V13.5', 'M6.5 9.5 L2.5 13.5'];

export interface ZoomableFigureProps {
  /**
   * The drawing. Treated as INERT CONTENT — see §1. It may be markup this
   * package did not construct.
   */
  children: ReactNode;
  /** What the figure is, for the controls' accessible names. e.g. "Diagram". */
  label: string;
  /** The host's own frame class (`md-mermaid`, `tch-xgraph__stage`, …). */
  className?: string;
  testId?: string;
  /** Extra `data-*` the host's own state or tests read off the root. */
  dataAttrs?: Record<`data-${string}`, string>;
}

export const ZoomableFigure = forwardRef<HTMLDivElement, ZoomableFigureProps>(function ZoomableFigure(
  { children, label, className, testId = 'zoomable-figure', dataAttrs },
  ref,
) {
  const [expanded, setExpanded] = useState(false);
  const [tf, setTf] = useState<Transform>(IDENTITY);
  const viewportRef = useRef<HTMLDivElement>(null);

  /**
   * Whether THIS component owns scrolling and pointer gestures. False is the
   * resting state and means the host's frame behaves exactly as it did before
   * this component existed — see §5.
   */
  const interactive = expanded || tf.k !== 1 || tf.x !== 0 || tf.y !== 0;

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    const el = viewportRef.current;
    setTf((prior) => {
      /**
       * The first zoom ABSORBS any native scroll offset into the transform. At
       * rest the viewport is a real scroll container (that is the doc-column
       * behaviour being preserved), so a reader may have already panned
       * sideways; the moment we switch to `overflow: hidden` that offset would
       * vanish and the diagram would jump by exactly the amount they scrolled.
       */
      const base =
        prior.k === 1 && prior.x === 0 && prior.y === 0 && el
          ? { k: 1, x: -el.scrollLeft, y: -el.scrollTop }
          : prior;
      const k = clampFigureZoom(base.k * factor);
      const ratio = k / base.k;
      // Zoom toward the given point, from graph/GraphView's onWheel.
      return { k, x: cx - (cx - base.x) * ratio, y: cy - (cy - base.y) * ratio };
    });
  }, []);

  /** Zoom about the viewport's centre — what the +/- buttons and keys use. */
  const zoomByStep = useCallback(
    (factor: number) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      zoomAt((rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2, factor);
    },
    [zoomAt],
  );

  const fit = useCallback(() => {
    setTf(IDENTITY);
    const el = viewportRef.current;
    if (el) {
      el.scrollLeft = 0;
      el.scrollTop = 0;
    }
  }, []);

  /**
   * Escape exits, per the artifact viewer (§2). On `window`, not the viewport:
   * pressing a control leaves focus on a button, and a reader who expanded with
   * the mouse has focus nowhere near the figure at all.
   */
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  /** Native, non-passive, and conditional — see §4 for all three. */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!expanded && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(
        event.clientX - rect.left,
        event.clientY - rect.top,
        Math.exp(-event.deltaY * WHEEL_ZOOM_RATE),
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [expanded, zoomAt]);

  /* --- pointer: drag to pan, two fingers to pinch -------------------------- */

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchDist = useRef<number | null>(null);
  const drag = useRef<{ startX: number; startY: number; tx: number; ty: number; moved: boolean } | null>(null);
  /** Set by a pan that actually moved, so the click it emits can be swallowed. */
  const panned = useRef(false);

  const spread = (): number => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    panned.current = false;
    if (!interactive) return;
    /* A press on something the CHILD made interactive stays the child's — the
       chat graph card's nodes are role=button, and a pan must not eat them. */
    if ((event.target as HTMLElement).closest?.('button, a, [role="button"]')) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      drag.current = null;
      pinchDist.current = spread();
      return;
    }
    if (pointers.current.size > 1) return;
    drag.current = { startX: event.clientX, startY: event.clientY, tx: tf.x, ty: tf.y, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size === 2 && pinchDist.current !== null) {
      const dist = spread();
      if (dist > 0 && pinchDist.current > 0) {
        const [a, b] = [...pointers.current.values()];
        const rect = viewportRef.current?.getBoundingClientRect();
        if (a && b) {
          zoomAt(
            (a.x + b.x) / 2 - (rect?.left ?? 0),
            (a.y + b.y) / 2 - (rect?.top ?? 0),
            dist / pinchDist.current,
          );
        }
        pinchDist.current = dist;
      }
      return;
    }

    const d = drag.current;
    if (!d) return;
    const dx = event.clientX - d.startX;
    const dy = event.clientY - d.startY;
    if (Math.abs(dx) > CLICK_SLOP || Math.abs(dy) > CLICK_SLOP) d.moved = true;
    setTf((prior) => ({ ...prior, x: d.tx + dx, y: d.ty + dy }));
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchDist.current = null;
    if (pointers.current.size === 0) {
      panned.current = drag.current?.moved ?? false;
      drag.current = null;
    }
  };

  /**
   * A pan that crossed the slop must not also open whatever it finished on top
   * of — releasing a drag over a graph node would otherwise navigate.
   */
  const onClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!panned.current) return;
    panned.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  /**
   * Double-click zooms toward the cursor (shift → out), reusing the wheel's
   * maths. EXPANDED ONLY: inline, double-click is how a reader selects a word,
   * and taking that over inside a document would be a worse bug than the one
   * this component fixes.
   */
  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!expanded) return;
    if ((event.target as HTMLElement).closest?.('button, a, [role="button"]')) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    zoomAt(
      event.clientX - (rect?.left ?? 0),
      event.clientY - (rect?.top ?? 0),
      event.shiftKey ? 1 / DOUBLE_CLICK_STEP : DOUBLE_CLICK_STEP,
    );
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const pan = (dx: number, dy: number) => setTf((prior) => ({ ...prior, x: prior.x + dx, y: prior.y + dy }));
    switch (event.key) {
      case '+':
      case '=':
        zoomByStep(ZOOM_STEP);
        break;
      case '-':
      case '_':
        zoomByStep(1 / ZOOM_STEP);
        break;
      case '0':
        fit();
        break;
      /* Arrows pan only once there is somewhere to pan TO. At rest they are the
         browser's, so the viewport still scrolls like the scroll container it
         is — and so a reader tabbing through a doc is not trapped in a figure. */
      case 'ArrowUp':
        if (!interactive) return;
        pan(0, PAN_STEP);
        break;
      case 'ArrowDown':
        if (!interactive) return;
        pan(0, -PAN_STEP);
        break;
      case 'ArrowLeft':
        if (!interactive) return;
        pan(PAN_STEP, 0);
        break;
      case 'ArrowRight':
        if (!interactive) return;
        pan(-PAN_STEP, 0);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const rootClass = [
    'kit-zfig',
    expanded ? 'kit-zfig--expanded' : null,
    className ?? null,
  ]
    .filter((c): c is string => c !== null)
    .join(' ');

  return (
    <div
      ref={ref}
      className={rootClass}
      data-testid={testId}
      data-expanded={expanded ? 'true' : 'false'}
      data-interactive={interactive ? 'true' : 'false'}
      {...dataAttrs}
    >
      <div
        className="kit-zfig__viewport"
        ref={viewportRef}
        tabIndex={0}
        role="group"
        aria-label={`${label}. Plus and minus zoom, zero fits${expanded ? ', Escape exits full screen' : ''}.`}
        data-testid={`${testId}-viewport`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={onClickCapture}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
      >
        {/* The transform is written ONLY once it is not the identity — see §5.
            The untrusted child hangs below here as inert content, with every
            handler above it on elements this file made (§1). */}
        <div
          className="kit-zfig__canvas"
          data-testid={`${testId}-canvas`}
          style={interactive ? { transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.k})` } : undefined}
        >
          {children}
        </div>
      </div>
      <div className="kit-zfig__controls" role="group" aria-label={`${label} view controls`}>
        <IconBtn label="Zoom in" onClick={() => zoomByStep(ZOOM_STEP)}>
          <VectorIcon paths={ICON_ZOOM_IN} size={13} />
        </IconBtn>
        <IconBtn label="Zoom out" onClick={() => zoomByStep(1 / ZOOM_STEP)}>
          <VectorIcon paths={ICON_ZOOM_OUT} size={13} />
        </IconBtn>
        <IconBtn label="Reset to fit" onClick={fit}>
          <VectorIcon paths={ICON_FIT} size={13} />
        </IconBtn>
        {/* A toggle, so `aria-pressed` carries the state — and the NAME changes
            too, because that is what a mouse reader reads off the tooltip. */}
        <IconBtn
          label={expanded ? 'Exit full screen' : 'Expand to full screen'}
          pressed={expanded}
          onClick={() => setExpanded((was) => !was)}
        >
          <VectorIcon paths={expanded ? ICON_COLLAPSE : ICON_EXPAND} size={13} />
        </IconBtn>
      </div>
    </div>
  );
});
