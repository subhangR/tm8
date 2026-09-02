/**
 * Where the other UI lives, and whether it is actually there.
 *
 * `packages/tm8-ui` is the frozen pre-Astryx 1.0 snapshot (`672df036`,
 * 2026-08-29). It is served — when an operator sets `TM8_UI_1_0_DIR` — under
 * `/ui-1.0/` on THIS origin, by the server's mounted static handler. Same
 * origin is the whole design: the session cookie is what makes the other UI
 * usable rather than a sign-in wall, and a second port would have meant a
 * second process and a cookie story to get wrong.
 *
 * THE MOUNT PATH IS DUPLICATED IN THREE PLACES and cannot be imported across
 * them: here, `packages/server/src/http/static.ts` (`UI_1_0_MOUNT_PATH`), and
 * `packages/tm8-ui/vite.config.ts` (`base`). The UI packages cannot import
 * from the server, and the 1.0 bundle bakes its asset URLs at build time.
 * Changing it means changing all three AND rebuilding 1.0.
 */

/** The 1.0 UI's address on this origin. Trailing slash: it is a directory. */
export const UI_1_0_PATH = '/ui-1.0/';

/** The product UI's address — where 1.0's own switch sends you back to. */
export const UI_2_0_PATH = '/';

export type UiVersionAvailability =
  | { readonly phase: 'probing' }
  | { readonly phase: 'available' }
  | { readonly phase: 'absent'; readonly reason: string };

/**
 * One probe per page load, shared by every mount of the control.
 *
 * Module-scoped rather than per-component: the account menu can open and close
 * many times, and re-probing on each open would put a request on the network
 * for a fact that cannot change without a server restart.
 */
let probe: Promise<UiVersionAvailability> | undefined;

/**
 * Ask whether the 1.0 bundle is served here.
 *
 * `index.html` specifically, not the directory: the mounted handler answers
 * extension-less paths with its own SPA fallback, so probing `/ui-1.0/` would
 * return 200 from the fallback even against a root that holds no bundle. The
 * file either exists or it does not.
 *
 * GET, NOT HEAD, and this was measured rather than assumed. tm8-server's
 * static dispatch is guarded on `method === 'GET'` (`http/server.ts`), so a
 * HEAD reaches no handler and comes back 404 — against a server that IS
 * serving the bundle. The first cut of this used HEAD and the control reported
 * the 1.0 UI permanently unavailable, which is the exact failure the probe
 * exists to prevent, wearing the probe's own clothes. index.html is ~2.5 kB and
 * this runs once per page load.
 *
 * A network failure reports ABSENT rather than throwing. The control's job is
 * to say whether the door opens, and "I could not tell" is a door that should
 * not be offered — but it must not take the account menu down with it.
 */
export function probeUi10(fetcher: typeof fetch = fetch): Promise<UiVersionAvailability> {
  probe ??= fetcher(`${UI_1_0_PATH}index.html`, { method: 'GET' }).then(
    (res) =>
      res.ok
        ? ({ phase: 'available' } as const)
        : ({
            phase: 'absent',
            reason: 'this server does not serve the 1.0 UI',
          } as const),
    () => ({ phase: 'absent', reason: 'the 1.0 UI could not be reached' }) as const,
  );
  return probe;
}

/** Test seam: forget the cached probe so each case starts from nothing. */
export function resetUi10Probe(): void {
  probe = undefined;
}
