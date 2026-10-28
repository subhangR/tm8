/**
 * The loop executor (design of record 01a182d4 §3.2–§3.3; dreamer-dispatcher
 * DESIGN §4.4 D6 for the misfire policy).
 *
 * ONE job on the existing R26 runner, registered beside backup and retention —
 * not a second timer subsystem. The runner already owns per-job locking,
 * failure isolation and jitter; a loop is DB-defined work that runs on it.
 *
 * CLAIM FIRST, THEN FIRE (§3.3). Each tick: park the loops nobody can act as
 * (`loops_park_orphans`), read the due set (`loops_claimable`), and for each
 * loop CLAIM a run through `loop_run_claim` — one transaction that locks the
 * row, re-checks it is still due, decides overlap, inserts the `loop_runs` row
 * and advances `next_run_at` — and only then fire it through the port. The
 * launch outcome lands through `loop_run_launched` / `loop_run_launch_failed`,
 * keyed on the run id. No bookkeeping write asserts the entity version, so a
 * human edit during a firing affects only later runs instead of making the
 * loop fire twice (research A's defect 1), and a second node running this job
 * would skip the rows the first one holds.
 *
 * MISFIRE POLICY: SKIP, NEVER BACKFILL. `next_run_at` is advanced FROM THE
 * FIRING INSTANT, not from the missed deadline, so a node that was down for six
 * hours wakes to one firing of an `every 5m` loop, not 72. A lapsed pause fires
 * once at the next tick, then resumes cadence (§3.2): "pause until Monday
 * 09:00" on a daily 09:00 loop must fire Monday 09:00.
 *
 * CONCURRENCY (§3.3): a loop whose previous run is still live is skipped
 * (`concurrency='skip'`: a 'skipped'/'overlap' row, schedule advances) or kept
 * due with no new row until that run settles (`'queue'`). Liveness is the PTY
 * map plus launches still in flight — never `work_sessions.status` alone, which
 * a session that died with the node keeps forever.
 *
 * RETRY (§3.3): a launch failure re-arms the loop at now + retry_delay_seconds
 * while retry_attempt < retry_attempts; the counter resets on a successful
 * launch. Failures are recorded on the run and on `last_error` and NEVER
 * disable the loop: a transient spawn refusal must not retire a schedule a
 * human set up.
 *
 * MAX RUNTIME (§3.3): every tick sweeps open runs; a live session past
 * fired_at + max_runtime_seconds is stopped through the port (the same server
 * path execution.terminate uses) and the run settles 'timed_out'. The sweep
 * also settles runs whose session has exited (so the open set stays small) and
 * fails a launch that never recorded a session within LAUNCH_GRACE_MS (the
 * server died mid-firing).
 */

import type { LoopAction, LoopConcurrency, ToolJsonValue } from '@tm8/contract';
import type { Db, DbClaims } from '../../db/types.js';
import {
  claimLoopRun,
  errorText,
  recordLoopLaunch,
  recordLoopLaunchFailure,
  settleLoopRun,
  type LoopRunOutcome,
} from '../../loops/bookkeeping.js';
import { nextRunAt, ScheduleError } from '../schedule.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const LOOPS_JOB_NAME = 'loops.execute-due';

/**
 * A claimed launch that has not recorded a session after this long is settled
 * 'failed': the only way to get there is a server that died between the claim
 * and the launch record. Matches the job's own timeout, so a slow but live
 * firing is never mistaken for a dead one.
 */
export const LAUNCH_GRACE_MS = 10 * 60_000;

/** A row of `loops_claimable` — everything a firing branches on, in one read (§2.1). */
export interface DueLoop {
  readonly entityId: string;
  readonly spaceId: string;
  readonly title: string;
  readonly schedule: string;
  /** IANA zone the cron half is evaluated in; intervals are zone-free (§3.1). */
  readonly timezone: string;
  readonly action: LoopAction;
  /** spawn: the runner; tool: the runs-as persona; dispatch: null. */
  readonly teamMemberId: string | null;
  readonly subjectId: string | null;
  readonly toolId: string | null;
  readonly toolInputs: Record<string, ToolJsonValue>;
  readonly prompt: string;
  readonly config: Record<string, unknown> | null;
  readonly version: number;
  readonly concurrency: LoopConcurrency;
  readonly maxRuntimeSeconds: number | null;
  readonly retryAttempts: number;
  readonly retryDelaySeconds: number;
  readonly retryAttempt: number;
  readonly pausedUntil: string | null;
  readonly nextRunAt: string | null;
  /**
   * The identity THIS firing runs as (375, §7): the human who armed the loop
   * while their membership is active, else the space's active owner. The due
   * read returns no loop without one — `loops_park_orphans` records those —
   * so it is null only for a caller that built the row by hand.
   */
  readonly actAsIdentity: string | null;
}

