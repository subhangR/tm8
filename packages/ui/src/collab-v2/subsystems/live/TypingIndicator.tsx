/**
 * TypingIndicator — "Mira is typing…" under a thread composer. Names resolve
 * from the graph store when it knows the actor; otherwise it degrades to a
 * count rather than inventing an identity.
 */
import type { EntityId } from '../../types/contract';
import { useActors, useTypingOf } from './useLive';

export interface TypingIndicatorProps {
  /** The thread anchor (channel / task / doc / member wall). */
  anchorId: EntityId;
  /** Actor ids to ignore — normally the viewer's own. */
  excludeIds?: EntityId[];
  /** Override the store (pure/demo use). */
  typingActorIds?: EntityId[];
}

function phrase(names: string[], unknown: number): string {
  const total = names.length + unknown;
  if (total === 0) return '';
  if (names.length === 0) return total === 1 ? 'Someone is typing…' : `${total} people are typing…`;
  if (total === 1) return `${names[0]} is typing…`;
  if (total === 2) return `${names[0]} and ${names[1] ?? 'someone'} are typing…`;
  return `${names[0]} and ${total - 1} others are typing…`;
}

export function TypingIndicator({ anchorId, excludeIds, typingActorIds }: TypingIndicatorProps) {
  const fromStore = useTypingOf(anchorId);
  const ids = (typingActorIds ?? fromStore).filter((id) => !excludeIds?.includes(id));
  const actors = useActors(ids);
  const named = actors
    .map((a) => ('displayName' in a ? a.displayName : null))
    .filter((n): n is string => Boolean(n));
  const text = phrase(named, ids.length - named.length);

  if (!text) return null;

  return (
    <div className="cv2-typing" data-testid="typing-indicator" role="status" aria-live="polite">
      <span className="cv2-typing__dots" aria-hidden="true">
        <i /><i /><i />
      </span>
      <span className="cv2-typing__text">{text}</span>
    </div>
  );
}
