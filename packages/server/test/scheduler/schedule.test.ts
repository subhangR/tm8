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

  it('accepts the IANA names the CLDR canonical list leaves out, and refuses what is not a zone name', () => {
    // Intl.supportedValuesOf('timeZone') lists Asia/Calcutta and Europe/Kiev, not the current names browsers report.
    for (const zone of ['Asia/Kolkata', 'Europe/Kyiv', 'America/Argentina/Buenos_Aires', 'US/Eastern', 'Etc/GMT+5', 'GMT']) {
      expect(isValidTimezone(zone), zone).toBe(true);
    }
    for (const zone of ['+05:30', ' UTC', 'Europe/London ', '../etc', '']) expect(isValidTimezone(zone), zone).toBe(false);
    expect(iso(nextRunAt('0 9 * * *', at('2026-07-01T00:00:00Z'), 'Asia/Kolkata'))).toBe('2026-07-01T03:30:00.000Z');
  });

  it('evaluates any spelling Intl accepts as its canonical zone (the caches are keyed by the canonical id)', () => {
    const from = at('2026-07-01T00:00:00Z');
    expect(iso(nextRunAt('0 9 * * *', from, 'eUrOpE/lOnDoN'))).toBe(iso(nextRunAt('0 9 * * *', from, 'Europe/London')));
  });
});

describe('bounds (review B1 and nit 10 of #1406)', () => {
  it('previews a yearly cron in milliseconds: one horizon for the whole preview, days and hours skipped', () => {
    const started = performance.now();
    const preview = previewSchedule('0 0 31 12 *', 'Europe/London', 10, at('2026-01-01T00:00:00Z'));
    const never = nextRunAt('0 0 30 2 *', at('2026-01-01T00:00:00Z'), 'Europe/London');
    // The minute walk took 8.3 s and 0.7 s for these on the node; generous for load.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(preview).toMatchObject({ valid: true, next: ['2026-12-31T00:00:00.000Z'] });
    expect(never).toBeNull();
  });

  it('refuses an interval longer than the horizon instead of returning an Invalid Date', () => {
    expect(() => assertValidSchedule('every 99999999d')).toThrow(ScheduleError);
    expect(() => nextRunAt('every 367d', at('2026-01-01T00:00:00Z'))).toThrow(/at most 366 days/);
    expect(iso(nextRunAt('every 366d', at('2026-01-01T00:00:00Z')))).toBe('2027-01-02T00:00:00.000Z');
    expect(previewSchedule('every 99999999d', 'UTC', 5)).toMatchObject({ valid: false, problem: expect.stringMatching(/366 days/) });
  });
});

/**
 * Review B1 of #1406: the walk skips local days and hours that cannot match.
 * The reference here is the rule it replaced, stepping EVERY minute, written
 * independently of the module (its own Intl offset reads, field sets generated
 * alongside the expression text). The two must agree on every seeded case:
 * `from` within two hours of each 2026 DST edge in London, New York and Lord
 * Howe (a 30-minute shift), and anywhere in Kolkata (+05:30), Kathmandu
 * (+05:45) and UTC; with POSIX dom|dow OR, steps, ranges and lists. An early
 * landing that skipped a match would show up as a later instant here.
 */