/** A row of `loop_runs_open_for_executor` — an unsettled firing and its session's facts. */
export interface OpenLoopRun {
  readonly runId: string;
  readonly loopId: string;
  readonly spaceId: string;
  readonly action: LoopAction;
  readonly trigger: 'schedule' | 'manual';
  readonly firedAt: string | Date;
  readonly sessionId: string | null;
  readonly maxRuntimeSeconds: number | null;
  readonly sessionStatus: string | null;
  readonly sessionKind: string | null;
  readonly exitCode: number | null;
  readonly toolExitCode: number | null;
  readonly exitedAt: string | Date | null;
  readonly actAsIdentity: string | null;
}

/** Why a session is being stopped, in the words the row will carry (171). */
export interface LoopStopRequest {
  /** Technical: the `error` text on the work_session row. */
  readonly reason: string;
  /** For a person: one plain sentence, the `ended_reason`. */
  readonly endedReason: string;
  readonly clientMutationId: string | null;
}

/**
 * What the job needs from the rest of the server, as a seam.
 *
 * The executor does NOT import SpawnService or the dispatch handler directly.
 * Those live behind `PtyHostService` and a live database, and a scheduler job
 * that transitively drags a PTY host into its imports cannot be tested without
 * one. The composition root supplies these (`createLoopExecutorPort`), and the
 * SAME instance serves `loops.runNow` and `loops.runs.stop`, so a manual run
 * fires and stops through exactly the path a scheduled one does.
 */
export interface LoopExecutorPort {
  /**
   * Claims for the CROSS-SPACE reads and the run bookkeeping (375, 382).
   *
   * These bind `tm8.background_job = 'loops.execute-due'`, which opens the
   * worker-gated doors and nothing else. They are deliberately NOT what a
   * firing runs under: the node's loopback owner is a member only of the spaces
   * it created, so firing as the owner is what made every loop in a human's own
   * space invisible — enabled, overdue, and silently skipped for 23 days.
   */
  dueReadClaims(): Promise<DbClaims>;
  /**
   * Claims for ONE loop's firing (or one run's stop): the identity the due
   * read resolved for it, who IS an active member of the loop's space. Every
   * door on the firing path (`derive_task_for_entity`, `resolve_actor`, spawn,
   * `stop_work_session`) requires that membership.
   */
  claimsForLoop(loop: Pick<DueLoop, 'entityId' | 'spaceId'>, actAsIdentity: string): DbClaims;
  /** Session ids with a genuinely live PTY right now (the liveness probe). */
  liveSessionIds(): readonly string[];
  /**
   * Fire a claimed run per `loop.action` (§3.4): spawn, dispatch or tool.
   * Returns the derived task (null for a tool firing) and the session.
   *
   * `firedAt` is the firing instant and `runId` the claimed run: together they
   * key every mutation id the firing mints (loops/firing.ts), so two firings of
   * one loop are two distinct commands and a transport retry is a replay.
   * `taskId` is null for a tool firing, which derives no task (§3.4).
   */
  fire(
    loop: DueLoop,
    claims: DbClaims,
    firedAt: Date,
    runId?: string,
  ): Promise<{ taskId: string | null; sessionId: string }>;
  /**
   * Stop a run's session through the server's own stop path — the one
   * `execution.terminate` takes (`stop_work_session`, then
   * `SpawnService.terminate`) — so a loop-stopped session is recorded exactly
   * like an operator-stopped one.
   */
  stopSession(claims: DbClaims, sessionId: string, request: LoopStopRequest): Promise<void>;
}

