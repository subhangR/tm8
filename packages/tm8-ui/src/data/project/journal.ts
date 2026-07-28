/**
 * Optimistic journal keyed by clientMutationId (LLD §7).
 *
 * Pure module: no timers, no framework, no IO. Every command settles with a
 * CommandResult or a rejection, so every journal entry has a deterministic
 * exit — reconcile (event echo OR CommandResult success, first wins) or
 * rollback (rejection). Double-reconcile and rollback-after-reconcile are
 * no-ops by construction.
 *
 * The journal captures PRIOR summaries (including was-absent) at
 * applyOptimistic time; rollback returns restore instructions the owning
 * store applies. It never touches store state itself.
 */
import type { EntityId, EntitySummary } from '@tm8/contract';

/** How to undo one optimistically patched entity. */
export type RestoreInstruction =
  /** The entity existed before the optimistic patch — put the captured summary back. */
  | { kind: 'restore'; summary: EntitySummary }
  /** The entity did NOT exist before (optimistic create) — remove it. */
  | { kind: 'remove'; id: EntityId };

export interface Journal {
  /**
   * Capture the pre-patch state of every entity named in `patches`.
   * `lookup` resolves the CURRENT cached summary (undefined = not cached).
   * Calling again with the same clientMutationId widens the capture set but
   * never overwrites an existing capture — the FIRST capture is the true
   * pre-optimistic state rollback must restore.
   */
  applyOptimistic(
    clientMutationId: string,
    patches: EntitySummary[],
    lookup: (id: EntityId) => EntitySummary | undefined,
  ): void;
  /**
   * Drop the entry: the server confirmed (event echo or CommandResult —
   * whichever arrives first wins). Returns true if an entry was dropped;
   * false = already reconciled/rolled back/never journaled (no-op).
   */
  reconcile(clientMutationId: string): boolean;
  /**
   * Drop the entry and return the instructions that restore the captured
   * pre-optimistic state. Empty array when there is nothing to roll back
   * (unknown id, or already reconciled — the authoritative state won).
   */
  rollback(clientMutationId: string): RestoreInstruction[];
  has(clientMutationId: string): boolean;
  /** Pending clientMutationIds, oldest first. */
  pending(): string[];
  clear(): void;
}

interface Entry {
  /** id → summary before the optimistic patch (undefined = was absent). */
  prev: Map<EntityId, EntitySummary | undefined>;
}

export function createJournal(): Journal {
  const entries = new Map<string, Entry>();

  return {
    applyOptimistic(clientMutationId, patches, lookup) {
      const entry = entries.get(clientMutationId) ?? { prev: new Map() };
      for (const patch of patches) {
        if (!entry.prev.has(patch.id)) entry.prev.set(patch.id, lookup(patch.id));
      }
      entries.set(clientMutationId, entry);
    },

    reconcile(clientMutationId) {
      return entries.delete(clientMutationId);
    },

    rollback(clientMutationId) {
      const entry = entries.get(clientMutationId);
      if (!entry) return [];
      entries.delete(clientMutationId);
      const instructions: RestoreInstruction[] = [];
      for (const [id, prev] of entry.prev) {
        instructions.push(prev === undefined ? { kind: 'remove', id } : { kind: 'restore', summary: prev });
      }
      return instructions;
    },

    has(clientMutationId) {
      return entries.has(clientMutationId);
    },

    pending() {
      return [...entries.keys()];
    },

    clear() {
      entries.clear();
    },
  };
}
