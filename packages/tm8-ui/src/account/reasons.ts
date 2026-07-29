/**
 * THE ACCOUNT MENU'S REFUSALS, in one place.
 *
 * Charter R7 / L6: a control the build cannot perform renders visible,
 * focusable and reasoned — never hidden, never live-and-inert. Collecting them
 * here means the copy can be read as a set (they must sound like one voice)
 * and means a reader can answer "what does this menu NOT do?" without reading
 * the component.
 *
 * Each reason states what is true, then the named constraint. Where the oracle
 * wrote the copy itself (`Act as teammate…`), the oracle's words are kept.
 */
import type { UnavailableReason } from '../panels/honesty/DisabledWithReason';

/**
 * Acting-as. The canvas ships this DISABLED by design — the disabled row is
 * the drawn state, not a shortfall of this build (T3-3 annotation 5).
 * `IdentityView.actingAs` is read-only; the seam has no command that sets it.
 */
export const ACT_AS_REASON: UnavailableReason = {
  cause: 'One signed-in identity on this node',
  remedy: 'the acting-as seam is reserved for accounts',
};

/**
 * Node settings (T3-5). Designed, not built: there is no node-settings screen
 * in this package to link to. The space-settings view ref is a DIFFERENT
 * surface, and routing here would be the misroute-honesty defect.
 */
export const NODE_SETTINGS_REASON: UnavailableReason = {
  cause: 'Node settings isn’t built in this build',
  remedy: 'trust · slots · project registry arrive with T3-5',
};

/**
 * Sign-out. Measured, not assumed: `src/data/seam.ts` exposes no auth or
 * session command — no signOut, no session teardown, nothing an account menu
 * could call. So the row states that, and the confirm dialog (which IS built)
 * only opens when a host passes a real executor.
 */
export const SIGN_OUT_REASON: UnavailableReason = {
  cause: 'Signing out isn’t connected yet',
  remedy: 'the facade seam exposes no session or auth command to call',
};

/** No membership for the active space ⇒ no member panel of yours to open. */
export const PROFILE_NO_MEMBER_REASON: UnavailableReason = {
  cause: 'You have no member record in this space',
  remedy: 'the profile row opens your member panel, and this space has none for you',
};

/** The host mounted the row without a handler — R5's enabled-inert class. */
export const PROFILE_NOT_WIRED_REASON: UnavailableReason = {
  cause: 'Opening your member panel isn’t connected here',
  remedy: 'this mount passed no profile handler',
};

/**
 * Theme → system. `useTheme` stores an explicit choice and exposes no clear,
 * so once you have chosen, this build cannot hand the decision back to the OS.
 * A host that CAN clear passes `useSystem` and the segment performs.
 */
export const THEME_SYSTEM_REASON: UnavailableReason = {
  cause: 'Can’t follow the system theme again',
  remedy: 'this build stores your choice and has no control that clears it',
};
