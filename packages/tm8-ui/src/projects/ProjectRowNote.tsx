import { useCallback, type ReactNode } from 'react';
import type { EntityDetail, EntitySummary } from '@tm8/contract';

import { recordFor, shortPath, useProjectRecords, type ProjectRecordPort } from './project-record';

/**
 * THE PROJECTS LIST'S SECOND LINE: where the project's work starts, and
 * whether agents run there without asking. A project row's summary carries
 * neither, so this reads the space's folder records once and answers per row.
 *
 * A record without a path is a member's read (only node admins see paths),
 * said in words rather than left blank; no record yet is no line at all.
 */
export function useProjectRowNote(port: ProjectRecordPort | null): ((row: EntitySummary) => ReactNode | null) | undefined {
  const { state } = useProjectRecords(port);
  const records = state.phase === 'ready' ? state.records : null;
  const note = useCallback(
    (row: EntitySummary): ReactNode | null => {
      if (!records) return null;
      const record = recordFor(records, row.id, row.state as EntityDetail['content']);
      if (!record) return null;
      return (
        <>
          <span
            className="lp__tile-note-path"
            title={record.workingDir ?? 'Only a node admin can see this folder’s path'}
          >
            {record.workingDir ? shortPath(record.workingDir) : 'folder: node admins only'}
          </span>
          {record.trust === 'untrusted' ? (
            <span className="lp__tile-note-flag" title="Agents ask for confirmation before running here">· untrusted</span>
          ) : null}
        </>
      );
    },
    [records],
  );
  return port ? note : undefined;
}
