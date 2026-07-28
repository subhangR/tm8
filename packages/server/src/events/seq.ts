/**
 * The sequence sources — a load-bearing seam, and the single narrowest point in
 * the event system.
 *
 * AM-2 §3: the durable `seq` is a PER-SPACE MONOTONIC value assigned by the
 * Postgres capture trigger from a per-space counter row
 * (`public.space_event_seq`, via `internal.next_event_seq`), in the same
 * transaction as the mutation it describes. It is simultaneously the client's
 * dedupe key, its ordering key, and the `since` cursor for `events.poll`. All
 * three properties fail together if two writers can mint a seq.
 *
 * ## Two counters, deliberately (S8)
 *
 * There are now TWO independent sequence spaces in this file, and conflating
 * them was a live footgun:
 *
 * 1. **The durable log** (`DurableSeqSource`). Postgres owns it. The trigger in
 *    db/migrations/003 mints the number inside the mutation's own transaction,
 *    so the server's job here is to READ the authoritative value, never to
 *    produce one. See `PgDurableSeqSource` and the note on why it has no
 *    `next()`.
 * 2. **The ephemeral presence/typing channel** (`SeqSource` /
 *    `PresenceSeqSource`). DEV-4: these events never touch the durable stream,
 *    and the contract says their `seq` is CHANNEL-LOCAL (contract.ts §5). It is
 *    in-memory, per-process, and resets on restart — all correct for a value
 *    nobody may use as a durable cursor.
 *
 * Before S8 the presence channel borrowed the durable `SeqSource`, which burned
 * durable sequence numbers on ephemeral events. That was harmless only while no
 * durable log existed. The moment Postgres became the durable authority the two
 * would have disagreed about what `next()` means — the in-memory counter would
 * hand out 1,2,3 while the database was already at 4,000 — and a presence event
 * would have carried a number that collides with a real durable seq. So the two
 * are now different TYPES, not two instances of one type, and no `if` can mix
 * them up.
 */
import type { Querier } from '../db/types.js';

/**
 * A channel-local, ephemeral sequence. The ONLY implementor is the presence
 * channel; the durable log uses `DurableSeqSource` instead.
 */
export interface SeqSource {
  /** Next sequence number for `spaceId`. Monotonically increasing per space. */
  next(spaceId: string): number | Promise<number>;
}

/**
 * Per-space counter starting at 1, for the ephemeral presence/typing channel
 * ONLY (DEV-4).
 *
 * In-memory is not a compromise here, it is the correct storage: presence is
 * ephemeral by contract, gaps and restarts are explicitly allowed, and a client
 * may not use these numbers as a durable cursor. Deliberately synchronous —
 * this really does no I/O, and `SeqSource.next` is declared possibly-async only
 * so an implementation that did could still fit.
 */
export class PresenceSeqSource implements SeqSource {
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

/**
 * Historical name for `PresenceSeqSource`, kept because the composition root
 * (main.ts) constructs it by this name and that file is not this lane's to edit.
 *
 * It is no longer a "skeleton stand-in for the durable log": the durable log is
 * real and lives in Postgres. What main.ts hands the publisher is the PRESENCE
 * counter, which is exactly what the publisher still needs one of.
 */
export const InMemorySeqSource = PresenceSeqSource;
export type InMemorySeqSource = PresenceSeqSource;

/**
 * The durable sequence, as the server is allowed to see it: READ-ONLY.
 *
 * Note what is NOT here: a `next()`. That absence is the whole design. The
 * capture trigger mints a seq in the same transaction as the mutation it
 * describes, so a server-side `next()` could only ever do one of two harmful
 * things — hand out a number for an event that does not exist (a permanent gap
 * that a client may legitimately read as "I am up to date"), or race the
 * trigger and hand out one that a real event will later reuse (a duplicate on
 * the dedupe key). Neither is worth the convenience. The server reads; Postgres
 * assigns.
 */
export interface DurableSeqSource {
  /**
   * The highest seq assigned in `spaceId`, or `null` when the mark CANNOT BE
   * ESTABLISHED — the row is not visible to this caller, or the space has no
   * counter row at all.
   *
   * ## Why this is `number | null` and not `number`
   *
   * It used to return 0 for "no row", documented as "the space has never had an
   * event". Those are not the same fact, and collapsing them produced a
   * confident wrong answer at the one place that most needs a right one.
   *
   * Concretely: `space_event_seq` is read under the caller's own claims, and
   * `internal.is_space_member(space_id)` is FALSE for an unbound identity. So a
   * caller without a bound identity got no row, which became 0, which reads as
   * "this space has never had an event" — for a space with thousands. A
   * consumer seeding a live cursor from that would silently replay the entire
   * retained log; a consumer reporting it would tell a caught-up client it was
   * at the beginning.
   *
   * `null` makes that answer UNREPRESENTABLE rather than merely unreached.
   * Every caller must now decide what "I cannot establish the mark" means for
   * it, and the correct decision is never "assume zero" — it is to refuse and
   * fall back to an explicit, cursor-carrying replay.
   */
  latest(spaceId: string): Promise<number | null>;
}

/**
 * `DurableSeqSource` over `public.space_event_seq` — the same counter row the
 * capture trigger increments, so the value read here is by construction the one
 * the trigger last assigned.
 *
 * Reads `space_event_seq` rather than `max(seq) from workspace_events` on
 * purpose: the counter row survives retention pruning
 * (`internal.prune_workspace_events` deletes events older than 7 days) while a
 * `max()` over the pruned table would appear to move BACKWARD. A high-water
 * mark that can decrease is not a high-water mark.
 */
export class PgDurableSeqSource implements DurableSeqSource {
  private readonly q: Querier;

  constructor(q: Querier) {
    this.q = q;
  }

  async latest(spaceId: string): Promise<number | null> {
    const rows = await this.q.query<{ last_seq: string | number }>(
      'select last_seq from public.space_event_seq where space_id = $1',
      [spaceId],
    );
    const row = rows[0];
    // NO ROW IS NOT ZERO. Since db/migrations/035 this table is readable by a
    // MEMBER of the space (grant AND policy — a bare grant would have left RLS
    // enabled with no policy, i.e. silently zero rows). So "no row" now means
    // one of: the caller is not a member, the caller has no bound identity, or
    // the space has genuinely never had an event. This method cannot tell those
    // apart and must not pretend to.
    if (row === undefined) return null;
    // bigint arrives from node-postgres as a string; Number() is safe well past
    // any plausible event count (2^53 events in one space is not a scenario).
    return Number(row.last_seq);
  }
}
