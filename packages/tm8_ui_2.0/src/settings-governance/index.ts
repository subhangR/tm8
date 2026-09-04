/**
 * `src/settings-governance/` — T2 half B: projects & trust (T2-2), interaction
 * profiles (T2-4), custom-kind authoring (T2-5).
 *
 * MOUNTABLE, NOT MOUNTED. Nothing here is wired into a screen: the coordinator
 * holds the wiring seat, and `HANDOVER.md` in this directory carries the exact
 * props and the exact call sites. Following `kit/`, `panels/`, `authoring/`,
 * `home/` and `settings-space/`, the stylesheet is imported by the SCREENS
 * (and therefore by this barrel), so a host that imports one symbol cannot end
 * up with a half-styled screen.
 *
 * Half A of T2 (`settings-space/`: T2-1 space settings, T2-3 menu editor) is a
 * sibling lane. The two are designed to sit inside one settings shell —
 * `settings-space/SettingsShell.tsx` owns the section nav, and these three
 * screens are section BODIES. See HANDOVER.md §7.
 */
import './governance.css';

export {
  ProjectsTrustScreen,
  UntrustedConsentCard,
  SessionProjectsCard,
  type ProjectsTrustScreenProps,
  type UntrustedConsentRequest,
  type UntrustedConsentDecision,
} from './ProjectsTrustScreen';

export {
  InteractionProfilesScreen,
  type InteractionProfilesScreenProps,
} from './InteractionProfilesScreen';

export { CustomKindsScreen, type CustomKindsScreenProps } from './CustomKindsScreen';

export {
  governancePortFromSeam,
  PROFILE_SLUG,
  PROJECT_SLUG,
  type GovernanceData,
  type GovernancePort,
  type LoadState,
} from './port';

export {
  GOVERNANCE_GAPS,
  GOVERNANCE_REASONS,
  type GovernanceGap,
  type GovernanceReasonId,
} from './reasons';

export {
  PROFILE_LIFECYCLE,
  SCRATCH_LABEL,
  UNIVERSAL_SPINE,
  draftKindId,
  draftRouteSlug,
  draftToCreateInput,
  emptyKindDraft,
  fieldTreatment,
  frozenNote,
  known,
  moveField,
  profileGroups,
  profileRowOf,
  projectRowOf,
  rankDefaults,
  slugifyKindName,
  unknown,
  unlinkRefusal,
  untrustRefusal,
  validateKindDraft,
  type DraftField,
  type DraftIssue,
  type KindDraft,
  type Known,
  type ProfileDefaultScope,
  type ProfileGroup,
  type ProfileLifecycle,
  type ProfileRow,
  type ProjectFacts,
  type ProjectRow,
  type SessionProjects,
} from './governance-model';
