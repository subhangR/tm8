/**
 * The loop executor (dreamer-dispatcher DESIGN §4.4, D6).
 *
 * ONE job on the existing R26 runner, registered beside backup and retention —
 * not a second timer subsystem. The runner already owns per-job locking,
 * failure isolation and jitter; a loop is DB-defined work that runs on it.
 *
 * Each due firing: derive a task from the loop's subject (or the loop itself),
 * spawn a session on it, edge both back to the loop with `triggered_by`, and
 * advance `next_run_at`.
 *
 * MISFIRE POLICY: SKIP, NEVER BACKFILL. A node that was down for six hours
 * wakes with an `every 5m` loop 72 firings behind. Backfilling would spawn 72
 * agent sessions at once — which is not "catching up", it is a self-inflicted
 * denial of service with a concurrency cap in front of it. `next_run_at` is
 * therefore recomputed FROM NOW, not from the missed deadline, and the missed
 * firings are simply gone. A loop is "do this periodically", not a queue.
 *
 * OVERLAP GUARD: a loop whose previous session is still live is skipped, so a
 * job that takes longer than its period degrades to "one at a time" instead of
 * accumulating sessions.
 *
 * Failures are recorded on the loop (`last_error`) and NEVER disable it: a
 * transient spawn refusal must not silently retire a schedule a human set up.
 */

import type { Db, DbClaims } from '../../db/types.js';
import { nextRunAt, ScheduleError } from '../schedule.js';
import type { JobContext, JobOutcome, ScheduledJob } from '../types.js';

export const LOOPS_JOB_NAME = 'loops.execute-due';

/** A row of the due-loop query — everything a firing needs, in one read. */
export interface DueLoop {
  readonly entityId: string;
  readonly spaceId: string;
  readonly title: string;
  readonly schedule: string;
  readonly teamMemberId: string | null;
  readonly subjectId: string | null;
  readonly prompt: string;
  readonly config: Record<string, unknown> | null;
  readonly version: number;
  /**
   * The identity THIS firing runs as (375): the human who armed the loop
   * (`armed_by_identity_id`, 343 — already the provenance root of a firing)
   * while their membership is active, else the space owner. Null when the
   * space has no active member left to act as — such a loop cannot be fired OR
   * recorded against, because every door on the path needs a member row.
   *
   * It is on the row rather than resolved per loop by the port because the
   * cross-space read is the only thing holding the elevated claim, so it is
   * also the only place that can see the answer.
   */
  readonly actAsIdentity: string | null;
}

/**
 * What the job needs from the rest of the server, as a seam.
 *
 * The executor does NOT import SpawnService or the dispatch handler directly.
 * Those live behind `PtyHostService` and a live database, and a scheduler job
 * that transitively drags a PTY host into its imports cannot be tested without
 * one. The composition root supplies these.
 */
export interface LoopExecutorPort {
  /**
   * Claims for the CROSS-SPACE due read, and for nothing else (375).
   *
   * These bind `tm8.background_job = 'loops.execute-due'`, which opens exactly
   * one read-only function. They are deliberately NOT what a firing runs under:
   * the node's loopback owner is a member only of the spaces it created, so
   * reading due loops as the owner is what made every loop in a human's own
   * space invisible — enabled, overdue, and silently skipped for 23 days.
   */
  dueReadClaims(): Promise<DbClaims>;
  /**
   * Claims for ONE loop's firing: the identity the due read resolved for it,
   * who IS an active member of the loop's space. Every door on the firing path
   * (`update_loop`, `derive_task_for_entity`, `resolve_actor`, spawn) requires
   * that membership, so this is the claim that makes them work — rather than a
   * bypass added to each of them.
   *
   * `actAsIdentity` is passed separately, already proven non-null by the
   * caller, so the port never has to decide what to do without one.
   */
  claimsForLoop(loop: DueLoop, actAsIdentity: string): DbClaims;
  /** Session ids with a genuinely live PTY right now (the liveness probe). */
  liveSessionIds(): readonly string[];
  /**
   * Spawn for a firing. Returns the new work_session id.
   * `teamMemberId === null` means "route through the dispatcher" (§4.4).
   *
   * `firedAt` is passed rather than read from the clock inside the port because
   * it is the identity of THIS firing: it keys the mutation ids that keep two
   * firings of one loop distinct commands. Taking it from the scheduler makes
   * that key deterministic and testable instead of wall-clock dependent.
   */
  fire(
    loop: DueLoop,
    claims: DbClaims,
    firedAt: Date,
  ): Promise<{ taskId: string; sessionId: string }>;
}

