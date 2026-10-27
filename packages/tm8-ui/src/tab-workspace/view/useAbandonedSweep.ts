/**
 * THE ABANDONED-RECORD SWEEP (New doc UX, Subhang form round 2: "auto-delete
 * it silently"; Kalai, 2026-10-07: every kind New creates at once).
 *
 * New creates the record before anyone types, so closing that tab without
 * writing anything would leave an "Untitled" behind in every list. When no
 * tab holds a record New made in this window, and its surface last reported
 * it untitled and empty, it is deleted — quietly, and through the same
 * `deleteEntity` (a recoverable delete) every other delete in the client uses.
 *
 * Only a record that has ARRIVED (its surface mounted in a tab) is a
 * candidate, so the window between create and the draft tab binding to it
 * can never read as "no tab holds it". Switching away keeps the tab, so it
 * keeps the record; closing the tab, or opening something else in it, is
 * leaving.
 *
 * BEFORE ANY DELETE THE RECORD IS READ AGAIN FROM THE SERVER, and kept if
 * anything hangs off it: a child (a subtask, and the delete would take it
 * along), or any link beyond its own provenance (a doc attached for context,
 * a teammate). Those are writes to OTHER rows, so neither the surface nor the
 * record's version sees them. A record whose surface cannot report every
 * edit to itself (a task's description, a story's roots) also carries the
 * version it arrived at, and is kept once that has moved; its check waits
 * `GRACE_MS` after the tab goes, so a save in flight when it closed lands
 * first. A failed read keeps the record. Left behind is always the safe
 * mistake.
 */
import { useEffect, useRef } from 'react';
import { emptyFreshDocs, forgetFreshDoc, isStillEmptyFreshDoc } from '../../doc-edit';
import { nextMutationId } from '../../authoring';
import type { WorkspaceRuntime } from '../runtime/dispatch';
import type { EntityDetail } from '@tm8/contract';
import type { WorkspaceGateHandles } from './context';

export const GRACE_MS = 3000;

/** The edges every record is born with; any other one means it was used. */
const BIRTH_EDGES: ReadonlySet<string> = new Set(['authored_from', 'assigned_to']);

/** True when nothing hangs off the record: no child, no link beyond its birth edges. */
export function standsAlone(detail: EntityDetail): boolean {
  const { children } = detail.hierarchy;
  if (children.items.length > 0 || (children.total ?? 0) > 0) return false;
  const groups = [...detail.connections.outgoing, ...detail.connections.incoming];
  return groups.every((group) => BIRTH_EDGES.has(group.type) || (group.edges.length === 0 && (group.summary?.count ?? 0) === 0));
}

export function useAbandonedSweep(runtime: WorkspaceRuntime, data: WorkspaceGateHandles['data']): void {
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const waiting = new Map<string, ReturnType<typeof setTimeout>>();
    const held = () => {
      const ids = new Set<string>();
      for (const tab of Object.values(runtime.store.getState().tabs)) {
        if (tab.type === 'entity') ids.add(tab.entityId);
      }
      return ids;
    };
    const remove = (id: string, version: number | null) => {
      const { seam, reconcileCommand } = dataRef.current;
      void seam
        .entity(id as Parameters<typeof seam.entity>[0])
        .then((fresh) => {
          // Reopened, or written in, while the read was out.
          if (held().has(id) || !isStillEmptyFreshDoc(id)) return;
          forgetFreshDoc(id);
          if (!standsAlone(fresh) || (version !== null && fresh.version !== version)) return;
          return seam.commands
            .deleteEntity(id as Parameters<typeof seam.commands.deleteEntity>[0], { clientMutationId: nextMutationId() })
            .then(reconcileCommand);
        })
        .catch(() => {
          /* Left behind is the outcome a failed read or delete has anyway: an
             "Untitled" record the person can delete by hand. */
          forgetFreshDoc(id);
        });
    };
    const settle = (id: string, version: number | null) => {
      waiting.delete(id);
      if (held().has(id) || !isStillEmptyFreshDoc(id)) return;
      remove(id, version);
    };
    const sweep = () => {
      const candidates = emptyFreshDocs();
      if (candidates.length === 0) return;
      const holding = held();
      for (const { id, version } of candidates) {
        if (holding.has(id) || waiting.has(id)) continue;
        // The doc editor reports every edit, and flushes as its tab closes.
        if (version === null) remove(id, null);
        else waiting.set(id, setTimeout(() => settle(id, version), GRACE_MS));
      }
    };
    const unsubscribe = runtime.store.subscribe(sweep);
    return () => {
      unsubscribe();
      for (const timer of waiting.values()) clearTimeout(timer);
    };
  }, [runtime]);
}
