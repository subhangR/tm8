/**
 * PresenceAvatars — "who is on this entity right now". Overlapping avatars,
 * humans round / agents rounded-square (the kit encodes the provenance), with
 * a +N overflow. Reads the presence store; an optional facade seeds the first
 * snapshot.
 */
import { Avatar } from '../../kit';
import type { ActorSummary, EntityId } from '../../types/contract';
import type { CollabFacade } from '../../facade/CollabFacade';
import { usePresenceOf } from './useLive';

export interface PresenceAvatarsProps {
  entityId: EntityId;
  /** Seeds the store once when the entity has no snapshot yet. */
  facade?: CollabFacade;
  /** Viewers to render instead of the store (pure/demo use). */
  viewers?: ActorSummary[];
  max?: number;
  size?: number;
  /** Hide the "viewing" word and render avatars only. */
  compact?: boolean;
}

export function PresenceAvatars({
  entityId, facade, viewers: override, max = 4, size = 20, compact = false,
}: PresenceAvatarsProps) {
  const snapshot = usePresenceOf(entityId, facade);
  const viewers = override ?? snapshot?.viewers ?? [];
  if (viewers.length === 0) return null;

  const shown = viewers.slice(0, max);
  const overflow = viewers.length - shown.length;
  const names = viewers.map((v) => v.displayName).join(', ');

  return (
    <span
      className="cv2-presence"
      data-testid="presence-avatars"
      title={`${names} ${viewers.length === 1 ? 'is' : 'are'} viewing`}
      aria-label={`${viewers.length} viewing: ${names}`}
    >
      <span className="cv2-presence__stack">
        {shown.map((actor) => (
          <span className="cv2-presence__slot" key={actor.id}>
            <Avatar actor={actor} size={size} />
          </span>
        ))}
        {overflow > 0 && (
          <span className="cv2-presence__more" style={{ width: size, height: size }}>+{overflow}</span>
        )}
      </span>
      {!compact && <span className="cv2-presence__word">viewing</span>}
    </span>
  );
}
