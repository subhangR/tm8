/**
 * `src/domain/` — THE KIND REGISTRY, the spine (LLD §2).
 *
 * This barrel is the ONLY entry point. Consumers (panels, collections, views,
 * shell, routes, stores) import from here and branch on nothing: L2 says a
 * per-kind behavior with no registry field is a spec defect, never an inline
 * `kind === …`. The kind string literals live in this directory and in
 * `src/fixtures/` — nowhere else (§15.2 CI rule).
 */

export type {
  ActionAvailability,
  ActionContext,
  ActionDef,
  ActionDispatch,
  ActionIntent,
  ActionRef,
  AssignControl,
  BodyArchetype,
  CardFieldRef,
  CardSpec,
  ChipSpec,
  CollectionMode,
  ContentBlockKind,
  ContentBlockRef,
  ContentSurfaces,
  CustomKindFallback,
  EditFieldSpec,
  FilterOption,
  FilterSpec,
  GroupByKey,
  Hash,
  IconRef,
  KindConfig,
  LifecycleTier,
  ListConfig,
  ListPageState,
  ListRowFacts,
  ListSection,
  LiveTreatment,
  MembershipListControl,
  PanelConfig,
  PulseBinding,
  QueryFilter,
  RouteStrategy,
  SetStateOutcome,
  SortKey,
  SortSpec,
  StateControl,
  StateOption,
  StatusPillSpec,
  StatusSource,
  TileBadgeSource,
  TileBadgeSpec,
  ValueControl,
  ValueOption,
} from './types';

export {
  CUSTOM_KIND_FALLBACK,
  VIEWER_ACTOR,
  countLabel,
  customKindSlug,
  needsViewer,
} from './types';

export {
  ALL_MODES,
  RESERVED_SLUGS,
  allKinds,
  collectionKinds,
  getKind,
  isReservedSlug,
  kindBySlug,
  kindOfSlug,
  slugOfKind,
} from './registry';

export { KIND_ART, VIEW_ART, type KindArt } from './kind-art';
export { KindIcon } from './KindIcon';
export { tileCountBadgesOf, type TileCountBadge } from './tile-counts';

export { REASONS, allActions, deferredActions, resolveAction } from './actions';

export {
  PREDATES_MERGE_DOOR,
  mergeRefusalOf,
  mergeRefusalText,
  type MergeRefusal,
} from './pr-merge';

export { actorPresentation, type ActorPresentation } from './actors';

export { QUIET_SESSION_DETAIL, needsAttentionOf, toRowFacts } from './needs-attention';

export {
  AGENT_TOOLS,
  LAUNCH_MODES,
  SCRATCH_OPTION,
  UNTRUSTED_REASON,
  ADDITIONAL_PROJECTS_UNAVAILABLE_REASON,
  PROFILE_PINNED_CAPTION,
  PROFILE_STATUS_REASON,
  profileRefusal,
  profileSelectable,
  resolveProfileChain,
  agentTool,
  buildSpawnInput,
  canLaunch,
  defaultConfigFor,
  defaultLaunchTarget,
  describeCapacity,
  describeLaunchManifest,
  describeTeammateLoad,
  describeProfile,
  modelsFor,
  newLaunchMutationId,
  EDGES_NOT_HYDRATED_REASON,
  ACCESS_MODE_CYCLE,
  accessModeLabel,
  describeAccessMode,
  nextAccessMode,
} from './launch';
export type {
  AgentToolDef,
  LaunchAccessMode,
  LaunchCapacity,
  LaunchConfig,
  LaunchMode,
  LaunchModeDef,
  LaunchProjectOption,
  LaunchRefusal,
  LaunchTarget,
  ManifestDescription,
  ManifestFact,
  ModelDef,
  ProfileChainStep,
  ProfileResolution,
  LaunchProfileOption,
  TeammateLaunchState,
} from './launch';

export { placeholderNameFor, slugifyTitle, titleNormalizerFor } from './title-grammar';

/** W4 — per-type status vocabularies (132): the one client-side statement of the rule. */
export {
  STRUCTURAL_STATUSES,
  WORKFLOW_AXIS,
  offWorkflowType,
  workflowRefusalText,
  workflowTypeOf,
  workflowVocabularyOf,
} from './workflows';

export {
  SHIPPED_DEFAULT_MENU,
  SHIPPED_DEFAULT_MENU_REVISION,
  isMenuEligibleKind,
  menuKindRefs,
  unrenderableKindRefs,
} from './menu';

/** The merged Home page's rail/presence kinds — registry-adjacent data (D18). */
export { HOME_PRESENCE_KIND, HOME_RAIL_KINDS } from './home-page';
export { CATEGORY_DEFAULT_STATUS } from './status-categories';
export {
  CHATS_ROOT,
  DEFAULT_HOME_KIND,
  LEGACY_HOME_TAB_KINDS,
  homeRailGroups,
  homeRootKinds,
  isHomeRootKind,
  type HomeRailGroup,
  type HomeRoot,
} from './home-rail';

/**
 * The MenuTarget <-> NavView mapping. Exported from the barrel because the
 * shell composes from `domain/`, and this is the one place the two navigation
 * vocabularies are joined.
 */
export { VIEW_REF_ROUTE, landingOfRoute, navViewOfName, routeViewOf } from './nav-targets';
export type { Landing } from './nav-targets';
