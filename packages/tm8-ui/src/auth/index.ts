/**
 * T3 · AUTH & ONBOARDING — the module's public face.
 *
 * The stylesheets are imported HERE, not in `main.tsx`, so this flow is
 * self-contained: a host that mounts `AuthFlow` gets its styling by importing
 * the component, with no second edit in a file it may not own. The precedent
 * is `panels/index.ts` and `shell/CommandPalette.tsx`, which do the same.
 *
 * honesty.css comes from `panels/` because `AuthCard`'s refusal skin is the
 * SAME treatment (D28/D32) and shares its caption voice — importing another
 * lane's stylesheet, never editing it.
 */
import '../styles/tokens.css';
import '../styles/canvas-extra.css';
import '../panels/honesty/honesty.css';
import './auth.css';
import './authboard.css';

export { AuthFlow, AUTH_FRAMES, DEV_BYPASS_NOTE } from './AuthFlow';

/* ── THE GATE (the mount contract) ─────────────────────────────────────── */
export { AuthGate, signOut, type AuthGateProps } from './AuthGate';
export { AccountMenu, type AccountMenuProps } from './AccountMenu';
export { useAuthActions, useGateSession, type AuthActions } from './gate-context';
export { useAuthSession, type AuthSessionState, type AuthStatus } from './useAuthSession';
export {
  readLocalAccount,
  readLocalAccounts,
  findLocalAccount,
  readLocalSession,
  resetLocalAuth,
  ACCOUNT_STORAGE_KEY,
  ACCOUNTS_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  MIN_PASSWORD_LENGTH,
  type AuthFailure,
  type LocalAccount,
  type LocalSession,
} from './session';
/** DEV-ONLY review surface — all 17 frames, both themes. Never product. */
export { AuthBoard } from './AuthBoard';
export { ORIENTATION_STORAGE_KEY, isOrientationDismissed } from './InviteFrames';
export { ALL_AUTH_REASONS, MISSING_AUTH_OPS } from './reasons';
export type {
  AuthFlowName,
  AuthFlowProps,
  AuthFrameDef,
  AuthFrameId,
  AuthIdentity,
  AuthOutcome,
} from './types';
