/**
 * The loop schedule grammar (dreamer-dispatcher DESIGN §4.4).
 *
 * A wrong schedule fails SILENTLY — the loop simply never fires, or fires on a
 * day nobody asked for, and the only symptom is absence. So the cases here are
 * chosen for the ways cron implementations are known to be wrong rather than
 * for coverage of the happy path.
 */
import { describe, expect, it } from 'vitest';

import {
  assertValidSchedule, describeSchedule, isValidTimezone, nextRunAt, previewSchedule, ScheduleError,
} from '../../src/scheduler/schedule.js';

const at = (iso: string): Date => new Date(iso);
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

describe('every <n>{m|h|d}', () => {
  it('advances by the stated interval from the given instant', () => {
    expect(iso(nextRunAt('every 5m', at('2026-08-09T10:00:00Z')))).toBe('2026-08-09T10:05:00.000Z');
    expect(iso(nextRunAt('every 2h', at('2026-08-09T10:00:00Z')))).toBe('2026-08-09T12:00:00.000Z');
    expect(iso(nextRunAt('every 1d', at('2026-08-09T10:00:00Z')))).toBe('2026-08-10T10:00:00.000Z');
  });

  it('is case- and whitespace-tolerant, because humans type it', () => {
    expect(iso(nextRunAt('  EVERY   3 H ', at('2026-08-09T10:00:00Z'))))
      .toBe('2026-08-09T13:00:00.000Z');
  });

  it('refuses a zero interval rather than scheduling a busy loop', () => {
    expect(() => nextRunAt('every 0m', at('2026-08-09T10:00:00Z'))).toThrow();
  });
});

describe('5-field cron', () => {
  it('finds the next matching minute, not the current one', () => {
    // Already exactly on the match: the answer must be the NEXT one, or a
    // firing would re-trigger itself for the rest of the minute.
    expect(iso(nextRunAt('0 3 * * *', at('2026-08-09T03:00:00Z')))).toBe('2026-08-10T03:00:00.000Z');
    expect(iso(nextRunAt('0 3 * * *', at('2026-08-09T02:59:00Z')))).toBe('2026-08-09T03:00:00.000Z');
  });

  it('handles steps, lists and ranges', () => {
    expect(iso(nextRunAt('*/15 * * * *', at('2026-08-09T10:01:00Z')))).toBe('2026-08-09T10:15:00.000Z');
    expect(iso(nextRunAt('0,30 * * * *', at('2026-08-09T10:05:00Z')))).toBe('2026-08-09T10:30:00.000Z');
    expect(iso(nextRunAt('0 9-17 * * *', at('2026-08-09T08:10:00Z')))).toBe('2026-08-09T09:00:00.000Z');
  });

  it('treats `a/s` as "from a to the top of the field", like every other cron', () => {
    expect(iso(nextRunAt('0/20 * * * *', at('2026-08-09T10:05:00Z')))).toBe('2026-08-09T10:20:00.000Z');
  });

  /**
   * THE classic silent bug. POSIX says that when BOTH day-of-month and
   * day-of-week are restricted, a date matching EITHER matches. An
   * implementation that ANDs them turns "the 1st, and every Monday" into
   * "Mondays that fall on the 1st" — which fires a handful of times a decade
   * and looks like a broken loop, not a broken parser.
   */
  it('ORs day-of-month with day-of-week when both are restricted', () => {
    // 2026-08-09 is a Sunday. `1` = the 1st of the month; `1` = Monday.
    const next = nextRunAt('0 0 1 * 1', at('2026-08-09T12:00:00Z'));
    // The following Monday (2026-08-10) must match via day-of-week alone,
    // even though it is the 10th and not the 1st.
    expect(iso(next)).toBe('2026-08-10T00:00:00.000Z');
  });

  it('ANDs nothing when only one day field is restricted', () => {
    // Day-of-month only: the 15th, whatever weekday that is.
    expect(iso(nextRunAt('0 0 15 * *', at('2026-08-09T12:00:00Z'))))
      .toBe('2026-08-15T00:00:00.000Z');
  });

  it('crosses month and year boundaries', () => {
    expect(iso(nextRunAt('0 0 1 1 *', at('2026-08-09T12:00:00Z')))).toBe('2027-01-01T00:00:00.000Z');
  });

  it('returns null for an expression that can never match', () => {
    // February 30th. Reportable, not throwable: the loop keeps its row and the
    // reason lands in last_error where a human can see it.
    expect(nextRunAt('0 0 30 2 *', at('2026-08-09T12:00:00Z'))).toBeNull();
  });

  it('rejects malformed expressions loudly', () => {
    expect(() => nextRunAt('0 0 *', at('2026-08-09T12:00:00Z'))).toThrow(ScheduleError);
    expect(() => nextRunAt('0 99 * * *', at('2026-08-09T12:00:00Z'))).toThrow(ScheduleError);
    expect(() => nextRunAt('0 0 * * 9', at('2026-08-09T12:00:00Z'))).toThrow(ScheduleError);
  });

  it('is evaluated in UTC, so a schedule cannot drift with the host timezone', () => {
    // Asserted as an absolute instant: if this were local-time arithmetic the
    // answer would move with TZ, and a nightly job would double-fire or vanish
    // one night a year.
    expect(iso(nextRunAt('30 2 * * *', at('2026-08-09T00:00:00Z'))))
      .toBe('2026-08-09T02:30:00.000Z');
  });
});

