/**
 * Feed layout — activity order (most recently active first), each row a Z2
 * card under an activity timestamp rule, regardless of the query's sort.
 */
import { useMemo } from 'react';
import { EntityCard } from '../../entity';
import { Timestamp } from '../../kit';
import type { EntityId, EntitySummary } from '../../types/contract';
import { setDragPayload } from '../dnd';
import { useListNav } from '../useListNav';

export interface FeedLayoutProps {
  items: EntitySummary[];
  onOpen: (id: EntityId) => void;
}

export function FeedLayout({ items, onOpen }: FeedLayoutProps) {
  const ordered = useMemo(
    () => [...items].sort((a, b) => Date.parse(b.activityAt) - Date.parse(a.activityAt)),
    [items],
  );
  const nav = useListNav(ordered.length, (i) => { if (ordered[i]) onOpen(ordered[i].id); });

  return (
    <div className="cv2-collection__feed" role="list" onKeyDown={nav.onKeyDown}>
      {ordered.map((entity, i) => (
        <div key={entity.id} role="listitem" className="cv2-collection__feeditem">
          <div className="cv2-collection__feedrule">
            <Timestamp className="cv2-collection__feedtime" at={entity.activityAt} prefix="active" />
          </div>
          <div
            className="cv2-collection__cell"
            draggable
            onDragStart={(e) => setDragPayload(e, entity)}
            onClick={() => onOpen(entity.id)}
            onFocus={() => nav.setIndex(i)}
            {...nav.cellProps(i)}
          >
            <EntityCard entity={entity} />
          </div>
        </div>
      ))}
    </div>
  );
}
