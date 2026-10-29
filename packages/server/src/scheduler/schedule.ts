/**
 * The loop schedule grammar (dreamer-dispatcher DESIGN §4.4).
 *
 * Two forms, both resolved to "the next instant at or after `from`":
 *
 *   every <n>{m|h|d}   — a fixed interval
 *   <m> <h> <dom> <mon> <dow>  — a standard 5-field cron expression
 *
 * Cron is evaluated by WALKING the wall clock rather than by solving each
 * field. Field-solving is where cron implementations go wrong (day-of-month and
 * day-of-week are OR'd, not AND'd, when both are restricted; month lengths and
 * leap years interact with `31`), and those bugs are silent — a loop simply
 * never fires, or fires on a day nobody asked for. The walk matches one wall
 * clock at a time, but skips a local day whose date cannot match and an hour
 * that cannot match, so a year is ~1,500 steps, not 527k minutes (a yearly cron
 * once cost seconds of the one event loop per preview; review B1 of #1406).
 *
 * The server's own zone never enters: cursors are UTC instants. Cron is matched
 * against the WALL-CLOCK fields in the loop's IANA `timezone` (loops design
 * §3.1, Intl only, no dependency); intervals are zone-free. DST: a wall-clock
 * minute that does not exist is never matched (no instant has it), and one that
 * occurs twice fires once, at its first occurrence.
 */

/** A schedule that never matches inside this window is treated as unfireable. */
const CRON_HORIZON_MINUTES = 366 * 24 * 60;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** The cron search window, and the longest interval (a longer one would never fire inside it). */
const HORIZON_MS = CRON_HORIZON_MINUTES * MINUTE_MS;

const INTERVAL = /^every\s+(\d+)\s*([mhd])$/i;

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

export class ScheduleError extends Error {}

/** An interval's length; bounded, so `every 99999999d` is refused instead of becoming an Invalid Date. */
function intervalMs(match: RegExpExecArray, schedule: string): number {
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 1) throw new ScheduleError(`interval must be a positive integer: "${schedule}"`);
  const ms = n * UNIT_MS[match[2]!.toLowerCase()]!;
  if (ms > HORIZON_MS) throw new ScheduleError(`interval must be at most 366 days: "${schedule}"`);
  return ms;
}

/** Inclusive numeric bounds per cron field, in field order. */
const CRON_BOUNDS: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week, 0 = Sunday
];

/**
 * Expand one cron field into the set of values it matches.
 * Supports `*`, `a`, `a-b`, `a-b/s`, `*​/s`, and comma-separated lists of those.
 */
