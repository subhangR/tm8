/**
 * loops.runNow, loops.runs.list, loops.runs.get, loops.runs.stop (design
 * 01a182d4 §3.3, §4.1). PR2 of the loops lane.
 *
 * Run now fires SYNCHRONOUSLY through the SAME executor port the scheduler
 * uses, after claiming a manual run through the same door: overlap is a 409
 * `loop_run_overlap` naming the live run unless `force`, the firing runs as the
 * loop's acting identity (§7), and the presser is recorded as `requestedBy`.
 * Stop goes through the port's stop path (the one `execution.terminate`
 * takes) and settles the run 'stopped'. The reads project `loop_runs` with the
 * derived status (loops/runs.ts).
 *
 * The port is optional: a node without an execution runtime still lists and
 * reads runs, and answers Run now and stop with an honest 501.
 */
import {
  CollabError,
  LoopRunNowInputSchema,
  LoopRunStatusSchema,
  LoopRunStopInputSchema,
  type LoopAction,
  type LoopConcurrency,
  type LoopRunResult,
  type ToolJsonValue,
} from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../db/types.js';
import type { FacadeDeps } from '../facade/deps.js';
import { claimsFor, commandEnvelope, limitOf, requireUuidParam } from '../facade/context.js';
import { toCollabError } from '../facade/execution-handlers.js';
import type { HandlerRegistry } from '../facade/registry.js';
import type { RequestContext } from '../http/types.js';
import type { DueLoop, LoopExecutorPort } from '../scheduler/jobs/loops.js';
import { claimLoopRun, errorText, recordLoopLaunch, recordLoopLaunchFailure, settleLoopRun } from './bookkeeping.js';
import { listLoopRuns, loadLoopRun } from './runs.js';

export interface LoopRunHandlerDeps {
  /** The ONE executor port, shared with the scheduler job (main.ts). */
  readonly executor?: LoopExecutorPort;
}

/** The route names the target; a repeated body id must agree with it. */
function routeId(ctx: RequestContext, field: 'loopId' | 'runId'): string {
  const id = requireUuidParam(ctx, field);
  const body = ctx.body;
  const bodyId = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[field] : undefined;
  if (bodyId !== undefined && bodyId !== id) {
    throw new CollabError('invalid_input', `body ${field} does not match route`);
  }
  return id;
}

interface LoopFiringRow {
  entityId: string; spaceId: string; title: string; schedule: string; timezone: string; action: LoopAction;
  teamMemberId: string | null; subjectId: string | null; toolId: string | null;
  toolInputs: Record<string, ToolJsonValue> | null; prompt: string; config: Record<string, unknown> | null;
  version: number; concurrency: LoopConcurrency; maxRuntimeSeconds: number | null;
  retryAttempts: number; retryDelaySeconds: number; retryAttempt: number;
  pausedUntil: string | Date | null; nextRunAt: string | Date | null;
}

/**
 * The loop as the executor sees it (a `DueLoop`), read under the CALLER's
 * claims so a non-member gets not_found, plus the identity the firing runs as.
 */
export async function loadLoopForFiring(q: Querier, loopId: string): Promise<DueLoop> {
  const [row] = await q.query<LoopFiringRow>(
    `select l.entity_id::text "entityId", e.space_id::text "spaceId", l.title, l.schedule, l.timezone, l.action,
            l.team_member_id::text "teamMemberId", l.subject_id::text "subjectId", l.tool_id::text "toolId",
            l.tool_inputs "toolInputs", l.prompt, l.config, e.version, l.concurrency,
            l.max_runtime_seconds "maxRuntimeSeconds", l.retry_attempts::int "retryAttempts",
            l.retry_delay_seconds "retryDelaySeconds", l.retry_attempt::int "retryAttempt",
            l.paused_until "pausedUntil", l.next_run_at "nextRunAt"
       from public.loops l join public.entities e on e.id = l.entity_id
      where l.entity_id = $1 and e.deleted_at is null and internal.entity_readable(e.id)`,
    [loopId],
  );
  if (!row) throw new CollabError('not_found', 'loop not found', { details: { loopId } });
  const acting = await q.rpc<{ identityId: string | null; via: string }>('loop_acting_as', [loopId]);
  const iso = (value: string | Date | null): string | null => (value === null ? null : new Date(value).toISOString());
  return {
    entityId: row.entityId,
    spaceId: row.spaceId,
    title: row.title,
    schedule: row.schedule,
    timezone: row.timezone,
    action: row.action,
    teamMemberId: row.teamMemberId,
    subjectId: row.subjectId,
    toolId: row.toolId,
    toolInputs: row.toolInputs ?? {},
    prompt: row.prompt,
    config: row.config,
    version: Number(row.version),
    concurrency: row.concurrency,
    maxRuntimeSeconds: row.maxRuntimeSeconds,
    retryAttempts: Number(row.retryAttempts),
    retryDelaySeconds: Number(row.retryDelaySeconds),
    retryAttempt: Number(row.retryAttempt),
    pausedUntil: iso(row.pausedUntil),
    nextRunAt: iso(row.nextRunAt),
    actAsIdentity: acting?.identityId ?? null,
  };
}

