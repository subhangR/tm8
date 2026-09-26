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
  AttachPaletteRow,
  BodyArchetype,
  CardFieldRef,
  CardSpec,
  ChipSpec,
  CollectionMode,
  ContentBlockKind,
  ContentBlockRef,
  CustomKindFallback,
  DateControl,
  EditFieldSpec,
  FilterOption,
  FilterSpec,
  GroupByKey,
  Hash,
  IconRef,
  KindConfig,
  StatusCategoryTab,
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

export { KIND_ART, SURFACE_ART, SURFACE_LABEL, VIEW_ART, type KindArt } from './kind-art';
export { KindIcon } from './KindIcon';
export { tileCountBadgesOf, type TileCountBadge } from './tile-counts';

export {
  PROCESS_CONTROL,
  REASONS,
  SHARING_CONTROL,
  allActions,
  deferredActions,
  hasEnded,
  processControlFor,
  resolveAction,
  sharingControlFor,
  sessionSharingOf,
  type SessionSharing,
} from './actions';

export {
  PREDATES_MERGE_DOOR,
  mergeRefusalOf,
  mergeRefusalText,
  type MergeRefusal,
} from './pr-merge';

export { actorName, actorPresentation, LEFT_SUFFIX, type ActorPresentation } from './actors';

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
  launchHarnessFacts,
  LAUNCH_CONTEXT_ROLE_LABEL,
  LAUNCH_CONTEXT_SOURCE_LABEL,
  launchContextFacts,
  launchCredentialFacts,
  launchSpaceCredentialIds,
  LAUNCH_SOURCE_WORD,
  describeTeammateLoad,
  describeProfile,
  modelsFor,
  newLaunchMutationId,
  pluginFactsOf,
  routePluginPick,
  type LaunchPluginFacts,
  type LaunchPluginSkills,
  type LoadInstalledPlugins,
  EDGES_NOT_HYDRATED_REASON,
  ACCESS_MODE_CYCLE,
  accessModeLabel,
  describeAccessMode,
  nextAccessMode,
  AGENT_CREDENTIAL_PROVIDER,
  CREDENTIAL_PROVIDER_LABEL,
  EFFORT_LABELS,
  effortLabel,
} from './launch';
export type {
  AgentToolDef,
  LaunchAccessMode,
  LaunchCredentialSource,
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
  HOME_RAIL_WITHHELD_KINDS,
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
export { CHANNEL_KIND, VIEW_REF_ROUTE, landingOfRoute, navViewOfName, routeViewOf } from './nav-targets';
export type { Landing } from './nav-targets';

/* SC-5: the launch picker's credential source options (D4/D5/D6a/D10). */
export {
  disabledSourcesNote,
  githubAuthorshipLine,
  isSpaceCredentialProvider,
  launchSourceOptions,
  launchableSpaceCredentials,
  parseLaunchSourceChoice,
  sourcePolicyReason,
} from './launch-sources';
export type { LaunchSourceChoice, LaunchSourceOption, LaunchSourceOptionsInput } from './launch-sources';

/* The Connections tab's words: one verb per edge type and direction, read from
   the open entity's side, plus which edges are messages rather than links. */
export { CONVERSATION_KIND, EDGE_VERBS, edgeVerb, edgeVerbBoth, isConversationEdge } from './edge-verbs';
export type { EdgeDirection, EdgeVerb } from './edge-verbs';

/* I9a: the authored selection header — which kinds carry one, and the
   editor's draft ↔ `HeaderTextInput` crossing. */
export {
  EMPTY_HEADER_DRAFT,
  HEADER_GUIDANCE,
  headerAuthorable,
  headerDraftHasText,
  headerDraftOf,
  headerDraftsEqual,
  headerInputOf,
  headerInputOfView,
  headerStaleness,
  parseKeywords,
  staleSentence,
} from './header';
export type { HeaderDraft } from './header';
