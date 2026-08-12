/**
 * Notification row — a NotificationItem is not an entity, so the row itself is
 * screen chrome; its *target* renders as a real `EntityChip` (Z1), its actor as
 * the kit Avatar, and its kind as a Pill driven by the kind table.
 */
import { EntityChip } from '../../entity';
import { Avatar, Pill, Timestamp } from '../../kit';
import type { EntityId, NotificationItem } from '../../types/contract';
import { specForNotification } from './kinds';

export interface NotificationRowProps {
  item: NotificationItem;
  read: boolean;
  spaceName?: string;
  /** Marks read and opens the target panel. */
  onActivate: (item: NotificationItem) => void;
  onOpenEntity: (id: EntityId) => void;
}

export function NotificationRow({
  item, read, spaceName, onActivate, onOpenEntity,
}: NotificationRowProps) {
  const spec = specForNotification(item.kind);
  return (
    <li
      className="cv2-inbox__row"
      data-read={read ? 'true' : 'false'}
      data-kind={item.kind}
      data-testid={`notif-${item.id}`}
    >
      <button
        type="button"
        className="cv2-inbox__main"
        data-testid={`notif-main-${item.id}`}
        aria-label={`${spec.label}: ${item.message ?? ''}${read ? '' : ' (unread)'}`}
        onClick={() => onActivate(item)}
      >
        <span className="cv2-inbox__dot" data-unread={read ? undefined : 'true'} aria-hidden="true" />
        <Pill tone={spec.tone} dot={false}>{spec.label}</Pill>
        {item.actor && <Avatar actor={item.actor} size={20} />}
        <span className="cv2-inbox__msg">{item.message}</span>
        <Timestamp className="cv2-inbox__time" at={item.createdAt} />
      </button>
      <div className="cv2-inbox__meta">
        {spaceName && <span className="cv2-inbox__space">{spaceName}</span>}
        {item.target && <EntityChip entity={item.target} variant="ref" onOpen={onOpenEntity} />}
      </div>
    </li>
  );
}
