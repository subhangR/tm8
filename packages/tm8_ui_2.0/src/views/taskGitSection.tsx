/**
 * The task detail's GIT section, composed once per host — the same shape as
 * `debugSurface.tsx` / `gitSurface.tsx` and for the same reason: the panel
 * layer is presentational, so the seam-reaching body is composed HERE and a
 * host opts in with one call.
 *
 * `completionGate` rides the DETAIL's task state (additive projection); an
 * older node that does not project it renders a section with no gate claim.
 */
import type { ReactNode } from 'react';
import type { EntityDetail, EntityId } from '@tm8/contract';
import { TaskGitSection } from '../git/TaskGitSection';
import type { Seam } from '../data/seam';

export function taskGitSectionFor(
  seam: Seam | undefined,
  detail: EntityDetail | null | undefined,
  onOpenEntity?: (id: string) => void,
): ReactNode | undefined {
  if (!seam || !detail || detail.kind !== 'task') return undefined;
  const gate = detail.state.kind === 'task' ? detail.state.completionGate : undefined;
  return (
    <TaskGitSection
      seam={seam}
      taskId={detail.id as EntityId}
      completionGate={gate}
      onOpenEntity={onOpenEntity}
    />
  );
}
