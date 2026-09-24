/**
 * The `workspace_events.subject_ids` backfill (migration 205) — online, batched,
 * resumable.
 *
 * Why a server job and not a script: the backfill has to finish on EVERY node
 * that applies 205 (dev machines, prod), and until it does the change feed
 * refuses windows below the watermark. A script someone must remember to run is
 * the failure mode where one node stays `index_incomplete` indefinitely. This
 * runner already exists, already runs on every node, and already carries
 * node-admin claims for sweeps of exactly this shape (the file-upload sweeps).
 *
 * Why it is safe to run online: each call of `public.backfill_event_subject_ids`
 * indexes ONE batch of rows of ONE space and commits — its own short
 * transaction, row locks only, on rows of an append-only log that nothing else
 * updates. Progress is the per-space watermark in the database, so an
 * interrupted tick (abort, timeout, restart) loses at most the batch in flight,
 * which rolled back, and the next tick carries on from where it stopped. Two
 * nodes never collide: the door picks its space `FOR UPDATE SKIP LOCKED`.
 *
 * Once every space is indexed, each tick is one cheap call that reports
 * `skipped`.
 */

import type { Db, DbClaims } from '../../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const EVENT_SUBJECT_BACKFILL_JOB_NAME = 'events.subject-ids-backfill';

export interface EventSubjectBackfillOptions {
  db: Db;
  /** Node-owner claims — the door is node-admin only. */
  claims: () => Promise<DbClaims>;
  /** Rows per call (per transaction). */
  batchSize?: number;
  /** Stop a tick after this long; the next tick resumes. */
  tickBudgetMs?: number;
  intervalMs?: number;
  runOnStart?: boolean;
}

/** What one call of the door reports. */
export interface BackfillStep {
  done: boolean;
  updated: number;
  pendingSpaces: number;
  spaceId?: string;
  indexedFrom?: number;
}

function normalizeStep(raw: unknown): BackfillStep {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    done: r['done'] === true,
    updated: Number(r['updated'] ?? 0),
    pendingSpaces: Number(r['pendingSpaces'] ?? 0),
    ...(typeof r['spaceId'] === 'string' ? { spaceId: r['spaceId'] } : {}),
    ...(r['indexedFrom'] === undefined ? {} : { indexedFrom: Number(r['indexedFrom']) }),
  };
}

/** One call = one batch = one transaction. Exported for tests. */
export async function runEventSubjectBackfillStep(
  db: Db,
  claims: DbClaims,
  batchSize = 500,
): Promise<BackfillStep> {
  return normalizeStep(await db.rpc(claims, 'public.backfill_event_subject_ids', [batchSize]));
}

/** One tick: batches until done, aborted, or out of budget. Exported for tests. */
export async function runEventSubjectBackfillTick(
  options: EventSubjectBackfillOptions,
  signal?: AbortSignal,
): Promise<JobOutcome> {
  const claims = await options.claims();
  const budget = options.tickBudgetMs ?? 60_000;
  const started = Date.now();
  let calls = 0;
  let updated = 0;
  let last: BackfillStep | null = null;

  while (!signal?.aborted && Date.now() - started < budget) {
    last = await runEventSubjectBackfillStep(options.db, claims, options.batchSize ?? 500);
    calls += 1;
    updated += last.updated;
    // `done` with no space means there was nothing to pick at all.
    if (last.done) break;
  }

  if (calls === 1 && last?.done === true && last.spaceId === undefined) {
    return { skipped: true, reason: 'every space is indexed' };
  }
  return {
    affected: updated,
    detail: { calls, done: last?.done ?? false, pendingSpaces: last?.pendingSpaces ?? null },
  };
}

export function createEventSubjectBackfillJob(options: EventSubjectBackfillOptions): ScheduledJob {
  return {
    name: EVENT_SUBJECT_BACKFILL_JOB_NAME,
    intervalMs: options.intervalMs ?? 60_000,
    jitterRatio: 0.1,
    runOnStart: options.runOnStart ?? true,
    timeoutMs: 5 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      return runEventSubjectBackfillTick(options, ctx.signal);
    },
  };
}
