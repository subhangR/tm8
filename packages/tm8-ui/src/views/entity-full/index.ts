/**
 * The Z4 entity full view — `#/s/{spaceId}/e/{entityId}` (ruling M1) and the
 * landing place for a panel's promote ⤢.
 *
 * Mounted by NOBODY yet. Phase 2 wires it in `GateApp`; see the component's doc
 * comment for the prop-by-prop contract and the R15 history discipline.
 */
export { EntityFullView, companionOf } from './EntityFullView';
export type {
  EntityArrival,
  EntityCompanion,
  EntityFullViewProps,
  EntityLeaveStep,
} from './EntityFullView';
export type { EntityFullPort, EntityResolution } from './port';
