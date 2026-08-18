import { describe, expect, it } from 'vitest';

import { AuthRateLimiter } from '../src/http/auth-rate-limit.js';
import { FixedWindowLimiter } from '../src/http/fixed-window.js';

/** Every test drives an explicit clock — nothing here waits on real time. */
function at(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return { now: () => value, advance: (ms: number) => { value += ms; } };
}

function loginBody(username: string): unknown {
  return { username, password: 'whatever' };
}

/** Drains a principal's failure budget so the next check is the refused one. */
function failNTimes(limiter: AuthRateLimiter, username: string, n: number): void {
  for (let i = 0; i < n; i += 1) {
    limiter.recordOutcome('auth.login', loginBody(username), true);
  }
}

describe('FixedWindowLimiter', () => {
  it('allows exactly `limit` hits, then refuses until the window rolls', () => {
    const clock = at();
    const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 1_000 }, clock.now);

    expect(limiter.hit('k').ok).toBe(true);
    expect(limiter.hit('k').ok).toBe(true);
    const refused = limiter.hit('k');
    expect(refused).toMatchObject({ ok: false, reason: 'over_limit' });

    clock.advance(1_001);
    expect(limiter.hit('k').ok).toBe(true);
  });

  it('reports a retryAfter that shrinks as the window drains, never a constant', () => {
    const clock = at();
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 10_000 }, clock.now);
    limiter.hit('k');

    const early = limiter.hit('k');
    clock.advance(6_000);
    const late = limiter.hit('k');

    expect(early.ok).toBe(false);
    expect(late.ok).toBe(false);
    // Two callers refused at different points in the same window must be told
    // different numbers, or they resynchronise into one herd on the boundary.
    if (early.ok || late.ok) throw new Error('expected both to be refused');
    expect(late.retryAfterMs).toBeLessThan(early.retryAfterMs);
    expect(late.retryAfterMs).toBeGreaterThan(0);
  });

  it('peek reports spentness without consuming budget', () => {
    const clock = at();
    const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 1_000 }, clock.now);

    expect(limiter.peek('k').spent).toBe(false);
    // A hundred peeks must not move the counter — this is the property the
    // auth check path depends on.
    for (let i = 0; i < 100; i += 1) limiter.peek('k');
    expect(limiter.hit('k').ok).toBe(true);
    expect(limiter.hit('k').ok).toBe(true);
    expect(limiter.peek('k').spent).toBe(true);
  });

  it('clear drops the window so a fresh budget is available', () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 1_000 }, at().now);
    limiter.hit('k');
    expect(limiter.peek('k').spent).toBe(true);
    limiter.clear('k');
    expect(limiter.peek('k').spent).toBe(false);
  });

  it('fails closed for NEW keys at the cap while established keys continue', () => {
    const clock = at();
    const limiter = new FixedWindowLimiter({ limit: 10, windowMs: 60_000, maxKeys: 4 }, clock.now);
    for (const key of ['a', 'b', 'c', 'd']) limiter.hit(key);

    // Nothing has expired, so the sweep frees nothing and the newcomer is the
    // one refused. An established bucket is still served.
    expect(limiter.hit('newcomer')).toMatchObject({ ok: false, reason: 'saturated' });
    expect(limiter.hit('a').ok).toBe(true);

    // Once the existing windows age out, the sweep reclaims them.
    clock.advance(60_001);
    expect(limiter.hit('newcomer').ok).toBe(true);
    expect(limiter.size()).toBeLessThanOrEqual(4);
  });
});

describe('AuthRateLimiter — client attempts', () => {
  it('refuses a guarded op past the attempt limit and leaves other ops alone', () => {
    const limiter = new AuthRateLimiter(
      { maxAttemptsPerClient: 2, attemptWindowMs: 60_000 },
      at().now,
    );

    limiter.check('auth.login', 'ip-1', loginBody('alice'));
    limiter.check('auth.login', 'ip-1', loginBody('alice'));
    expect(() => limiter.check('auth.login', 'ip-1', loginBody('alice'))).toThrow(/too many/i);

    // A different client has its own budget...
    expect(() => limiter.check('auth.login', 'ip-2', loginBody('alice'))).not.toThrow();
    // ...and an unguarded operation is never counted at all.
    expect(() => limiter.check('entities.upsert', 'ip-1', {})).not.toThrow();
  });

  it('carries a whole-second retryAfterSeconds in details for the 429 header', () => {
    const limiter = new AuthRateLimiter(
      { maxAttemptsPerClient: 1, attemptWindowMs: 30_000 },
      at().now,
    );
    limiter.check('auth.login', 'ip-1', loginBody('alice'));

    try {
      limiter.check('auth.login', 'ip-1', loginBody('alice'));
      throw new Error('expected a refusal');
    } catch (err) {
      const details = (err as { details?: Record<string, unknown> }).details;
      expect((err as { code?: string }).code).toBe('rate_limited');
      expect(details?.retryAfterSeconds).toBe(30);
    }
  });
});

