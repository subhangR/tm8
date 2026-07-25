/**
 * Gallery layout — Z2 grid, grid-orientation arrow keys.
 */
import { EntityCard } from '../../entity';
import type { EntityId, EntitySummary } from '../../types/contract';
import { setDragPayload } from '../dnd';
import type { RowAction, RowSelection } from '../slots';
import { useListNav } from '../useListNav';

const GRID_COLUMNS = 3;

export interface GalleryLayoutProps {
  items: EntitySummary[];
  onOpen: (id: EntityId) => void;
  rowAction?: RowAction;
  selection?: RowSelection;
}

export function GalleryLayout({ items, onOpen, rowAction, selection }: GalleryLayoutProps) {
  const nav = useListNav(
    items.length,
    (i) => { if (items[i]) onOpen(items[i].id); },
    { orientation: 'grid', columns: GRID_COLUMNS },
  );
  const slots = Boolean(rowAction || selection);

  return (
    <div className="cv2-collection__gallery" role="list" onKeyDown={nav.onKeyDown}>
      {items.map((entity, i) => (
        <div
          key={entity.id}
          role="listitem"
          className={`cv2-collection__cell${slots ? ' cv2-collection__cell--slots' : ''}`}
          draggable
          onDragStart={(e) => setDragPayload(e, entity)}
          onClick={() => onOpen(entity.id)}
          onFocus={() => nav.setIndex(i)}
          {...nav.cellProps(i)}
        >
          {selection && (
            <input
              type="checkbox"
              className="cv2-collection__check"
              checked={selection.selectedIds.has(entity.id)}
              onChange={() => selection.onToggle(entity.id)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${entity.title}`}
            />
          )}
          <div className="cv2-collection__cellbody">
            <EntityCard entity={entity} />
          </div>
          {rowAction && (
            <span className="cv2-collection__rowaction" onClick={(e) => e.stopPropagation()}>
              {rowAction(entity)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