function statusFilter(raw: string | null): ReturnType<typeof LoopRunStatusSchema.parse> | null {
  if (raw === null || raw === '') return null;
  const parsed = LoopRunStatusSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CollabError('invalid_input', `status must be one of ${LoopRunStatusSchema.options.join(', ')}`);
  }
  return parsed.data;
}

export function registerLoopRunHandlers(registry: HandlerRegistry, deps: FacadeDeps, loops: LoopRunHandlerDeps = {}): void {
  const db: Db = deps.db;
  const requireExecutor = (what: string): LoopExecutorPort => {
    if (!loops.executor) {
      throw new CollabError('not_implemented', `${what} needs an execution runtime, which this node does not have`);
    }
    return loops.executor;
  };
  const readRun = (claims: DbClaims, runId: string, withOutputTail: boolean) =>
    db.tx(claims, (q) => loadLoopRun(q, runId, { withOutputTail }));

  registry.registerAll({
    'loops.runNow': async (ctx) => {
      const input = { ...LoopRunNowInputSchema.parse(ctx.body), loopId: routeId(ctx, 'loopId') };
      const executor = requireExecutor('Run now');
      const claims = claimsFor(await deps.owner(), ctx, commandEnvelope(ctx));
      const now = new Date();
      const loop = await db.tx(claims, (q) => loadLoopForFiring(q, input.loopId));
      if (loop.actAsIdentity === null) {
        throw new CollabError('invariant_violation', 'this loop has no active member to run as; it needs arming', {
          details: { reason: 'needs_arming', loopId: loop.entityId },
        });
      }
      const claim = await claimLoopRun(db, claims, {
        loopId: loop.entityId,
        now,
        trigger: 'manual',
        liveSessionIds: executor.liveSessionIds(),
        actedAsIdentityId: loop.actAsIdentity,
        requestedBy: input.actorId ?? null,
        force: input.force ?? false,
        clientMutationId: input.clientMutationId,
      });
      if (!claim.claimed) {
        if (claim.reason === 'overlap') {
          throw new CollabError('conflict', 'a run of this loop is still live; pass force to run anyway', {
            details: { reason: 'loop_run_overlap', runId: claim.waitingOnRunId ?? null },
          });
        }
        throw new CollabError('conflict', 'this loop is being fired right now; try again in a moment', {
          details: { reason: 'loop_run_locked' },
        });
      }
      const runId = claim.runId as string;
      // A replayed claim (same clientMutationId) comes back with the run that
      // already launched: firing it again replays the spawn's own ledger (same
      // key), so this stays a single run either way.
      const loopClaims = executor.claimsForLoop(loop, loop.actAsIdentity);
      try {
        const launched = await executor.fire(loop, loopClaims, now, runId);
        await recordLoopLaunch(db, claims, runId, launched);
        if (loop.action === 'dispatch') await settleLoopRun(db, claims, runId, 'completed', null);
      } catch (error) {
        const message = errorText(error);
        await recordLoopLaunchFailure(db, claims, runId, message, now).catch(() => undefined);
        throw toCollabError(error);
      }
      const result: LoopRunResult = { run: await readRun(claims, runId, false) };
      return result;
    },

    'loops.runs.list': async (ctx) => {
      const loopId = requireUuidParam(ctx, 'loopId');
      const status = statusFilter(ctx.query.get('status'));
      const limit = limitOf(ctx.query.get('limit'));
      const cursor = ctx.query.get('cursor');
      const claims = claimsFor(await deps.owner(), ctx);
      return db.tx(claims, async (q) => {
        const [loop] = await q.query<{ id: string }>(
          `select e.id from public.entities e where e.id = $1 and e.kind = 'loop' and e.deleted_at is null and internal.entity_readable(e.id)`,
          [loopId],
        );
        if (!loop) throw new CollabError('not_found', 'loop not found', { details: { loopId } });
        return listLoopRuns(q, { loopId, status, limit, cursor });
      });
    },

    'loops.runs.get': async (ctx) => {
      const runId = requireUuidParam(ctx, 'runId');
      const claims = claimsFor(await deps.owner(), ctx);
      return readRun(claims, runId, true);
    },

    'loops.runs.stop': async (ctx) => {
      const input = { ...LoopRunStopInputSchema.parse(ctx.body), runId: routeId(ctx, 'runId') };
      const claims = claimsFor(await deps.owner(), ctx, commandEnvelope(ctx));
      const run = await readRun(claims, input.runId, false);
      if (run.status !== 'running') {
        throw new CollabError('conflict', `the run is ${run.status}, not running`, {
          details: { reason: 'loop_run_not_running', status: run.status },
        });
      }
      if (run.sessionId === null) {
        throw new CollabError('conflict', 'the run has not launched its session yet; try again in a moment', {
          details: { reason: 'loop_run_launching' },
        });
      }
      const executor = requireExecutor('Stopping a run');
      await executor.stopSession(claims, run.sessionId, {
        reason: 'stopped through loops.runs.stop',
        endedReason: "Stopped by request from the loop's run history.",
        clientMutationId: input.clientMutationId,
      });
      await settleLoopRun(db, claims, input.runId, 'stopped', null);
      const result: LoopRunResult = { run: await readRun(claims, input.runId, false) };
      return result;
    },
  });
}
