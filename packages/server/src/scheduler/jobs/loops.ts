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
  /** Claims the executor acts under — the node's loopback owner. */
  claimsFor(spaceId: string): Promise<DbClaims>;
  /** Session ids with a genuinely live PTY right now (the liveness probe). */
  liveSessionIds(): readonly string[];
  /**
   * Spawn for a firing. Returns the new work_session id.
   * `teamMemberId === null` means "route through the dispatcher" (§4.4).
   */
  fire(loop: DueLoop, claims: DbClaims): Promise<{ taskId: string; sessionId: string }>;
}

export interface LoopsJobOptions {
  readonly db: Db;
  readonly port: LoopExecutorPort;
  /** Default 60s — the resolution of the cron half of the grammar. */
  readonly intervalMs?: number;
  /** Safety valve: never fire more than this many loops in one tick. */
  readonly maxPerTick?: number;
}

const DUE_LOOPS_SQL = `
  select l.entity_id::text  "entityId",
         e.space_id::text   "spaceId",
         l.title            "title",
         l.schedule         "schedule",
         l.team_member_id::text "teamMemberId",
         l.subject_id::text "subjectId",
         l.prompt           "prompt",
         l.config           "config",
         e.version          "version"
    from public.loops l
    join public.entities e on e.id = l.entity_id
   where l.enabled
     and e.deleted_at is null
     and l.next_run_at is not null
     and l.next_run_at <= now()
   order by l.next_run_at
   limit $1`;

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
      // A read under the node owner's claims; per-loop work re-derives claims
      // for the loop's own space.
      const claims = await port.claimsFor('');
      const due = await db.query<DueLoop>(claims, DUE_LOOPS_SQL, [maxPerTick]);
      if (due.length === 0) return { skipped: true, reason: 'no loops are due' };

      const live = port.liveSessionIds();
      let fired = 0;
      let skipped = 0;
      let failed = 0;

      for (const loop of due) {
        if (ctx.signal.aborted) break;
        const loopClaims = await port.claimsFor(loop.spaceId);

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
          await recordRun(db, loopClaims, loop, advance, 'previous firing is still live');
          skipped += 1;
          continue;
        }
        if (scheduleError !== null) {
          // Left ENABLED with the reason recorded: a bad expression is a thing
          // a human fixes, not a reason for the server to retire their loop.
          await recordRun(db, loopClaims, loop, null, scheduleError);
          failed += 1;
          continue;
        }

        try {
          await port.fire(loop, loopClaims);
          await recordRun(db, loopClaims, loop, advance, null);
          fired += 1;
        } catch (error) {
          await recordRun(db, loopClaims, loop, advance,
            error instanceof Error ? error.message : String(error));
          ctx.logger.debug(`loop ${loop.entityId} failed to fire: ${String(error)}`);
          failed += 1;
        }
      }

      return { affected: fired, detail: { due: due.length, fired, skipped, failed } };
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
  } catch {
    // A version conflict here means someone edited the loop while it fired.
    // Their edit wins; the next tick recomputes from whatever they set.
  }
}
