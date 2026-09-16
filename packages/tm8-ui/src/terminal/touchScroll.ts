/**
 * Touch scrolling for xterm.js.
 *
 * xterm ships no touch support. Its `.xterm-viewport` is absolutely positioned
 * and `.xterm-screen` — a later sibling — paints on top of it, so every touch
 * lands on the screen layer, which is not scrollable. Desktop works only
 * because xterm registers a `wheel` listener on `.xterm` and moves the viewport
 * programmatically; there is no `touchmove` equivalent, so a finger drag on a
 * phone scrolls nothing.
 *
 * This translates a one-finger vertical drag into `viewport.scrollTop`, with a
 * decaying fling so long scrollback is reachable without a dozen drags.
 */

/** Movement (px) before the gesture commits to an axis. */
const AXIS_LOCK_PX = 6;
/** Per-frame velocity decay during a fling. */
const FLING_DECAY = 0.94;
/** Fling stops below this speed (px per frame). */
const FLING_MIN_VELOCITY = 0.4;
/** Velocity is blended across samples so one jittery frame cannot dominate. */
const VELOCITY_SMOOTHING = 0.7;

type Axis = 'undecided' | 'vertical' | 'horizontal';

function findViewport(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('.xterm-viewport');
}

function canScroll(viewport: HTMLElement): boolean {
  return viewport.scrollHeight - viewport.clientHeight > 1;
}

/**
 * Wire touch scrolling onto a terminal host. Returns a disposer.
 *
 * The listeners live on the host rather than on `.xterm-viewport` because the
 * viewport does not exist until `term.open()` has run and is replaced on some
 * renderer transitions; resolving it per gesture keeps this independent of
 * xterm's mount order.
 */
export function attachTouchScroll(container: HTMLElement): () => void {
  let axis: Axis = 'undecided';
  let tracking = false;
  let startX = 0;
  let startY = 0;
  let lastY = 0;
  let lastAt = 0;
  let velocity = 0;
  let flingFrame: number | null = null;

  const stopFling = () => {
    if (flingFrame === null) return;
    cancelAnimationFrame(flingFrame);
    flingFrame = null;
  };

  const startFling = (viewport: HTMLElement) => {
    if (Math.abs(velocity) < FLING_MIN_VELOCITY) return;
    const step = () => {
      flingFrame = null;
      const before = viewport.scrollTop;
      viewport.scrollTop = before - velocity;
      // A fling that has run into either end has nothing left to animate.
      if (viewport.scrollTop === before) return;
      velocity *= FLING_DECAY;
      if (Math.abs(velocity) < FLING_MIN_VELOCITY) return;
      flingFrame = requestAnimationFrame(step);
    };
    flingFrame = requestAnimationFrame(step);
  };

  const onTouchStart = (event: TouchEvent) => {
    stopFling();
    // Multi-touch is pinch-zoom or a selection gesture, never a scroll.
    if (event.touches.length !== 1) {
      tracking = false;
      return;
    }
    const touch = event.touches[0]!;
    tracking = true;
    axis = 'undecided';
    startX = touch.clientX;
    startY = touch.clientY;
    lastY = touch.clientY;
    lastAt = event.timeStamp;
    velocity = 0;
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!tracking || axis === 'horizontal') return;
    if (event.touches.length !== 1) {
      tracking = false;
      return;
    }
    const touch = event.touches[0]!;

    if (axis === 'undecided') {
      const dx = Math.abs(touch.clientX - startX);
      const dy = Math.abs(touch.clientY - startY);
      if (Math.max(dx, dy) < AXIS_LOCK_PX) return;
      // Horizontal drags belong to whatever pans the surrounding layout.
      axis = dy > dx ? 'vertical' : 'horizontal';
      if (axis === 'horizontal') return;
    }

    const viewport = findViewport(container);
    // With nothing to scroll, let the gesture bubble to the page.
    if (!viewport || !canScroll(viewport)) return;

    const delta = touch.clientY - lastY;
    lastY = touch.clientY;

    const elapsed = event.timeStamp - lastAt;
    lastAt = event.timeStamp;
    if (elapsed > 0) {
      // Normalise to px/frame at 60Hz so the fling reads the same on any device.
      const sample = (delta / elapsed) * 16;
      velocity = velocity * (1 - VELOCITY_SMOOTHING) + sample * VELOCITY_SMOOTHING;
    }

    const before = viewport.scrollTop;
    viewport.scrollTop = before - delta;
    if (viewport.scrollTop === before) {
      // At an end of the scrollback: hand the overscroll back rather than
      // swallowing it, so the gesture can still pan the enclosing panel.
      velocity = 0;
      return;
    }
    if (event.cancelable) event.preventDefault();
  };

  const onTouchEnd = (event: TouchEvent) => {
    if (!tracking) return;
    tracking = false;
    if (axis !== 'vertical') return;
    axis = 'undecided';
    if (event.type === 'touchcancel') {
      velocity = 0;
      return;
    }
    const viewport = findViewport(container);
    if (viewport && canScroll(viewport)) startFling(viewport);
  };

  container.addEventListener('touchstart', onTouchStart, { passive: true });
  // Non-passive: consuming the drag requires preventDefault.
  container.addEventListener('touchmove', onTouchMove, { passive: false });
  container.addEventListener('touchend', onTouchEnd, { passive: true });
  container.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return () => {
    stopFling();
    container.removeEventListener('touchstart', onTouchStart);
    container.removeEventListener('touchmove', onTouchMove);
    container.removeEventListener('touchend', onTouchEnd);
    container.removeEventListener('touchcancel', onTouchEnd);
  };
}
