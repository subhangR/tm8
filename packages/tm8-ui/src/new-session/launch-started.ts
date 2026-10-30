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