export interface LoopsJobOptions {
  readonly db: Db;
  readonly port: LoopExecutorPort;
  /** Default 60s — the resolution of the cron half of the grammar. */
  readonly intervalMs?: number;
  /** Safety valve: never fire more than this many loops in one tick. */
  readonly maxPerTick?: number;
}

/**
 * The due read goes through `loops_due_for_executor` (375), NOT a direct select.
 *
 * The predicates and the ordering moved into that function unchanged; what the
 * door adds is the ability to see a loop at all. A direct
 * `select … from public.loops join public.entities` is filtered by
 * `entities_select` to `space_id = any(internal.member_space_ids())`, and the
 * executor's identity is a member of the spaces the NODE created — so every
 * loop in a space a human created returned zero rows, forever, with no error
 * recorded anywhere. See the migration header for the measurement.
 */
const DUE_LOOPS_SQL = `
  select d.entity_id::text       "entityId",
         d.space_id::text        "spaceId",
         d.title                 "title",
         d.schedule              "schedule",
         d.team_member_id::text  "teamMemberId",
         d.subject_id::text      "subjectId",
         d.prompt                "prompt",
         d.config                "config",
         d.version               "version",
         d.act_as_identity       "actAsIdentity"
    from public.loops_due_for_executor($1) d`;

/**
 * Is a previous firing of this loop still running? Asked of the PTY map, never
 * of `work_sessions.status` — a session that died with the node keeps its last
 * status forever, and an overlap guard reading that column would wedge a loop
 * permanently after one crash.
 */
async function hasLiveFiring(
  db: Db,
  claims: DbClaims,
  loopId: string,
  live: readonly string[],
): Promise<boolean> {
  if (live.length === 0) return false;
  const rows = await db.query<{ id: string }>(
    claims,
    `select src_id::text id from public.edges
      where dst_id = $1 and type = 'triggered_by' and src_id = any($2::uuid[])
      limit 1`,
    [loopId, [...live]],
  );
  return rows.length > 0;
}

