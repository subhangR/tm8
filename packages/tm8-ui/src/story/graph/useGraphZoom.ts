/**
 * Zoom, pan and full screen for the story graph (issue #22: a 74-root story
 * could neither be enlarged nor seen whole).
 *
 * ZOOM IS THE SVG'S WIDTH, NOT A TRANSFORM. `kit/ZoomableFigure` transforms a
 * wrapper because it frames markup it cannot style; the graph is ours, and its
 * scroller is already what pans it, centres it on open and scrolls a picked
 * node into view. Writing an explicit width keeps all of that working
 * unchanged, and native scrolling stays the pan for touch and trackpad.
 *
 * At rest (`zoom === null`) nothing is written and the canvas sizes itself as
 * it always has. Plain wheel stays the page's; Ctrl/Cmd+wheel (which is also
 * what a trackpad pinch sends) and a two-finger touch pinch zoom about the
 * pointer. Keyboard +/-/0 take no modifier, so Ctrl/Cmd +/- stays the
 * browser's zoom.
 *
 * FULL SCREEN IS A CSS STATE on the same card (`.stg-card--max`), as the
 * artifact viewer and `ZoomableFigure` settled it: no reparenting, so the
 * page's popover and details keep working, and Escape exits.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react';

export const GRAPH_ZOOM_MIN = 0.2;
export const GRAPH_ZOOM_MAX = 4;
/** Per press of +/-. */
const ZOOM_STEP = 1.25;
/** Wheel→zoom rate, `ZoomableFigure`'s (and `graph/GraphView`'s). */
const WHEEL_ZOOM_RATE = 0.0016;
/** Pointer travel past which a press on the canvas is a pan, not a click. */
const CLICK_SLOP = 3;

export function clampGraphZoom(k: number): number {
  return Math.min(GRAPH_ZOOM_MAX, Math.max(GRAPH_ZOOM_MIN, k));
}

/** A drawing point (viewBox units) held under a point of the scroller (its CSS px) across a zoom. */
interface Anchor {
  px: number;
  py: number;
  sx: number;
  sy: number;
}

/**
 * Screen px per CSS px at this element. The app root carries a CSS `zoom`
 * (`styles/app.css`), and client rects are in screen px while widths and
 * scroll offsets are in CSS px, so every measurement goes through this.
 */
function pxPerCss(el: HTMLElement): number {
  const w = el.offsetWidth;
  return w > 0 ? el.getBoundingClientRect().width / w || 1 : 1;
}

export interface GraphZoom {
  /** null = at rest: the canvas sizes itself. Otherwise drawn px per viewBox unit. */
  zoom: number | null;
  /** The scale the canvas is drawn at right now, for the % readout. */
  shown: number;
  maximised: boolean;
  zoomBy: (factor: number) => void;
  /** Scale so the whole drawing fits the visible canvas. */
  fit: () => void;
  /** Back to rest. */
  reset: () => void;
  toggleMax: () => void;
  /** Spread on the scroller. */
  scrollerProps: {
    onKeyDown: (ev: KeyboardEvent<HTMLDivElement>) => void;
    onPointerDown: (ev: PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (ev: PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (ev: PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (ev: PointerEvent<HTMLDivElement>) => void;
    onClickCapture: (ev: MouseEvent<HTMLDivElement>) => void;
  };
}

/** `fill`: the card has a definite height (the full view), so fit can use it. */
export function useGraphZoom(scrollRef: RefObject<HTMLDivElement | null>, width: number, height: number, fill: boolean): GraphZoom {
  const [zoom, setZoom] = useState<number | null>(null);
  const [maximised, setMaximised] = useState(false);
  const [shown, setShown] = useState(1);
  const anchor = useRef<Anchor | null>(null);

  const svgOf = () => scrollRef.current?.querySelector<SVGSVGElement>(':scope > svg') ?? null;
  /** The scale actually drawn: at rest the browser decides it, so measure. */
  const current = useCallback((): number => {
    const el = scrollRef.current;
    const r = svgOf()?.getBoundingClientRect();
    return el && r && r.width > 0 && width > 0 ? r.width / pxPerCss(el) / width : 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  /*
   * Wheel and pinch can fire several times before React renders, so the
   * target scale and the anchored point are carried in refs until the layout
   * effect lands them; measuring the DOM again in between would read the old size.
   */
  const pending = useRef<number | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const el = scrollRef.current;
      const svg = svgOf();
      if (!el || !svg) return;
      const z = pxPerCss(el);
      const box = el.getBoundingClientRect();
      const px = clientX === undefined ? el.clientWidth / 2 : (clientX - box.left) / z;
      const py = clientY === undefined ? el.clientHeight / 2 : (clientY - box.top) / z;
      const from = pending.current ?? zoomRef.current ?? current();
      const next = clampGraphZoom(from * factor);
      if (next === from) return;
      if (anchor.current) anchor.current = { ...anchor.current, px, py };
      else {
        const k = zoomRef.current ?? current();
        const r = svg.getBoundingClientRect();
        anchor.current = { px, py, sx: (px - (r.left - box.left) / z) / k, sy: (py - (r.top - box.top) / z) / k };
      }
      pending.current = next;
      setZoom(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current],
  );

  /* After a zoom renders, scroll so the anchored drawing point is back under the pointer. */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const svg = svgOf();
    const a = anchor.current;
    anchor.current = null;
    pending.current = null;
    if (el && svg && a && zoom !== null) {
      const z = pxPerCss(el);
      const box = el.getBoundingClientRect();
      const r = svg.getBoundingClientRect();
      el.scrollLeft += (r.left - box.left) / z + a.sx * zoom - a.px;
      el.scrollTop += (r.top - box.top) / z + a.sy * zoom - a.py;
    }
    setShown(current());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, maximised, width, current]);

  /* At rest the drawn scale follows the box: keep the readout honest as it resizes. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setShown(current()));
    ro.observe(el);
    const svg = svgOf();
    if (svg) ro.observe(svg);
    return () => ro.disconnect();
  }, [scrollRef, current]);

  const fit = useCallback(() => {
    const el = scrollRef.current;
    if (!el || width <= 0 || height <= 0) return;
    /* Inline the card's height follows the drawing, so only the width can be fitted. */
    const k = maximised || fill ? Math.min(el.clientWidth / width, el.clientHeight / height) : el.clientWidth / width;
    setZoom(clampGraphZoom(k));
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }, [scrollRef, width, height, maximised, fill]);

