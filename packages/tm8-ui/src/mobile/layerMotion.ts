/**
 * LAYER MOTION — the drawer's exit, swipe-to-close (audit C4) and the sheet's
 * drag-to-dismiss (audit D1). Task t-layers, 2026-10-18.
 *
 * Two rules hold for all of it:
 *
 *   - MOTION IS AN ENHANCEMENT. Under `prefers-reduced-motion: reduce` a layer
 *     still opens and closes and still follows the finger; it only stops
 *     travelling on its own. Without `matchMedia` (jsdom) there is no motion.
 *   - CLOSE GESTURES ONLY. There is no edge-swipe to OPEN the drawer: the left
 *     edge is Android's back gesture, and a drawer that grabbed it would fight
 *     the one gesture CONTRACT §5 says we never fight.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';

/** The exit runs on `--pn-dur-base` (180ms); a frame of slack before unmount. */
export const LAYER_EXIT_MS = 200;

export function layerMotionAllowed(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Keep a layer mounted through its exit.
 *
 * `mounted` stays true for `LAYER_EXIT_MS` after `open` goes false, with
 * `closing` true for that window, so the layer can play its exit instead of
 * vanishing. With motion off it unmounts in the same render, as before.
 */
export function usePresence(open: boolean): { mounted: boolean; closing: boolean } {
  const [prevOpen, setPrevOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setClosing(!open && layerMotionAllowed());
  }
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => setClosing(false), LAYER_EXIT_MS);
    return () => clearTimeout(timer);
  }, [closing]);
  return { mounted: open || closing, closing };
}

export interface DragDismissOptions {
  /** Which way closes: the drawer leaves to the left, a sheet downwards. */
  readonly direction: 'left' | 'down';
  /** Where the drag may start, inside the panel. Absent ⇒ the whole panel. */
  readonly handle?: string;
  /** Starts on a button/link are allowed (the drawer is all rows). */
  readonly fromControls?: boolean;
  /**
   * Called once a release commits to closing, with the panel still where the
   * finger left it (`transform` set) and the offset (px, signed) — so the
   * caller can run the rest of the exit from there instead of from the start.
   */
  readonly onDismiss: (offset: number, panel: HTMLElement) => void;
  readonly enabled?: boolean;
}

/** Movement before the gesture picks an axis. */
const SLOP = 10;
/** Fraction of the panel past which a release closes. */
const DISTANCE = 0.3;
/** Or a flick this fast (px/ms) in the closing direction. */
const VELOCITY = 0.5;

/**
 * Follow a finger dragging a panel closed, and close it past the threshold.
 *
 * Writes `transform` on the panel while dragging, `data-dragging` on it so the
 * stylesheet can drop transitions, and the scrim's opacity on the panel's
 * parent. On a release short of the threshold the panel springs back.
 */
export function useDragDismiss(panelRef: RefObject<HTMLElement | null>, options: DragDismissOptions): void {
  const { direction, handle, fromControls = false, onDismiss, enabled = true } = options;
  /* Live callback: hosts pass an arrow per render, and re-binding mid-drag
     would drop the gesture. */
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || !enabled) return;
    const horizontal = direction === 'left';
    const sign = direction === 'left' ? -1 : 1;

    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let offset = 0;
    let lastT = 0;
    let lastOffset = 0;
    let velocity = 0;
    let suppressClick = false;

    const scrim = () => (panel.parentElement && panel.parentElement !== document.body ? panel.parentElement : null);

    const paint = (value: number) => {
      panel.style.transform = horizontal ? `translateX(${value}px)` : `translateY(${value}px)`;
      const size = horizontal ? panel.offsetWidth : panel.offsetHeight;
      const s = scrim();
      if (s && size > 0) s.style.opacity = String(Math.max(0, 1 - Math.abs(value) / size));
    };

    const clear = () => {
      panel.removeAttribute('data-dragging');
      panel.style.transform = '';
      panel.style.transition = '';
      const s = scrim();
      if (s) s.style.opacity = '';
    };

    const onDown = (event: PointerEvent) => {
      if (pointerId !== null || event.button !== 0) return;
      const target = event.target as Element | null;
      if (handle && !target?.closest(handle)) return;
      if (!fromControls && target?.closest('button, a, input, select, textarea, [contenteditable="true"]')) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      dragging = false;
      offset = 0;
      velocity = 0;
      lastT = performance.now();
      lastOffset = 0;
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!dragging) {
        const along = horizontal ? dx : dy;
        const across = horizontal ? dy : dx;
        if (Math.abs(along) < SLOP && Math.abs(across) < SLOP) return;
        /* Pick the axis once. Across, or the opening direction, is not ours:
           let the panel scroll and stop watching this pointer. */
        if (Math.abs(across) >= Math.abs(along) || Math.sign(along) !== sign) {
          pointerId = null;
          return;
        }
        dragging = true;
        panel.setAttribute('data-dragging', '');
        try {
          panel.setPointerCapture(event.pointerId);
        } catch {
          /* jsdom and old engines: the drag still works while over the panel. */
        }
      }
      const along = horizontal ? dx : dy;
      offset = sign < 0 ? Math.min(0, along) : Math.max(0, along);
      const now = performance.now();
      const dt = now - lastT;
      if (dt > 0) velocity = (offset - lastOffset) / dt;
      lastT = now;
      lastOffset = offset;
      paint(offset);
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      if (!dragging) return;
      dragging = false;
      suppressClick = true;
      const size = horizontal ? panel.offsetWidth : panel.offsetHeight;
      const far = size > 0 && Math.abs(offset) >= size * DISTANCE;
      const flick = velocity * sign >= VELOCITY;
      if (event.type !== 'pointercancel' && (far || flick)) {
        panel.removeAttribute('data-dragging');
        dismissRef.current(offset, panel);
        return;
      }
      /* Spring back. */
      if (layerMotionAllowed()) {
        panel.style.transition = 'transform var(--pn-dur-fast) var(--pn-ease-out)';
        panel.addEventListener('transitionend', clear, { once: true });
        panel.removeAttribute('data-dragging');
        panel.style.transform = '';
        const s = scrim();
        if (s) s.style.opacity = '';
      } else {
        clear();
      }
    };

    /* A drag that started on a row must not also open that row. */
    const onClick = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const onDownReset = () => {
      suppressClick = false;
    };

    panel.addEventListener('pointerdown', onDownReset, true);
    panel.addEventListener('pointerdown', onDown);
    panel.addEventListener('pointermove', onMove);
    panel.addEventListener('pointerup', onUp);
    panel.addEventListener('pointercancel', onUp);
    panel.addEventListener('click', onClick, true);
    return () => {
      panel.removeEventListener('pointerdown', onDownReset, true);
      panel.removeEventListener('pointerdown', onDown);
      panel.removeEventListener('pointermove', onMove);
      panel.removeEventListener('pointerup', onUp);
      panel.removeEventListener('pointercancel', onUp);
      panel.removeEventListener('click', onClick, true);
    };
  }, [panelRef, direction, handle, fromControls, enabled]);
}
