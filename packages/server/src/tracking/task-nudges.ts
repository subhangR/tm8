/**
 * The task-keyed loops (prompt v2.0 spec §4), as a DECISION separated from a
 * DELIVERY — the same split, for the same reason, as ./nudges.ts.
 *
 * 207 gives these loops their own ledger, `session_task_nudges`, keyed on
 * (session, task, loop): each loop fires ONCE per session and task, ever, and
 * the key lives in Postgres so a restart cannot re-send. Only `task_state`
 * (Q16) is implemented here; `closure`, `exit_without_receipt` and
 * `delegation_audit` (S3) claim through the same `internal.claim_task_nudge`
 * and share `TaskNudgeLoop`.
 *
 * task_state: when a LIVE session's task is cancelled, completed by somebody
 * else, or the session's teammate is unassigned from it, the session gets one
 * message telling it to stop and report. Detection is 207's triggers, written
 * in the same transaction as the transition; everything that decides WHETHER
 * to send is `decideTaskStateNudge`, with no I/O in it.
 *
 * Nothing in these bodies is third-party text — ids and a status enum the
 * server wrote — so unlike the forge loops there is nothing to fence.
 */

import type { Db, DbClaims } from '../db/types.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../scheduler/types.js';
import { capBody, type NudgeDispatcher } from './nudges.js';

export const TASK_NUDGE_JOB_NAME = 'tracking.task-nudges';

/** 207's ledger CHECK, verbatim. */
export type TaskNudgeLoop = 'closure' | 'exit_without_receipt' | 'delegation_audit' | 'task_state';

export type TaskStateCause = 'cancelled' | 'completed' | 'unassigned';

/** One row of 207 §C's outbox, as `claim_pending_task_nudges` returns it. */
export interface PendingTaskNudge {
  pendingId: string;
  spaceId: string;
  workSessionId: string;
  taskId: string;
  loopKind: TaskNudgeLoop;
  cause: TaskStateCause;
  /** The task's work_status after the transition; null for an unassignment. */
  status: string | null;
  /** Who made the write, or null for a write with no actor (a system path). */
  actorId: string | null;
  /** The session's own teammate, or null if it has none. */
  teammateId: string | null;
  /** The session's status NOW, not at detection. */
  sessionStatus: string | null;
  attempts: number;
}

export type TaskNudgeDecision =
  | { send: true; body: string }
  | { send: false; reason: 'own_transition' | 'session_not_live' | 'unsupported_loop' };

const LIVE_SESSION_STATUSES: ReadonlySet<string> = new Set(['spawning', 'running', 'idle']);

/**
 * The decision, with no I/O in it.
 *
 * OWN TRANSITION. A session acts as its teammate, so an actor equal to the
 * session's teammate is the session (or its teammate) doing it — it already
 * knows. The spec names this for completion ("completed by someone else");
 * it is applied to cancellation and unassignment too, because telling a
 * session about its own act is noise for exactly the same reason. An absent
 * actor (a system write, e.g. a merge-gated completion) is never "own".
 *
 * NOT LIVE. The trigger enqueues only live sessions, but the session may have
 * exited before the drain. A dead session cannot stop, so it is not told.
 */
export function decideTaskStateNudge(row: PendingTaskNudge): TaskNudgeDecision {
  if (row.loopKind !== 'task_state') return { send: false, reason: 'unsupported_loop' };
  if (row.sessionStatus === null || !LIVE_SESSION_STATUSES.has(row.sessionStatus)) {
    return { send: false, reason: 'session_not_live' };
  }
  if (row.actorId !== null && row.teammateId !== null && row.actorId === row.teammateId) {
    return { send: false, reason: 'own_transition' };
  }
  return { send: true, body: taskStateBody(row) };
}

/** The two sentences Q16 fixed. No other prose. */
export function taskStateBody(row: Pick<PendingTaskNudge, 'cause' | 'status' | 'taskId'>): string {
  if (row.cause === 'unassigned') {
    return `You were unassigned from task ${row.taskId}: stop and report.`;
  }
  const status = row.status ?? (row.cause === 'cancelled' ? 'cancelled' : 'done');
  return `Task ${row.taskId} is now ${status}: stop and report.`;
}

export interface TaskNudgeDelivery {
  delivered: number;
  suppressed: number;
  duplicates: number;
  notLive: number;
  failed: string[];
}

/**
 * Drain: decide each row, then either settle it with the decision's reason or
 * post it through 207 §E2, which claims the ledger, sends and settles in ONE
 * transaction. Routes are recorded and dispatched afterwards as tm8_app, as
 * ./nudges.ts does and for the reason 103 K4 gives.
 */
