/**
 * Server-block scheduler (R26) — ONE job runner for the whole process.
 *
 * ```ts
 * const sidecar = await ensureSidecar();
 * const scheduler = createDefaultScheduler({ sidecar });
 * scheduler.start();
 * // ... shutdown:
 * await scheduler.stop();
 * ```
 *
 * Registered at W1: the daily `pg_dump` (live) and the four retention jobs
 * (stubs until the schema lands). Spell schedules and reminders take the
 * reserved slots in M3 — as jobs on this runner, not a second timer subsystem.
 */

import type { SidecarManager } from '../sidecar/manager.js';
import { createBackupJob, BACKUP_JOB_NAME, type BackupJobOptions } from './jobs/backup.js';
import { createLoopsJob, LOOPS_JOB_NAME, type LoopExecutorPort, type LoopsJobOptions } from './jobs/loops.js';
import { createRetentionJobs, type RetentionJobOptions } from './jobs/retention.js';
import { Scheduler, type SchedulerOptions } from './scheduler.js';

export { Scheduler, type SchedulerOptions } from './scheduler.js';
export {
  BACKUP_JOB_NAME,
  createBackupJob,
  type BackupJobOptions,
} from './jobs/backup.js';
export {
  createLoopsJob,
  type DueLoop,
  type LoopExecutorPort,
  type LoopsJobOptions,
} from './jobs/loops.js';
export { LOOPS_JOB_NAME } from './jobs/loops.js';
export { assertValidSchedule, nextRunAt, ScheduleError } from './schedule.js';
export {
  COMMAND_LEDGER_TTL_MS,
  RESERVED_JOB_SLOTS,
  RETENTION_POLICIES,
  createRetentionJobs,
  type RetentionJobKey,
  type RetentionJobOptions,
  type RetentionPolicy,
  type RetentionSweep,
} from './jobs/retention.js';
export type {
  JobContext,
  JobOutcome,
  JobStatus,
  ScheduledJob,
  SchedulerStatus,
} from './types.js';

export interface DefaultSchedulerOptions extends SchedulerOptions {
  /** When present, the daily `pg_dump` job is registered and wired to it. */
  readonly sidecar?: SidecarManager;
  readonly backup?: Omit<BackupJobOptions, 'sidecar'>;
  readonly retention?: RetentionJobOptions;
  /**
   * Loops (§4.4). Optional because the executor needs a live database AND the
   * PTY liveness probe, which a node running without the execution block does
   * not have — such a node must still schedule backups.
   */
  readonly loops?: Omit<LoopsJobOptions, 'db' | 'port'> & { db: LoopsJobOptions['db']; port: LoopExecutorPort };
}

/** The W1 job set: daily backup (when a sidecar is supplied) + retention. */
export function createDefaultScheduler(opts: DefaultSchedulerOptions = {}): Scheduler {
  const scheduler = new Scheduler(opts);
  if (opts.sidecar !== undefined) {
    scheduler.register(createBackupJob({ sidecar: opts.sidecar, ...opts.backup }));
  }
  scheduler.registerAll(createRetentionJobs(opts.retention));
  if (opts.loops !== undefined) scheduler.register(createLoopsJob(opts.loops));
  return scheduler;
}

/** Every job name the default set registers — handy for assertions and `doctor`. */
export function defaultJobNames(withSidecar: boolean, withLoops = false): string[] {
  const names = createRetentionJobs().map((j) => j.name);
  const base = withSidecar ? [BACKUP_JOB_NAME, ...names] : names;
  return withLoops ? [...base, LOOPS_JOB_NAME] : base;
}
