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

/**
 * The word a tombstoned membership adds after the name (G6, migration 231).
 * `left` and `removed` both render as "(left)": the reader needs to know
 * this person is no longer here, and who ended it is not theirs to learn
 * from a byline.
 */
export const LEFT_SUFFIX = '(left)';

/**
 * An actor's name as every byline and assignee label should print it. The
 * actor and everything they authored still render after their membership
 * ends; `memberStatus` is present only then, and adds " (left)".
 */
export function actorName(
  actor: Pick<ActorSummary, 'displayName'> & { memberStatus?: ActorSummary['memberStatus'] },
): string {
  return actor.memberStatus ? `${actor.displayName} ${LEFT_SUFFIX}` : actor.displayName;
}
