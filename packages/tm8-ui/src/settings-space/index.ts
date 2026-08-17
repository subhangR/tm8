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
/* The phone drilldown. Scoped entirely under `.cv2-root[data-shell='mobile']`,
   so on a desktop it is inert — see the file's own header. */
import './settings-mobile.css';

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

/* ── THE SECTION FRAME ─────────────────────────────────────────────────────
   Exported because two of the twelve sections are built in OTHER modules
   (`settings-governance/`, `settings-credentials/`) and injected through
   `sections`. Before this they had no way to lay themselves out like their
   neighbours except by re-typing the shell's private divs, which is exactly
   how the screen drifted apart. See SECTION-CONTRACT.md. */
export { SectionFrame, SectionAbsent, type SectionFrameProps } from './SectionFrame';

/* ── individual frames, mountable on their own ────────────────────────────── */
export { ProfileSection } from './ProfileSection';
export { DangerSection } from './DangerSection';
export {
  MembersSection,
  ROLES_LEGEND,
  ROLE_RULES_NOTE,
  VIEWER_ROLE_FOOTNOTE,
  shortAge,
  type MembersSectionProps,
} from './MembersSection';
export {
  InvitesPanel,
  RedeemLanding,
  REDEEM_DEAD_WORD,
  joinUrlFor,
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

/**
 * The REFUSAL ledger. It used to be the GAP ledger — "every act this surface
 * draws that no seam can perform" — and 109 changed what most of it means:
 * roles and the whole invite family are wired now, so what remains is either a
 * genuine missing capability (member removal) or a rule that a particular
 * viewer does not satisfy (the not-admin locks).
 */
export { ALL_SETTINGS_REASONS } from './reasons';

/** DEV-ONLY review surface — every frame, both themes. Never product. */
export { SettingsBoard } from './SettingsBoard';
export { SPECIMEN_INVITES, SPECIMEN_REDEEM, specimenMembers } from './specimen';
