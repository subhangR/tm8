/**
 * Collection system barrel (Layer 4) — ONE CollectionView for every list of
 * entities (six layouts) + the GraphCanvas showcase.
 */
import './collections.css';

export { CollectionView, type CollectionViewProps } from './CollectionView';
export {
  COLLECTION_LAYOUTS, LayoutSwitcher, GroupByPivot, SaveViewControl,
  type CollectionLayout,
} from './controls';
export { EmptyState } from './EmptyState';
export { useCollection, type UseCollectionValue } from './useCollection';
export { useListNav, type ListNav } from './useListNav';
export {
  groupItems, boardColumns, axisNameOf, isAxisGroupBy, STATUS_ORDER,
  type BoardColumn, type GroupByKey,
} from './grouping';
export {
  moveTaskToStatus, moveTaskToAxisValue, assignTaskTo, reparentEntity,
  nextMutationId, type MutationOutcome,
} from './mutations';
export { setDragPayload, readDragPayload, hasDragPayload } from './dnd';
export type { RowAction, RowSelection } from './slots';
export { ListLayout } from './layouts/ListLayout';
export { BoardLayout } from './layouts/BoardLayout';
export { TreeLayout } from './layouts/TreeLayout';
export { FeedLayout } from './layouts/FeedLayout';
export { GalleryLayout } from './layouts/GalleryLayout';
export * from './graph';
