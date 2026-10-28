import {
  CollabError, decodeCursor, encodeCursor, LOOP_PAUSE_MAX_DAYS, LOOP_PREVIEW_DEFAULT_COUNT,
  LoopCreateInputSchema, LoopUpdateInputSchema, LoopEnableInputSchema, LoopPauseInputSchema,
  LoopSchedulePreviewInputSchema, type LoopAction,
} from '@tm8/contract';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { claimsFor, commandEnvelope, requireUuidParam, limitOf } from '../facade/context.js';
import type { Querier } from '../db/types.js';
import type { RequestContext } from '../http/types.js';
import { previewSchedule } from '../scheduler/schedule.js';
import { listLoopViews, loadLoopView } from './views.js';
import { assertToolPersona, requireSpawnConfig, requireValidSchedule, scheduleWrite, type ScheduleState } from './write.js';
import { registerLoopRunHandlers, type LoopRunHandlerDeps } from './run-handlers.js';

/** What the composition root hands the loops family beyond FacadeDeps (PR2: the executor port). */
export type LoopHandlerDeps = LoopRunHandlerDeps;

/** The route names the target; a repeated body ID must agree with it. */
function loopRouteId(ctx: RequestContext, field: 'spaceId' | 'loopId'): string {
  const id = requireUuidParam(ctx, field);
  const bodyId = (ctx.body as Record<string, unknown> | undefined)?.[field];
  if (bodyId !== undefined && bodyId !== id) {
    throw new CollabError('invalid_input', `body ${field} does not match route`);
  }
  return id;
}

async function currentSchedule(q: Querier, loopId: string): Promise<ScheduleState> {
  const [row] = await q.query<ScheduleState>(
    `select l.schedule, l.timezone, l.enabled from public.loops l join public.entities e on e.id = l.entity_id
      where l.entity_id = $1 and e.deleted_at is null and internal.entity_readable(e.id)`, [loopId]);
  if (!row) throw new CollabError('not_found', 'Loop is unavailable');
  return row;
}

/** update_loop (378) in named form; every argument this module does not name stays at its default. */
interface LoopPatch {
  title?: string | null; schedule?: string | null;
  teamMemberId?: string | null; clearTeamMember?: boolean;
  subjectId?: string | null; clearSubject?: boolean;
  prompt?: string | null; config?: unknown; enabled?: boolean | null;
  nextRunAt?: string | null; clearNextRunAt?: boolean; lastError?: string | null; clearLastError?: boolean;
  action?: LoopAction | null; toolId?: string | null; clearTool?: boolean; toolInputs?: unknown;
  timezone?: string | null; pausedUntil?: string | null; clearPausedUntil?: boolean;
  concurrency?: string | null; maxRuntimeSeconds?: number | null; clearMaxRuntime?: boolean;
  retryAttempts?: number | null; retryDelaySeconds?: number | null;
}

async function updateLoop(q: Querier, loopId: string, expectedVersion: number, actorId: string | null,
  clientMutationId: string, patch: LoopPatch): Promise<void> {
  await q.rpc('update_loop', [
    loopId, expectedVersion, actorId,
    patch.title ?? null, patch.schedule ?? null,
    patch.teamMemberId ?? null, patch.clearTeamMember ?? false,
    patch.subjectId ?? null, patch.clearSubject ?? false,
    patch.prompt ?? null, patch.config === undefined ? null : JSON.stringify(patch.config),
    patch.enabled ?? null,
    patch.nextRunAt ?? null, patch.clearNextRunAt ?? false,
    null, patch.lastError ?? null, patch.clearLastError ?? false,
    clientMutationId,
    patch.action ?? null, patch.toolId ?? null, patch.clearTool ?? false,
    patch.toolInputs === undefined ? null : JSON.stringify(patch.toolInputs),
    patch.timezone ?? null, patch.pausedUntil ?? null, patch.clearPausedUntil ?? false,
    patch.concurrency ?? null, patch.maxRuntimeSeconds ?? null, patch.clearMaxRuntime ?? false,
    patch.retryAttempts ?? null, patch.retryDelaySeconds ?? null, null,
  ]);
}

