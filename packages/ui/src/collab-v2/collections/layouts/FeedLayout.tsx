/**
 * Feed layout — activity order (most recently active first), each row a Z2
 * card under an activity timestamp rule, regardless of the query's sort.
 */
import { useMemo } from 'react';
import { EntityCard } from '../../entity';
import type { EntityId, EntitySummary } from '../../types/contract';
import { setDragPayload } from '../dnd';
import { useListNav } from '../useListNav';

export interface FeedLayoutProps {
  items: EntitySummary[];
  onOpen: (id: EntityId) => void;
}

function timeAgo(iso: string): string {
  const delta = Date.now() - Date.parse(iso);
  const min = Math.max(0, Math.floor(delta / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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
            <span className="cv2-collection__feedtime">active {timeAgo(entity.activityAt)}</span>
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
