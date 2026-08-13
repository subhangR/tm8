/**
 * AvatarStack — up to three actors + "+n" (doc 06 §2.4). Order is the
 * CALLER's (recency, by convention); keyed by actor id; provenance shapes
 * preserved; one tooltip per avatar with the full name. Run-shaped actors
 * (kind `work_session`) are counted but never drawn as a face — they fold
 * into the overflow count, because a stack of faces must contain only faces.
 */
import type { ActorSummary } from '@tm8/contract';
import { actorPresentation } from '../domain/actors';
import { Avatar } from './Avatar';

const VISIBLE = 3;

export function AvatarStack({ actors, total = actors.length }: { actors: readonly ActorSummary[]; total?: number }) {
  if (actors.length === 0) return null;
  const faces = actors.filter((actor) => actorPresentation(actor) !== 'run');
  const shown = faces.slice(0, VISIBLE);
  const overflow = Math.max(total - shown.length, 0);
  return (
    <span className="kit-avatarstack" data-testid="avatar-stack">
      {shown.map((actor) => (
        <Avatar
          key={actor.id}
          actorId={actor.id}
          provenance={actorPresentation(actor) === 'agent' ? 'agent' : 'human'}
          label={actor.displayName}
          size={15}
          src={actor.avatar ?? null}
        />
      ))}
      {overflow > 0 ? <span className="kit-avatarstack__more">{`+${overflow}`}</span> : null}
    </span>
  );
}
