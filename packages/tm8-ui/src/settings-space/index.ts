/**
 * T2 SETTINGS — half A (space settings · members · invites · menu editor).
 * The module's public face.
 *
 * The stylesheets are imported HERE, not in `main.tsx`, so the surface is
 * self-contained: a host that mounts `SettingsShell` gets its styling by
 * importing the component, with no second edit in a file it may not own.
 * Precedent: `panels/index.ts`, `auth/index.ts`.
 *
 * `honesty.css` comes from `panels/` because every refusal on this surface IS
 * the D28 treatment — importing another lane's stylesheet, never editing it.
 */
import '../styles/tokens.css';
import '../styles/canvas-extra.css';
import '../panels/honesty/honesty.css';
import './settings.css';

/* ── the mount contract ───────────────────────────────────────────────────── */
export { SettingsShell } from './SettingsShell';
export { settingsPortFromSeam, memberKindRef, ownerRoleRef, roleOf, type SettingsPort } from './port';
export {
  SETTINGS_SECTIONS,
  type SettingsData,
  type SettingsSectionDef,
  type SettingsSectionId,
  type SettingsShellProps,
  type RedeemState,
  type SpecimenInvite,
} from './types';

/* ── individual frames, mountable on their own ────────────────────────────── */
export { MembersSection, ROLES_LEGEND, VIEWER_ROLE_FOOTNOTE, shortAge, type MembersSectionProps } from './MembersSection';
export {
  InvitesPanel,
  RedeemLanding,
  REDEEM_DEAD_WORD,
  type InvitesPanelProps,
  type RedeemLandingProps,
} from './InviteFrames';
export { MenuEditor, glyphOf, labelOf, type MenuEditorProps } from './MenuEditor';
export {
  IdentityProfileSection,
  GLOBAL_ID_EXPLAINER,
  globalIdProblem,
  type IdentityProfileSectionProps,
  type ProfileDraftInput,
} from './IdentityProfileSection';

/* ── the editor model, exported so a host can drive it in a test ──────────── */
export {
  MENU_CAPS,
  addChild,
  addGroup,
  addItem,
  availableKindRefs,
  availableViewRefs,
  childCapacity,
  draftConfig,
  draftIssue,
  groupCapacity,
  isDirty,
  moveChild,
  moveGroup,
  moveItem,
  removeChild,
  removeGroup,
  removeItem,
  renameGroup,
  startDraft,
  type Capacity,
  type MenuDraft,
} from './menu-edit';

/** The GAP ledger — every act this surface draws that no seam can perform. */
export { ALL_SETTINGS_REASONS } from './reasons';

/** DEV-ONLY review surface — every frame, both themes. Never product. */
export { SettingsBoard } from './SettingsBoard';
export { SPECIMEN_INVITES, SPECIMEN_REDEEM, specimenMembers } from './specimen';
