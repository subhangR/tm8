/**
 * ↑ ↓ PgUp PgDn scroll the terminal on screen while focus is outside it
 * (owner reports 2026-10-07). After a tab switch focus sits on the strip, so
 * the arrows used to go nowhere; focusing the terminal instead made the next
 * `]` a keystroke into the session. So the keyboard stays where it is and only
 * the view scrolls — history for a shell, wheel reports for a TUI — and
 * nothing is ever written to the PTY.
 *
 * Only when nothing else wants the key: not in a field, a list, a menu or a
 * dialog, not inside xterm itself (it owns its keys), and not a key a handler
 * already took.
 */
import { scrollVisibleTerminal } from '../../terminal/scrollTargets';

const STEP: Record<string, { lines?: number; pages?: number }> = {
  ArrowUp: { lines: -1 },
  ArrowDown: { lines: 1 },
  PageUp: { pages: -1 },
  PageDown: { pages: 1 },
};

/** Elements whose own arrows matter: fields, composite widgets, dialogs, terminals. */
const OWNS_ARROWS =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm, ' +
  '[role="listbox"], [role="menu"], [role="menubar"], [role="grid"], [role="tree"], [role="treegrid"], ' +
  '[role="radiogroup"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="dialog"], [aria-modal="true"]';

export function shouldScrollTerminal(event: KeyboardEvent): boolean {
  if (!(event.key in STEP) || event.defaultPrevented) return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target === document.body || target === document.documentElement) return true;
  if (target.closest(OWNS_ARROWS)) return false;
  // A focused scroll area (a doc, a transcript) scrolls itself.
  for (let el: Element | null = target; el && el !== document.body; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return false;
  }
  return true;
}

/** Install the listener; returns its remover. */
export function installTerminalArrowScroll(): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (!shouldScrollTerminal(event)) return;
    const host = document.querySelector('[data-testid="tws-content"]');
    if (host && scrollVisibleTerminal(host, STEP[event.key]!)) event.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
