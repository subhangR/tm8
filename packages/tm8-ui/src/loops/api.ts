import type {
  EntityId,
  LoopAction,
  LoopDefinitionDraft,
  LoopDefinitionPatch,
  LoopListResult,
  LoopRunListResult,
  LoopRunResult,
  LoopRun,
  LoopRunStatus,
  LoopSchedulePreview,
  LoopView,
  OperationName,
  SpaceId,
} from '@tm8/contract';
import { nextMutationId } from '../authoring/commands';
import type { HttpClient } from '../data/real/http';

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
  LoopListResult,
  LoopRun,
  LoopRunListResult,
  LoopRunResult,
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

/** `loops.list`'s query string (the server reads exactly these keys). */
export type LoopListQuery = {
  enabled?: boolean;
  action?: LoopAction;
  words?: string;
  limit?: number;
  cursor?: string;
};

/** `loops.runs.list`'s query string. */
export type LoopRunListQuery = { status?: LoopRunStatus; limit?: number; cursor?: string };

/**
 * A command's idempotency key. The doors replay a recorded result for a key
 * they have seen, so a caller that may RETRY one intent (a lost response, a
 * conflict re-read) passes the same key each time; omitted, each call mints
 * its own.
 */
export interface LoopCommandOptions { clientMutationId?: string }

export interface LoopsClient {
  create(spaceId: SpaceId, definition: LoopCreateDefinition, enabled?: boolean, options?: LoopCommandOptions): Promise<LoopView>;
  update(loop: Pick<LoopView, 'id' | 'version'>, definition: LoopDefinitionPatch, options?: LoopCommandOptions): Promise<LoopView>;
  get(loopId: EntityId): Promise<LoopView>;
  list(spaceId: SpaceId, query?: LoopListQuery): Promise<LoopListResult>;
  enable(loop: Pick<LoopView, 'id' | 'version'>, options?: LoopCommandOptions): Promise<LoopView>;
  disable(loop: Pick<LoopView, 'id' | 'version'>, options?: LoopCommandOptions): Promise<LoopView>;
  pause(loop: Pick<LoopView, 'id' | 'version'>, until: string, options?: LoopCommandOptions): Promise<LoopView>;
  resume(loop: Pick<LoopView, 'id' | 'version'>, options?: LoopCommandOptions): Promise<LoopView>;
  runNow(loopId: EntityId, force?: boolean, options?: LoopCommandOptions): Promise<LoopRunResult>;
  runsList(loopId: EntityId, query?: LoopRunListQuery): Promise<LoopRunListResult>;
  runsGet(runId: string): Promise<LoopRun>;
  runsStop(runId: string, options?: LoopCommandOptions): Promise<LoopRunResult>;
  schedulePreview(spaceId: SpaceId, schedule: string, timezone?: string, count?: number): Promise<LoopSchedulePreview>;
}

/** All requests go through the operation catalog and the authenticated transport, like `createToolPort`. */
export function createLoopsClient(http: HttpClient): LoopsClient {
  const command = (options?: LoopCommandOptions) => ({ clientMutationId: options?.clientMutationId ?? nextMutationId() });
  const versioned = (loop: Pick<LoopView, 'id' | 'version'>, options?: LoopCommandOptions) =>
    ({ ...command(options), loopId: loop.id, expectedVersion: loop.version });
  const call = <T>(name: OperationName, options: Parameters<HttpClient['call']>[1]) =>
    http.call<T>(name, options);
  const loopParams = (loop: Pick<LoopView, 'id'>) => ({ params: { loopId: loop.id } });
  return {
    create: (spaceId, definition, enabled = true, options) =>
      call<LoopView>('loops.create', { params: { spaceId }, body: { ...command(options), spaceId, definition, enabled } }),
    update: (loop, definition, options) =>
      call<LoopView>('loops.update', { ...loopParams(loop), body: { ...versioned(loop, options), definition } }),
    get: loopId => call<LoopView>('loops.get', { params: { loopId } }),
    list: (spaceId, query = {}) => call<LoopListResult>('loops.list', { params: { spaceId }, query }),
    enable: (loop, options) => call<LoopView>('loops.enable', { ...loopParams(loop), body: versioned(loop, options) }),
    disable: (loop, options) => call<LoopView>('loops.disable', { ...loopParams(loop), body: versioned(loop, options) }),
    pause: (loop, until, options) => call<LoopView>('loops.pause', { ...loopParams(loop), body: { ...versioned(loop, options), until } }),
    resume: (loop, options) => call<LoopView>('loops.resume', { ...loopParams(loop), body: versioned(loop, options) }),
    runNow: (loopId, force, options) =>
      call<LoopRunResult>('loops.runNow', { params: { loopId }, body: { ...command(options), loopId, ...(force ? { force: true } : {}) } }),
    runsList: (loopId, query = {}) => call<LoopRunListResult>('loops.runs.list', { params: { loopId }, query }),
    runsGet: runId => call<LoopRun>('loops.runs.get', { params: { runId } }),
    runsStop: (runId, options) => call<LoopRunResult>('loops.runs.stop', { params: { runId }, body: { ...command(options), runId } }),
    schedulePreview: (spaceId, schedule, timezone, count) =>
      call<LoopSchedulePreview>('loops.schedule.preview', {
        params: { spaceId },
        body: { spaceId, schedule, ...(timezone ? { timezone } : {}), ...(count ? { count } : {}) },
      }),
  };
}

/** A refusal because the loop moved since it was read — an edit by someone else, or just a firing. */
export function isVersionConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'version_conflict';
}

/**
 * Which form field a server refusal names. `invalid_input` carries a field
 * path (design §4.3) either as `details.path` (string or segments) or, in the
 * facade's zod idiom, as a `path: message` prefix of the message. The
 * `definition.` prefix is dropped so `definition.schedule` → `schedule`, and
 * `definition.toolInputs.<name>` keeps its tail. The loops doors also repeat
 * the path at the head of the message (`schedule: cron needs 5 fields`); the
 * field already names it, so that head is dropped from the text.
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
  const full = path;
  path = path.replace(/^body\./, '').replace(/^definition\./, '');
  const head = [full, `definition.${path}`, path].find(prefix => prefix !== '' && text.startsWith(`${prefix}: `));
  if (head) text = text.slice(head.length + 2);
  return path === '' ? null : { path, message: text };
}
