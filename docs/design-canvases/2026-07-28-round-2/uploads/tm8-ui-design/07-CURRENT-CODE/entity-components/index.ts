/** Entity component system barrel (L1) — one system, parameterized by kind. */
import './entity.css';

export { CollabFacadeProvider, useFacade } from './context';
export { REGISTRY_CTX } from './ctx';
export { EntityChip, ENTITY_DRAG_MIME, type EntityChipProps, type EntityDragPayload } from './EntityChip';
export { EntityCard, type EntityCardProps } from './EntityCard';
export { ChipById, CardById } from './EntityById';
export {
  EntityPanel, PANEL_TABS,
  type EntityPanelProps, type EntityPanelSlots,
} from './EntityPanel';
export {
  EntityFullView,
  type EntityFullViewProps, type EntityFullViewSlots,
} from './EntityFullView';
export { Tombstone, type TombstoneProps } from './Tombstone';
export { ChipSkeleton, EntityCardSkeleton, EntityPanelSkeleton } from './skeletons';
