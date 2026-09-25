/**
 * READS MAY NOT TAKE THE WHOLE POOL.
 *
 * The Postgres pool (`TM8_DB_POOL_MAX`) is one FIFO queue shared by every
 * request. A read and a command wait in the same line, so a wave of reads —
 * every open tab re-reading its lists and boards after a durable event — puts
 * `execution.spawn` or a task completion BEHIND the wave, and when the wave
 * outlasts `connectionTimeoutMillis` (5s) the command fails with a 503 while
 * the reads that caused it succeed.
 *
 * Measured on prod 2026-09-24 (pool 32, 8 cores): each event burst drove
 * 70-80 concurrent HTTP requests and all 32 pooled connections `active` on the
 * same entity read for seconds; over a 50s window the pool was fully busy 38%
 * of the time. Launches and completions were the calls users saw fail.
 *
 * So catalog `kind: 'read'` operations are admitted through this gate, capped
 * below the pool size. Whatever the reads are doing, `reserve` connections are
 * left for commands and streams. Past the cap a read waits HERE — in process,
 * holding no connection — rather than in pg-pool's queue in front of a command.
 * A read that cannot be admitted within `maxWaitMs` is refused as a retryable
 * 503 with `Retry-After`, below the clients' 15s deadline. So is a read that
 * arrives when the queue is already `maxQueue` deep — at once, not after 8s.
 * A queued read whose client disconnects leaves the queue and never runs:
 * during an incident users reload tabs, and every abandoned read left queued
 * would be RLS work done for nobody, doubling the backlog.
 *
 * Deliberately NOT applied to commands: a command waiting here would be the
 * exact starvation this exists to prevent, moved one layer up.
 */
import { CollabError } from '@tm8/contract';

export interface ReadAdmissionOptions {
  /** Concurrent reads admitted. */
  readonly limit: number;
  /** Longest a read may queue before it is refused. */
  readonly maxWaitMs?: number;
  /** Most reads that may wait at once; past it a read is refused at once. Default `4 × limit`. */
  readonly maxQueue?: number;
  /** Where the rate-limited queue/refusal line goes. Default `console.warn`. */
  readonly log?: (line: string) => void;
  /** Injectable clock for the log's rate limit. */
  readonly now?: () => number;
}

export interface ReadAdmissionStats {
  readonly limit: number;
  readonly active: number;
  readonly queued: number;
  readonly maxQueue: number;
}

type Counter = 'queued' | 'timedOut' | 'queueFull' | 'abandoned';

interface Waiter {
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** What `acquire` rejects with when its signal aborts: the caller left, nothing to answer. */
function abandoned(): Error {
  const err = new Error('read abandoned by its client before admission');
  err.name = 'AbortError';
  return err;
}

export class ReadAdmission {
  readonly limit: number;
  readonly maxQueue: number;
  private readonly maxWaitMs: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private active = 0;
  private readonly queue: Waiter[] = [];
  /** Since the last log line. */
  private counts: Record<Counter, number> = { queued: 0, timedOut: 0, queueFull: 0, abandoned: 0 };
  private lastLogAt = Number.NEGATIVE_INFINITY;

