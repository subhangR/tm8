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
 * A record whose surface cannot report every edit (a task's description, a
 * story's roots) carries the version it arrived at, and is kept once that
 * has moved. The check waits `GRACE_MS` after the tab goes, so a save that
 * was in flight when it closed has landed in the store first; an unknown
 * version keeps the record. Left behind is always the safe mistake.
 */
import { useEffect, useRef } from 'react';
import { emptyFreshDocs, forgetFreshDoc, isStillEmptyFreshDoc } from '../../doc-edit';
import { nextMutationId } from '../../authoring';
import type { WorkspaceRuntime } from '../runtime/dispatch';
import type { WorkspaceGateHandles } from './context';

export const GRACE_MS = 3000;

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
    const remove = (id: string) => {
      forgetFreshDoc(id);
      const { seam, reconcileCommand } = dataRef.current;
      seam.commands
        .deleteEntity(id as Parameters<typeof seam.commands.deleteEntity>[0], { clientMutationId: nextMutationId() })
        .then(reconcileCommand, () => {
          /* Left behind is the outcome a failed delete has anyway: an
             "Untitled" record the person can delete by hand. */
        });
    };
    const settle = (id: string, version: number | null) => {
      waiting.delete(id);
      if (held().has(id) || !isStillEmptyFreshDoc(id)) return;
      if (version !== null) {
        const now = dataRef.current.detailOf(id)?.version;
        if (now !== version) {
          forgetFreshDoc(id);
          return;
        }
      }
      remove(id);
    };
    const sweep = () => {
      const candidates = emptyFreshDocs();
      if (candidates.length === 0) return;
      const holding = held();
      for (const { id, version } of candidates) {
        if (holding.has(id) || waiting.has(id)) continue;
        // The doc editor reports every edit, and flushes as its tab closes.
        if (version === null) remove(id);
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
