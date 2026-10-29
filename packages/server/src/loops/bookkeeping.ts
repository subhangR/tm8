/**
 * The run-row doors of migration 385, as typed calls (design 01a182d4 §3.3).
 *
 * Shared by the executor job (scheduler/jobs/loops.ts) and the Run now handler
 * (loops/run-handlers.ts), so a manual firing is recorded by exactly the code a
 * scheduled one is. Every write here is keyed on the RUN ID, never on the loop's
 * entity version — the defect research A measured in the old `update_loop`
 * bookkeeping, where a human edit mid-firing dropped the write and the loop
 * fired twice.
 *
 * The schedule grammar is evaluated by the CALLER (scheduler/schedule.ts); the
 * doors store the advanced instant they are handed and never compute one.
 */
import type { LoopRunSkipReason, LoopRunStatus, LoopRunTrigger } from '@tm8/contract';
import type { Db, DbClaims } from '../db/types.js';

/** What `public.loop_run_claim` answers. */
export interface LoopRunClaim {
  readonly claimed: boolean;
  /** Present when claimed. */
  readonly runId?: string | null;
  readonly launch?: 'fired' | 'skipped';
  readonly skipReason?: LoopRunSkipReason | null;
  readonly attempt?: number;
  readonly actedAsIdentityId?: string | null;
  readonly requestedBy?: string | null;
  /** Present when not claimed. */
  readonly reason?: 'not_due' | 'locked' | 'overlap' | 'queued';
  /** The open run the decision was made against (overlap, queued, skipped). */
  readonly waitingOnRunId?: string | null;
}

export interface LoopRunClaimRequest {
  readonly loopId: string;
  /** The firing instant — the scheduler's `firedAt`, or now for Run now. */
  readonly now: Date;
  readonly trigger: LoopRunTrigger;
  /** Session ids with a live PTY right now (375's probe); the overlap read. */
  readonly liveSessionIds: readonly string[];
  /** Schedule claims: the advanced instant, or null with `scheduleError`. */
  readonly nextRunAt?: Date | null;
  readonly scheduleError?: string | null;
  /** The identity the firing runs as (§7), when the caller already resolved it. */
  readonly actedAsIdentityId?: string | null;
  /** Manual claims: the requesting actor (null = the caller's own member row). */
  readonly requestedBy?: string | null;
  /** Manual claims: fire even though a previous run is still live. */
  readonly force?: boolean;
  /** Manual claims: the client's mutation id, so a transport retry replays. */
  readonly clientMutationId?: string | null;
}

export async function claimLoopRun(db: Db, claims: DbClaims, request: LoopRunClaimRequest): Promise<LoopRunClaim> {
  return db.rpc<LoopRunClaim>(claims, 'loop_run_claim', [
    request.loopId,
    request.now.toISOString(),
    request.trigger,
    [...request.liveSessionIds],
    request.nextRunAt ? request.nextRunAt.toISOString() : null,
    request.scheduleError ?? null,
    request.actedAsIdentityId ?? null,
    request.requestedBy ?? null,
    request.force ?? false,
    request.clientMutationId ?? null,
  ]);
}

/** After the port fired: the run gets its task and session; the loop's retry counter and last_error clear. */
export async function recordLoopLaunch(
  db: Db,
  claims: DbClaims,
  runId: string,
  launched: { taskId: string | null; sessionId: string | null },
): Promise<void> {
  await db.rpc(claims, 'loop_run_launched', [runId, launched.taskId, launched.sessionId]);
}

/**
 * After the port threw: launch='failed' with the error on the run and on the
 * loop's last_error; a scheduled run with retries left is re-armed at
 * now + retry_delay_seconds. Returns the retry instant, or null.
 */
export async function recordLoopLaunchFailure(
  db: Db,
  claims: DbClaims,
  runId: string,
  error: string,
  now: Date,
): Promise<string | null> {
  const result = await db.rpc<{ retryAt: string | null }>(claims, 'loop_run_launch_failed', [runId, error, now.toISOString()]);
  return result?.retryAt ?? null;
}

export type LoopRunOutcome = Extract<LoopRunStatus, 'completed' | 'failed' | 'stopped' | 'timed_out'>;

/** Settles once (384): a second settle reports the first outcome and changes nothing. */
export async function settleLoopRun(
  db: Db,
  claims: DbClaims,
  runId: string,
  outcome: LoopRunOutcome,
  error: string | null,
): Promise<LoopRunOutcome> {
  const result = await db.rpc<{ outcome: LoopRunOutcome }>(claims, 'loop_run_settle', [runId, outcome, error]);
  return result.outcome;
}

/** One retry for a bookkeeping write after a successful fire: a pool blip must not lose the record. */
export async function retryOnce<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch {
    return write();
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
