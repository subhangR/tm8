/**
 * The mounted terminals, so a surface outside xterm can scroll the one on
 * screen without focusing it (owner report 2026-10-07: arrows after a tab
 * switch should scroll the terminal, but focusing it made the next `]` a
 * keystroke into the session). Scrolling goes through `scrollTerminalLines`:
 * history for a shell, wheel reports for a TUI that tracks the mouse. It never
 * writes to the PTY.
 */
import { scrollTerminalLines, type ScrollTerminal } from './scrollTerminal';

const mounted = new Set<ScrollTerminal>();

export function registerScrollTarget(term: ScrollTerminal): () => void {
  mounted.add(term);
  return () => mounted.delete(term);
}

/** The first mounted terminal laid out inside `root`, if any. */
function visibleIn(root: ParentNode): ScrollTerminal | null {
  for (const term of mounted) {
    const el = term.element;
    if (el && el.isConnected && root.contains(el) && el.getClientRects().length > 0) return term;
  }
  return null;
}

/**
 * Scroll the terminal on screen inside `root` by `lines` (or by half a screen
 * per `pages`). False when there is none to scroll.
 */
export function scrollVisibleTerminal(root: ParentNode, by: { lines?: number; pages?: number }): boolean {
  const term = visibleIn(root);
  if (!term) return false;
  const lines = by.pages ? by.pages * Math.max(1, Math.floor(term.rows / 2)) : (by.lines ?? 0);
  scrollTerminalLines(term, lines);
  return true;
}
