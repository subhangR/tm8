import type { EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';

/**
 * Open immediately, then record that YOU have seen it.
 *
 * OPENING IS A READ, AND ONLY A READ (Attention v2, decisions G4/G5/Q18). This
 * function used to fire `resolveAttention` on the way through whenever the
 * rendered summary said a request was pending, which made navigation a
 * space-wide write: walking past an entity cleared an escalation every other
 * member could see, and the person who raised it got no say. Three bad
 * consequences followed, and all three are the reason the call is gone rather
 * than merely conditional:
 *
 *   · IT DESTROYED THE QUEUE BY READING IT. The attention dock had to carry a
 *     footnote explaining that its own rows were settled by the act of opening
 *     the page, because otherwise the surface read as lying.
 *   · IT RACED THE DOCK. A bulk resolve bumps the version of every row it
 *     touches, so a dock that had been on screen for one navigation was holding
 *     stale versions by design and settling anything returned version_conflict.
 *   · IT WAS UNADDRESSABLE. `resolveAttention` is bulk: there was no way to
 *     resolve one request and leave its siblings pending.
 *
 * Settling is now only ever explicit, per-row, and undoable — `AttentionRequests`
 * owns it through `attentionRequests.update`.
 *
 * WHAT REMAINS IS THE READ MARK — per viewer, and unconditional. This is what
 * clears the rail's unseen mark: an entity you looked at is one you have seen,
 * whether or not anyone escalated it. It writes only your own row, which is
 * exactly why it survived the change that removed the space-wide write.
 *
 * It is fire-and-forget: navigation has already happened by the time it is
 * issued, and it failing should not strand the user on the page they just left.
 * It coalesces through `marking`, so a double click is one write rather than two.
 */
export function openEntityAndMarkRead(input: {
  entityId: EntityId;
  open(id: EntityId): void;
  commands: Pick<Seam['commands'], 'upsertReadMark'>;
  /** In-flight read marks, so a double click coalesces to one write. */
  marking?: Set<EntityId>;
  /** Called once a read mark lands, so the rail's counters can catch up. */
  onRead?(): void;
  now?: () => number;
}): void {
  input.open(input.entityId);

  if (!input.commands.upsertReadMark || input.marking?.has(input.entityId)) return;

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
