/**
 * T3-3 · ACCOUNT MENU — the module's public face.
 *
 * The stylesheets are imported HERE, not in `main.tsx`, so the surface is
 * self-contained: a host that mounts `AccountMenu` gets its styling by
 * importing the component, with no second edit in a file this lane does not
 * own. Precedent: `auth/index.ts`, `panels/index.ts`.
 */
import '../styles/tokens.css';
import '../styles/canvas-extra.css';
import './account.css';

export { AccountMenu } from './AccountMenu';
export type { AccountMenuProps, AccountTheme, AccountThemeControl } from './AccountMenu';
export { SignOutConfirm, type SignOutConfirmProps } from './SignOutConfirm';
export { presentIdentity, type IdentityPresentation } from './identity';
export {
  ACT_AS_REASON,
  NODE_SETTINGS_REASON,
  PROFILE_NOT_WIRED_REASON,
  PROFILE_NO_MEMBER_REASON,
  SIGN_OUT_REASON,
  THEME_SYSTEM_REASON,
} from './reasons';
