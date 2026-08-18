/**
 * Rate limiting for the credential-bearing operations.
 *
 * `auth.login` is timing-safe — a wrong username spends the same scrypt work
 * as a wrong password (`identity/crypto.ts` UNMATCHABLE_VERIFIER) — but it was
 * never volume-limited. Timing safety stops you learning WHICH half was wrong;
 * it does nothing about ten thousand tries. nginx has `limit_req` on
 * `/v2/ws` only, so `location /` — which carries every auth call — reached the
 * node unthrottled from the edge as well.
 *
 * TWO DIMENSIONS, COUNTED DIFFERENTLY, AND THE DIFFERENCE IS THE WHOLE POINT.
 *
 *   client → ATTEMPTS.  Every guarded op, counted whether it succeeds or
 *     fails. This is the flood limit: one source hammering the node.
 *
 *   principal → FAILURES.  Only wrong answers count, and a success clears the
 *     bucket. This is the credential-stuffing limit: many sources, one
 *     account.
 *
 * Counting ATTEMPTS per principal instead would build a denial-of-service
 * against real users: anyone who can name your username could burn its budget
 * and lock you out of your own node. Counting failures cannot be abused that
 * way, because an attacker cannot manufacture failures against an account
 * without... failing, which is the thing being measured. The cost is that the
 * outcome must be observed, which is why this class has a `record` half and
 * the pipeline calls it around the handler rather than only before it.
 *
 * WHAT IS NEVER A BUCKET KEY: a secret. Usernames are public-ish identifiers
 * and are safe to hold. An invite code and a claim token are BEARER
 * CAPABILITIES — keying a Map by one would put live credentials in process
 * memory and, worse, in any future dump of limiter state. So token-bearing ops
 * get the client dimension only, which is the dimension that actually bounds
 * guessing at an unguessable string anyway.
 *
 * IN-MEMORY, PER-PROCESS, RESET BY A RESTART. Consistent with every other
 * ephemeral guard here (ws-admission, presence, subscriptions); there is no
 * counter table in this schema and inventing one for this would be the only
 * durable rate state in the system. An attacker who can restart the server has
 * already won.
 */
import { fail } from './errors.js';
import { FixedWindowLimiter } from './fixed-window.js';

export interface AuthRateLimits {
  /** Attempts per client per window, across all guarded ops. */
  readonly maxAttemptsPerClient: number;
  readonly attemptWindowMs: number;
  /** Consecutive failures per principal before refusal. */
  readonly maxFailuresPerPrincipal: number;
  readonly failureWindowMs: number;
}

export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  // Generous enough that a human retyping a password, or a browser gate
  // probing `auth.session.get` on every mount, never notices.
  maxAttemptsPerClient: 60,
  attemptWindowMs: 60_000,
  // Tight, because it only ever counts wrong answers and a right one wipes it.
  maxFailuresPerPrincipal: 10,
  failureWindowMs: 15 * 60_000,
};

/**
 * The credential-guessing surface. Five of these are claim-free (reachable
 * with no credential at all), which is exactly why they need a volume bound;
 * `auth.password.change` is here for the walk-up case — a live session must
 * not be able to grind out the CURRENT password it was asked for.
 *
 * Deliberately absent: `auth.session.get` and `auth.logout`. Neither takes a
 * guessable secret in its body, both are called on a schedule by a healthy
 * client, and limiting them would throttle the gate rather than an attacker.
 */
export const RATE_LIMITED_AUTH_OPS: ReadonlySet<string> = new Set([
  'auth.login',
  'auth.signup',
  'auth.password.change',
  'auth.claim',
  'auth.claim.reissue',
  'auth.invite.resolve',
  'auth.invite.signup',
]);

/**
 * Ops whose body carries a non-secret identifier worth counting failures
 * against. The value is the body field to read.
 */
const PRINCIPAL_FIELD: Readonly<Record<string, string>> = {
  'auth.login': 'username',
  'auth.signup': 'username',
  'auth.invite.signup': 'username',
};

