/**
 * THE DESKTOP MODES SWITCH (D31, 2026-10-06).
 *
 * `three` (the default): the desktop has three modes — Work · Design ·
 * Observe — lands on Work, and redirects Home, the old Work and Board into
 * Work. `legacy`: the pre-D31 desktop (Home landing, Home · Workspace · Work ·
 * Board · Graph selector, no redirects).
 *
 * A ROLLBACK HATCH, not a preference: there is no control for it. It exists
 * so the retired desktop views stay reachable — for their own tests, and for
 * Subhang to compare — until stage (c) deletes them. Device-scoped, read once
 * per GateApp mount, like `topbar-version`. The phone ignores it (D16).
 */
export type DesktopModes = 'three' | 'legacy';

export const DESKTOP_MODES_KEY = 'tm8.desktop-modes';

export function desktopModes(): DesktopModes {
  if (typeof window === 'undefined') return 'three';
  try {
    return window.localStorage.getItem(DESKTOP_MODES_KEY) === 'legacy' ? 'legacy' : 'three';
  } catch {
    return 'three';
  }
}

export function setDesktopModes(next: DesktopModes): void {
  if (typeof window === 'undefined') return;
  try {
    if (next === 'three') window.localStorage.removeItem(DESKTOP_MODES_KEY);
    else window.localStorage.setItem(DESKTOP_MODES_KEY, next);
  } catch {
    // Storage refused: the default holds.
  }
}
