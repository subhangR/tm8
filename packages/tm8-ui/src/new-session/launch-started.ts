/**
 * THE LAUNCH HAND-OFF SEAM (task 01a182bb, lanes A and B) — what the launch
 * popup tells its host the moment Launch is pressed, before the node answers.
 *
 * The popup (lane A) calls `onLaunchStarted` synchronously on the press; a
 * host that returns true takes over the progress display (the launching page,
 * lane B) and the popup dismisses at once. Both lanes create this file with the
 * identical type, so the merge is trivial.
 */
import type { EntityId, ProjectId } from '@tm8/contract';
import type { LaunchVerb } from './LaunchCardV3';

export interface LaunchStarted {
  clientMutationId: string;        // the exact id sent in the spawn input
  subjectId: EntityId;             // the task/entity launched on
  title: string;                   // the session title the input carries
  verb: LaunchVerb;                // 'worker' | 'coordinator' | 'dispatcher' …
  teammate: { id: EntityId; name: string } | null;
  model: string | null; effort: string | null; accessMode: string | null;
  workdir: { kind: 'scratch' } | { kind: 'project'; projectId: ProjectId; mode: 'project' | 'worktree'; baseRef: string | null };
  notes: string;
}
