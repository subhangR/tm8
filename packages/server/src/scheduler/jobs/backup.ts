/**
 * The scheduled `pg_dump` job — SIDECAR-PACKAGING.md §5.
 *
 * "Cadence: daily, wall-clock, via the R26 scheduler … The scheduler calls
 * `SidecarManager.backupNow({ tier: 'daily' })`. No separate cron." Retention
 * (7 daily + 4 weekly, pre-migration exempt) and weekly promotion happen inside
 * `backupNow`, so this job stays a thin, testable adapter.
 *
 * Backups are the trust backstop that makes single-homed spaces acceptable
 * (T-L5), so a failing backup is a loud failure, never a silent skip.
 */

import type { SidecarManager } from '../../sidecar/manager.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const BACKUP_JOB_NAME = 'sidecar.daily-backup';

export interface BackupJobOptions {
  readonly sidecar: SidecarManager;
  /** Default 24h. */
  readonly intervalMs?: number;
  /** Take one shortly after boot as well. Default false. */
  readonly runOnStart?: boolean;
}

export function createBackupJob(opts: BackupJobOptions): ScheduledJob {
  const { sidecar } = opts;
  return {
    name: BACKUP_JOB_NAME,
    intervalMs: opts.intervalMs ?? 24 * 60 * 60_000,
    // A wide spread: the daily dump is the heaviest scheduled work there is.
    jitterRatio: 0.15,
    runOnStart: opts.runOnStart ?? false,
    timeoutMs: 60 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      const status = sidecar.status();
      if (status.state !== 'RUNNING') {
        // Not a failure: a backup while the sidecar is starting or failed would
        // be meaningless. Reported, never silent.
        return { skipped: true, reason: `sidecar is ${status.state}, not RUNNING` };
      }
      const result = await sidecar.backupNow({ tier: 'daily' });
      ctx.logger.debug(`daily backup → ${result.path}`);
      return {
        affected: 1,
        detail: { path: result.path, bytes: result.bytes, format: result.format },
      };
    },
  };
}
