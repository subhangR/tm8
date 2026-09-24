/**
 * EVENT-DRIVEN RE-READS, COALESCED AND BOUNDED.
 *
 * `useGateData` re-reads three things when the durable stream moves: the rail
 * counters, every cached list's `total`, and every cached board. Each used to
 * be a LEADING throttle — the first event armed a 400ms timer, later events
 * were ignored until it fired — and the list re-probe then fired one
 * `collections.query` per cached key (up to `ROW_QUERY_CACHE_CAP`, 64) all at
 * once. Under an agent writing a run of events that is a fresh wave every
 * 400ms per tab, whether or not the previous wave had come back.
 *
 * Measured on prod 2026-09-24 (8 cores, pool 32): each durable-event burst
 * put 70-80 concurrent HTTP requests on the node and all 32 pooled
 * connections into `active` on the same `select ENTITY_COLUMNS ...` shape for
 * several seconds; over one 50s window the pool was fully busy 38% of the
 * time. Every other request — `execution.spawn`, a task completion — queued
 * behind the wave and failed its 5s pool-acquire deadline as a 503.
 *
 * Two rules fix the shape without changing what is read:
 *
 * 1. **Trailing debounce with a ceiling, and single-flight.** A burst costs
 *    ONE round, fired `quietMs` after the last event but never later than
 *    `maxWaitMs` after the first. A round never overlaps its predecessor: an
 *    event arriving mid-round marks the trigger dirty and exactly one more
 *    round follows. So a tab's request rate is bounded by its own round-trip
 *    time, not by the event rate.
 * 2. **Bounded concurrency inside a round** (`runLimited`), so one tab with a
 *    full row cache holds at most `limit` pooled connections, not 64.
 */

export interface CoalescedTrigger {
  /** An event arrived; schedule (or extend) a round. */
  note(): void;
  /** Cancel any pending timer; a round in flight finishes but never re-arms. */
  dispose(): void;
}

export interface CoalescedTriggerOptions {
  /** Fire this long after the LAST event of a burst. */
  readonly quietMs: number;
  /** …but never later than this after the FIRST unhandled event. */
  readonly maxWaitMs: number;
  /** One round. Awaited: the next round cannot start until it settles. */
  readonly run: () => Promise<void> | void;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

export function createCoalescedTrigger(opts: CoalescedTriggerOptions): CoalescedTrigger {
  const now = opts.now ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** When the oldest event not yet served by a round arrived. */
  let firstPendingAt: number | undefined;
  let inFlight = false;
  /** An event arrived while a round was in flight. */
  let dirty = false;
  let disposed = false;

  const arm = (): void => {
    if (disposed || inFlight || firstPendingAt === undefined) return;
    if (timer !== undefined) clearTimeout(timer);
    const ceiling = firstPendingAt + opts.maxWaitMs - now();
    const delay = Math.max(0, Math.min(opts.quietMs, ceiling));
    timer = setTimeout(fire, delay);
  };

  const fire = (): void => {
    timer = undefined;
    if (disposed) return;
    firstPendingAt = undefined;
    inFlight = true;
    void Promise.resolve()
      .then(opts.run)
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (dirty && !disposed) {
          dirty = false;
          firstPendingAt = now();
          arm();
        }
      });
  };

  return {
    note(): void {
      if (disposed) return;
      if (inFlight) {
        dirty = true;
        return;
      }
      if (firstPendingAt === undefined) firstPendingAt = now();
      arm();
    },
    dispose(): void {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Run `tasks` with at most `limit` in flight. Resolves when all have settled;
 * a rejected task is swallowed (each caller handles its own failure).
 */
export async function runLimited(
  tasks: readonly (() => Promise<unknown>)[],
  limit: number,
): Promise<void> {
  let next = 0;
  const width = Math.max(1, Math.min(limit, tasks.length));
  const lane = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next++]!;
      try {
        await task();
      } catch {
        // Owned by the task.
      }
    }
  };
  await Promise.all(Array.from({ length: width }, lane));
}

/** A burst waits out this much quiet before re-reading… */
export const EVENT_REFRESH_QUIET_MS = 600;
/** …and never longer than this under a continuous stream. */
export const EVENT_REFRESH_MAX_WAIT_MS = 2_000;
/** Concurrent re-reads one tab may hold for list totals. */
export const EVENT_REFRESH_CONCURRENCY = 4;
