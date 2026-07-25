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
import { createRetentionJobs, type RetentionJobOptions } from './jobs/retention.js';
import { Scheduler, type SchedulerOptions } from './scheduler.js';

export { Scheduler, type SchedulerOptions } from './scheduler.js';
export {
  BACKUP_JOB_NAME,
  createBackupJob,
  type BackupJobOptions,
} from './jobs/backup.js';
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
}

/** The W1 job set: daily backup (when a sidecar is supplied) + retention. */
export function createDefaultScheduler(opts: DefaultSchedulerOptions = {}): Scheduler {
  const scheduler = new Scheduler(opts);
  if (opts.sidecar !== undefined) {
    scheduler.register(createBackupJob({ sidecar: opts.sidecar, ...opts.backup }));
  }
  scheduler.registerAll(createRetentionJobs(opts.retention));
  return scheduler;
}

/** Every job name the default set registers — handy for assertions and `doctor`. */
export function defaultJobNames(withSidecar: boolean): string[] {
  const names = createRetentionJobs().map((j) => j.name);
  return withSidecar ? [BACKUP_JOB_NAME, ...names] : names;
}
