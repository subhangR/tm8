import type { AttentionRequestMutationResult, EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';

/**
 * Open immediately, then record that it was opened.
 *
 * TWO INDEPENDENT SIDE EFFECTS, and they are not the same thing:
 *
 *   · RESOLVE ATTENTION — space-wide. Clears the escalation everyone can see,
 *     so it is CONDITIONAL on the entity actually having one. Firing it on
 *     every navigation would both flood a route older backends may not know
 *     and write to a shared queue for entities nobody flagged.
 *
 *   · UPSERT A READ MARK — per viewer. This is what clears the rail's unseen
 *     mark, so it is UNCONDITIONAL: an entity you looked at is one you have
 *     seen, whether or not anyone escalated it. It writes only your own row.
 *
 * Both are fire-and-forget: navigation has already happened by the time either
 * is issued, and neither failing should strand the user on the page they just
 * left. Each coalesces through its own in-flight set, so a double click is one
 * write rather than two.
 */
export function openEntityAndResolve(input: {
  entityId: EntityId;
  needsAttention: boolean;
  open(id: EntityId): void;
  commands: Pick<Seam['commands'], 'resolveAttention' | 'upsertReadMark'>;
  reconcile(result: AttentionRequestMutationResult): void;
  onError(error: unknown): void;
  resolving?: Set<EntityId>;
  /** In-flight read marks, coalesced separately from `resolving`. */
  marking?: Set<EntityId>;
  /** Called once a read mark lands, so the rail's counters can catch up. */
  onRead?(): void;
  now?: () => number;
}): void {
  input.open(input.entityId);

  if (input.commands.upsertReadMark && !input.marking?.has(input.entityId)) {
    input.marking?.add(input.entityId);
    // `lastReadAt` is bound server-side; the value sent here is the client's
    // best guess and is deliberately not trusted for ordering.
    void input.commands
      .upsertReadMark(input.entityId, new Date((input.now ?? Date.now)()).toISOString())
      .then(
        () => input.onRead?.(),
        // A failed read mark is SILENT. The consequence is that a row keeps
        // its unseen mark — visible, self-correcting on the next open, and not
        // worth a toast over a navigation the user already completed.
        () => undefined,
      )
      .finally(() => {
        input.marking?.delete(input.entityId);
      });
  }

  // Opening an ordinary entity must stay a read-only navigation action. Apart
  // from avoiding needless traffic, this keeps an older backend from being
  // flooded with a route it does not know while a UI/backend deploy rolls out.
  if (!input.needsAttention || input.resolving?.has(input.entityId)) return;

  input.resolving?.add(input.entityId);
  void input.commands.resolveAttention(input.entityId, {
    clientMutationId: `attention-open:${input.entityId}:${(input.now ?? Date.now)()}`,
  }).then(input.reconcile, input.onError).finally(() => {
    input.resolving?.delete(input.entityId);
  });
}
