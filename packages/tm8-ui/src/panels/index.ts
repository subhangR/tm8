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
  ListViewSwitcher,
  type BoardSnapshot,
  type EntityListPanelProps,
  type LaunchSources,
} from './EntityListPanel';
export {
  EntityControlStrip,
  type ControlHost,
  type ControlSubject,
} from './controls/EntityControls';
export {
  EntityDetailPanel,
  type DetailReasons,
  type EntityDetailPanelProps,
  type MergePrSources,
} from './EntityDetailPanel';
export { PANEL_TABS, type PanelHost, type PanelTab } from './detail/chrome';
export {
  EmptyBody,
  ErrorBody,
  LoadingBody,
  PermissionLostPanel,
  StalePinBanner,
  TombstoneBody,
} from './detail/PanelStates';
export { GenericBody } from './bodies/GenericBody';
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