export async function deliverPendingTaskNudges(
  db: Db,
  claims: DbClaims,
  pending: readonly PendingTaskNudge[],
  dispatch?: NudgeDispatcher,
): Promise<TaskNudgeDelivery> {
  const result: TaskNudgeDelivery = { delivered: 0, suppressed: 0, duplicates: 0, notLive: 0, failed: [] };

  for (const row of pending) {
    const decision = decideTaskStateNudge(row);
    if (!decision.send) {
      try {
        await db.rpc(claims, 'public.settle_pending_task_nudge', [row.pendingId, decision.reason, null]);
        if (decision.reason === 'session_not_live') result.notLive += 1;
        else result.suppressed += 1;
      } catch (error) {
        result.failed.push(`${row.loopKind}/${row.taskId}: settle failed: ${describe(error)}`);
      }
      continue;
    }

    let posted: { posted?: unknown; reason?: unknown; messageId?: unknown; workSessionId?: unknown };
    try {
      posted = await db.rpc(claims, 'public.post_task_nudge', [
        row.pendingId,
        capBody(decision.body),
        // One (session, task, loop) is one message, so this key is exact, and
        // 019's own idempotency becomes a second net under the ledger.
        `task-nudge:${row.loopKind}:${row.workSessionId}:${row.taskId}`,
      ]);
    } catch (error) {
      result.failed.push(`${row.loopKind}/${row.taskId}: post failed: ${describe(error)}`);
      try {
        await db.rpc(claims, 'public.settle_pending_task_nudge', [row.pendingId, null, describe(error)]);
      } catch {
        // Best effort: the attempt counter is diagnostics, not correctness.
      }
      continue;
    }

    if (posted.posted !== true) {
      if (posted.reason === 'duplicate') result.duplicates += 1;
      else result.notLive += 1;
      continue;
    }

    result.delivered += 1;
    if (dispatch && typeof posted.workSessionId === 'string' && typeof posted.messageId === 'string') {
      try {
        const routes = await db.rpc(claims, 'public.w2_record_session_message_routes', [
          [posted.messageId],
          null,
        ]);
        await dispatch({ routes, workSessionId: posted.workSessionId });
      } catch (error) {
        // Stored and settled; only the terminal write failed, and 019's
        // delivery rows own that retry.
        result.failed.push(`${row.loopKind}/${row.taskId}: dispatch failed: ${describe(error)}`);
      }
    }
  }

  return result;
}

export interface TaskNudgeJobOptions {
  db: Db;
  claims: () => Promise<DbClaims>;
  dispatch?: NudgeDispatcher;
  /** Rows drained per tick. */
  budget?: number;
  /** How long an undelivered row waits before it is retired as expired. */
  maxPendingAgeHours?: number;
  intervalMs?: number;
  runOnStart?: boolean;
}

export async function runTaskNudgeTick(options: TaskNudgeJobOptions): Promise<JobOutcome> {
  const claims = await options.claims();
  const claimed = await options.db.rpc<{ pending?: unknown }>(
    claims,
    'public.claim_pending_task_nudges',
    [options.budget ?? 50, options.maxPendingAgeHours ?? 24],
  );
  const pending = normalizePendingTaskNudges(claimed?.pending);
  if (pending.length === 0) return { skipped: true, reason: 'no queued task nudges' };
  const delivery = await deliverPendingTaskNudges(options.db, claims, pending, options.dispatch);
  return {
    affected: delivery.delivered,
    detail: { ...delivery, pending: pending.length, failed: delivery.failed.slice(0, 10) },
  };
}

export function createTaskNudgeJob(options: TaskNudgeJobOptions): ScheduledJob {
  return {
    name: TASK_NUDGE_JOB_NAME,
    // Short: "stop" is only useful while the session is still working, and a
    // drain with nothing queued is one indexed read. No provider is called,
    // so running on start costs nothing either.
    intervalMs: options.intervalMs ?? 15_000,
    jitterRatio: 0.1,
    runOnStart: options.runOnStart ?? true,
    timeoutMs: 60_000,
    async run(_ctx: JobContext): Promise<JobOutcome> {
      return runTaskNudgeTick(options);
    },
  };
}

const LOOPS: ReadonlySet<string> = new Set(['closure', 'exit_without_receipt', 'delegation_audit', 'task_state']);
const CAUSES: ReadonlySet<string> = new Set(['cancelled', 'completed', 'unassigned']);

export function normalizePendingTaskNudges(raw: unknown): PendingTaskNudge[] {
  if (!Array.isArray(raw)) return [];
  const rows: PendingTaskNudge[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.pendingId !== 'string' || typeof r.spaceId !== 'string'
      || typeof r.workSessionId !== 'string' || typeof r.taskId !== 'string'
      || typeof r.loopKind !== 'string' || !LOOPS.has(r.loopKind)
      || typeof r.cause !== 'string' || !CAUSES.has(r.cause)
    ) continue;
    rows.push({
      pendingId: r.pendingId,
      spaceId: r.spaceId,
      workSessionId: r.workSessionId,
      taskId: r.taskId,
      loopKind: r.loopKind as TaskNudgeLoop,
      cause: r.cause as TaskStateCause,
      status: typeof r.status === 'string' ? r.status : null,
      actorId: typeof r.actorId === 'string' ? r.actorId : null,
      teammateId: typeof r.teammateId === 'string' ? r.teammateId : null,
      sessionStatus: typeof r.sessionStatus === 'string' ? r.sessionStatus : null,
      attempts: typeof r.attempts === 'number' ? r.attempts : 0,
    });
  }
  return rows;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