function expandField(field: string, index: number): Set<number> {
  const [lo, hi] = CRON_BOUNDS[index]!;
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    if (rangePart === undefined || rangePart === '') throw new ScheduleError(`empty cron field part in "${field}"`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new ScheduleError(`invalid cron step in "${part}"`);

    let start = lo;
    let end = hi;
    if (rangePart !== '*') {
      const bounds = rangePart.split('-');
      const first = Number(bounds[0]);
      if (!Number.isInteger(first)) throw new ScheduleError(`invalid cron value in "${part}"`);
      start = first;
      end = bounds.length > 1 ? Number(bounds[1]) : first;
      if (!Number.isInteger(end)) throw new ScheduleError(`invalid cron range in "${part}"`);
      // A bare `a` with a step means "from a to the top of the field", which is
      // what every cron implementation does and what `0/15` in the wild means.
      if (bounds.length === 1 && stepPart !== undefined) end = hi;
    }
    if (start < lo || end > hi || start > end) {
      throw new ScheduleError(`cron field out of range in "${part}" (expected ${lo}..${hi})`);
    }
    for (let v = start; v <= end; v += step) out.add(v);
  }
  if (out.size === 0) throw new ScheduleError(`cron field "${field}" matches nothing`);
  return out;
}

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when BOTH day fields are restricted — then they are OR'd, per POSIX. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new ScheduleError(`cron expressions have 5 fields, got ${fields.length}`);
  return {
    minute: expandField(fields[0]!, 0),
    hour: expandField(fields[1]!, 1),
    dom: expandField(fields[2]!, 2),
    month: expandField(fields[3]!, 3),
    dow: expandField(fields[4]!, 4),
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

/** Wall-clock fields of an instant in some zone. */
interface Wall { minute: number; hour: number; date: number; month: number; day: number; year: number }

/** The date fields: month, then day of month and day of week. */
function dayMatches(spec: CronSpec, at: Wall): boolean {
  if (!spec.month.has(at.month)) return false;
  // POSIX: when both day fields are restricted a date matching EITHER matches.
  // Getting this wrong is the classic silent cron bug — `0 0 1 * 1` means "the
  // 1st, and every Monday", not "Mondays that fall on the 1st".
  const domHit = spec.dom.has(at.date);
  const dowHit = spec.dow.has(at.day);
  if (spec.domRestricted && spec.dowRestricted) return domHit || dowHit;
  if (spec.domRestricted) return domHit;
  if (spec.dowRestricted) return dowHit;
  return true;
}

export const DEFAULT_TIMEZONE = 'UTC';

/** An IANA zone name's shape (`Area/Location`, `UTC`, `Etc/GMT+5`): no offsets, no spaces. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const ZONE_CACHE_MAX = 1024;
/**
 * A spelling → Intl's canonical id (null: not a zone). Intl matches zone ids
 * regardless of case, so callers choose the spellings: the map is capped, and
 * everything keyed on a zone below uses the canonical id, which is bounded.
 */
const zoneIds = new Map<string, string | null>();

function canonicalZone(timezone: string): string | null {
  let id = zoneIds.get(timezone);
  if (id === undefined) {
    id = null;
    if (timezone.length <= 64 && ZONE_NAME.test(timezone)) {
      try {
        id = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
      } catch {
        id = null;
      }
    }
    if (zoneIds.size < ZONE_CACHE_MAX) zoneIds.set(timezone, id);
  }
  return id;
}

/**
 * IANA validation (§3.1): a zone the runtime's Intl can evaluate, which is what
 * the cron walk below needs. `Intl.supportedValuesOf('timeZone')` alone is too
 * narrow: it lists only CLDR canonical names, so the current IANA names
 * browsers report (`Asia/Kolkata`, `Europe/Kyiv`) and `UTC` itself are missing.
 */
export function isValidTimezone(timezone: string): boolean {
  return canonicalZone(timezone) !== null;
}

export function assertValidTimezone(timezone: string): void {
  if (!isValidTimezone(timezone)) throw new ScheduleError(`unknown IANA timezone "${timezone}"`);
}

const OFFSET_BUCKET_MS = 15 * 60_000;
/** One formatter per canonical zone id: bounded by the zones Intl knows, whatever the callers spell. */
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The zone's UTC offset at an instant, in ms. Offsets only change on quarter-
 * hour boundaries, so the walk asks Intl once per bucket it lands in.
 */
function offsetFinder(timezone: string): (ms: number) => number {
  const id = canonicalZone(timezone) ?? timezone;
  if (id === 'UTC') return () => 0;
  let format = formatters.get(id);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: id, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    });
    formatters.set(id, format);
  }
  const zone = format;
  const cache = new Map<number, number>();
  return (ms) => {
    const bucket = Math.floor(ms / OFFSET_BUCKET_MS) * OFFSET_BUCKET_MS;
    let offset = cache.get(bucket);
    if (offset === undefined) {
      const parts: Record<string, number> = {};
      for (const part of zone.formatToParts(new Date(bucket))) {
        if (part.type !== 'literal') parts[part.type] = Number(part.value);
      }
      offset = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!) - bucket;
      cache.set(bucket, offset);
    }
    return offset;
  };
}

