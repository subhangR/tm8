/**
 * Switching to a session tab puts the keyboard in its terminal (owner report
 * 2026-10-07: "after i switch tab and press up down arrow the terminal is not
 * scrolling"). A pooled terminal stays mounted across switches, so xterm's own
 * mount-time focus never runs again; focus was left on the tab strip and the
 * arrows went nowhere.
 *
 * Polls a few frames because a tab opened for the first time mounts its
 * terminal after the switch paints. Gives up quietly when nothing appears (an
 * exited session's read-only canvas, a kind with no terminal), and never takes
 * focus from a field the viewer moved into meanwhile.
 */
const MAX_FRAMES = 30;

/** The visible terminal input inside the Work content pane, if any. */
function visibleTerminalInput(): HTMLTextAreaElement | null {
  const host = document.querySelector<HTMLElement>('[data-testid="tws-content"]');
  if (!host) return null;
  for (const area of host.querySelectorAll<HTMLTextAreaElement>('.xterm .xterm-helper-textarea')) {
    const term = area.closest<HTMLElement>('.xterm');
    if (term && term.offsetParent !== null && term.getClientRects().length > 0 && !area.disabled) return area;
  }
  return null;
}

/** Focus the active tab's terminal once it is on screen. */
export function focusTabTerminal(): void {
  if (typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') return;
  const startedOn = document.activeElement;
  let frames = 0;
  const tick = () => {
    // The viewer moved on (typed into a field, opened a menu): leave them be.
    const now = document.activeElement;
    if (now !== startedOn && now !== document.body && !now?.closest?.('.tws-strip')) return;
    const area = visibleTerminalInput();
    if (area) {
      area.focus({ preventScroll: true });
      return;
    }
    frames += 1;
    if (frames < MAX_FRAMES) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
