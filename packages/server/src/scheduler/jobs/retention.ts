/**
 * Retention jobs (R26) — registered now, inert until the schema lands.
 *
 * These four are the retention surface 09 §3.3 names: command-ledger TTL, event
 * pruning, soft-delete purge, snapshot prune. They are registered at W1 with
 * their real names, cadences and policies so the runner's shape is settled and
 * the job list is visible in `status()` — but their bodies are **stubs** until
 * the db workstream's tables exist.
 *
 * They are stubs in the honest sense: each reports `skipped` with a reason on
 * every run rather than pretending to have swept anything. Wiring one up is
 * replacing its `sweep` with a real implementation — the registration, cadence,
 * locking, logging and failure isolation do not change.
 */

import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** The command-ledger TTL, per 09 §3.1 (004 ledgers migration). */
export const COMMAND_LEDGER_TTL_MS = 24 * HOUR;

/**
 * A retention sweep. Returns the number of rows removed.
 *
 * The seam the db workstream fills in at W2: `createRetentionJobs({ sweeps: {...} })`
 * with a real implementation per key turns the stub into a live job with no
 * other change.
 */
export type RetentionSweep = (ctx: JobContext) => Promise<number>;

export type RetentionJobKey =
  | 'retention.command-ledger'
  | 'retention.workspace-events'
  | 'retention.soft-delete-purge'
  | 'retention.snapshot-prune';

export interface RetentionPolicy {
  readonly key: RetentionJobKey;
  /** How often the sweep runs. */
  readonly intervalMs: number;
  /** How long rows are retained — the policy this job enforces. */
  readonly retainMs: number | null;
  /** One line, used in logs and in the skip reason. */
  readonly description: string;
}

export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  {
    key: 'retention.command-ledger',
    intervalMs: HOUR,
    retainMs: COMMAND_LEDGER_TTL_MS,
    description: 'drop command_ledger rows past their 24h idempotency TTL',
  },
  {
    key: 'retention.workspace-events',
    intervalMs: 6 * HOUR,
    retainMs: 30 * DAY,
    description: 'prune workspace_events beyond the catch-up window',
  },
  {
    key: 'retention.soft-delete-purge',
    intervalMs: DAY,
    retainMs: 30 * DAY,
    description: 'hard-delete entities soft-deleted longer than the grace period',
  },
  {
    key: 'retention.snapshot-prune',
    intervalMs: DAY,
    retainMs: null,
    description: 'prune superseded entity snapshots/versions beyond the keep count',
  },
];

export interface RetentionJobOptions {
  /** Real sweeps, keyed by job name. Anything absent stays a reporting stub. */
  readonly sweeps?: Partial<Record<RetentionJobKey, RetentionSweep>>;
  /** Override cadences (tests, or an operator-tuned deployment). */
  readonly intervalsMs?: Partial<Record<RetentionJobKey, number>>;
}

function stubReason(p: RetentionPolicy): string {
  const window = p.retainMs === null ? 'keep-count policy' : `retain ${Math.round(p.retainMs / HOUR)}h`;
  return `stub — ${p.description} (${window}); awaiting the db schema, nothing was swept`;
}

/** Build the four retention jobs, live where a sweep was supplied. */
export function createRetentionJobs(opts: RetentionJobOptions = {}): ScheduledJob[] {
  return RETENTION_POLICIES.map((policy): ScheduledJob => {
    const sweep = opts.sweeps?.[policy.key];
    return {
      name: policy.key,
      intervalMs: opts.intervalsMs?.[policy.key] ?? policy.intervalMs,
      jitterRatio: 0.1,
      timeoutMs: 10 * 60_000,
      async run(ctx: JobContext): Promise<JobOutcome> {
        if (sweep === undefined) {
          return { skipped: true, reason: stubReason(policy) };
        }
        const affected = await sweep(ctx);
        return { affected, detail: { policy: policy.description } };
      },
    };
  });
}

/**
 * Slots reserved for M3 (09 §3.3): spell schedules and reminders plug into this
 * same runner. Named here so the next owner adds a job, not a second scheduler.
 */
export const RESERVED_JOB_SLOTS = ['spells.scheduled-rules', 'notifications.reminders'] as const;