function wallAt(ms: number, offsetAt: (ms: number) => number): Wall {
  const wall = new Date(ms + offsetAt(ms));
  return {
    minute: wall.getUTCMinutes(), hour: wall.getUTCHours(), date: wall.getUTCDate(),
    month: wall.getUTCMonth() + 1, day: wall.getUTCDay(), year: wall.getUTCFullYear(),
  };
}

const sameWall = (a: Wall, b: Wall) =>
  a.minute === b.minute && a.hour === b.hour && a.date === b.date && a.month === b.month && a.year === b.year;

/**
 * The next firing at or after `from`, or null when the expression can never
 * match (`31 2 30 2 *` — February 30th). Null is a REPORTABLE state, not an
 * exception: the loop stays enabled with a recorded `last_error` so a human can
 * see the schedule they wrote is unsatisfiable.
 */
export function nextRunAt(schedule: string, from: Date, timezone: string = DEFAULT_TIMEZONE): Date | null {
  const interval = INTERVAL.exec(schedule.trim());
  if (interval) return new Date(from.getTime() + intervalMs(interval, schedule));

  const spec = parseCron(schedule);
  assertValidTimezone(timezone);
  const start = firstCandidate(from);
  const at = nextCronInstant(spec, offsetFinder(timezone), start, start + HORIZON_MS);
  return at === null ? null : new Date(at);
}

/**
 * The next whole minute after `from`: cron has minute resolution, and firing at
 * `from` itself would re-fire the same minute that just fired.
 */
const firstCandidate = (from: Date): number => Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;

/** How early a day skip lands: a DST change shortens a local day by up to two hours (Antarctica/Troll). */
const DAY_SKIP_MARGIN_MS = 2 * HOUR_MS;

/**
 * The first instant in [start, end) whose wall clock in the zone matches, or
 * null. Correct by the same rule as stepping every minute, without the minutes:
 * - a local day whose DATE cannot match is skipped whole, landing up to two
 *   hours EARLY (local arithmetic says how far midnight is; a DST change makes
 *   the day shorter, and landing late could step over the next day's first
 *   hours), then hour by hour into midnight;
 * - an HOUR that cannot match is skipped to the next local hour, which a DST
 *   jump makes the next hour that exists;
 * - minutes are stepped only inside a matching hour.
 * A wall-clock minute that occurs twice (fall-back) fires once, first.
 */
function nextCronInstant(spec: CronSpec, offsetAt: (ms: number) => number, start: number, end: number): number | null {
  let cursor = start;
  while (cursor < end) {
    const wall = wallAt(cursor, offsetAt);
    if (!dayMatches(spec, wall)) {
      const toMidnight = ((23 - wall.hour) * 60 + (60 - wall.minute)) * MINUTE_MS;
      cursor += toMidnight > DAY_SKIP_MARGIN_MS ? toMidnight - DAY_SKIP_MARGIN_MS : (60 - wall.minute) * MINUTE_MS;
      continue;
    }
    if (!spec.hour.has(wall.hour)) {
      cursor += (60 - wall.minute) * MINUTE_MS;
      continue;
    }
    // A fall-back repeats wall-clock minutes: only the first occurrence fires.
    // Real zones shift by 30, 60 or (Antarctica/Troll) 120 minutes.
    if (spec.minute.has(wall.minute)
      && !sameWall(wallAt(cursor - 30 * MINUTE_MS, offsetAt), wall)
      && !sameWall(wallAt(cursor - HOUR_MS, offsetAt), wall)
      && !sameWall(wallAt(cursor - 2 * HOUR_MS, offsetAt), wall)) return cursor;
    cursor += MINUTE_MS;
  }
  return null;
}

