/**
 * `src/panels/` — the two universal primitives (L3) and their bodies.
 *
 * Stylesheets are imported by the barrel so any consumer that renders a panel
 * gets its styles, with no bootstrap file to remember to edit — which also
 * keeps these modules drop-in for whoever composes the shell.
 */
import '../styles/canvas-extra.css';
import './honesty/honesty.css';
import './panels.css';

export {
  EntityListPanel,
  type BoardSnapshot,
  type EntityListPanelProps,
  type LaunchSources,
  type ListPicker,
} from './EntityListPanel';
export {
  ListRootHeader,
  rootBirthAction,
  type ListRootChatsCell,
  type ListRootHeaderProps,
  type ListRootOption,
} from './ListRootHeader';
export {
  EntityControlStrip,
  type ControlHost,
  type ControlSubject,
} from './controls/EntityControls';
export {
  EntityDetailPanel,
  countConnections,
  type DetailReasons,
  type EntityDetailPanelProps,
  type MergePrSources,
} from './EntityDetailPanel';
export {
  PANEL_TABS,
  panelActionContext,
  panelMenuItems,
  type PanelHost,
  type PanelMenuItem,
  type PanelTab,
} from './detail/chrome';
export {
  EmptyBody,
  ErrorBody,
  LoadingBody,
  PermissionLostPanel,
  StalePinBanner,
  TombstoneBody,
} from './detail/PanelStates';
export {
  NewContainerSheet,
  buildContainersCreateInput,
  NEW_CONTAINER_DEFAULTS,
  type NewContainerDraft,
  type NewContainerSheetProps,
} from './NewContainerSheet';
export { GenericBody } from './bodies/GenericBody';
/* `MachineBody` imports its OWN stylesheet (the GovernedBody/HubBody pattern),
   so a deep-path import of this component still arrives styled — the
   barrel-only-CSS trap does not apply to a body. */
export { MachineBody, type MachineBodyProps } from './bodies/MachineBody';
export { TerminalBody, type TerminalBodyProps } from './bodies/TerminalBody';
export { SharedContextSection } from './share/SharedContextSection';
export { ShareDragGhost, ShareDropTarget } from './share/ShareDropTarget';
export {
  deliveryFacet,
  isFullySettled,
  recordFacet,
  withdrawalAudit,
  type FacetView,
} from './share/facets';
export {
  DisabledAction,
  DisabledIconControl,
  toReason,
  type UnavailableReason,
} from './honesty/DisabledWithReason';
export { HollowInline, HollowStat } from './honesty/HollowValue';
export { ReasonNote } from './honesty/ReasonNote';