export interface LoopsJobOptions {
  readonly db: Db;
  readonly port: LoopExecutorPort;
  /** Default 60s — the resolution of the cron half of the grammar. */
  readonly intervalMs?: number;
  /** Safety valve: never fire more than this many loops in one tick. */
  readonly maxPerTick?: number;
  /** Default LAUNCH_GRACE_MS. */
  readonly launchGraceMs?: number;
}

/**
 * The due read (382's `loops_claimable`), NOT a direct select: a direct
 * `select … from public.loops join public.entities` is filtered by
 * `entities_select` to the executor identity's own member spaces, which is the
 * 375 outage. The door is gated on the worker claim and returns every column a
 * firing branches on, already filtered to loops that have an identity to act as.
 */
const CLAIMABLE_SQL = `
  select d.entity_id::text          "entityId",
         d.space_id::text           "spaceId",
         d.title                    "title",
         d.schedule                 "schedule",
         d.timezone                 "timezone",
         d.action                   "action",
         d.team_member_id::text     "teamMemberId",
         d.subject_id::text         "subjectId",
         d.tool_id::text            "toolId",
         d.tool_inputs              "toolInputs",
         d.prompt                   "prompt",
         d.config                   "config",
         d.version                  "version",
         d.concurrency              "concurrency",
         d.max_runtime_seconds      "maxRuntimeSeconds",
         d.retry_attempts           "retryAttempts",
         d.retry_delay_seconds      "retryDelaySeconds",
         d.retry_attempt            "retryAttempt",
         d.paused_until             "pausedUntil",
         d.next_run_at              "nextRunAt",
         d.act_as_identity          "actAsIdentity"
    from public.loops_claimable($1, $2) d`;

const PARK_ORPHANS_SQL = `
  select p.entity_id::text "entityId", p.space_id::text "spaceId", p.title "title"
    from public.loops_park_orphans($1) p`;

const OPEN_RUNS_SQL = `
  select o.run_id::text              "runId",
         o.loop_id::text             "loopId",
         o.space_id::text            "spaceId",
         o.action                    "action",
         o.trigger                   "trigger",
         o.fired_at                  "firedAt",
         o.session_id::text          "sessionId",
         o.max_runtime_seconds       "maxRuntimeSeconds",
         o.session_status            "sessionStatus",
         o.session_kind              "sessionKind",
         o.exit_code                 "exitCode",
         o.tool_exit_code            "toolExitCode",
         o.exited_at                 "exitedAt",
         o.act_as_identity           "actAsIdentity"
    from public.loop_runs_open_for_executor($1) o`;

const LIVE_STATUSES = new Set(['spawning', 'running', 'idle']);
const TERMINAL_STATUSES = new Set(['exited', 'failed']);

/** The advanced instant for one loop, or the reason the schedule could not be evaluated. */
export function advanceFor(loop: Pick<DueLoop, 'schedule' | 'timezone'>, firedAt: Date): { nextRunAt: Date | null; scheduleError: string | null } {
  try {
    const next = nextRunAt(loop.schedule, firedAt, loop.timezone);
    return next === null
      ? { nextRunAt: null, scheduleError: `schedule "${loop.schedule}" never matches` }
      : { nextRunAt: next, scheduleError: null };
  } catch (error) {
    return {
      nextRunAt: null,
      scheduleError: error instanceof ScheduleError ? error.message : `unparseable schedule "${loop.schedule}"`,
    };
  }
}

/**
 * What a session's terminal status says the run's outcome was. A tool run's
 * non-zero exit is the RUN's failure (§3.4); an agent session's outcome is its
 * status (ghost reconciliation and the lost-session reaper both record 'failed').
 */
export function outcomeOfExitedSession(run: Pick<OpenLoopRun, 'sessionStatus' | 'sessionKind' | 'toolExitCode' | 'exitCode'>): { outcome: LoopRunOutcome; error: string | null } | null {
  if (run.sessionStatus === null || !TERMINAL_STATUSES.has(run.sessionStatus)) return null;
  if (run.sessionStatus === 'failed') return { outcome: 'failed', error: 'the session failed' };
  if (run.sessionKind === 'tool' && run.toolExitCode !== null && run.toolExitCode !== 0) {
    return { outcome: 'failed', error: `the tool exited with code ${run.toolExitCode}` };
  }
  return { outcome: 'completed', error: null };
}