/** Parse-only check, for validating a schedule before it is stored. */
export function assertValidSchedule(schedule: string): void {
  const interval = INTERVAL.exec(schedule.trim());
  if (interval) {
    intervalMs(interval, schedule);
    return;
  }
  parseCron(schedule);
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');
const isNumber = (field: string) => /^\d+$/.test(field);

/**
 * A human summary of a valid schedule (§3.1): "Every 15 minutes", "Every day at
 * 09:00 Europe/London", "Weekdays at 08:30 UTC", or the expression itself when
 * no plainer sentence says exactly the same thing.
 */
export function describeSchedule(schedule: string, timezone: string = DEFAULT_TIMEZONE): string {
  const trimmed = schedule.trim();
  const interval = INTERVAL.exec(trimmed);
  if (interval) {
    const n = Number(interval[1]);
    const unit = ({ m: 'minute', h: 'hour', d: 'day' } as const)[interval[2]!.toLowerCase() as 'm' | 'h' | 'd'];
    return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  }
  const fields = trimmed.split(/\s+/);
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const raw = `Cron \`${fields.join(' ')}\` (${timezone})`;
  if (dom !== '*' || month !== '*') return raw;
  const every = /^\*\/(\d+)$/.exec(minute);
  if (every && hour === '*' && dow === '*') {
    const n = Number(every[1]);
    if (n === 1) return 'Every minute';
    if (60 % n === 0) return `Every ${n} minutes`;
    // `*/7` fires at :00, :07 … :56 and again at :00: not an even cadence.
    const minutes = [...expandField(minute, 0)].map((m) => `:${pad(m)}`);
    return `Every hour at ${minutes.length === 1 ? minutes[0] : `${minutes.slice(0, -1).join(', ')} and ${minutes.at(-1)}`}`;
  }
  if (isNumber(minute) && hour === '*' && dow === '*') return `Every hour at :${pad(Number(minute))}`;
  if (!isNumber(minute) || !isNumber(hour)) return raw;
  const at = `${pad(Number(hour))}:${pad(Number(minute))} ${timezone}`;
  if (dow === '*') return `Every day at ${at}`;
  if (dow === '1-5') return `Weekdays at ${at}`;
  if (dow === '0,6' || dow === '6,0') return `Weekends at ${at}`;
  if (isNumber(dow) && Number(dow) <= 6) return `Every ${DAY_NAMES[Number(dow)]} at ${at}`;
  return raw;
}

export interface SchedulePreview { valid: boolean; problem: string | null; summary: string; next: string[] }

/**
 * `loops.schedule.preview` and LoopView.schedule. `count` 0 skips the cron
 * walk entirely (list rows). The instants come from ONE horizon (a year from
 * `from`), not one per instant: a yearly cron previews its next instant, never
 * ten years of walking inside a request.
 */
export function previewSchedule(schedule: string, timezone: string, count: number, from: Date = new Date()): SchedulePreview {
  try {
    assertValidSchedule(schedule);
    assertValidTimezone(timezone);
  } catch (error) {
    const problem = error instanceof ScheduleError ? error.message : String(error);
    return { valid: false, problem, summary: '', next: [] };
  }
  const summary = describeSchedule(schedule, timezone);
  const next: string[] = [];
  const interval = INTERVAL.exec(schedule.trim());
  if (interval) {
    const step = intervalMs(interval, schedule);
    for (let i = 1; i <= count; i += 1) next.push(new Date(from.getTime() + i * step).toISOString());
    return { valid: true, problem: null, summary, next };
  }
  if (count <= 0) return { valid: true, problem: null, summary, next };
  const spec = parseCron(schedule);
  const offsetAt = offsetFinder(timezone);
  let cursor = firstCandidate(from);
  const end = cursor + HORIZON_MS;
  for (let i = 0; i < count; i += 1) {
    const at = nextCronInstant(spec, offsetAt, cursor, end);
    if (at === null) {
      if (i === 0) return { valid: false, problem: 'the schedule never matches within a year', summary, next };
      break;
    }
    next.push(new Date(at).toISOString());
    cursor = at + MINUTE_MS;
  }
  return { valid: true, problem: null, summary, next };
}
