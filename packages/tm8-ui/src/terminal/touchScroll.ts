import { scrollTerminalLines, type ScrollTerminal } from './scrollTerminal';

/**
 * Translate touch drags into terminal history or application mouse scrolling. In xterm 6 the
 * legacy .xterm-viewport is empty; scrollback lives in a virtual scroller,
 * so neither its scrollHeight nor assigning its scrollTop can scroll output.
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

/** Attach after term.open(); dispose before the terminal is destroyed. */
export function attachTouchScroll(container: HTMLElement, term: ScrollTerminal): () => void {
  let remainder = 0;
  let rowHeight = 0;

  // Public xterm scrolling is in whole rows. Preserve sub-row movement across
  // touch samples and fling frames, otherwise slow drags never move a line.
  const scrollPixels = (pixels: number): boolean => {
    const buffer = term.buffer.active;
    const appScrolls = term.modes.mouseTrackingMode !== 'none' || buffer.type === 'alternate';
    if (rowHeight <= 0 || (!appScrolls && (buffer.baseY === 0 ||
        (pixels < 0 && buffer.viewportY === 0) ||
        (pixels > 0 && buffer.viewportY === buffer.baseY)))) {
      remainder = 0;
      return false;
    }
    remainder += pixels / rowHeight;
    const lines = Math.trunc(remainder);
    remainder -= lines;
    if (lines !== 0) scrollTerminalLines(term, lines);
    return true;
  };

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

  const startFling = () => {
    if (Math.abs(velocity) < FLING_MIN_VELOCITY) return;
    const step = () => {
      flingFrame = null;
      if (!scrollPixels(-velocity)) return;
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
    remainder = 0;
    rowHeight = (container.querySelector('.xterm-screen')?.getBoundingClientRect().height ?? 0) / term.rows;
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

    const delta = touch.clientY - lastY;
    lastY = touch.clientY;

    const elapsed = event.timeStamp - lastAt;
    lastAt = event.timeStamp;
    if (elapsed > 0) {
      // Normalise to px/frame at 60Hz so the fling reads the same on any device.
      const sample = (delta / elapsed) * 16;
      velocity = velocity * (1 - VELOCITY_SMOOTHING) + sample * VELOCITY_SMOOTHING;
    }

    if (!scrollPixels(-delta)) {
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
    startFling();
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
