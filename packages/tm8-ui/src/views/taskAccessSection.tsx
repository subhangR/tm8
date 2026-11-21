import type { ReactNode } from 'react';
import type { EntityDetail, EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { TaskAccessSection } from '../task-access/TaskAccessSection';

/** The same viewer-scoped task access surface in every panel host. */
export function taskAccessSectionFor(
  seam: Seam | undefined,
  detail: EntityDetail | null | undefined,
  onOpenEntity?: (id: string) => void,
): ReactNode | undefined {
  if (!seam || !detail || detail.kind !== 'task' || detail.deletedAt) return undefined;
  return <TaskAccessSection key={detail.id} seam={seam} taskId={detail.id as EntityId} onOpenEntity={onOpenEntity} />;
}
