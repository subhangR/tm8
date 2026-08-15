/**
 * Shell public surface (LLD §4). Views and the App compose from here; nothing
 * outside `src/shell/` should reach past this barrel into a component file.
 */

// The geometry law (§5.1/§5.3) — pure, store-free, unit-tested in isolation.
export {
  GRID_GAP,
  LEFT_PANEL_DEFAULT,
  LEFT_PANEL_MIN,
  MAX_PINNED,
  MENU_COLLAPSED,
  MENU_EXPANDED,
  PANEL_COL_MIN,
  RIGHT_PANEL_DEFAULT,
  RIGHT_PANEL_MIN,
  SERVER_RAIL_HIDDEN,
  SERVER_RAIL_SHOWN,
  TERMINAL_HOST_MIN_HEIGHT,
  admitPin,
  cMin,
  cMinFor,
  normalize,
  panelSlots,
  solveWorkspace,
  type AdmissionInput,
  type NormalizeInput,
  type NormalizeResult,
  type PanelStackMode,
  type PinAdmission,
  type PinRefusal,
  type PinRefusalReason,
  type PoolFacts,
  type SolveInput,
  type WorkspaceLayout,
} from './geometry';

export { PanelStack, type PanelStackProps } from './PanelStack';
export {
  WorkspaceGrid,
  type WorkspaceGridProps,
  type WorkspacePanelSide,
} from './WorkspaceGrid';
export { Z4Host, type Z4HostProps } from './Z4Host';
export {
  MenuRail,
  ADD_SERVER_DISABLED_REASON,
  type KindPresenter,
  type MenuDynamicGroup,
  type MenuEntityRow,
  type MenuRailProps,
  type MenuTarget,
  type RefPresentation,
  type ServerRailItem,
} from './MenuRail';
export { SpaceTabBar, type SpaceTabBarProps } from './SpaceTabBar';
export {
  SpaceSwitcher,
  SWITCHER_ADD_SERVER_REASON,
  SWITCHER_ADD_SPACE_REASON,
  type SpaceSwitcherProps,
} from './SpaceSwitcher';
export { NoticeHost, useNotices, type NoticeHostHandle, type NoticeHostProps } from './NoticeHost';
export {
  NOTICE_TTL_MS,
  demotionNotice,
  describeDropped,
  overflowNotice,
  type DroppedClass,
  type Notice,
  type NoticeTone,
} from './notices';
// The shipped default CONSTANT is re-exported from `src/domain` (D18), not
// from here — shell owns the resolver, domain owns the kind-naming data.
export {
  VIEW_PRESENTATION,
  resolveMenu,
  type MenuFallbackReason,
  type MenuSource,
  type ResolvedMenu,
} from './menu-resolve';
export {
  usePanelEngine,
  useMeasuredWidth,
  type PanelEngine,
  type PanelEngineOptions,
} from './usePanelEngine';
export {
  selectPanelIds,
  selectVisibleCount,
  type ContentSurface,
  type NavPanelState,
  type NavPort,
  type PanelHost,
  type PanelTab,
  type PinOutcome,
} from './nav-port';