export function createLoopsJob(opts: LoopsJobOptions): ScheduledJob {
  const { db, port } = opts;
  const maxPerTick = opts.maxPerTick ?? 25;
  const launchGraceMs = opts.launchGraceMs ?? LAUNCH_GRACE_MS;

  return {
    name: LOOPS_JOB_NAME,
    intervalMs: opts.intervalMs ?? 60_000,
    // Small: this job is cheap and its whole point is punctuality.
    jitterRatio: 0.05,
    runOnStart: false,
    timeoutMs: 10 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      const worker = await port.dueReadClaims();
      const now = ctx.firedAt;
      const nowIso = now.toISOString();

      /**
       * No active member left to act as: the armer left and no owner remains.
       * Nothing can be fired for this loop. It is parked LOUDLY — `last_error`
       * says 'needs arming' once, the clock keeps running, and it is no longer
       * selected as due, so 25 such orphans can no longer starve the queue.
       */
      const parked = await db.query<{ entityId: string; spaceId: string; title: string }>(worker, PARK_ORPHANS_SQL, [nowIso]);
      for (const loop of parked) {
        ctx.logger.warn(
          `loop ${loop.entityId} ("${loop.title}") in space ${loop.spaceId} has no active `
          + "member to act as; parked with last_error 'needs arming' until the space has one",
        );
      }

      const due = await db.query<DueLoop>(worker, CLAIMABLE_SQL, [maxPerTick, nowIso]);
      const live = port.liveSessionIds();
      let fired = 0;
      let skipped = 0;
      let failed = 0;
      let queued = 0;
      let notDue = 0;

      for (const loop of due) {
        if (ctx.signal.aborted) break;

        const { nextRunAt: advance, scheduleError } = advanceFor(loop, now);
        const claim = await claimLoopRun(db, worker, {
          loopId: loop.entityId,
          now,
          trigger: 'schedule',
          liveSessionIds: live,
          nextRunAt: advance,
          scheduleError,
          actedAsIdentityId: loop.actAsIdentity,
        });

        if (!claim.claimed) {
          // 'queued': stays due, no row, fires when the previous run settles.
          // 'not_due'/'locked': a human edit or another claimer got there first.
          if (claim.reason === 'queued') queued += 1; else notDue += 1;
          continue;
        }
        if (claim.launch === 'skipped') {
          skipped += 1;
          if (claim.skipReason === 'schedule_invalid') {
            // Left ENABLED and parked (next_run_at null) with the reason on the
            // loop: a bad expression is a thing a human fixes, not a reason for
            // the server to retire their loop.
            ctx.logger.warn(`loop ${loop.entityId} ("${loop.title}") is parked: ${scheduleError ?? 'schedule invalid'}`);
          }
          continue;
        }

        const runId = claim.runId as string;
        if (loop.actAsIdentity === null) {
          await recordLoopLaunchFailure(db, worker, runId, 'no active member to act as', now);
          failed += 1;
          continue;
        }
        const loopClaims = port.claimsForLoop(loop, loop.actAsIdentity);
        try {
          const launched = await port.fire(loop, loopClaims, now, runId);
          await recordLoopLaunch(db, worker, runId, launched);
          // A dispatch firing is DONE when the request is delivered: the
          // dispatcher session is long-lived and shared by the whole space, so
          // it must never count as this run's liveness (it would overlap forever).
          if (loop.action === 'dispatch') await settleLoopRun(db, worker, runId, 'completed', null);
          fired += 1;
        } catch (error) {
          const message = errorText(error);
          ctx.logger.debug(`loop ${loop.entityId} failed to fire: ${message}`);
          await recordLoopLaunchFailure(db, worker, runId, message, now).catch((cause: unknown) => {
            /**
             * LOGGED, never swallowed: this is the only writer of the failure,
             * and an empty catch here is half of why the 2026-10 outage was
             * invisible. Not re-thrown: one loop's bookkeeping must not end the
             * tick for the others.
             */
            ctx.logger.warn(`loop ${loop.entityId} failed to fire AND its failure could not be recorded on run ${runId}: ${errorText(cause)}`);
          });
          failed += 1;
        }
      }

      const sweep = await sweepOpenRuns({ db, port, worker, now, live, launchGraceMs, ctx });

      if (due.length === 0 && parked.length === 0 && sweep.timedOut + sweep.settled + sweep.abandoned === 0) {
        return { skipped: true, reason: 'no loops are due' };
      }
      return {
        affected: fired,
        detail: {
          due: due.length,
          fired,
          skipped,
          failed,
          queued,
          ...(notDue > 0 ? { notDue } : {}),
          ...(parked.length > 0 ? { orphaned: parked.length } : {}),
          ...(sweep.timedOut > 0 ? { timedOut: sweep.timedOut } : {}),
          ...(sweep.settled > 0 ? { settled: sweep.settled } : {}),
          ...(sweep.abandoned > 0 ? { abandoned: sweep.abandoned } : {}),
        },
      };
    },
  };
}

