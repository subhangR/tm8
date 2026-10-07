/**
 * THE ABANDONED-DOC SWEEP (New doc UX, Subhang form round 2: "auto-delete it
 * silently").
 *
 * New doc creates the record before anyone types, so closing that tab
 * without writing anything would leave an "Untitled" behind in every list.
 * When no tab holds a doc New doc made in this window, and the editor last
 * reported it untitled and empty, it is deleted — quietly, and through the
 * same `deleteEntity` (a recoverable delete) every other delete in the client
 * uses.
 *
 * Only a doc that has ARRIVED (its surface mounted in a tab) is a candidate,
 * so the window between create and the draft tab binding to it can never
 * read as "no tab holds it". Switching away keeps the tab, so it keeps the
 * doc; closing the tab, or opening something else in it, is leaving.
 */
import { useEffect, useRef } from 'react';
import { emptyFreshDocIds, forgetFreshDoc, isFreshArrival } from '../../doc-edit';
import { nextMutationId } from '../../authoring';
import type { WorkspaceRuntime } from '../runtime/dispatch';
import type { WorkspaceGateHandles } from './context';

export function useAbandonedDocSweep(runtime: WorkspaceRuntime, data: WorkspaceGateHandles['data']): void {
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const sweep = () => {
      const candidates = emptyFreshDocIds().filter((id) => !isFreshArrival(id));
      if (candidates.length === 0) return;
      const held = new Set<string>();
      for (const tab of Object.values(runtime.store.getState().tabs)) {
        if (tab.type === 'entity') held.add(tab.entityId);
      }
      for (const id of candidates) {
        if (held.has(id)) continue;
        forgetFreshDoc(id);
        const { seam, reconcileCommand } = dataRef.current;
        seam.commands
          .deleteEntity(id as Parameters<typeof seam.commands.deleteEntity>[0], { clientMutationId: nextMutationId() })
          .then(reconcileCommand, () => {
            /* Left behind is the outcome a failed delete has anyway: an
               "Untitled" doc the person can delete by hand. */
          });
      }
    };
    return runtime.store.subscribe(sweep);
  }, [runtime]);
}
