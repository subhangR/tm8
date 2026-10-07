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

/** One arrow press, in px for a document. */
export const ARROW_SCROLL_PX = 40;

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
export type ScrollKey = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

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
  const term = visibleScrollTerminal(root);
  if (term) {
    scrollTerminalLines(term, sign * (unit === 'page' ? Math.max(1, term.rows - 1) : 1));
    return true;
  }
  const scroller = mainScroller(root);
  if (scroller) {
    const step = unit === 'page' ? Math.max(ARROW_SCROLL_PX, scroller.clientHeight - ARROW_SCROLL_PX) : ARROW_SCROLL_PX;
    scroller.scrollBy({ top: sign * step });
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