/**
 * The max-runtime and settle sweep (§3.3), over every open firing.
 *
 *   - a launch with no session after `launchGraceMs` → 'failed' (the server
 *     died between the claim and the launch record);
 *   - a session at a terminal status → 'completed' or 'failed' from its facts,
 *     so the open set stays the live set;
 *   - a LIVE session past fired_at + max_runtime_seconds → stopped through the
 *     port, then 'timed_out'. Liveness is the PTY map: a ghost row has nothing
 *     to stop, and its reconciliation settles the run above on a later tick.
 *     If the stop itself fails the run is left open and retried next tick,
 *     rather than recorded as stopped while the process still runs.
 */
async function sweepOpenRuns(input: {
  db: Db;
  port: LoopExecutorPort;
  worker: DbClaims;
  now: Date;
  live: readonly string[];
  launchGraceMs: number;
  ctx: JobContext;
}): Promise<{ timedOut: number; settled: number; abandoned: number }> {
  const { db, port, worker, now, ctx } = input;
  const liveSet = new Set(input.live);
  const open = await db.query<OpenLoopRun>(worker, OPEN_RUNS_SQL, [now.toISOString()]);
  let timedOut = 0;
  let settled = 0;
  let abandoned = 0;

  const settle = async (run: OpenLoopRun, outcome: LoopRunOutcome, error: string | null): Promise<boolean> => {
    try {
      await settleLoopRun(db, worker, run.runId, outcome, error);
      return true;
    } catch (cause) {
      ctx.logger.warn(`loop run ${run.runId} could not be settled ${outcome}: ${errorText(cause)}`);
      return false;
    }
  };

  for (const run of open) {
    if (ctx.signal.aborted) break;
    const firedAt = new Date(run.firedAt).getTime();

    if (run.sessionId === null) {
      if (now.getTime() - firedAt >= input.launchGraceMs) {
        if (await settle(run, 'failed', 'the launch was never recorded (the server may have restarted mid-firing)')) abandoned += 1;
      }
      continue;
    }

    const exited = outcomeOfExitedSession(run);
    if (exited !== null) {
      if (await settle(run, exited.outcome, exited.error)) settled += 1;
      continue;
    }

    if (run.maxRuntimeSeconds === null) continue;
    if (firedAt + run.maxRuntimeSeconds * 1000 > now.getTime()) continue;
    if (!liveSet.has(run.sessionId) && !(run.sessionStatus !== null && LIVE_STATUSES.has(run.sessionStatus))) continue;
    if (run.actAsIdentity === null) {
      ctx.logger.warn(`loop run ${run.runId} exceeded its max runtime but its space has no active member to stop it as`);
      continue;
    }
    const claims = port.claimsForLoop({ entityId: run.loopId, spaceId: run.spaceId }, run.actAsIdentity);
    try {
      await port.stopSession(claims, run.sessionId, {
        reason: `loop max runtime of ${run.maxRuntimeSeconds}s exceeded`,
        endedReason: 'Stopped by its loop: the run exceeded its maximum runtime.',
        clientMutationId: `loop-timeout:${run.runId}`,
      });
    } catch (cause) {
      ctx.logger.warn(`loop run ${run.runId} exceeded its max runtime but the stop failed: ${errorText(cause)}`);
      continue;
    }
    if (await settle(run, 'timed_out', `exceeded the maximum runtime of ${run.maxRuntimeSeconds} seconds`)) timedOut += 1;
  }

  return { timedOut, settled, abandoned };
}
