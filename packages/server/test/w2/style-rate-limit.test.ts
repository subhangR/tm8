/**
 * Styles spec §6.7: the style write limits, the families they key on, the
 * 429 shape, and that 0 disables a window. Clock injected; no sleeping.
 */
import { describe, expect, it } from 'vitest';

import { CollabError } from '@tm8/contract';

import { DEFAULT_STYLE_RATE_LIMITS, STYLE_RATE_FAMILY, StyleRateLimiter } from '../../src/http/style-rate-limit.js';

function refusal(run: () => void): { code: string; retryAfterMs: unknown } | null {
  try {
    run();
    return null;
  } catch (err) {
    if (!(err instanceof CollabError)) throw err;
    return { code: err.code, retryAfterMs: (err.details as { retryAfterMs?: unknown }).retryAfterMs };
  }
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('style rate limits (§6.7)', () => {
  it('ships the spec table as its defaults', () => {
    expect(DEFAULT_STYLE_RATE_LIMITS).toEqual({
      editPerMinute: 120, editBurst: 20,
      publishPerMinute: 20, publishBurst: 5,
      resolvePerMinute: 120, prefsPerMinute: 30, defaultPerMinute: 30,
    });
  });

  it('limits every style write and resolve, and no read', () => {
    expect(Object.keys(STYLE_RATE_FAMILY).sort()).toEqual([
      'identity.stylePrefs.set', 'spaces.styleDefault.set',
      'styles.personal.create', 'styles.personal.delete', 'styles.personal.update',
      'styles.pull', 'styles.push', 'styles.remove', 'styles.resolve',
    ]);
    const limiter = new StyleRateLimiter({ editPerMinute: 1, editBurst: 1 });
    for (let i = 0; i < 50; i += 1) limiter.check('styles.get', 'me');
  });

  it('edit burst: the 21st write in 5 s is 429 rate_limited with the time left in the window', () => {
    const c = clock();
    const limiter = new StyleRateLimiter({}, c.now);
    for (let i = 0; i < 20; i += 1) limiter.check('styles.personal.update', 'me');
    c.advance(2_000);
    expect(refusal(() => limiter.check('styles.pull', 'me'))).toEqual({ code: 'rate_limited', retryAfterMs: 3_000 });
    // Another identity has its own budget.
    expect(refusal(() => limiter.check('styles.personal.update', 'you'))).toBeNull();
    // Once the burst window rolls, the same caller writes again.
    c.advance(3_000);
    expect(refusal(() => limiter.check('styles.personal.update', 'me'))).toBeNull();
  });

  it('edit sustained: 120 per minute even when every burst window is respected', () => {
    const c = clock();
    const limiter = new StyleRateLimiter({}, c.now);
    for (let i = 0; i < 120; i += 1) {
      if (i > 0 && i % 20 === 0) c.advance(5_000);
      limiter.check('styles.personal.create', 'me');
    }
    c.advance(5_000);
    expect(refusal(() => limiter.check('styles.personal.create', 'me'))?.code).toBe('rate_limited');
  });

  it('publish: burst 5 per 10 s, and push/remove share it', () => {
    const limiter = new StyleRateLimiter();
    for (let i = 0; i < 3; i += 1) limiter.check('styles.push', 'me');
    for (let i = 0; i < 2; i += 1) limiter.check('styles.remove', 'me');
    expect(refusal(() => limiter.check('styles.push', 'me'))?.code).toBe('rate_limited');
    // A different family is not spent by publishing.
    expect(refusal(() => limiter.check('styles.personal.update', 'me'))).toBeNull();
  });

  it('prefs 30 / 60 s per identity; default 30 / 60 s per key the caller passes (the space)', () => {
    const limiter = new StyleRateLimiter();
    for (let i = 0; i < 30; i += 1) {
      limiter.check('identity.stylePrefs.set', 'me');
      limiter.check('spaces.styleDefault.set', 'space-a');
    }
    expect(refusal(() => limiter.check('identity.stylePrefs.set', 'me'))?.code).toBe('rate_limited');
    expect(refusal(() => limiter.check('spaces.styleDefault.set', 'space-a'))?.code).toBe('rate_limited');
    expect(refusal(() => limiter.check('spaces.styleDefault.set', 'space-b'))).toBeNull();
  });

  it('0 disables a window (env-overridable like TM8_AUTH_MAX_ATTEMPTS)', () => {
    const limiter = new StyleRateLimiter({ editBurst: 0, editPerMinute: 0 });
    for (let i = 0; i < 500; i += 1) limiter.check('styles.personal.update', 'me');
  });
});