describe('AuthRateLimiter — principal failures', () => {
  it('refuses the attempt AFTER the budget of failures is spent', () => {
    const limiter = new AuthRateLimiter(
      { maxFailuresPerPrincipal: 3, failureWindowMs: 900_000, maxAttemptsPerClient: 1_000 },
      at().now,
    );

    // Two failures: still admitted, because two is under the limit.
    failNTimes(limiter, 'alice', 2);
    expect(() => limiter.check('auth.login', 'ip-1', loginBody('alice'))).not.toThrow();

    // The third spends the budget; the next attempt is the one refused.
    failNTimes(limiter, 'alice', 1);
    expect(() => limiter.check('auth.login', 'ip-1', loginBody('alice'))).toThrow(/too many/i);
  });

  it('follows the account across clients — the point of the dimension', () => {
    const limiter = new AuthRateLimiter(
      { maxFailuresPerPrincipal: 2, failureWindowMs: 900_000, maxAttemptsPerClient: 1_000 },
      at().now,
    );
    failNTimes(limiter, 'alice', 2);

    // Credential stuffing rotates the source address; the principal bucket is
    // what makes that rotation pointless.
    expect(() => limiter.check('auth.login', 'a-fresh-ip', loginBody('alice'))).toThrow(/too many/i);
    // A different account from that same fresh address is unaffected.
    expect(() => limiter.check('auth.login', 'a-fresh-ip', loginBody('bob'))).not.toThrow();
  });

  it('a success clears the failures, so a typo does not follow a real user', () => {
    const limiter = new AuthRateLimiter(
      { maxFailuresPerPrincipal: 3, failureWindowMs: 900_000, maxAttemptsPerClient: 1_000 },
      at().now,
    );
    failNTimes(limiter, 'alice', 2);
    limiter.recordOutcome('auth.login', loginBody('alice'), false);

    failNTimes(limiter, 'alice', 2);
    expect(() => limiter.check('auth.login', 'ip-1', loginBody('alice'))).not.toThrow();
  });

  it('CHECKING never counts as failing — otherwise checks would lock the account out', () => {
    const limiter = new AuthRateLimiter(
      { maxFailuresPerPrincipal: 2, failureWindowMs: 900_000, maxAttemptsPerClient: 1_000 },
      at().now,
    );
    // This is the regression that matters: a check that mutated the failure
    // window would refuse a user who has never once got their password wrong.
    for (let i = 0; i < 50; i += 1) {
      expect(() => limiter.check('auth.login', `ip-${i}`, loginBody('alice'))).not.toThrow();
    }
  });

  it('cannot be used to lock someone out, because only real failures count', () => {
    const limiter = new AuthRateLimiter(
      { maxFailuresPerPrincipal: 2, failureWindowMs: 900_000, maxAttemptsPerClient: 1_000 },
      at().now,
    );
    // An attacker who merely NAMES the victim moves nothing.
    for (let i = 0; i < 20; i += 1) limiter.check('auth.login', 'attacker', loginBody('victim'));
    expect(() => limiter.check('auth.login', 'victim-ip', loginBody('victim'))).not.toThrow();
  });

  it('releases the principal once its window rolls', () => {
    const clock = at();
    const limiter = new AuthRateLimiter(
      { maxFailuresPerPrincipal: 1, failureWindowMs: 900_000, maxAttemptsPerClient: 1_000 },
      clock.now,
    );
    failNTimes(limiter, 'alice', 1);
    expect(() => limiter.check('auth.login', 'ip-1', loginBody('alice'))).toThrow();

    clock.advance(900_001);
    expect(() => limiter.check('auth.login', 'ip-1', loginBody('alice'))).not.toThrow();
  });
});

describe('AuthRateLimiter — what is never a bucket key', () => {
  it('does not key a principal bucket off a bearer capability', () => {
    const limiter = new AuthRateLimiter(
      { maxFailuresPerPrincipal: 1, failureWindowMs: 900_000, maxAttemptsPerClient: 1_000 },
      at().now,
    );
    // An invite code and a claim token are credentials. Failing on them must
    // not create a per-secret bucket holding the secret in memory; these ops
    // get the client dimension only.
    limiter.recordOutcome('auth.invite.resolve', { code: 'inv_secret' }, true);
    limiter.recordOutcome('auth.claim', { token: 'tm8c_secret' }, true);
    expect(() => limiter.check('auth.invite.resolve', 'ip-1', { code: 'inv_secret' })).not.toThrow();
    expect(() => limiter.check('auth.claim', 'ip-1', { token: 'tm8c_secret' })).not.toThrow();
  });

  it('treats usernames case-insensitively and survives a hostile body', () => {
    const limiter = new AuthRateLimiter(
      { maxFailuresPerPrincipal: 1, failureWindowMs: 900_000, maxAttemptsPerClient: 1_000 },
      at().now,
    );
    limiter.recordOutcome('auth.login', loginBody('Alice'), true);
    // Case must not be a way to mint a fresh budget for the same account.
    expect(() => limiter.check('auth.login', 'ip-1', loginBody('alice'))).toThrow(/too many/i);

    // A body with no usable username simply has no principal dimension.
    expect(() => limiter.check('auth.login', 'ip-2', null)).not.toThrow();
    expect(() => limiter.check('auth.login', 'ip-2', { username: 42 })).not.toThrow();
    expect(() => limiter.check('auth.login', 'ip-2', { username: '   ' })).not.toThrow();
  });
});

describe('AuthRateLimiter — disabling', () => {
  it('a limit of 0 switches that dimension off without refusing everything', () => {
    const limiter = new AuthRateLimiter(
      { maxAttemptsPerClient: 0, maxFailuresPerPrincipal: 0 },
      at().now,
    );
    for (let i = 0; i < 500; i += 1) {
      limiter.recordOutcome('auth.login', loginBody('alice'), true);
      expect(() => limiter.check('auth.login', 'ip-1', loginBody('alice'))).not.toThrow();
    }
  });
});
