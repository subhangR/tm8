/**
 * Recovers a tab that outlived the build it booted from.
 *
 * Every deploy replaces `dist/assets` wholesale, and each chunk's name carries
 * its content hash. A tab opened before the deploy still runs the OLD entry
 * chunk, and that entry asks for lazy chunks under their OLD names: the
 * mermaid renderer, the chat screens, excalidraw, the codemirror languages.
 * Those files are gone, so the server answers 404 and the import rejects with
 * "Failed to fetch dynamically imported module". Before this file, that error
 * ended up on screen as a dead "This diagram could not be drawn" card
 * (2026-10-20, agentdev1).
 *
 * Vite's preload helper fires `vite:preloadError` on window for any lazy
 * import that fails. One reload fetches the current index.html (served
 * `no-cache`, see server/src/http/static.ts) and so the current chunk names.
 *
 * ONCE, NOT ALWAYS. A chunk can also be missing from the CURRENT build (a broken
 * deploy, or the network dropping mid-fetch). A reload cannot fix that, and an
 * unguarded handler would loop forever. A timestamp in sessionStorage caps it
 * at one reload per window; after that the error propagates and the caller's
 * own failure state renders, which is the honest outcome.
 *
 * The event is NOT `preventDefault`ed: the import still rejects. A caller
 * that renders before the reload lands shows its normal failure state for a
 * moment, not a module that resolved to undefined.
 */

export const STALE_BUILD_RELOAD_KEY = 'tm8.stale-build-reload-at';
export const STALE_BUILD_RELOAD_WINDOW_MS = 30_000;

interface RecoveryEnv {
  addEventListener(type: string, listener: () => void): void;
  location: { reload(): void };
}

interface StampStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function installStaleBuildRecovery(
  env: RecoveryEnv = window,
  storage: StampStore | undefined = safeSessionStorage(),
  now: () => number = Date.now,
): void {
  env.addEventListener('vite:preloadError', () => {
    // No storage (privacy mode, a sandboxed frame) means no loop guard, and
    // a reload loop is worse than a dead card.
    if (!storage) return;
    const last = Number(storage.getItem(STALE_BUILD_RELOAD_KEY) ?? 0);
    if (now() - last < STALE_BUILD_RELOAD_WINDOW_MS) return;
    try {
      storage.setItem(STALE_BUILD_RELOAD_KEY, String(now()));
    } catch {
      return;
    }
    env.location.reload();
  });
}

function safeSessionStorage(): StampStore | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
