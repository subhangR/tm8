/**
 * THE GHOST REAPER (Spec D1 §4.4, migration 299).
 *
 * A session whose record says it is live while this node holds no process for
 * it is "stale" to the client — and, before this job, stayed stale forever: it
 * sat in the Running tab, counted against the concurrency cap, and only a node
 * restart (boot ghost reconciliation) ever retired it. After `staleAfterMs`
 * without a process this job records it `failed / lost`, which moves it to the
 * Interrupted tab with attention. It writes a PROCESS fact only: the outcome
 * stays open and the claims stay held, so the session can be resumed.
 *
 * The clock is the SpawnService's in-memory first sighting, so one tick never
 * reaps: a session has to be seen without a process on two ticks at least
 * `staleAfterMs` apart.
 */
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const LOST_SESSION_REAPER_JOB_NAME = 'execution.lost-session-reaper';

/** Spec D1 §4.4: longer than the 90 s liveness snapshot window. D6 may tune it. */
export const DEFAULT_LOST_AFTER_MS = 10 * 60_000;

export interface LostSessionReaperOptions {
  reap(staleAfterMs: number): Promise<{ reaped: number; errors: Array<{ message: string }> }>;
  staleAfterMs?: number;
  intervalMs?: number;
}

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runLostSessionReaperTick(
  options: LostSessionReaperOptions,
  log?: (message: string) => void,
): Promise<JobOutcome> {
  const { reaped, errors } = await options.reap(options.staleAfterMs ?? DEFAULT_LOST_AFTER_MS);
  if (errors.length > 0) {
    log?.(`${LOST_SESSION_REAPER_JOB_NAME}: ${errors.length} problem(s): ${
      errors.slice(0, 5).map((e) => e.message).join('; ')}`);
  }
  if (reaped === 0 && errors.length === 0) {
    return { skipped: true, reason: 'no session has been without a process long enough' };
  }
  return { affected: reaped, detail: { reaped, failed: errors.length } };
}

export function lostAfterMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['TM8_LOST_SESSION_AFTER_MIN'];
  const minutes = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_LOST_AFTER_MS;
}

export function createLostSessionReaperJob(options: LostSessionReaperOptions): ScheduledJob {
  return {
    name: LOST_SESSION_REAPER_JOB_NAME,
    intervalMs: options.intervalMs ?? 60_000,
    jitterRatio: 0.1,
    runOnStart: false,
    timeoutMs: 2 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      return runLostSessionReaperTick(options, (m) => { ctx.logger.warn(m); });
    },
  };
}

export const COMPLETED_AUTO_CLOSE_JOB_NAME = 'execution.completed-auto-close';

/**
 * Spec D1, owner ruling Q3: close a COMPLETED session's process once it has
 * been idle for its space's `session_autoclose_minutes` (default 30, 0 =
 * never). Lives beside the reaper: both are the node tidying processes whose
 * work no longer needs them, and both only ever write process facts.
 */
export function createCompletedAutoCloseJob(options: {
  close(): Promise<{ closed: number; errors: Array<{ message: string }> }>;
  intervalMs?: number;
}): ScheduledJob {
  return {
    name: COMPLETED_AUTO_CLOSE_JOB_NAME,
    intervalMs: options.intervalMs ?? 60_000,
    jitterRatio: 0.1,
    runOnStart: false,
    timeoutMs: 2 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      const { closed, errors } = await options.close();
      if (errors.length > 0) {
        ctx.logger.warn(`${COMPLETED_AUTO_CLOSE_JOB_NAME}: ${errors.length} problem(s): ${
          errors.slice(0, 5).map((e) => e.message).join('; ')}`);
      }
      if (closed === 0 && errors.length === 0) {
        return { skipped: true, reason: 'no completed session idle past its window' };
      }
      return { affected: closed, detail: { closed, failed: errors.length } };
    },
  };
}
