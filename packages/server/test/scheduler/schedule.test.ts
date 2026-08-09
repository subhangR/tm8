/**
 * The loop schedule grammar (dreamer-dispatcher DESIGN §4.4).
 *
 * A wrong schedule fails SILENTLY — the loop simply never fires, or fires on a
 * day nobody asked for, and the only symptom is absence. So the cases here are
 * chosen for the ways cron implementations are known to be wrong rather than
 * for coverage of the happy path.
 */
import { describe, expect, it } from 'vitest';

import { assertValidSchedule, nextRunAt, ScheduleError } from '../../src/scheduler/schedule.js';

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
