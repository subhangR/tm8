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
import type { NodeEndingSweepReport } from '@tm8/execution';

import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const LOST_SESSION_REAPER_JOB_NAME = 'execution.lost-session-reaper';

/** Spec D1 §4.4: longer than the 90 s liveness snapshot window. D6 may tune it. */
export const DEFAULT_LOST_AFTER_MS = 10 * 60_000;

export interface LostSessionReaperOptions {
  reap(staleAfterMs: number): Promise<NodeEndingSweepReport>;
  staleAfterMs?: number;
  intervalMs?: number;
}

/**
 * The one line every tick of a node-ending job logs (397), the reaper's and
 * the auto-close's alike. EVERY tick: before 397 the reaper could not see
 * ghosts outside its identity's spaces, reported `skipped`, and said nothing
 * for weeks while 19 dead rows held the cap. `notRecorded` is counted apart
 * from `retired` and `refused`, so a pass whose writes all came back
 * `recorded: false` is visible too. Its level is `tickLogLevel`'s.
 */
export interface NodeSweepTickLine {
  candidates: number;
  retired: number;
  notRecorded: number;
  refused: number;
  /** The first five refusals, verbatim. */
  problems: string[];
}

export function nodeSweepTickLine(report: NodeEndingSweepReport): NodeSweepTickLine {
  return {
    candidates: report.candidates,
    retired: report.retired,
    notRecorded: report.notRecorded,
    refused: report.errors.length,
    problems: report.errors.slice(0, 5).map((e) => e.message),
  };
}

/**
 * warn on any refusal, or when writes came back not recorded and nothing was
 * retired (the silent-failure shape); info when there was anything to see;
 * debug for an all-zero tick, so a quiet node does not write 1440 identical
 * lines a day.
 */
export function tickLogLevel(line: NodeSweepTickLine): 'warn' | 'info' | 'debug' {
  if (line.refused > 0 || (line.notRecorded > 0 && line.retired === 0)) return 'warn';
  return line.candidates > 0 || line.retired > 0 || line.notRecorded > 0 ? 'info' : 'debug';
}

/** Log one tick's line at its level, and turn the report into the job's outcome. */
function finishTick(
  jobName: string,
  report: NodeEndingSweepReport,
  idleReason: string,
  log?: (message: string, line: NodeSweepTickLine) => void,
): JobOutcome {
  const line = nodeSweepTickLine(report);
  log?.(`${jobName}: tick`, line);
  if (line.retired === 0 && line.refused === 0 && line.notRecorded === 0) {
    return { skipped: true, reason: idleReason };
  }
  return {
    affected: line.retired,
    detail: { retired: line.retired, notRecorded: line.notRecorded, failed: line.refused },
  };
}

/** The job's logger, at the line's level. */
function logAtLevel(ctx: JobContext): (message: string, line: NodeSweepTickLine) => void {
  return (message, line) => {
    ctx.logger[tickLogLevel(line)](message, line);
  };
}

/** One tick, exported so tests and `scheduler.runNow` drive it without a timer. */
export async function runLostSessionReaperTick(
  options: LostSessionReaperOptions,
  log?: (message: string, line: NodeSweepTickLine) => void,
): Promise<JobOutcome> {
  const report = await options.reap(options.staleAfterMs ?? DEFAULT_LOST_AFTER_MS);
  return finishTick(LOST_SESSION_REAPER_JOB_NAME, report, 'no session has been without a process long enough', log);
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
      return runLostSessionReaperTick(options, logAtLevel(ctx));
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
export interface CompletedAutoCloseOptions {
  close(): Promise<NodeEndingSweepReport>;
  intervalMs?: number;
}

/** One tick, exported so tests drive it without a timer. */
export async function runCompletedAutoCloseTick(
  options: CompletedAutoCloseOptions,
  log?: (message: string, line: NodeSweepTickLine) => void,
): Promise<JobOutcome> {
  return finishTick(COMPLETED_AUTO_CLOSE_JOB_NAME, await options.close(), 'no completed session idle past its window', log);
}

export function createCompletedAutoCloseJob(options: CompletedAutoCloseOptions): ScheduledJob {
  return {
    name: COMPLETED_AUTO_CLOSE_JOB_NAME,
    intervalMs: options.intervalMs ?? 60_000,
    jitterRatio: 0.1,
    runOnStart: false,
    timeoutMs: 2 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      return runCompletedAutoCloseTick(options, logAtLevel(ctx));
    },
  };
}