  const reset = useCallback(() => setZoom(null), []);
  const zoomBy = useCallback((factor: number) => zoomAt(factor), [zoomAt]);
  const toggleMax = useCallback(() => setMaximised((was) => !was), []);

  /* Escape leaves full screen. On window: after pressing the button, focus is on it, not the canvas. */
  useEffect(() => {
    if (!maximised) return undefined;
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === 'Escape' && !ev.defaultPrevented) setMaximised(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximised]);

  /* Ctrl/Cmd+wheel and two-finger pinch: native and non-passive, since React's root wheel/touch listeners are passive. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      zoomAt(Math.exp(-ev.deltaY * WHEEL_ZOOM_RATE), ev.clientX, ev.clientY);
    };
    let spread = 0;
    const span = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
    const onTouchStart = (ev: TouchEvent) => {
      if (ev.touches.length === 2) spread = span(ev.touches);
    };
    const onTouchMove = (ev: TouchEvent) => {
      if (ev.touches.length !== 2 || spread <= 0) return;
      ev.preventDefault();
      const next = span(ev.touches);
      if (next <= 0) return;
      zoomAt(next / spread, (ev.touches[0]!.clientX + ev.touches[1]!.clientX) / 2, (ev.touches[0]!.clientY + ev.touches[1]!.clientY) / 2);
      spread = next;
    };
    const onTouchEnd = (ev: TouchEvent) => {
      if (ev.touches.length < 2) spread = 0;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [scrollRef, zoomAt]);

  /* Mouse drag on the empty canvas pans (touch already scrolls natively). A press on a node stays the node's. */
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const panned = useRef(false);
  const onPointerDown = (ev: PointerEvent<HTMLDivElement>) => {
    panned.current = false;
    const el = ev.currentTarget;
    if (ev.pointerType !== 'mouse' || ev.button !== 0) return;
    if ((ev.target as Element).closest?.('.stg-n, button, a, [role="button"]')) return;
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
    drag.current = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
  };
  const onPointerMove = (ev: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== ev.pointerId) return;
    const dx = ev.clientX - d.x;
    const dy = ev.clientY - d.y;
    if (!d.moved && Math.abs(dx) <= CLICK_SLOP && Math.abs(dy) <= CLICK_SLOP) return;
    if (!d.moved) {
      d.moved = true;
      ev.currentTarget.setPointerCapture?.(ev.pointerId);
      ev.currentTarget.classList.add('stg-scroll--panning');
    }
    ev.currentTarget.scrollLeft = d.left - dx;
    ev.currentTarget.scrollTop = d.top - dy;
  };
  const onPointerEnd = (ev: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== ev.pointerId) return;
    panned.current = drag.current.moved;
    drag.current = null;
    ev.currentTarget.classList.remove('stg-scroll--panning');
  };
  /* A drag that panned must not also click whatever it was released over. */
  const onClickCapture = (ev: MouseEvent<HTMLDivElement>) => {
    if (!panned.current) return;
    panned.current = false;
    ev.preventDefault();
    ev.stopPropagation();
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === '+' || ev.key === '=') zoomAt(ZOOM_STEP);
    else if (ev.key === '-' || ev.key === '_') zoomAt(1 / ZOOM_STEP);
    else if (ev.key === '0') setZoom(null);
    else return;
    ev.preventDefault();
  };

  return {
    zoom,
    shown,
    maximised,
    zoomBy,
    fit,
    reset,
    toggleMax,
    scrollerProps: { onKeyDown, onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd, onClickCapture },
  };
}
