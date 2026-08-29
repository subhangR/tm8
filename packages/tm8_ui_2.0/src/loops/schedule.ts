/**
 * Browser-side projection of the node's loop schedule grammar.
 *
 * A loop create/edit has to send `nextRunAt` through `entities.create` /
 * `entities.patch`; the scheduler deliberately reads that one column and does
 * not infer a missing value. This module therefore mirrors
 * `packages/server/src/scheduler/schedule.ts` so the UI writes the same first
 * deadline the executor writes after every firing.
 *
 * Keep the grammar deliberately closed: `every <n>{m|h|d}` or five-field
 * cron, evaluated in UTC with POSIX day-of-month/day-of-week OR semantics.
 */

const CRON_HORIZON_MINUTES = 366 * 24 * 60;
const INTERVAL = /^every\s+(\d+)\s*([mhd])$/i;

const UNIT_MS: Readonly<Record<string, number>> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

export class LoopScheduleError extends Error {}

const CRON_BOUNDS: ReadonlyArray<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function expandField(field: string, index: number): Set<number> {
  const [lo, hi] = CRON_BOUNDS[index]!;
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    if (rangePart === undefined || rangePart === '') {
      throw new LoopScheduleError(`empty cron field part in "${field}"`);
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new LoopScheduleError(`invalid cron step in "${part}"`);
    }

    let start = lo;
    let end = hi;
    if (rangePart !== '*') {
      const bounds = rangePart.split('-');
      const first = Number(bounds[0]);
      if (!Number.isInteger(first)) {
        throw new LoopScheduleError(`invalid cron value in "${part}"`);
      }
      start = first;
      end = bounds.length > 1 ? Number(bounds[1]) : first;
      if (!Number.isInteger(end)) {
        throw new LoopScheduleError(`invalid cron range in "${part}"`);
      }
      if (bounds.length === 1 && stepPart !== undefined) end = hi;
    }
    if (start < lo || end > hi || start > end) {
      throw new LoopScheduleError(
        `cron field out of range in "${part}" (expected ${lo}..${hi})`,
      );
    }
    for (let value = start; value <= end; value += step) out.add(value);
  }
  if (out.size === 0) throw new LoopScheduleError(`cron field "${field}" matches nothing`);
  return out;
}

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new LoopScheduleError(`cron expressions have 5 fields, got ${fields.length}`);
  }
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
  const domHit = spec.dom.has(at.getUTCDate());
  const dowHit = spec.dow.has(at.getUTCDay());
  if (spec.domRestricted && spec.dowRestricted) return domHit || dowHit;
  if (spec.domRestricted) return domHit;
  if (spec.dowRestricted) return dowHit;
  return true;
}

/** The next firing strictly after `from`, matching the node executor. */
export function nextLoopRunAt(schedule: string, from: Date): Date | null {
  const interval = INTERVAL.exec(schedule.trim());
  if (interval) {
    const amount = Number(interval[1]);
    if (!Number.isInteger(amount) || amount < 1) {
      throw new LoopScheduleError(`interval must be a positive integer: "${schedule}"`);
    }
    return new Date(from.getTime() + amount * UNIT_MS[interval[2]!.toLowerCase()]!);
  }

  const spec = parseCron(schedule);
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let step = 0; step < CRON_HORIZON_MINUTES; step += 1) {
    if (matches(spec, cursor)) return new Date(cursor.getTime());
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

/** A user-facing validation result without throwing through a render. */
export function loopScheduleProblem(schedule: string, from = new Date()): string | null {
  if (schedule.trim() === '') return 'Schedule is required.';
  try {
    if (nextLoopRunAt(schedule, from) === null) {
      return 'This schedule does not match any time in the next year.';
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Schedule is invalid.';
  }
}
