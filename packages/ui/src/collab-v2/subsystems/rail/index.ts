/** Connections rail (L2.2) barrel — the hierarchy + edges subsystem. */
import './rail.css';

export {
  ConnectionsRail, connectionsSlot,
  type ConnectionsRailProps, type ConnectionsSlot,
} from './ConnectionsRail';
export { HierarchySection, type HierarchySectionProps } from './HierarchySection';
export { EdgeGroupSection, type EdgeGroupSectionProps } from './EdgeGroupSection';
export { EdgeComposer, type EdgeComposerProps, type PickEntity } from './EdgeComposer';
export { useRailData, type RailData } from './useRailData';
export {
  CUSTOM_TYPE, GROUP_PREVIEW, RAIL_EDGE_TYPES,
  edgeEndpoints, groupKey, newMutationId, orderedGroups, otherEnd, planReorder,
  positionBetween, railEdgeLabel, resolutionBadge, unresolvedCount, waitingOn,
  type ReorderPlan, type ResolutionBadge,
} from './model';
