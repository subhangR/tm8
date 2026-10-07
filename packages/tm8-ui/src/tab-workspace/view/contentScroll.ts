/**
 * ↑/↓ SCROLL THE ACTIVE TAB (user ruling, task 01a1156f): "when we switch to a
 * tab or start a new tab, pressing up down arrows must scroll the terminal or
 * document or whatever".
 *
 * Switching or opening a tab hands focus to the content host (only when focus
 * was nowhere in particular — the page, the tab strip, the browser list; never
 * out of a field a draft autofocused). With the host itself focused, ↑/↓ and
 * PageUp/PageDown scroll what the tab shows: the terminal on screen through the
 * terminal registry, otherwise the largest scroller in the tab.
 */
import { scrollTerminalLines, visibleScrollTerminal } from '../../terminal/scrollTerminal';

/** One arrow press, in px for a document (user ruling: 40px + 150%). */
export const ARROW_SCROLL_PX = 100;
/** One arrow press in a terminal, in lines (1 + 150%); the fraction carries over. */
export const ARROW_SCROLL_LINES = 2.5;

/**
 * THE HOLD CURVE (user ruling, task 01a1156f): a held arrow speeds up. A tap is
 * one base step; while the key auto-repeats, each step is multiplied by
 * `holdBoost`, easing in from 1× to HOLD_MAX_BOOST× over HOLD_RAMP_MS, so a
 * short hold stays readable and a long one crosses a long page quickly.
 */
export const HOLD_RAMP_MS = 1200;
export const HOLD_MAX_BOOST = 4;

/** The step multiplier `heldMs` into a hold: ease-in (quadratic), clamped. */
export function holdBoost(heldMs: number): number {
  const t = Math.min(1, Math.max(0, heldMs) / HOLD_RAMP_MS);
  return 1 + (HOLD_MAX_BOOST - 1) * t * t;
}

/** When the current hold began, and the terminal's fractional line carry. */
let holdStartedAt = 0;
let lineCarry = 0;

const KEYS: Record<string, 'line' | 'page'> = {
  ArrowDown: 'line',
  ArrowUp: 'line',
  PageDown: 'page',
  PageUp: 'page',
};

function scrollsY(el: HTMLElement): boolean {
  if (el.scrollHeight <= el.clientHeight) return false;
  const { overflowY } = getComputedStyle(el);
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
}

/** The parts of a key event the host reads (DOM or React). */
export type ScrollKey = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'> & { repeat?: boolean };

/** The tab's main scroller: the visible one with the largest box. */
export function mainScroller(root: HTMLElement): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestArea = 0;
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (!scrollsY(el) || el.getClientRects().length === 0) continue;
    const area = el.clientWidth * el.clientHeight;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Scroll the tab for a key pressed on the content host. Returns whether the key
 * was the host's (so the caller consumes it) — an arrow is consumed even at the
 * end of the scroll, so it never falls through to a page-level binding.
 */
export function scrollContentForKey(root: HTMLElement, event: ScrollKey): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const unit = KEYS[event.key];
  if (!unit) return false;
  const sign = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : -1;
  const now = performance.now();
  if (!event.repeat) {
    holdStartedAt = now;
    lineCarry = 0;
  }
  // Pages are already big; only the arrows ride the curve.
  const boost = unit === 'line' ? holdBoost(now - holdStartedAt) : 1;
  const term = visibleScrollTerminal(root);
  if (term) {
    if (unit === 'page') {
      scrollTerminalLines(term, sign * Math.max(1, term.rows - 1));
    } else {
      lineCarry += ARROW_SCROLL_LINES * boost;
      const lines = Math.floor(lineCarry);
      lineCarry -= lines;
      scrollTerminalLines(term, sign * lines);
    }
    return true;
  }
  const scroller = mainScroller(root);
  if (scroller) {
    const step =
      unit === 'page' ? Math.max(ARROW_SCROLL_PX, scroller.clientHeight - ARROW_SCROLL_PX) : Math.round(ARROW_SCROLL_PX * boost);
    // A tap glides; a held key's repeats land at once, or each would chase the last.
    scroller.scrollBy({ top: sign * step, behavior: event.repeat ? 'auto' : 'smooth' });
  }
  return true;
}

/**
 * Whether switching tabs may take focus for the content: focus is on the page
 * itself, in the tab strip, in the browser list, or already in the content
 * host (the host itself, not a field inside the old tab — that one unmounts).
 */
export function mayTakeFocus(host: HTMLElement): boolean {
  const at = document.activeElement;
  if (!at || at === document.body || at === host) return true;
  if (host.contains(at)) return false;
  return !!at.closest('[data-testid="tws-strip"], [data-testid="tws-browser-list"]');
}
