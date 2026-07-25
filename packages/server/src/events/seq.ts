/**
 * The sequence source — a load-bearing seam, and the single narrowest point in
 * the event system.
 *
 * AM-2 §3: the durable `seq` is a PER-SPACE MONOTONIC value assigned by the
 * Postgres capture trigger from a per-space counter row, in the same
 * transaction as the mutation it describes. It is simultaneously the client's
 * dedupe key, its ordering key, and the `since` cursor for `events.poll`. All
 * three properties fail together if two writers can mint a seq.
 *
 * Therefore: NOTHING OUTSIDE THIS FILE MAY GENERATE A SEQ. No handler, no
 * publisher, no test fixture invents a number and puts it in an envelope. Code
 * asks a `SeqSource`; that is the only door.
 *
 * `InMemorySeqSource` is a SKELETON stand-in and nothing more. It survives one
 * process lifetime, does not coordinate with a database, and would hand out
 * colliding values the moment a second node existed — which is precisely why
 * the interface, not the implementation, is the deliverable here. At W2 this
 * interface is implemented against the `workspace_events` table and the
 * in-memory one is deleted.
 */

export interface SeqSource {
  /** Next sequence number for `spaceId`. Monotonically increasing per space. */
  next(spaceId: string): number | Promise<number>;
}

/**
 * Per-space counter starting at 1. Skeleton only — see the file header.
 *
 * Deliberately synchronous: `SeqSource.next` is declared as possibly-async so
 * the Postgres implementation fits, but the skeleton must not pretend to be
 * doing I/O it is not doing.
 */
export class InMemorySeqSource implements SeqSource {
  private readonly counters = new Map<string, number>();

  next(spaceId: string): number {
    const current = this.counters.get(spaceId) ?? 0;
    const value = current + 1;
    this.counters.set(spaceId, value);
    return value;
  }

  /** Last value handed out for `spaceId`, or 0 if none. Test/debug affordance. */
  peek(spaceId: string): number {
    return this.counters.get(spaceId) ?? 0;
  }
}
