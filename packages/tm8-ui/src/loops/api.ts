import type {
  EntityId,
  LoopAction,
  LoopDefinitionDraft,
  LoopDefinitionPatch,
  LoopRun,
  LoopRunStatus,
  LoopSchedulePreview,
  LoopView,
  OperationName,
  SpaceId,
} from '@tm8/contract';
import type { HttpClient } from '../data/real/http';
import type { Seam } from '../data/seam';

/*
 * THE LOOPS CLIENT — the one place the UI reaches `loops.*`.
 *
 * Every loop surface (the form, the list, the loop page) talks through
 * `LoopsClient`, never through `entities.create`/`entities.patch`: the server
 * owns scheduling (design 01a182d4 §3.1), so nothing here computes a next run
 * or validates a schedule — `schedulePreview` asks the server. The client is
 * a 1:1 mirror of the 13 catalog operations; the types are the contract's.
 */

export type {
  LoopAction,
  LoopConcurrency,
  LoopDefinition,
  LoopDefinitionDraft,
  LoopDefinitionPatch,
  LoopRun,
  LoopRunSkipReason,
  LoopRunStatus,
  LoopRunTrigger,
  LoopSchedulePreview,
  LoopSpawnConfig,
  LoopSpawnMode,
  LoopView,
} from '@tm8/contract';
/** The session modes a spawn loop may carry (the contract's `LoopSpawnMode`). */
export type LoopSessionMode = import('@tm8/contract').LoopSpawnMode;
/** What `loops.create` takes: timezone/config/concurrency/retry/toolInputs have server defaults. */
export type LoopCreateDefinition = LoopDefinitionDraft;

export interface LoopListQuery {
  enabled?: boolean;
  action?: LoopAction;
  words?: string;
  limit?: number;
  cursor?: string;
}

export interface LoopPage<T> { items: T[]; nextCursor: string | null }

export interface LoopsClient {
  create(spaceId: SpaceId, definition: LoopCreateDefinition, enabled?: boolean): Promise<LoopView>;
  update(loop: Pick<LoopView, 'id' | 'version'>, definition: LoopDefinitionPatch): Promise<LoopView>;
  get(loopId: EntityId): Promise<LoopView>;
  list(spaceId: SpaceId, query?: LoopListQuery): Promise<LoopPage<LoopView>>;
  enable(loop: Pick<LoopView, 'id' | 'version'>): Promise<LoopView>;
  disable(loop: Pick<LoopView, 'id' | 'version'>): Promise<LoopView>;
  pause(loop: Pick<LoopView, 'id' | 'version'>, until: string): Promise<LoopView>;
  resume(loop: Pick<LoopView, 'id' | 'version'>): Promise<LoopView>;
  runNow(loopId: EntityId, force?: boolean): Promise<{ run: LoopRun }>;
  runsList(loopId: EntityId, query?: { status?: LoopRunStatus; limit?: number; cursor?: string }): Promise<LoopPage<LoopRun>>;
  runsGet(runId: string): Promise<LoopRun>;
  runsStop(runId: string): Promise<{ run: LoopRun }>;
  schedulePreview(spaceId: SpaceId, schedule: string, timezone?: string, count?: number): Promise<LoopSchedulePreview>;
}

/** All requests go through the operation catalog and the authenticated transport, like `createToolPort`. */
export function createLoopsClient(http: HttpClient): LoopsClient {
  const command = () => ({ clientMutationId: `loop-${crypto.randomUUID()}` });
  const versioned = (loop: Pick<LoopView, 'id' | 'version'>) => ({ ...command(), loopId: loop.id, expectedVersion: loop.version });
  const call = <T>(name: OperationName, options: Parameters<HttpClient['call']>[1]) =>
    http.call<T>(name, options);
  const loopParams = (loop: Pick<LoopView, 'id'>) => ({ params: { loopId: loop.id } });
  return {
    create: (spaceId, definition, enabled = true) =>
      call<LoopView>('loops.create', { params: { spaceId }, body: { ...command(), spaceId, definition, enabled } }),
    update: (loop, definition) =>
      call<LoopView>('loops.update', { ...loopParams(loop), body: { ...versioned(loop), definition } }),
    get: loopId => call<LoopView>('loops.get', { params: { loopId } }),
    list: (spaceId, query = {}) =>
      call<LoopPage<LoopView>>('loops.list', { params: { spaceId }, query: stringQuery(query) }),
    enable: loop => call<LoopView>('loops.enable', { ...loopParams(loop), body: versioned(loop) }),
    disable: loop => call<LoopView>('loops.disable', { ...loopParams(loop), body: versioned(loop) }),
    pause: (loop, until) => call<LoopView>('loops.pause', { ...loopParams(loop), body: { ...versioned(loop), until } }),
    resume: loop => call<LoopView>('loops.resume', { ...loopParams(loop), body: versioned(loop) }),
    runNow: (loopId, force) =>
      call<{ run: LoopRun }>('loops.runNow', { params: { loopId }, body: { ...command(), loopId, ...(force ? { force: true } : {}) } }),
    runsList: (loopId, query = {}) =>
      call<LoopPage<LoopRun>>('loops.runs.list', { params: { loopId }, query: stringQuery(query) }),
    runsGet: runId => call<LoopRun>('loops.runs.get', { params: { runId } }),
    runsStop: runId => call<{ run: LoopRun }>('loops.runs.stop', { params: { runId }, body: { ...command(), runId } }),
    schedulePreview: (spaceId, schedule, timezone, count) =>
      call<LoopSchedulePreview>('loops.schedule.preview', {
        params: { spaceId },
        body: { spaceId, schedule, ...(timezone ? { timezone } : {}), ...(count ? { count } : {}) },
      }),
  };
}

function stringQuery(query: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query) as [string, unknown][]) if (value !== undefined) out[key] = String(value);
  return out;
}

/** The seam's loops client, or null on a surface wired without one (fixtures, a read-only host). */
export function useLoopsClient(seam: Pick<Seam, 'commands'> | null | undefined): LoopsClient | null {
  return seam?.commands.loops ?? null;
}

/**
 * Which form field a server refusal names. `invalid_input` carries a field
 * path (design §4.3) either as `details.path` (string or segments) or, in the
 * facade's zod idiom, as a `path: message` prefix of the message. The
 * `definition.` prefix is dropped so `definition.schedule` → `schedule`, and
 * `definition.toolInputs.<name>` keeps its tail.
 */
export function fieldPathOf(error: unknown): { path: string; message: string } | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, message, details } = error as { code?: unknown; message?: unknown; details?: Record<string, unknown> };
  if (code !== 'invalid_input' || typeof message !== 'string') return null;
  const issues = Array.isArray(details?.issues) ? details.issues as { path?: unknown; message?: unknown }[] : [];
  const raw = details?.path ?? details?.field ?? issues[0]?.path;
  let path: string | null = Array.isArray(raw) ? raw.map(String).join('.') : typeof raw === 'string' ? raw : null;
  let text = typeof issues[0]?.message === 'string' && details?.path === undefined ? issues[0].message : message;
  if (path === null) {
    const match = /^((?:body\.)?(?:definition\.)?[A-Za-z][\w.]*): (.+)$/s.exec(message);
    if (!match) return null;
    path = match[1]!;
    text = match[2]!;
  }
  path = path.replace(/^body\./, '').replace(/^definition\./, '');
  return path === '' ? null : { path, message: text };
}
