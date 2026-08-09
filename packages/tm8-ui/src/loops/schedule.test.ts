import { describe, expect, it } from 'vitest';
import { loopScheduleProblem, nextLoopRunAt } from './schedule';

describe('loop schedule parity with the node executor', () => {
  it('advances fixed intervals from the supplied instant', () => {
    const from = new Date('2026-08-09T12:34:56.000Z');
    expect(nextLoopRunAt('every 15m', from)?.toISOString()).toBe('2026-08-09T12:49:56.000Z');
    expect(nextLoopRunAt('every 2h', from)?.toISOString()).toBe('2026-08-09T14:34:56.000Z');
  });

  it('evaluates cron in UTC from the next whole minute', () => {
    const from = new Date('2026-08-09T08:59:40.000Z');
    expect(nextLoopRunAt('0 9 * * *', from)?.toISOString()).toBe('2026-08-09T09:00:00.000Z');
  });

  it('keeps POSIX day-of-month/day-of-week OR semantics', () => {
    const from = new Date('2026-08-02T00:00:00.000Z');
    // Monday the 3rd matches the restricted DOW even though it is not the 1st.
    expect(nextLoopRunAt('0 9 1 * 1', from)?.toISOString()).toBe('2026-08-03T09:00:00.000Z');
  });

  it('returns a visible problem for malformed and impossible schedules', () => {
    expect(loopScheduleProblem('tomorrow')).toContain('5 fields');
    expect(loopScheduleProblem('0 0 30 2 *', new Date('2026-01-01T00:00:00.000Z')))
      .toContain('does not match');
  });
});
