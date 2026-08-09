/**
 * The loop schedule grammar (dreamer-dispatcher DESIGN §4.4).
 *
 * Two forms, both resolved to "the next instant at or after `from`":
 *
 *   every <n>{m|h|d}   — a fixed interval
 *   <m> <h> <dom> <mon> <dow>  — a standard 5-field cron expression
 *
 * Cron is evaluated by STEPPING MINUTES rather than by solving each field.
 * Field-solving is where cron implementations go wrong (day-of-month and
 * day-of-week are OR'd, not AND'd, when both are restricted; month lengths and
 * leap years interact with `31`), and those bugs are silent — a loop simply
 * never fires, or fires on a day nobody asked for. Stepping is obviously
 * correct by construction, and the horizon below bounds the cost: one year of
 * minutes is ~527k cheap comparisons, run once per firing, not per tick.
 *
 * All arithmetic is UTC. A schedule that drifted with the server's local DST
 * would fire twice or not at all one night a year, and the graph would record
 * that as the loop's fault.
 */

/** A schedule that never matches inside this window is treated as unfireable. */
const CRON_HORIZON_MINUTES = 366 * 24 * 60;

const INTERVAL = /^every\s+(\d+)\s*([mhd])$/i;

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

export class ScheduleError extends Error {}

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

function matches(spec: CronSpec, at: Date): boolean {
  if (!spec.minute.has(at.getUTCMinutes())) return false;
  if (!spec.hour.has(at.getUTCHours())) return false;
  if (!spec.month.has(at.getUTCMonth() + 1)) return false;
  // POSIX: when both day fields are restricted a date matching EITHER matches.
  // Getting this wrong is the classic silent cron bug — `0 0 1 * 1` means "the
  // 1st, and every Monday", not "Mondays that fall on the 1st".
  const domHit = spec.dom.has(at.getUTCDate());
  const dowHit = spec.dow.has(at.getUTCDay());
  if (spec.domRestricted && spec.dowRestricted) return domHit || dowHit;
  if (spec.domRestricted) return domHit;
  if (spec.dowRestricted) return dowHit;
  return true;
}

/**
 * The next firing at or after `from`, or null when the expression can never
 * match (`31 2 30 2 *` — February 30th). Null is a REPORTABLE state, not an
 * exception: the loop stays enabled with a recorded `last_error` so a human can
 * see the schedule they wrote is unsatisfiable.
 */
export function nextRunAt(schedule: string, from: Date): Date | null {
  const interval = INTERVAL.exec(schedule.trim());
  if (interval) {
    const n = Number(interval[1]);
    if (!Number.isInteger(n) || n < 1) throw new ScheduleError(`interval must be a positive integer: "${schedule}"`);
    return new Date(from.getTime() + n * UNIT_MS[interval[2]!.toLowerCase()]!);
  }

  const spec = parseCron(schedule);
  // Start at the next whole minute: cron has minute resolution, and firing at
  // `from` itself would re-fire the same minute that just fired.
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let step = 0; step < CRON_HORIZON_MINUTES; step += 1) {
    if (matches(spec, cursor)) return new Date(cursor.getTime());
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

/** Parse-only check, for validating a schedule before it is stored. */
export function assertValidSchedule(schedule: string): void {
  if (INTERVAL.test(schedule.trim())) return;
  parseCron(schedule);
}
