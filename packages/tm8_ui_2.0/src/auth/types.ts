/**
 * The T3 flow's public shape — the props contract the coordinator wires the
 * gate against, and the frame identifiers taken from the oracle's own
 * `data-screen-label` attributes.
 */
import type { ReactNode } from 'react';
import type { IdentityView } from '../data/seam';
import type { Theme } from '../theme/useTheme';

/**
 * The oracle's seventeen frames, by its own ids. Ordered as the oracle's DOM
 * orders them (1h → 1j → 1i, and 1l → 1o → 1m), because the DOM order is the
 * order the flows read in — the ids alphabetise differently and following the
 * alphabet would silently reorder two flows.
 */
export type AuthFrameId =
  | '1a' | '1b' | '1c'
  | '1d' | '1e' | '1f' | '1g'
  | '1h' | '1j' | '1i'
  | '1k' | '1l' | '1o' | '1m' | '1n'
  | '1p' | '1q';

export type AuthFlowName = 'first-run' | 'sign-in' | 'invite' | 'server' | 'account';

export interface AuthFrameDef {
  id: AuthFrameId;
  /** The oracle's `data-screen-label`, verbatim. */
  label: string;
  flow: AuthFlowName;
  /** True where the frame is a dialog over the workspace, not a full stage. */
  overlay: boolean;
}

/**
 * The identity the flow displays. Typed as a SUBSET of the seam's own
 * `IdentityView` rather than a fresh interface: the flow reads four fields, and
 * borrowing them from the source type means a bridge-side rename turns this
 * red instead of rendering `undefined` in the account menu.
 */
export type AuthIdentity = Pick<
  IdentityView,
  'username' | 'displayName' | 'avatar' | 'isOwner'
>;

/**
 * The ONLY outcome this build can produce. There is no `kind: 'signed-in'`,
 * because there is no sign-in verb behind the seam — and a union member that
 * can never be constructed is a promise the type would be making on the code's
 * behalf. When an auth seam lands, adding the member here makes every
 * consumer's switch non-exhaustive, which is the compiler doing the wiring
 * review for us.
 */
export interface AuthOutcome {
  kind: 'dev-bypass';
  note: string;
}

export interface AuthFlowProps {
  /**
   * Called when the flow reaches a terminal state. In this build the only
   * path here is the dev bypass, and its own copy says so.
   */
  onDone: (outcome: AuthOutcome) => void;

  /** Pin a frame (review harness / the gate mounting one screen). */
  frame?: AuthFrameId;
  /** Where the flow's own state machine starts when `frame` is not pinned. */
  initialFrame?: AuthFrameId;
  onFrameChange?: (id: AuthFrameId) => void;

  /**
   * The viewer, when the host already has one — 1p renders it LIVE. `null`
   * says the host looked and found none; `undefined` says it never asked.
   * Both render honestly and differently.
   */
  identity?: AuthIdentity | null;

  /**
   * 1g's "N live sessions still running". OMITTED BY DEFAULT AND ON PURPOSE:
   * `seam.liveness` is space-scoped and unreachable while signed out, so the
   * sentence is absent unless a host can genuinely supply the number. A zero
   * here would be a lie of precision; the oracle's 2 would be fiction.
   */
  liveSessionCount?: number;

  /** Theme for the scope this flow opens. Uncontrolled ⇒ follows useTheme(). */
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;

  /**
   * `own` (default) opens a `.cv2-root` scope; `inherit` renders bare.
   *
   * D60 puts `zoom: 1.1` on `.cv2-root` and zoom COMPOUNDS — a nested scope
   * would render the whole flow at 1.21× inside the gated app while every
   * standalone screenshot looked correct. That is the entire reason this prop
   * exists, and `auth.test.tsx` asserts it.
   */
  rootScope?: 'own' | 'inherit';

  /**
   * Render the dev bypass — the one control that can call `onDone`. Off by
   * default so it cannot reach a build that did not ask for it.
   */
  devBypass?: boolean;

  /** What sits behind the overlay frames (1f, 1j, 1k). */
  backdrop?: ReactNode;

  /** 1j — fired when the viewer dismisses orientation. */
  onOrientationDismissed?: () => void;
}

/** What each frame component receives. */
export interface FrameProps {
  identity?: AuthIdentity | null;
  liveSessionCount?: number;
  theme: Theme;
  onThemeChange?: (theme: Theme) => void;
  onFrameChange?: (id: AuthFrameId) => void;
  onOrientationDismissed?: () => void;
  backdrop?: ReactNode;
}
