import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import { zoomOf } from './useMenuAnchor';

/**
 * A FIXED POPOVER BESIDE ITS TRIGGER, CLAMPED TO THE VIEWPORT.
 *
 * The rail's Needs-you / Status popovers and the action strip's forms popover
 * open SIDEWAYS (to the right of the rail, to the left of the strip), so
 * `useMenuAnchor`'s below/above flip does not fit them. Three things went
 * wrong when each placed itself (task 01a112b9):
 *  - nothing kept the box on screen: a tall form under a chip halfway down a
 *    short window ran off the bottom edge;
 *  - the measured rect was fed straight back as a `position: fixed` length
 *    inside `.cv2-root`'s `zoom: 1.1`, which scales it again — the popover
 *    drifted off its trigger (see `useMenuAnchor` for the zoom story);
 *  - a popover whose content grew (a form opened inside it) never re-placed.
 *
 * So placement is one pure function in SCREEN pixels, divided by the host's
 * zoom only when written back, and the hook re-runs it on resize, on any
 * scroll, and whenever the popover's own size changes.
 */

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PlaceOptions {
  /** Which side of the anchor it opens on; flips when that side has no room. */
  side: 'left' | 'right';
  /** `start`: top edges aligned (grows down); `end`: bottom edges aligned (grows up). */
  align: 'start' | 'end';
  /** Space between anchor and popover, in CSS px (scaled by the zoom). */
  gap?: number;
  /** Minimum distance from every viewport edge, in screen px. */
  margin?: number;
}

export interface Placement {
  left: number;
  top: number;
  maxHeight: number;
  maxWidth: number;
  /** The side actually used after any flip. */
  side: 'left' | 'right';
}

export const POPOVER_MARGIN_PX = 8;

/**
 * Where the popover goes. Every input is in screen pixels (what
 * `getBoundingClientRect` and `innerWidth` answer); the result is in CSS px
 * for an element inside a host zoomed by `zoom`.
 */
export function placePopover(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  zoom: number,
  { side, align, gap = 8, margin = POPOVER_MARGIN_PX }: PlaceOptions,
): Placement {
  const z = zoom > 0 ? zoom : 1;
  const g = gap * z;
  const maxWidth = Math.max(0, viewport.width - 2 * margin);
  const maxHeight = Math.max(0, viewport.height - 2 * margin);
  const width = Math.min(size.width, maxWidth);
  const height = Math.min(size.height, maxHeight);

  const rightX = anchor.right + g;
  const leftX = anchor.left - g - width;
  const fitsRight = rightX + width <= viewport.width - margin;
  const fitsLeft = leftX >= margin;
  let used = side;
  if (side === 'right' && !fitsRight && fitsLeft) used = 'left';
  if (side === 'left' && !fitsLeft && fitsRight) used = 'right';
  const x = used === 'right' ? rightX : leftX;

  const y = align === 'start' ? anchor.top : anchor.bottom - height;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  return {
    left: clamp(x, margin, viewport.width - margin - width) / z,
    top: clamp(y, margin, viewport.height - margin - height) / z,
    maxHeight: maxHeight / z,
    maxWidth: maxWidth / z,
    side: used,
  };
}

/**
 * The fixed style for `popRef` while `open`, anchored to `anchor()` (a rect in
 * screen px; pass a function so a caller can combine boxes, e.g. the rail's
 * right edge with its button's height). Hidden until the first measurement.
 */
export function useAnchoredPopover(
  open: boolean,
  anchor: () => Rect | null | undefined,
  popRef: RefObject<HTMLElement | null>,
  options: PlaceOptions,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const { side, align, gap, margin } = options;
  useLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    const place = () => {
      const pop = popRef.current;
      const rect = anchor();
      if (!pop || !rect) return;
      const box = pop.getBoundingClientRect();
      /* The popover's natural height, not one already capped by a previous
         pass's max-height: scrollHeight is in CSS px, so scale it up. */
      const zoom = zoomOf(pop.parentElement ?? pop);
      const natural = Math.max(box.height, pop.scrollHeight * zoom);
      const p = placePopover(
        rect,
        { width: box.width, height: natural },
        { width: window.innerWidth, height: window.innerHeight },
        zoom,
        { side, align, gap, margin },
      );
      setStyle((was) => {
        if (was && was.left === p.left && was.top === p.top && was.maxHeight === p.maxHeight && was.maxWidth === p.maxWidth) {
          return was;
        }
        return {
          position: 'fixed',
          left: p.left,
          top: p.top,
          right: 'auto',
          bottom: 'auto',
          maxHeight: p.maxHeight,
          maxWidth: p.maxWidth,
        };
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (popRef.current) {
      observer?.observe(popRef.current);
      for (const child of Array.from(popRef.current.children)) observer?.observe(child);
    }
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      observer?.disconnect();
    };
    // `anchor` is read fresh on every pass; re-subscribing per render would
    // re-place on every keystroke inside the popover for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, popRef, side, align, gap, margin]);
  return style ?? { position: 'fixed', visibility: 'hidden' };
}