function principalOf(opName: string, body: unknown): string | null {
  const field = PRINCIPAL_FIELD[opName];
  if (!field) return null;
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as Record<string, unknown>)[field];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  // Bounded: the key comes from an untrusted body, and an unbounded one lets a
  // caller inflate the Map's memory per entry as well as its cardinality.
  return trimmed.length === 0 ? null : `${opName}:${trimmed.slice(0, 120)}`;
}

/**
 * The client bucket is `wsClientKey` — imported, not reimplemented. Its rule
 * is the TCP peer upgraded to `X-Real-IP` ONLY when the peer is loopback:
 * behind nginx every peer is 127.0.0.1, so without the upgrade the whole
 * internet shares one bucket, and trusting that header from a non-loopback
 * peer would let anyone choose their own bucket. Both halves are load-bearing,
 * which is exactly why there must not be a second copy of them.
 *
 * Known and accepted: on a single-machine dev node every caller IS loopback,
 * so all local clients share a bucket unless something sets `X-Real-IP`. Same
 * trade ws-admission already makes, and the attempt limit is set high enough
 * that it does not bite a developer.
 */
export class AuthRateLimiter {
  /**
   * `null` = this dimension is switched off (its configured limit was 0).
   * Modelled as absence rather than as a huge limit so the disabled case costs
   * nothing and, more importantly, cannot accumulate keys — a "limit of
   * Infinity" limiter is still a Map that grows with every distinct caller.
   */
  private readonly attempts: FixedWindowLimiter | null;
  private readonly failures: FixedWindowLimiter | null;

  constructor(limits: Partial<AuthRateLimits> = {}, now: () => number = Date.now) {
    const resolved = { ...DEFAULT_AUTH_RATE_LIMITS, ...limits };
    this.attempts = resolved.maxAttemptsPerClient > 0
      ? new FixedWindowLimiter(
        { limit: resolved.maxAttemptsPerClient, windowMs: resolved.attemptWindowMs },
        now,
      )
      : null;
    this.failures = resolved.maxFailuresPerPrincipal > 0
      ? new FixedWindowLimiter(
        { limit: resolved.maxFailuresPerPrincipal, windowMs: resolved.failureWindowMs },
        now,
      )
      : null;
  }

  /**
   * Called before the handler runs. Throws `rate_limited` (429, retryable)
   * when either dimension is spent.
   *
   * The principal dimension is CHECKED here and COUNTED in `recordOutcome` —
   * checking a failure counter before the attempt is what makes the (n+1)th
   * try refuse instead of the (n+2)th.
   */
  check(opName: string, clientKey: string, body: unknown): void {
    if (!RATE_LIMITED_AUTH_OPS.has(opName)) return;

    const principal = this.failures === null ? null : principalOf(opName, body);
    if (principal !== null && this.failures !== null) {
      // `peek`, never `hit`: this call is a check, not a failure. Only
      // `recordOutcome` gets to leave a mark.
      const spent = this.failures.peek(principal);
      if (spent.spent) {
        // Deliberately the same words as the client refusal: which limit you
        // tripped is an oracle telling an attacker whether the account exists
        // and whether they are close to it.
        throw rateLimited(spent.retryAfterMs);
      }
    }

    if (this.attempts !== null) {
      const attempt = this.attempts.hit(clientKey);
      if (!attempt.ok) throw rateLimited(attempt.retryAfterMs);
    }
  }

  /**
   * Called after the handler settles. `failed` is the ONLY thing that moves
   * the principal counter, and a success clears it outright.
   */
  recordOutcome(opName: string, body: unknown, failed: boolean): void {
    if (this.failures === null || !RATE_LIMITED_AUTH_OPS.has(opName)) return;
    const principal = principalOf(opName, body);
    if (principal === null) return;
    if (failed) this.failures.hit(principal);
    else this.failures.clear(principal);
  }
}

function rateLimited(retryAfterMs: number): Error {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return fail(
    'rate_limited',
    'too many authentication attempts — wait and try again',
    { retryAfterSeconds },
  );
}
