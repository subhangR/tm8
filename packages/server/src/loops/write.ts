import { CollabError, LoopSpawnConfigSchema, type LoopSpawnConfig } from '@tm8/contract';
import type { Querier } from '../db/types.js';
import { assertValidSchedule, assertValidTimezone, nextRunAt, ScheduleError } from '../scheduler/schedule.js';

/** Recorded as `last_error` when a valid schedule can never match (design §3.3: parked, never silent). */
export const SCHEDULE_NEVER_MATCHES = 'schedule never matches within a year';

/** `assertValidSchedule` on every write (§2.1), as invalid_input with the field named. */
export function requireValidSchedule(schedule: string, timezone: string): void {
  try {
    assertValidSchedule(schedule);
  } catch (error) {
    throw new CollabError('invalid_input', `schedule: ${messageOf(error)}`, { details: { path: 'definition.schedule' } });
  }
  try {
    assertValidTimezone(timezone);
  } catch (error) {
    throw new CollabError('invalid_input', `timezone: ${messageOf(error)}`, { details: { path: 'definition.timezone' } });
  }
}

/** `config` is passed through to execution.spawn, so it is validated on every write; unknown keys are refused. */
export function requireSpawnConfig(config: unknown): LoopSpawnConfig {
  const parsed = LoopSpawnConfigSchema.safeParse(config ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = ['definition', 'config', ...(issue?.path ?? [])].join('.');
    throw new CollabError('invalid_input', `${path}: ${issue?.message ?? 'invalid spawn config'}`, { details: { path } });
  }
  return parsed.data;
}

export interface ScheduleWrite {
  /** undefined leaves next_run_at as it is; null clears it. */
  nextRunAt: string | null | undefined;
  /**
   * Set when the deadline was recomputed: the never-matches reason, or null to
   * clear the reason a parked loop carried. undefined leaves last_error alone.
   */
  lastError: string | null | undefined;
}

export interface ScheduleState {
  schedule: string; timezone: string; enabled: boolean;
  /**
   * The stored deadline and error, when the caller read them. A loop with no
   * deadline and an error is PARKED (§3.3): its schedule could not be evaluated,
   * and that error is the reason. Omitted means unknown, and nothing is cleared.
   */
  nextRunAt?: Date | string | null; lastError?: string | null;
}

function recompute(before: ScheduleState | null, after: ScheduleState, now: Date): ScheduleWrite {
  // Validated here as well as on the write: a stored schedule that predates
  // validation reaches this through enable, and must be refused, not thrown.
  requireValidSchedule(after.schedule, after.timezone);
  const next = nextRunAt(after.schedule, now, after.timezone);
  if (next === null) return { nextRunAt: null, lastError: SCHEDULE_NEVER_MATCHES };
  // A run's failure stays until a run succeeds; only a parked loop's reason is stale here.
  const parked = before !== null && before.nextRunAt === null && (before.lastError ?? null) !== null;
  return { nextRunAt: next.toISOString(), lastError: parked ? null : undefined };
}

/**
 * The one rule for when the server writes next_run_at (§3.1): on create
 * (enabled), on enable, and on any schedule or timezone change (enabled or not,
 * so a disabled loop's view stays honest), always from now. Disabling leaves it
 * alone; the due read ignores a disabled loop. No client value is ever consulted.
 */
export function scheduleWrite(before: ScheduleState | null, after: ScheduleState, now: Date = new Date()): ScheduleWrite {
  const rescheduled = before !== null
    && (before.schedule.trim() !== after.schedule.trim() || before.timezone !== after.timezone);
  const armed = after.enabled && (before === null || !before.enabled);
  return rescheduled || armed ? recompute(before, after, now) : { nextRunAt: undefined, lastError: undefined };
}

function messageOf(error: unknown): string {
  return error instanceof ScheduleError || error instanceof Error ? error.message : String(error);
}

/**
 * A tool loop runs as its persona (coordinator ruling, §2.1): one is required
 * when the tool's current definition reaches tm8 (tm8Access read|write). Judged
 * on the row the write left, so a definition edit cannot strand it.
 */
export async function assertToolPersona(q: Querier, loopId: string): Promise<void> {
  const [row] = await q.query<{ team_member_id: string | null; tm8_access: string | null }>(
    `select l.team_member_id, t.definition ->> 'tm8Access' as tm8_access
       from public.loops l join public.tools t on t.entity_id = l.tool_id
      where l.entity_id = $1 and l.action = 'tool'`, [loopId]);
  if (row && row.team_member_id === null && (row.tm8_access === 'read' || row.tm8_access === 'write')) {
    throw new CollabError('invalid_input',
      `definition.teamMemberId: a tool with tm8Access ${row.tm8_access} runs as a persona; name one`,
      { details: { path: 'definition.teamMemberId' } });
  }
}
