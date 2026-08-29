/**
 * Actor PRESENTATION, derived once, in domain/ — the only layer allowed to
 * name kinds (§15.2; the no-branching test bans kind literals everywhere
 * else). The contract's `ActorSummary.kind` now honestly carries
 * `work_session` for a run with no resolvable persona, and the shape law is:
 * humans are round, agents are rounded-square, and a RUN IS NEVER AN AVATAR —
 * it renders as a session chip (▸ + title), because drawing a process with a
 * face is the exact lie the honest kind exists to end.
 */
import type { ActorSummary } from '@tm8/contract';

export type ActorPresentation = 'human' | 'agent' | 'run';

export function actorPresentation(
  actor: Pick<ActorSummary, 'kind' | 'isAgent'>,
): ActorPresentation {
  if (actor.kind === 'work_session') return 'run';
  return actor.isAgent ? 'agent' : 'human';
}
