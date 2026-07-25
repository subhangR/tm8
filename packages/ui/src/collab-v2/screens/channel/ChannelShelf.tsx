/**
 * Shelf — the horizontal strip of pinned entity cards under the header: the
 * channel's "important things" (the spec doc, the milestone task, the on-call
 * agent). Pin is an edge prop, so the shelf is whatever the facade's channel
 * projection puts in `content.pinned` — every cell is the same Z2 EntityCard.
 */
import { EntityCard } from '../../entity';
import type { EntityId, EntitySummary } from '../../types/contract';

export interface ChannelShelfProps {
  items: EntitySummary[];
  onOpenEntity: (id: EntityId) => void;
}

export function ChannelShelf({ items, onOpenEntity }: ChannelShelfProps) {
  if (items.length === 0) {
    return (
      <div className="cv2-hub__shelf cv2-hub__shelf--empty" data-testid="channel-shelf">
        <p className="cv2-empty-line">Nothing pinned yet — pin a task or doc to shelve it here.</p>
      </div>
    );
  }
  return (
    <div className="cv2-hub__shelf" data-testid="channel-shelf" aria-label="Pinned">
      {items.map((item) => (
        <div
          key={item.id}
          role="button"
          tabIndex={0}
          className="cv2-hub__shelfcell"
          data-entity={item.id}
          onClick={() => onOpenEntity(item.id)}
          onKeyDown={(e) => { if (e.key === 'Enter') onOpenEntity(item.id); }}
        >
          <span className="cv2-hub__pin" aria-hidden="true">📌</span>
          <EntityCard entity={item} />
        </div>
      ))}
    </div>
  );
}