describe('assertValidSchedule', () => {
  it('accepts both grammars and rejects everything else', () => {
    expect(() => assertValidSchedule('every 10m')).not.toThrow();
    expect(() => assertValidSchedule('*/5 * * * *')).not.toThrow();
    expect(() => assertValidSchedule('hourly')).toThrow(ScheduleError);
  });
});

describe('cron in an IANA timezone (loops design §3.1)', () => {
  it('matches the wall clock of the zone, not UTC', () => {
    // 09:00 in London in summer is 08:00 UTC.
    expect(iso(nextRunAt('0 9 * * *', at('2026-07-01T00:00:00Z'), 'Europe/London'))).toBe('2026-07-01T08:00:00.000Z');
    // ...and in winter it is 09:00 UTC.
    expect(iso(nextRunAt('0 9 * * *', at('2026-01-05T00:00:00Z'), 'Europe/London'))).toBe('2026-01-05T09:00:00.000Z');
    expect(iso(nextRunAt('30 8 * * 1-5', at('2026-10-30T13:00:00Z'), 'America/New_York')))
      .toBe('2026-11-02T13:30:00.000Z'); // Friday afternoon -> Monday 08:30 EST
  });

  it('keeps day-of-week in the zone across the UTC date line', () => {
    // Monday 07:00 in Tokyo is Sunday 22:00 UTC.
    expect(iso(nextRunAt('0 7 * * 1', at('2026-08-08T00:00:00Z'), 'Asia/Tokyo'))).toBe('2026-08-09T22:00:00.000Z');
  });

  it('DST spring-forward: a wall-clock minute that does not exist is skipped', () => {
    // 2026-03-29 01:30 does not exist in London; the next 01:30 is the 30th.
    expect(iso(nextRunAt('30 1 * * *', at('2026-03-28T12:00:00Z'), 'Europe/London'))).toBe('2026-03-30T00:30:00.000Z');
  });

  it('DST fall-back: a wall-clock minute that occurs twice fires once, the first time', () => {
    // 2026-10-25 01:30 London happens at 00:30 UTC (BST) and again at 01:30 UTC (GMT).
    const first = nextRunAt('30 1 * * *', at('2026-10-24T12:00:00Z'), 'Europe/London');
    expect(iso(first)).toBe('2026-10-25T00:30:00.000Z');
    expect(iso(nextRunAt('30 1 * * *', first!, 'Europe/London'))).toBe('2026-10-26T01:30:00.000Z');
  });

  it('intervals are zone-free', () => {
    expect(iso(nextRunAt('every 1d', at('2026-03-28T12:00:00Z'), 'Europe/London'))).toBe('2026-03-29T12:00:00.000Z');
  });

  it('refuses an unknown zone', () => {
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(() => nextRunAt('0 9 * * *', at('2026-07-01T00:00:00Z'), 'Mars/Olympus')).toThrow(ScheduleError);
  });
});

describe('describeSchedule', () => {
  it.each([
    ['every 15m', 'UTC', 'Every 15 minutes'],
    ['every 1h', 'UTC', 'Every hour'],
    ['every 2d', 'UTC', 'Every 2 days'],
    ['0 9 * * *', 'Europe/London', 'Every day at 09:00 Europe/London'],
    ['30 8 * * 1-5', 'UTC', 'Weekdays at 08:30 UTC'],
    ['0 10 * * 0,6', 'UTC', 'Weekends at 10:00 UTC'],
    ['0 7 * * 1', 'Asia/Tokyo', 'Every Monday at 07:00 Asia/Tokyo'],
    ['*/10 * * * *', 'UTC', 'Every 10 minutes'],
    ['5 * * * *', 'UTC', 'Every hour at :05'],
    ['17 3 1 * *', 'UTC', 'Cron `17 3 1 * *` (UTC)'],
  ])('%s in %s', (schedule, timezone, summary) => {
    expect(describeSchedule(schedule, timezone)).toBe(summary);
  });
});

describe('previewSchedule', () => {
  it('returns the summary and the next instants', () => {
    const preview = previewSchedule('0 9 * * *', 'UTC', 3, at('2026-08-09T10:00:00Z'));
    expect(preview).toEqual({
      valid: true, problem: null, summary: 'Every day at 09:00 UTC',
      next: ['2026-08-10T09:00:00.000Z', '2026-08-11T09:00:00.000Z', '2026-08-12T09:00:00.000Z'],
    });
  });

  it('reports an invalid schedule or zone with the problem, never throws', () => {
    expect(previewSchedule('every 0m', 'UTC', 5).valid).toBe(false);
    expect(previewSchedule('61 * * * *', 'UTC', 5)).toMatchObject({ valid: false, next: [] });
    expect(previewSchedule('0 9 * * *', 'Mars/Olympus', 5).problem).toMatch(/timezone/);
  });

  it('an unsatisfiable cron is invalid with a reason', () => {
    expect(previewSchedule('0 0 30 2 *', 'UTC', 5)).toMatchObject({ valid: false, problem: expect.stringMatching(/never matches/) });
  });

  it('count 0 skips the stepping (list rows)', () => {
    expect(previewSchedule('0 0 30 2 *', 'UTC', 0)).toMatchObject({ valid: true, next: [] });
  });
});
