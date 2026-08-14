/**
 * THE MOBILE SHELL SEAM — exported, and MOUNTED BY NOBODY.
 *
 * Nothing in this directory is wired into the app. That is the design of
 * Phase 1, not an oversight: the mount point is `views/GateApp.tsx`, and two
 * workers editing that file is a merge conflict on the one file whose failure
 * mode is a SILENT WRONG SCREEN. A single serialized Phase 2 worker mounts
 * every seam in this lane at once.
 *
 * ── WHAT PHASE 2 CALLS ────────────────────────────────────────────────────
 *
 * Two things, in this order:
 *
 *     const { shell } = useShellKind();          // 1. which rendering
 *     return shell === 'mobile'                  // 2. the fork
 *       ? <MobileFrame key="mobile">{…}</MobileFrame>
 *       : <ExistingDesktopTree key="desktop" />;
 *
 * The fork goes BELOW `AuthGate` and BELOW the router mount, and ABOVE the
 * screen switch. Below the gate because a signed-out deep link must still be
 * captured and replayed by the gate, and that contract is the same for both
 * shells. Below the router mount because both shells hydrate from the same
 * hydrated `navStore` — the mount is not forked, only the rendering is.
 *
 * THE `key` IS LOAD-BEARING, and it is how R19 gets answered in one character
 * of API rather than a mechanism. §4.4 leaves open whether switching shells
 * mid-session — rotating a tablet, or toggling the override — REMOUNTS or
 * SWAPS IN PLACE, and recommends remount with the route as the restoration
 * contract. Distinct `key`s give exactly that: React tears down one tree and
 * builds the other, and what survives is precisely what lives in `navStore` —
 * which is to say, what a shared link would have restored anyway. If Phase 2
 * omits the keys it silently gets swap-in-place, and both shells then have to
 * agree about scroll and focus restoration, which neither is written to do.
 *
 * WHAT PHASE 2 MUST NOT DO: pass the mobile shell its own router, target, or
 * history object. `no-router-fork.test.ts` fails the build if anything in here
 * acquires one, and §4.3 is why — two history models cannot agree about what
 * BACK means, and the cross-device link contract (§6) dies on the spot.
 *
 * `usePanelEngine` is NOT reachable from this shell and must stay that way: it
 * is called in exactly one place, `views/WorkspaceView.tsx:115` (re-verified on
 * this branch), so a mobile shell that never renders `WorkspaceView` never runs
 * the R13 demotion loop. That is what makes this fork safe to land without
 * touching R13's lane.
 */

export { MOBILE_MAX_WIDTH, asShellKind, shellFor } from './shell-for';
export type { PointerType, ShellForInput, ShellKind } from './shell-for';

export { SHELL_OVERRIDE_KEY, useShellKind } from './useShellKind';
export type { ShellSelection } from './useShellKind';

export { MobileFrame } from './MobileFrame';
export type { MobileFrameProps } from './MobileFrame';