/** A recomputed deadline as update_loop arguments; undefined fields leave the row alone. */
function deadlinePatch(before: ScheduleState, after: ScheduleState): LoopPatch {
  const write = scheduleWrite(before, after);
  if (write.nextRunAt === undefined) return {};
  return {
    nextRunAt: write.nextRunAt, clearNextRunAt: write.nextRunAt === null,
    ...(write.lastError ? { lastError: write.lastError } : {}),
  };
}

export function registerLoopHandlers(registry: HandlerRegistry, deps: FacadeDeps, loops: LoopHandlerDeps = {}): void {
  const command = async <T>(ctx: RequestContext, work: (q: Querier) => Promise<T>) =>
    deps.db.tx(claimsFor(await deps.owner(), ctx, commandEnvelope(ctx)), work);
  const read = async <T>(ctx: RequestContext, work: (q: Querier) => Promise<T>) =>
    deps.db.tx(claimsFor(await deps.owner(), ctx), work);

  /** The four control commands share one shape: load, patch, return the view. */
  const control = (patchOf: (input: { until?: string }, current: ScheduleState) => LoopPatch, schema = LoopEnableInputSchema) =>
    async (ctx: RequestContext) => {
      const input = schema.parse(ctx.body) as { expectedVersion: number; clientMutationId: string; actorId?: string; until?: string };
      const loopId = loopRouteId(ctx, 'loopId');
      return command(ctx, async q => {
        const current = await currentSchedule(q, loopId);
        await updateLoop(q, loopId, input.expectedVersion, input.actorId ?? null, input.clientMutationId, patchOf(input, current));
        return loadLoopView(q, loopId);
      });
    };

  registry.registerAll({
    'loops.create': async ctx => {
      const input = LoopCreateInputSchema.parse(ctx.body);
      const spaceId = loopRouteId(ctx, 'spaceId');
      const d = input.definition;
      const timezone = d.timezone ?? 'UTC';
      const enabled = input.enabled ?? true;
      requireValidSchedule(d.schedule, timezone);
      const config = requireSpawnConfig(d.config ?? {});
      const write = scheduleWrite(null, { schedule: d.schedule, timezone, enabled });
      return command(ctx, async q => {
        const result = await q.rpc<{ entity: { id: string } }>('create_loop', [
          spaceId, d.title, input.actorId ?? null, d.schedule,
          d.teamMemberId ?? null, d.subjectId ?? null, d.prompt ?? '', JSON.stringify(config),
          enabled, write.nextRunAt ?? null, null, null, input.clientMutationId,
          d.action, d.toolId ?? null, JSON.stringify(d.toolInputs ?? {}), timezone,
          d.concurrency ?? 'skip', d.maxRuntimeSeconds ?? null,
          d.retry?.attempts ?? 0, d.retry?.delaySeconds ?? 300,
        ]);
        await assertToolPersona(q, result.entity.id);
        return loadLoopView(q, result.entity.id);
      });
    },
    'loops.update': async ctx => {
      const input = LoopUpdateInputSchema.parse(ctx.body);
      const loopId = loopRouteId(ctx, 'loopId');
      const d = input.definition;
      const config = d.config === undefined ? undefined : requireSpawnConfig(d.config);
      return command(ctx, async q => {
        const current = await currentSchedule(q, loopId);
        const after = { schedule: d.schedule ?? current.schedule, timezone: d.timezone ?? current.timezone, enabled: current.enabled };
        requireValidSchedule(after.schedule, after.timezone);
        await updateLoop(q, loopId, input.expectedVersion, input.actorId ?? null, input.clientMutationId, {
          title: d.title, schedule: d.schedule, timezone: d.timezone, action: d.action,
          teamMemberId: d.teamMemberId, clearTeamMember: d.teamMemberId === null,
          subjectId: d.subjectId, clearSubject: d.subjectId === null,
          toolId: d.toolId, clearTool: d.toolId === null, toolInputs: d.toolInputs,
          prompt: d.prompt, config, concurrency: d.concurrency,
          maxRuntimeSeconds: d.maxRuntimeSeconds, clearMaxRuntime: d.maxRuntimeSeconds === null,
          retryAttempts: d.retry?.attempts, retryDelaySeconds: d.retry?.delaySeconds,
          ...deadlinePatch(current, after),
        });
        await assertToolPersona(q, loopId);
        return loadLoopView(q, loopId);
      });
    },
    'loops.get': async ctx => read(ctx, q => loadLoopView(q, requireUuidParam(ctx, 'loopId'))),
    'loops.list': async ctx => {
      const spaceId = requireUuidParam(ctx, 'spaceId'), limit = limitOf(ctx.query.get('limit'));
      const words = ctx.query.get('words') ?? '';
      const enabledParam = ctx.query.get('enabled');
      if (enabledParam !== null && enabledParam !== 'true' && enabledParam !== 'false') {
        throw new CollabError('invalid_input', 'enabled must be true or false');
      }
      const actionParam = ctx.query.get('action');
      if (actionParam !== null && !['spawn', 'dispatch', 'tool'].includes(actionParam)) {
        throw new CollabError('invalid_input', 'action must be spawn, dispatch or tool');
      }
      const enabled = enabledParam === null ? null : enabledParam === 'true';
      const action = actionParam as LoopAction | null;
      const cursor = ctx.query.get('cursor');
      const keys = cursor ? decodeCursor(cursor).k : [spaceId, words, enabledParam, action, null];
      if (keys.length !== 5 || keys[0] !== spaceId || keys[1] !== words || keys[2] !== enabledParam || keys[3] !== action
        || (keys[4] !== null && typeof keys[4] !== 'string')) {
        throw new CollabError('invalid_cursor', 'Invalid loop cursor');
      }
      return read(ctx, async q => {
        const rows = await listLoopViews(q, { spaceId, enabled, action, words, afterId: keys[4] as string | null, limit });
        const page = rows.slice(0, limit);
        return { items: page, nextCursor: rows.length > limit ? encodeCursor([spaceId, words, enabledParam, action, page.at(-1)!.id]) : null };
      });
    },
    // §3.1: enable recomputes from now, so a loop disabled for a week does not fire the instant it returns.
    'loops.enable': control((_input, current) => ({ enabled: true, ...deadlinePatch(current, { ...current, enabled: true }) })),
    // Disable keeps next_run_at for reporting; the due read ignores a disabled loop.
    'loops.disable': control(() => ({ enabled: false })),
    // A pause does not stop the clock (§3.2): a deadline missed while paused fires once when it ends.
    'loops.pause': control((input) => {
      const until = new Date(input.until!);
      const now = Date.now();
      if (until.getTime() <= now) {
        throw new CollabError('invalid_input', 'until must be in the future', { details: { path: 'until' } });
      }
      if (until.getTime() > now + LOOP_PAUSE_MAX_DAYS * 24 * 60 * 60_000) {
        throw new CollabError('invalid_input', `until must be within ${LOOP_PAUSE_MAX_DAYS} days`, { details: { path: 'until' } });
      }
      return { pausedUntil: until.toISOString() };
    }, LoopPauseInputSchema),
    'loops.resume': control(() => ({ clearPausedUntil: true })),
    'loops.schedule.preview': async ctx => {
      const input = LoopSchedulePreviewInputSchema.parse(ctx.body);
      const spaceId = loopRouteId(ctx, 'spaceId');
      return read(ctx, async q => {
        const [row] = await q.query<{ member: string | null }>('select internal.current_member_id($1::uuid) as member', [spaceId]);
        if (!row?.member) throw new CollabError('forbidden', 'Only a member of this Space can preview its schedules');
        return previewSchedule(input.schedule, input.timezone ?? 'UTC', input.count ?? LOOP_PREVIEW_DEFAULT_COUNT);
      });
    },
  });
  // PR2: runNow and runs.* (loops/run-handlers.ts), sharing the scheduler's executor port.
  registerLoopRunHandlers(registry, deps, loops);
}
