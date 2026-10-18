/**
 * WHICH SURFACE A SESSION IS SHOWING — so the chrome around it can take the
 * right scope (Subhang, 2026-10-18, task 01a14c39).
 *
 * The session's transcript follows the APP THEME exactly as a chat thread does;
 * only the TERMINAL surface stands in the always-dark scope (which itself
 * follows the active style's `--pn-term-chrome`, see `useAlwaysDarkTheme`). The
 * panel frame, the workspace title bar and the action strip all sit OUTSIDE
 * `WorkSessionContent`, which owns the selection, so it reports what it shows
 * here and they read it back.
 *
 * Before a body has mounted (the tab's loading frame, or the panel's first
 * render) the answer is PREDICTED with the same precedence the body resolves
 * its first surface by — route, then the viewer's own last choice, then the
 * default — so the loading frame and the first paint already wear the scope
 * the loaded view will, with no light/dark flash between them.
 */
import { useSyncExternalStore } from 'react';
import type { ContentSurface } from '../../routes';

const shown = new Map<string, ContentSurface>();
const listeners = new Set<() => void>();

export function reportShownSurface(sessionId: string, surface: ContentSurface | null): void {
  if ((shown.get(sessionId) ?? null) === surface) return;
  if (surface) shown.set(sessionId, surface);
  else shown.delete(sessionId);
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** The surface a mounted session body is showing, or null while none is. */
export function useShownSurface(sessionId: string | null | undefined): ContentSurface | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? (shown.get(sessionId) ?? null) : null),
    () => null,
  );
}

/** The one surface drawn in the always-dark scope. */
export function isDarkSurface(surface: ContentSurface): boolean {
  return surface === 'terminal';
}

export function __resetShownSurfacesForTests(): void {
  shown.clear();
}