describe('the cron walk agrees with stepping every minute', () => {
  const MIN = 60_000;
  const HORIZON = 4 * 24 * 60 * MIN;
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(0x1406);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(items: readonly T[]): T => items[int(0, items.length - 1)]!;

  interface Field { text: string; values: Set<number> }
  const range = (lo: number, hi: number, step = 1) => { const out = new Set<number>(); for (let v = lo; v <= hi; v += step) out.add(v); return out; };
  function field(lo: number, hi: number, starWeight: number, steps: readonly number[]): Field {
    const r = rand();
    if (r < starWeight) return { text: '*', values: range(lo, hi) };
    switch (int(0, 4)) {
      case 0: { const v = int(lo, hi); return { text: String(v), values: new Set([v]) }; }
      case 1: {
        const values = new Set<number>(); while (values.size < int(2, 4)) values.add(int(lo, hi));
        const sorted = [...values].sort((a, b) => a - b);
        return { text: sorted.join(','), values: new Set(sorted) };
      }
      case 2: { const s = pick(steps); return { text: `*/${s}`, values: range(lo, hi, s) }; }
      case 3: { const a = int(lo, hi - 1); const b = int(a + 1, Math.min(hi, a + 8)); return { text: `${a}-${b}`, values: range(a, b) }; }
      default: { const a = int(lo, hi - 2); const b = int(a + 2, hi); const s = int(2, 3); return { text: `${a}-${b}/${s}`, values: range(a, b, s) }; }
    }
  }

  const offsetFormat = new Map<string, Intl.DateTimeFormat>();
  function offsetOf(zone: string, ms: number): number {
    let f = offsetFormat.get(zone);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
      offsetFormat.set(zone, f);
    }
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!) - Math.floor(ms / MIN) * MIN;
  }
  function reference(f: { minute: Field; hour: Field; dom: Field; month: Field; dow: Field }, zone: string, from: number): number | null {
    const buckets = new Map<number, number>();
    const wall = (ms: number) => {
      const b = Math.floor(ms / (15 * MIN)) * 15 * MIN;
      let o = buckets.get(b);
      if (o === undefined) { o = offsetOf(zone, b); buckets.set(b, o); }
      const d = new Date(ms + o);
      return [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay(), d.getUTCFullYear()] as const;
    };
    const domRestricted = f.dom.text !== '*', dowRestricted = f.dow.text !== '*';
    const start = Math.floor(from / MIN) * MIN + MIN;
    for (let c = start; c < start + HORIZON; c += MIN) {
      const w = wall(c);
      if (!f.minute.values.has(w[0]) || !f.hour.values.has(w[1]) || !f.month.values.has(w[3])) continue;
      const dom = f.dom.values.has(w[2]), dow = f.dow.values.has(w[4]);
      if (!(domRestricted && dowRestricted ? dom || dow : domRestricted ? dom : dowRestricted ? dow : true)) continue;
      if ([30, 60, 120].some((m) => wall(c - m * MIN).join() === w.join())) continue;
      return c;
    }
    return null;
  }

  // The 2026 offset changes of each DST zone, found by scanning (no hard-coded rules).
  function edges(zone: string): number[] {
    const out: number[] = [];
    const year = Date.UTC(2026, 0, 1);
    let previous = offsetOf(zone, year);
    for (let t = year + 15 * MIN; t < Date.UTC(2027, 0, 1); t += 15 * MIN) {
      const o = offsetOf(zone, t);
      if (o !== previous) out.push(t);
      previous = o;
    }
    return out;
  }
  const dstZones = ['Europe/London', 'America/New_York', 'Australia/Lord_Howe'];
  const starts: Array<{ zone: string; from: number }> = [];
  const edgeCount = new Map<string, number>();
  for (const zone of dstZones) {
    const found = edges(zone);
    edgeCount.set(zone, found.length);
    for (const edge of found) for (let i = 0; i < 45; i += 1) starts.push({ zone, from: edge + int(-120, 120) * MIN + int(0, 59) * 1000 });
  }
  for (const zone of ['Asia/Kolkata', 'Asia/Kathmandu', 'UTC']) {
    for (let i = 0; i < 30; i += 1) starts.push({ zone, from: Date.UTC(2026, int(0, 11), int(1, 28), int(0, 23), int(0, 59), int(0, 59)) });
  }

  it(`${starts.length} seeded cases agree`, () => {
    for (const zone of dstZones) expect(edgeCount.get(zone), zone).toBeGreaterThanOrEqual(2);
    const mismatches: string[] = [];
    for (const { zone, from } of starts) {
      const f = {
        minute: field(0, 59, 0.1, [5, 7, 10, 15, 20, 30]),
        hour: field(0, 23, 0.4, [2, 3, 4, 6]),
        dom: field(1, 31, 0.6, [2, 3]),
        month: { text: '*', values: range(1, 12) },
        dow: field(0, 6, 0.6, [2]),
      };
      const expression = `${f.minute.text} ${f.hour.text} ${f.dom.text} ${f.month.text} ${f.dow.text}`;
      const want = reference(f, zone, from);
      const got = nextRunAt(expression, new Date(from), zone);
      const start = Math.floor(from / MIN) * MIN + MIN;
      const agrees = want === null ? got === null || got.getTime() >= start + HORIZON : got?.getTime() === want;
      if (!agrees) mismatches.push(`${expression} in ${zone} from ${new Date(from).toISOString()}: walk ${iso(got)}, minute-by-minute ${want === null ? 'none within 4 days' : new Date(want).toISOString()}`);
    }
    expect(mismatches).toEqual([]);
  }, 60_000);
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
    ['*/1 * * * *', 'UTC', 'Every minute'],
    // A step that does not divide 60 restarts each hour: not "every 7 minutes" (review nit 9).
    ['*/7 * * * *', 'UTC', 'Every hour at :00, :07, :14, :21, :28, :35, :42, :49 and :56'],
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
