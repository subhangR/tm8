/**
 * Style write limits — styles spec 01a0fc22 v8 §6.7.
 *
 * WHY STYLES, WHEN NO OTHER ENTITY WRITE IS LIMITED. A push repaints every
 * viewer on that space style and a personal edit repaints every one of the
 * owner's tabs, so a looping agent is not a load problem but a strobe in
 * other people's windows. The limits are set well above anything a person at
 * an editor or an agent iterating on a theme does, and well below a loop.
 *
 * | family   | ops                                                   | key      | limit                         |
 * |----------|-------------------------------------------------------|----------|-------------------------------|
 * | edit     | styles.personal.create/update/delete, styles.pull     | identity | 120 / 60 s, burst 20 / 5 s    |
 * | publish  | styles.push, styles.remove                            | identity | 20 / 60 s, burst 5 / 10 s     |
 * | resolve  | styles.resolve                                        | identity | 120 / 60 s                    |
 * | prefs    | identity.stylePrefs.set                               | identity | 30 / 60 s                     |
 * | default  | spaces.styleDefault.set                               | space    | 30 / 60 s                     |
 *
 * A breach is `429 rate_limited` with `details.retryAfterMs` (the time until
 * THIS key's window rolls, from `FixedWindowLimiter`). Every count is
 * env-overridable like `TM8_AUTH_MAX_ATTEMPTS` (`config.ts`); 0 disables that
 * window. In-memory and per-process, like every other limiter here (see
 * `auth-rate-limit.ts` for why that is enough).
 *
 * A refused hit still counts against the window it was refused by. That is
 * the FixedWindowLimiter contract everywhere else in this server, and it is
 * the right side for a loop: hammering through a 429 keeps it closed.
 */
import { fail } from './errors.js';
import { FixedWindowLimiter } from './fixed-window.js';

export interface StyleRateLimits {
  /** Edit family per identity per minute; 0 disables. */
  readonly editPerMinute: number;
  /** Edit family burst per identity per 5 s; 0 disables. */
  readonly editBurst: number;
  /** Publish family (push/remove) per identity per minute; 0 disables. */
  readonly publishPerMinute: number;
  /** Publish family burst per identity per 10 s; 0 disables. */
  readonly publishBurst: number;
  /** `styles.resolve` per identity per minute; 0 disables. */
  readonly resolvePerMinute: number;
  /** `identity.stylePrefs.set` per identity per minute; 0 disables. */
  readonly prefsPerMinute: number;
  /** `spaces.styleDefault.set` per space per minute; 0 disables. */
  readonly defaultPerMinute: number;
}

export const DEFAULT_STYLE_RATE_LIMITS: StyleRateLimits = {
  editPerMinute: 120,
  editBurst: 20,
  publishPerMinute: 20,
  publishBurst: 5,
  resolvePerMinute: 120,
  prefsPerMinute: 30,
  defaultPerMinute: 30,
};

export type StyleRateFamily = 'edit' | 'publish' | 'resolve' | 'prefs' | 'default';

/** Which family each limited operation spends from. Reads are never limited. */
export const STYLE_RATE_FAMILY: Readonly<Record<string, StyleRateFamily>> = {
  'styles.personal.create': 'edit',
  'styles.personal.update': 'edit',
  'styles.personal.delete': 'edit',
  'styles.pull': 'edit',
  'styles.push': 'publish',
  'styles.remove': 'publish',
  'styles.resolve': 'resolve',
  'identity.stylePrefs.set': 'prefs',
  'spaces.styleDefault.set': 'default',
};

const MINUTE_MS = 60_000;

function window(limit: number, windowMs: number, now: () => number): FixedWindowLimiter | null {
  return limit > 0 ? new FixedWindowLimiter({ limit, windowMs }, now) : null;
}

export class StyleRateLimiter {
  /** Per family: the sustained window first, then the burst window (if any). */
  private readonly windows: Readonly<Record<StyleRateFamily, readonly FixedWindowLimiter[]>>;

  constructor(limits: Partial<StyleRateLimits> = {}, now: () => number = Date.now) {
    const l = { ...DEFAULT_STYLE_RATE_LIMITS, ...limits };
    const keep = (...ws: (FixedWindowLimiter | null)[]) => ws.filter((w): w is FixedWindowLimiter => w !== null);
    this.windows = {
      edit: keep(window(l.editPerMinute, MINUTE_MS, now), window(l.editBurst, 5_000, now)),
      publish: keep(window(l.publishPerMinute, MINUTE_MS, now), window(l.publishBurst, 10_000, now)),
      resolve: keep(window(l.resolvePerMinute, MINUTE_MS, now)),
      prefs: keep(window(l.prefsPerMinute, MINUTE_MS, now)),
      default: keep(window(l.defaultPerMinute, MINUTE_MS, now)),
    };
  }

  /**
   * Counts one hit for `opName` against `key` (an identity id, or a space id
   * for the default) and throws `rate_limited` when any window is spent. An
   * operation outside the table is a no-op, so a read can never be refused.
   */
  check(opName: string, key: string): void {
    const family = STYLE_RATE_FAMILY[opName];
    if (family === undefined) return;
    for (const limiter of this.windows[family]) {
      const verdict = limiter.hit(`${family}:${key}`);
      if (!verdict.ok) {
        throw fail('rate_limited', `too many ${opName} calls — wait and try again`, {
          retryAfterMs: verdict.retryAfterMs,
        });
      }
    }
  }
}
