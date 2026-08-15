/**
 * WHAT THE VIEWER LEAVES BEHIND — the one reset a session end runs.
 *
 * THE DEFECT THIS EXISTS FOR (2026-08-15). `signOutOfServer` cleared the pass
 * and NOTHING ELSE, while `navStore` and `screenStackStore` are module-level.
 * A store that outlives the pass outlives the VIEWER: sign out, hand the laptop
 * over, and the next person to sign in inherits the open panels, the pinned
 * entities, the `?session=` and every detail screen's stack — entity ids and
 * session ids belonging to somebody who has left. It does not throw. It shows
 * you the last person's rows.
 *
 * WHY IT SURVIVED THIS LONG. Before the router mount (PR #220), `activeTarget`
 * was a component-local `useState` that a remount reset, so React masked half
 * of it. Making `navStore` authoritative did not create the leak; it removed
 * the accident that was hiding it.
 *
 * THE DISCIPLINE THIS JOINS, RATHER THAN THE SECOND ONE IT COULD HAVE BEEN.
 * `leaveSpaceContext` (`views/GateApp.tsx`) is the ONE path a space or server
 * switch goes through, and its docblock says why: entity ids are space-scoped
 * while both stores are module-level, and three hand-written copies of that
 * reset is three chances for the fourth switch to be written with two of the
 * four lines. Sign-out is that same act — LEAVING A CONTEXT — with a wider
 * scope, so it takes the same path: `forgetSpaceScopedPanels` below is the
 * shared body, and `leaveSpaceContext` now calls it rather than restating it.
 *
 * WHY THE ORCHESTRATOR LIVES IN `auth/` AND NOT IN `stores/`. What must be
 * forgotten is not a fact about the stores; it is a fact about the SESSION —
 * "everything the departing pass could reach". That set spans four layers
 * (stores, the address, two browser-local caches), and the module that knows a
 * session has ended is this one. `stores/` may not import `views/`, and an
 * inverted registration hook ("whoever cares, register a reset") is exactly the
 * fragility the bug came from: a reset nobody remembered to register fails
 * silently, forever, the way this one did.
 *
 * WHAT IS DELIBERATELY NOT CLEARED — each of these is a ruling, not an
 * oversight:
 *   - the KNOWN-ACCOUNTS list (`pass-store.ts`), so the gate can still offer
 *     "sign back in as @amber". `session.ts`'s header rules this directly.
 *   - PERSISTED chat drafts (`chat-store.ts`), keyed by viewer member id and
 *     unreadable by the next one; destroying half-written messages is a worse
 *     failure than the one this guards.
 *   - the node-claim cache and the theme, which are facts about the NODE and
 *     about this browser, not about the person.
 */
import { UNADDRESSED_HASH, createBrowserTarget, type RouterTarget } from '../routes';
import { navStore, resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { chatStore } from '../channel-screen/chat-store';
import { resetChatEntityResolutionCache } from '../chat-home/EntityChip';
import { clearLastPlace } from '../views/last-place';
import { clearLaunchCache, nodeKeyOf } from '../data/launch-cache';
import { readActiveServerId, routeBaseUrlFor } from '../servers/server-key';

/**
 * HOW the session ended, because the two ends differ in exactly one respect
 * and the difference is a ruling (D74):
 *
 *   `signed-out` — the viewer ASKED to leave. They may be handing over the
 *   machine, so the address is blanked and this node's browser-local memory of
 *   where they were goes with it.
 *
 *   `expired` — the SERVER ended it, mid-use, without being asked. The address
 *   is left exactly as it stands, so signing back in returns the same viewer to
 *   the page they were reading. The module-level stores are still cleared:
 *   whoever signs in next re-derives them from the address, which is a request
 *   and not a leak.
 */
export type SessionEnd = 'signed-out' | 'expired';

export interface SessionResetOptions {
  /**
   * The address to blank. Defaults to the live browser address — the same
   * transport the router writes through, so the sign-out act and the router
   * cannot disagree about what an address is. Tests pass a memory target.
   */
  address?: RouterTarget | null;
}

/**
 * THE SHARED BODY — every open panel and every screen stack, forgotten.
 *
 * Extracted verbatim from `leaveSpaceContext`, which keeps its interim
 * workspace target and its `replace` history discipline: those are about
 * ARRIVING somewhere else, which a sign-out does not do.
 *
 * `applyNormalization({stack:[],pinned:[]})` rather than a raw `setState`,
 * because the store's own action is what prunes `tabs` and `contentSurface` for
 * the ids it drops — a hand-rolled clear would have left per-panel state keyed
 * by entities that are no longer open anywhere.
 */
export function forgetSpaceScopedPanels(): void {
  navStore.getState().applyNormalization({ stack: [], pinned: [] });
  navStore.getState().setSession(null);
  screenStackStore.getState().clearAll();
}

function activeNodeKey(): string {
  return nodeKeyOf(routeBaseUrlFor(readActiveServerId()));
}

function browserAddress(): RouterTarget | null {
  if (typeof window === 'undefined') return null;
  return createBrowserTarget(window);
}

/**
 * THE SESSION IS OVER — forget the viewer.
 *
 * Called from `session.ts` on both ends: the explicit `signOutOfServer` and the
 * reload check's `invalid` verdict, which is the one other place this browser
 * learns that a pass has stopped being anybody's.
 *
 * ORDER MATTERS AND IS NOT ALPHABETICAL. The stores go before the address,
 * matching the Server-switch reset above `resetAddress` in `GateApp`: clearing
 * `navStore` schedules the router's debounced replace, and that write is a
 * no-op only because the store now has no space id. Blanking first would let
 * the settle write the OLD address back over the blank one.
 *
 * NOT A CONTRADICTION OF `signed-out-hash.test.tsx` ("the signed-out gate must
 * never write the hash"). That law binds the RENDER path — a gate that tidies
 * the URL destroys a deep link for the recipient it exists to serve, who is
 * signed out and has not touched anything. This is the opposite case: a live
 * viewer performed an act. The distinction is act versus render, and the test
 * that pins the law never signs out, so both stay true.
 */
export function endSession(end: SessionEnd, opts: SessionResetOptions = {}): void {
  // The whole store, not just the panels: a sign-out leaves no space either, and
  // `resetNav` is exported for exactly this.
  resetNav();
  screenStackStore.getState().clearAll();
  chatStore.getState().clearAll();
  resetChatEntityResolutionCache();

  if (end !== 'signed-out') return;

  const nodeKey = activeNodeKey();
  clearLastPlace(nodeKey);
  clearLaunchCache(nodeKey);
  const address = opts.address === undefined ? browserAddress() : opts.address;
  address?.setHash(UNADDRESSED_HASH, { replace: true });
}
