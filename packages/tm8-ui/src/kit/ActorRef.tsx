/**
 * ActorRef — one actor, rendered from its PAYLOAD, no extra fetches
 * (doc 06 §2.2). The resolver (server `loadActors`) already did the work:
 *
 *   - a persona (kind `team_member`/`member`) renders as its Avatar — colour
 *     FNV-1a on the ACTOR id (never the display name), shape is provenance;
 *   - `via` present ⇒ the persona acted THROUGH a run: a "via session"
 *     suffix chip rides beside the name, carrying the session id for hosts
 *     that navigate;
 *   - kind `work_session` (no resolvable persona) ⇒ a session chip
 *     (▸ + title), NEVER an avatar — a run is not a person, and drawing a
 *     process with a face is the lie the honest kind exists to end.
 */
import type { ActorSummary } from '@tm8/contract';
import { actorPresentation } from '../domain/actors';
import { Avatar } from './Avatar';

export function ActorRef({
  actor,
  onOpenSession,
}: {
  actor: ActorSummary;
  /** Host navigation for the `via` chip / session chip. Absent ⇒ inert text. */
  onOpenSession?: (sessionId: string) => void;
}) {
  const presentation = actorPresentation(actor);

  if (presentation === 'run') {
    const open = onOpenSession ? () => onOpenSession(actor.id) : undefined;
    return (
      <span className="kit-actorref kit-actorref--run" data-testid="actor-ref-run">
        {open ? (
          <button type="button" className="kit-actorref__session" onClick={open}>
            {`▸ ${actor.displayName}`}
          </button>
        ) : (
          <span className="kit-actorref__session">{`▸ ${actor.displayName}`}</span>
        )}
      </span>
    );
  }

  const sessionId = actor.via?.sessionId;
  return (
    <span className="kit-actorref" data-testid="actor-ref">
      <Avatar
        actorId={actor.id}
        provenance={presentation}
        label={actor.displayName}
        size={15}
        src={actor.avatar ?? null}
      />
      <span className="kit-actorref__name">{actor.displayName}</span>
      {sessionId ? (
        onOpenSession ? (
          <button
            type="button"
            className="kit-actorref__via"
            data-testid="actor-ref-via"
            title="Acted through a session — open it"
            onClick={() => onOpenSession(sessionId)}
          >
            via session
          </button>
        ) : (
          <span className="kit-actorref__via" data-testid="actor-ref-via">
            via session
          </span>
        )
      ) : null}
    </span>
  );
}
