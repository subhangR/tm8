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
  BodyArchetype,
  CardFieldRef,
  CardSpec,
  ChipSpec,
  CollectionMode,
  ContentBlockKind,
  ContentBlockRef,
  ContentSurfaces,
  CustomKindFallback,
  FilterOption,
  FilterSpec,
  GroupByKey,
  Hash,
  IconRef,
  KindConfig,
  LifecycleTier,
  ListConfig,
  ListRowFacts,
  ListSection,
  LiveTreatment,
  PanelConfig,
  PulseBinding,
  QueryFilter,
  RouteStrategy,
  SortKey,
  SortSpec,
  StatusPillSpec,
  StatusSource,
  TileBadgeSource,
  TileBadgeSpec,
} from './types';

export { CUSTOM_KIND_FALLBACK, customKindSlug } from './types';

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

export { REASONS, allActions, deferredActions, resolveAction } from './actions';

export {
  SHIPPED_DEFAULT_MENU,
  SHIPPED_DEFAULT_MENU_REVISION,
  isMenuEligibleKind,
  menuKindRefs,
  unrenderableKindRefs,
} from './menu';