  constructor(opts: ReadAdmissionOptions) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new Error(`read admission limit must be a positive integer, got ${opts.limit}`);
    }
    this.limit = opts.limit;
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_READ_ADMISSION_WAIT_MS;
    this.maxQueue = opts.maxQueue ?? DEFAULT_READ_ADMISSION_QUEUE_FACTOR * opts.limit;
    if (!Number.isInteger(this.maxQueue) || this.maxQueue < 0) {
      throw new Error(`read admission maxQueue must be a non-negative integer, got ${this.maxQueue}`);
    }
    this.log = opts.log ?? ((line) => console.warn(line));
    this.now = opts.now ?? (() => Date.now());
  }

  stats(): ReadAdmissionStats {
    return { limit: this.limit, active: this.active, queued: this.queue.length, maxQueue: this.maxQueue };
  }

  /**
   * Wait for a slot. Resolves to the release function, which MUST be called
   * exactly once (extra calls are ignored).
   *
   * `signal` is the client: if it aborts while the read is queued, the waiter
   * leaves the queue and the promise rejects with an `AbortError` — the read
   * is never admitted, so its handler (and its RLS work) never runs. An abort
   * after admission is ignored; the caller owns the read from then on.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      this.note('abandoned');
      return Promise.reject(abandoned());
    }
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    if (this.queue.length >= this.maxQueue) {
      this.note('queueFull');
      return Promise.reject(this.refusal('read_admission_queue_full'));
    }
    return new Promise((resolve, reject) => {
      const leave = (): void => {
        clearTimeout(entry.timer);
        signal?.removeEventListener('abort', onAbort);
        const at = this.queue.indexOf(entry);
        if (at >= 0) this.queue.splice(at, 1);
      };
      const onAbort = (): void => {
        leave();
        this.note('abandoned');
        reject(abandoned());
      };
      const entry: Waiter = {
        grant: () => {
          clearTimeout(entry.timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(this.releaser());
        },
        timer: setTimeout(() => {
          leave();
          this.note('timedOut');
          reject(this.refusal('read_admission_timeout'));
        }, this.maxWaitMs),
      };
      entry.timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
      this.note('queued');
    });
  }

  private refusal(reason: 'read_admission_timeout' | 'read_admission_queue_full'): CollabError {
    return new CollabError('upstream_unavailable', 'the node is busy serving reads, retry shortly', {
      details: {
        reason,
        limit: this.limit,
        active: this.active,
        queued: this.queue.length,
        retryAfterSeconds: 1,
      },
      retryable: true,
    });
  }

  /**
   * Count, and at most once per `READ_ADMISSION_LOG_INTERVAL_MS` say so. The
   * gate engaging is the signal an operator needs during a read wave, and a
   * line per request would be the flood it is reporting on.
   */
  private note(what: Counter): void {
    this.counts[what] += 1;
    const at = this.now();
    if (at - this.lastLogAt < READ_ADMISSION_LOG_INTERVAL_MS) return;
    this.lastLogAt = at;
    const c = this.counts;
    this.counts = { queued: 0, timedOut: 0, queueFull: 0, abandoned: 0 };
    this.log(
      `[http] read admission: active ${this.active}/${this.limit}, queue ${this.queue.length}/${this.maxQueue}; ` +
        `since last line queued ${c.queued}, refused ${c.timedOut} (wait > ${this.maxWaitMs}ms), ` +
        `refused ${c.queueFull} (queue full), dropped ${c.abandoned} (client gone)`,
    );
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      // Hand the slot straight to the next waiter: `active` is unchanged.
      if (next) next.grant();
      else this.active -= 1;
    };
  }
}

/** Under the clients' 15s deadline, with room for the read itself. */
export const DEFAULT_READ_ADMISSION_WAIT_MS = 8_000;

/**
 * The queue holds at most `4 × limit` reads (pool 32 → 24 admitted, 96 queued).
 *
 * Sized against the burst that motivated the gate: 70-80 concurrent requests
 * per durable-event burst fit in `limit + 4 × limit` = 120 whole, so a single
 * burst is queued, never refused. Past that the queue is several bursts deep;
 * a slot frees at the rate reads complete, so a waiter at the back of four
 * full generations of reads is unlikely to be admitted inside `maxWaitMs` and
 * would only hold a socket and memory for 8s to be refused anyway. Refusing
 * it at once, with the same retryable 503 and `Retry-After`, tells the client
 * the same thing sooner and keeps the queue from growing without bound under
 * tab reloads.
 */
export const DEFAULT_READ_ADMISSION_QUEUE_FACTOR = 4;

/** At most one `[http] read admission` line per this interval. */
export const READ_ADMISSION_LOG_INTERVAL_MS = 10_000;

/**
 * Reads admitted for a pool of `poolMax`: a quarter of the pool (at least 2,
 * never all of it) is held back for commands. Pool 32 → 24; pool 8 → 6.
 * A pool of 1 or 2 cannot reserve anything useful and admits 1.
 */
export function readLimitForPool(poolMax: number): number {
  const reserve = Math.max(2, Math.ceil(poolMax / 4));
  return Math.max(1, poolMax - reserve);
}
