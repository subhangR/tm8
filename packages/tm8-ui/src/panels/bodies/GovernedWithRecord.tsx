import { useMemo } from 'react';
import type { EntityDetail } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import { recordFor, useProjectRecords, type ProjectRecordPort } from '../../projects/project-record';
import { GovernedBody, type GovernedBlockRef } from './GovernedBody';
import type { GovernedRecordControls } from './GovernedRecord';

/**
 * The governed body with its record read: the host hands a record port, this
 * finds the entity's folder record in it and binds the writes and git reads to
 * that folder. With no port the body renders exactly as before (not loaded).
 */
export function GovernedWithRecord({
  detail,
  blocks,
  port,
  livenessOf,
  onOpenEntity,
}: {
  detail: EntityDetail;
  blocks: readonly GovernedBlockRef[];
  port: ProjectRecordPort | null;
  livenessOf?: (id: string) => SessionLiveness;
  onOpenEntity?: (id: string) => void;
}) {
  const { state, replace } = useProjectRecords(port);
  const resource = state.phase === 'ready' ? recordFor(state.records, detail.id, detail.content) : undefined;
  const folderId = resource?.id ?? null;

  const controls = useMemo<GovernedRecordControls | undefined>(() => {
    if (!port || !folderId) return undefined;
    const update = port.update;
    return {
      branches: () => port.branches(folderId),
      worktrees: () => port.worktrees(folderId),
      ...(update
        ? {
            update: async (patch) => {
              const next = await update(folderId, patch);
              replace(next);
              return next;
            },
          }
        : {}),
      ...(port.directories ? { directories: port.directories } : {}),
    };
  }, [port, folderId, replace]);

  return (
    <GovernedBody
      detail={detail}
      blocks={blocks}
      {...(resource !== undefined ? { resource } : {})}
      {...(controls ? { recordControls: controls } : {})}
      {...(livenessOf ? { livenessOf } : {})}
      {...(onOpenEntity ? { onOpenEntity } : {})}
    />
  );
}
