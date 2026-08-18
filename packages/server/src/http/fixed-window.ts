/**
 * A fixed-window counter with lazily bounded memory — the one rate-limiting
 * algorithm this server has.
 *
 * It was written inside `WsAdmissionController.preflight` and lived there
 * alone. `auth.login` needed the same shape, and the choice was to copy the
 * loop or to lift it; copying would have meant two eviction policies drifting
 * apart, and the eviction policy is the subtle half. So this is the lift:
 * ws-admission now consumes it and keeps its own connection-lease counters,
 * which are a capacity concern and genuinely different.
 *
 * WHY FIXED WINDOW AND NOT A TOKEN BUCKET. A tumbling window lets a caller
 * spend the whole budget at the very end of one window and again at the very
 * start of the next — a 2x burst across the seam. That is a real property and
 * it is accepted: the limits here are set to catch automated floods, where the
 * burst is irrelevant, not to shape well-behaved traffic. The window is one
 * integer and one timestamp per key; a bucket is refill arithmetic on every
 * hit for a smoothness nobody is asking for.
 *
 * WHY IT FAILS CLOSED FOR NEW KEYS. A limiter that allocates a bucket per
 * distinct key is itself a memory amplifier: spoofable keys (see
 * `wsClientKey`) mean an attacker picks the cardinality. Above `maxKeys` we
 * sweep expired windows, and if that does not get us under the cap we refuse
 * NEW keys while existing ones continue. Refusing the newcomer is the right
 * side to fail on — the established buckets are the ones with legitimate
 * traffic in them.
 */

export interface FixedWindowOptions {
  /** Hits allowed per window. The (limit + 1)th hit in a window is refused. */
  readonly limit: number;
  readonly windowMs: number;
  /** Distinct keys held before the sweep + fail-closed arm engages. */
  readonly maxKeys?: number;
}

export type FixedWindowVerdict =
  | { readonly ok: true; readonly count: number }
  /**
   * `over_limit` — this key spent its budget. `saturated` — the limiter is at
   * its key cap and this key is new. Both refuse; they are distinguished
   * because only the first is about the caller, and an operator reading logs
   * needs to know which one they are looking at.
   */
  | { readonly ok: false; readonly reason: 'over_limit' | 'saturated'; readonly retryAfterMs: number };

type Window = { startedAt: number; count: number };

const DEFAULT_MAX_KEYS = 10_000;

export class FixedWindowLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, Window>();

  constructor(options: FixedWindowOptions, now: () => number = Date.now) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.now = now;
  }

  /** Counts one hit against `key` and says whether it is allowed. */
  hit(key: string): FixedWindowVerdict {
    const now = this.now();
    const prior = this.windows.get(key);

    if (!prior && this.windows.size >= this.maxKeys) {
      this.sweep(now);
      if (this.windows.size >= this.maxKeys) {
        return { ok: false, reason: 'saturated', retryAfterMs: this.windowMs };
      }
    }

    const window = !prior || now - prior.startedAt >= this.windowMs
      ? { startedAt: now, count: 0 }
      : prior;
    window.count += 1;
    this.windows.set(key, window);

    if (window.count > this.limit) {
      // Time until THIS key's window rolls, never a fixed constant: telling
      // every refused caller the same number is how you synchronise them into
      // a thundering herd on the boundary.
      const remaining = window.startedAt + this.windowMs - now;
      return { ok: false, reason: 'over_limit', retryAfterMs: remaining > 0 ? remaining : this.windowMs };
    }
    return { ok: true, count: window.count };
  }

  /**
   * Reports whether `key` has already spent its budget, WITHOUT counting a
   * hit. A failure counter has to be readable this way: the check happens
   * before the attempt and the attempt is not itself a failure, so `hit` would
   * both mis-count and (paired with `clear`) erase the history it is meant to
   * be reading.
   */
  peek(key: string): { readonly spent: boolean; readonly retryAfterMs: number } {
    const now = this.now();
    const window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      return { spent: false, retryAfterMs: 0 };
    }
    const remaining = window.startedAt + this.windowMs - now;
    return {
      spent: window.count >= this.limit,
      retryAfterMs: remaining > 0 ? remaining : this.windowMs,
    };
  }

  /**
   * Drops `key`'s window. The caller that needs this is a FAILURE counter
   * after a success: proving you know the credential must clear the record of
   * having guessed at it, or one wrong attempt would follow a legitimate user
   * for the rest of the window.
   */
  clear(key: string): void {
    this.windows.delete(key);
  }

  /** Distinct live keys. Exposed for tests and for a health/metrics read. */
  size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    const target = Math.floor(this.maxKeys * 0.9);
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
      if (this.windows.size < target) break;
    }
  }
}
