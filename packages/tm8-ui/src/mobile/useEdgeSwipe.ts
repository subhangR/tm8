/**
 * OUR OWN EDGE-SWIPE BACK — ONLY IN iOS STANDALONE (CONTRACT §5 ruling 2).
 *
 * iOS Safari has its own edge swipe and Android has its own back gesture, and
 * both walk the real history this app writes, so neither needs (or tolerates)
 * one of ours. A home-screen web app on iOS (`display-mode: standalone`) has no
 * browser chrome and no native gesture at all; there, and only there, a drag
 * from the left edge does what the ‹ button does.
 *
 * The page follows the finger, and a drag past a third of the width (or a
 * quick flick) commits. Reduced motion keeps the gesture and drops the travel.
 */
import { useEffect } from 'react';

const EDGE_PX = 24;
const COMMIT_FRACTION = 1 / 3;
const FLICK_PX_PER_MS = 0.5;
const SETTLE_MS = 200;

/** iOS, launched from the home screen. Read once per mount; neither changes mid-session. */
export function isIosStandalone(win: Window = window): boolean {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  const ios = /iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  if (!ios) return false;
  const standalone = nav.standalone === true || (win.matchMedia?.('(display-mode: standalone)').matches ?? false);
  return standalone;
}

export function useEdgeSwipe(root: HTMLElement | null, onBack: (() => void) | null): void {
  useEffect(() => {
    if (!root || !onBack || !isIosStandalone()) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let start: { x: number; y: number; t: number } | null = null;
    let tracking = false;
    let dx = 0;
    const page = () => root.firstElementChild as HTMLElement | null;
    const settle = (to: string, then?: () => void) => {
      const el = page();
      if (!el) return then?.();
      if (reduced) {
        el.style.transform = '';
        return then?.();
      }
      el.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
      el.style.transform = to;
      window.setTimeout(() => {
        el.style.transition = '';
        el.style.transform = '';
        then?.();
      }, SETTLE_MS);
    };
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || e.touches.length > 1 || t.clientX > EDGE_PX) return;
      start = { x: t.clientX, y: t.clientY, t: e.timeStamp };
      tracking = false;
      dx = 0;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const mx = t.clientX - start.x;
      const my = t.clientY - start.y;
      if (!tracking) {
        if (Math.abs(my) > Math.abs(mx) && Math.abs(my) > 8) {
          start = null; // a scroll, not a swipe
          return;
        }
        if (mx < 8) return;
        tracking = true;
      }
      dx = Math.max(0, mx);
      e.preventDefault();
      const el = page();
      if (el && !reduced) el.style.transform = `translateX(${dx}px)`;
    };
    const up = (e: TouchEvent) => {
      if (!start) return;
      const was = start;
      start = null;
      if (!tracking) return;
      const width = root.clientWidth || window.innerWidth;
      const speed = dx / Math.max(1, e.timeStamp - was.t);
      if (dx > width * COMMIT_FRACTION || speed > FLICK_PX_PER_MS) settle('translateX(100%)', onBack);
      else settle('translateX(0)');
    };
    root.addEventListener('touchstart', down, { passive: true });
    root.addEventListener('touchmove', move, { passive: false });
    root.addEventListener('touchend', up, { passive: true });
    root.addEventListener('touchcancel', up, { passive: true });
    return () => {
      root.removeEventListener('touchstart', down);
      root.removeEventListener('touchmove', move);
      root.removeEventListener('touchend', up);
      root.removeEventListener('touchcancel', up);
    };
  }, [root, onBack]);
}
