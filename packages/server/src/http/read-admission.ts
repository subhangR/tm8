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
 * 503 with `Retry-After`, below the clients' 15s deadline.
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
}

export interface ReadAdmissionStats {
  readonly limit: number;
  readonly active: number;
  readonly queued: number;
}

export class ReadAdmission {
  readonly limit: number;
  private readonly maxWaitMs: number;
  private active = 0;
  private readonly queue: Array<{ grant: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(opts: ReadAdmissionOptions) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new Error(`read admission limit must be a positive integer, got ${opts.limit}`);
    }
    this.limit = opts.limit;
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_READ_ADMISSION_WAIT_MS;
  }

  stats(): ReadAdmissionStats {
    return { limit: this.limit, active: this.active, queued: this.queue.length };
  }

  /**
   * Wait for a slot. Resolves to the release function, which MUST be called
   * exactly once (extra calls are ignored).
   */
  acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const entry = {
        grant: () => {
          clearTimeout(entry.timer);
          resolve(this.releaser());
        },
        timer: setTimeout(() => {
          const at = this.queue.indexOf(entry);
          if (at >= 0) this.queue.splice(at, 1);
          reject(new CollabError('upstream_unavailable', 'the node is busy serving reads, retry shortly', {
            details: {
              reason: 'read_admission_timeout',
              limit: this.limit,
              active: this.active,
              queued: this.queue.length,
              retryAfterSeconds: 1,
            },
            retryable: true,
          }));
        }, this.maxWaitMs),
      };
      entry.timer.unref?.();
      this.queue.push(entry);
    });
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
 * Reads admitted for a pool of `poolMax`: a quarter of the pool (at least 2,
 * never all of it) is held back for commands. Pool 32 → 24; pool 8 → 6.
 * A pool of 1 or 2 cannot reserve anything useful and admits 1.
 */
export function readLimitForPool(poolMax: number): number {
  const reserve = Math.max(2, Math.ceil(poolMax / 4));
  return Math.max(1, poolMax - reserve);
}
