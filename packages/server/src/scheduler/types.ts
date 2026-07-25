/**
 * Scheduler types (R26).
 *
 * ONE job runner for the whole server block. Retention (command-ledger TTL,
 * event pruning, soft-delete purge, snapshot prune) and the scheduled `pg_dump`
 * live here today; spell schedules and reminders plug into the same runner later
 * (09 §3.3) rather than growing a second timer subsystem.
 */

import type { SidecarLogger } from '../sidecar/log.js';

export interface JobContext {
  /** Job name, for log lines the job emits itself. */
  readonly name: string;
  /** Wall-clock at which this run was dispatched. */
  readonly firedAt: Date;
  /** Logger already tagged for the scheduler. */
  readonly logger: SidecarLogger;
  /** Aborted when the scheduler stops or the job exceeds its timeout. */
  readonly signal: AbortSignal;
}

/**
 * What a job did. `skipped` is a first-class outcome so a stub — or a job that
 * had nothing to do — is visibly distinct from one that ran and touched nothing.
 */
export interface JobOutcome {
  readonly skipped?: boolean;
  /** Required when `skipped` — no silent no-ops. */
  readonly reason?: string;
  /** Rows/files/entities affected, for the log line. */
  readonly affected?: number;
  readonly detail?: Record<string, unknown>;
}

export interface ScheduledJob {
  /** Unique within a scheduler. Used as the lock key and in every log line. */
  readonly name: string;
  /** Base period between runs. */
  readonly intervalMs: number;
  /**
   * Fractional jitter applied to every delay, in [0, 1). 0.1 means ±10%.
   * Jitter keeps a fleet of servers (and the jobs within one) from stampeding
   * the database on the same tick.
   */
  readonly jitterRatio?: number;
  /** Run once shortly after `start()` rather than waiting a full interval. */
  readonly runOnStart?: boolean;
  /** Abort + report failure after this long. Default 5 min. */
  readonly timeoutMs?: number;
  run(ctx: JobContext): Promise<JobOutcome | void>;
}

export type JobRunState = 'idle' | 'running';

export interface JobStatus {
  readonly name: string;
  readonly state: JobRunState;
  readonly intervalMs: number;
  /** ISO-8601 UTC of the last completed run. */
  readonly lastRunAt: string | null;
  readonly lastOutcome: JobOutcome | null;
  readonly lastError: string | null;
  readonly runs: number;
  readonly failures: number;
  /** Runs skipped because the previous run was still going (overrun). */
  readonly overruns: number;
  /** ISO-8601 UTC of the next scheduled fire, null when stopped. */
  readonly nextRunAt: string | null;
}

export interface SchedulerStatus {
  readonly running: boolean;
  readonly jobs: readonly JobStatus[];
}
