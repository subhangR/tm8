/**
 * Tombstone — the deleted entity, preserving history shape. Chips in threads
 * and rails become tombstone chips; cards keep their footprint (title struck,
 * counters intact) so lists don't reflow when history is kept honest.
 */
import { TOMBSTONE, registryFor, relTime } from '../registry';
import type { EntitySummary } from '../types/contract';

export interface TombstoneProps {
  entity: EntitySummary;
  variant?: 'chip' | 'card';
}

export function Tombstone({ entity, variant = 'chip' }: TombstoneProps) {
  const entry = registryFor(entity.kind);
  const label = TOMBSTONE.label(entity.kind);

  if (variant === 'chip') {
    return (
      <span className="cv2-chip cv2-chip--tombstone" data-kind={entity.kind} title={`${label} · ${entity.title}`}>
        <span className="cv2-chip__glyph" aria-hidden="true">{TOMBSTONE.glyph}</span>
        <s className="cv2-chip__label">{entity.title}</s>
        <span className="cv2-chip__meta">{label}</span>
      </span>
    );
  }

  return (
    <div className="cv2-card cv2-card--tombstone" data-kind={entity.kind}>
      <div className="cv2-card__head">
        <span className="cv2-chip__glyph" aria-hidden="true">{TOMBSTONE.glyph}</span>
        <span className="cv2-card__kind">{entry.label}</span>
        <span className="cv2-card__kind">{label}</span>
      </div>
      <div className="cv2-card__title"><s>{entity.title}</s></div>
      <div className="cv2-card__foot">
        <span className="cv2-count">👍 {entity.counters.likes}</span>
        <span className="cv2-count">⭐ {entity.counters.stars}</span>
        <span className="cv2-count">◈ {entity.counters.points}</span>
        <span className="cv2-count">💬 {entity.counters.messages}</span>
        {entity.deletedAt && <span className="cv2-count cv2-count--right">deleted {relTime(entity.deletedAt)}</span>}
      </div>
    </div>
  );
}
