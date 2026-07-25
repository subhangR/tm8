/**
 * Shared per-row slot contracts for the collection layouts. Screens pass
 * these through `CollectionView` so List/Board/Tree/Gallery rows can carry
 * screen-owned affordances (quick actions, bulk-select) without each screen
 * rebuilding its own row component.
 */
import type { ReactNode } from 'react';
import type { EntityId, EntitySummary } from '../types/contract';

/** Per-row trailing action slot (kebab menu, quick buttons). */
export type RowAction = (entity: EntitySummary) => ReactNode;

/** Checkbox mode — rows render a leading checkbox bound to this set. */
export interface RowSelection {
  selectedIds: ReadonlySet<EntityId>;
  onToggle: (id: EntityId) => void;
}