export function createLoopsJob(opts: LoopsJobOptions): ScheduledJob {
  const { db, port } = opts;
  const maxPerTick = opts.maxPerTick ?? 25;

  return {
    name: LOOPS_JOB_NAME,
    intervalMs: opts.intervalMs ?? 60_000,
    // Small: this job is cheap and its whole point is punctuality.
    jitterRatio: 0.05,
    runOnStart: false,
    timeoutMs: 10 * 60_000,
    async run(ctx: JobContext): Promise<JobOutcome> {
      // The cross-space read, under the job claim and nothing else; each firing
      // then runs under its OWN loop's space claims (375).
      const due = await db.query<DueLoop>(await port.dueReadClaims(), DUE_LOOPS_SQL, [maxPerTick]);
      if (due.length === 0) return { skipped: true, reason: 'no loops are due' };

      const live = port.liveSessionIds();
      let fired = 0;
      let skipped = 0;
      let failed = 0;
      let orphaned = 0;

      for (const loop of due) {
        if (ctx.signal.aborted) break;

        /**
         * No active member left to act as: the space's creator left and no
         * owner remains. Nothing can be done with this loop — every door on
         * the path, `update_loop` included, needs a member row — so it cannot
         * even be recorded against. LOUD rather than debug: it is unfixable
         * from inside the server and the log is the only place it can surface.
         */
        if (loop.actAsIdentity === null) {
          ctx.logger.warn(
            `loop ${loop.entityId} ("${loop.title}") in space ${loop.spaceId} has no active `
            + 'member to act as; it cannot be fired or recorded against until the space has one',
          );
          orphaned += 1;
          continue;
        }

        const loopClaims = port.claimsForLoop(loop, loop.actAsIdentity);

        // Advance the schedule FIRST, from now. Whatever happens to this
        // firing, the loop must not stay due — a loop that fails to advance is
        // re-selected on the very next tick and becomes a spawn loop.
        let advance: Date | null = null;
        let scheduleError: string | null = null;
        try {
          advance = nextRunAt(loop.schedule, ctx.firedAt);
          if (advance === null) scheduleError = `schedule "${loop.schedule}" never matches`;
        } catch (error) {
          scheduleError = error instanceof ScheduleError
            ? error.message
            : `unparseable schedule "${loop.schedule}"`;
        }

        if (await hasLiveFiring(db, loopClaims, loop.entityId, live)) {
          await recordRun(db, loopClaims, loop, advance, 'previous firing is still live', ctx);
          skipped += 1;
          continue;
        }
        if (scheduleError !== null) {
          // Left ENABLED with the reason recorded: a bad expression is a thing
          // a human fixes, not a reason for the server to retire their loop.
          await recordRun(db, loopClaims, loop, null, scheduleError, ctx);
          failed += 1;
          continue;
        }

        try {
          await port.fire(loop, loopClaims, ctx.firedAt);
          await recordRun(db, loopClaims, loop, advance, null, ctx);
          fired += 1;
        } catch (error) {
          await recordRun(db, loopClaims, loop, advance,
            error instanceof Error ? error.message : String(error), ctx);
          ctx.logger.debug(`loop ${loop.entityId} failed to fire: ${String(error)}`);
          failed += 1;
        }
      }

      return {
        affected: fired,
        detail: { due: due.length, fired, skipped, failed, ...(orphaned > 0 ? { orphaned } : {}) },
      };
    },
  };
}

/**
 * Write the outcome back through `update_loop` rather than an UPDATE.
 *
 * The door is the single writer, so a firing lands in the command ledger and
 * the event stream like every other change. A scheduler that reached around it
 * would leave the graph describing a loop that never appeared to run.
 */
async function recordRun(
  db: Db,
  claims: DbClaims,
  loop: DueLoop,
  advance: Date | null,
  error: string | null,
  ctx: JobContext,
): Promise<void> {
  try {
    await db.tx(claims, async (q) => {
      await q.rpc('update_loop', [
        loop.entityId,
        loop.version,
        null,
        null, null,
        null, false,
        null, false,
        null, null, null,
        advance ? advance.toISOString() : null,
        advance === null,
        new Date().toISOString(),
        error,
        error === null,
        `loop-run:${loop.entityId}:${loop.version}`,
      ]);
    });
  } catch (cause) {
    /**
     * A version conflict here means someone edited the loop while it fired.
     * Their edit wins; the next tick recomputes from whatever they set — so
     * this is genuinely not an error.
     *
     * It is LOGGED anyway, because this `catch` used to be empty and that is
     * half of why the 2026-10 outage was invisible: `recordRun` is the only
     * writer of `last_error`, so a door that refuses it swallows the record of
     * every other failure with it. A loop that is not advancing and has no
     * `last_error` has to leave a trace SOMEWHERE, and this is the only place
     * left. Not re-thrown: one loop's bookkeeping must not end the tick for
     * the others.
     */
    ctx.logger.warn(
      `loop ${loop.entityId} ran but its outcome could not be recorded `
      + `(update_loop refused at version ${loop.version}): ${String(cause)}`,
    );
  }
}
