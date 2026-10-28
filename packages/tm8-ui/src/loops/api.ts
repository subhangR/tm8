import type {
  ActorSummary,
  EntityId,
  LaunchAccessMode,
  LaunchCredentialSource,
  LaunchReasoningEffort,
  OperationName,
  ProjectId,
  SpaceId,
  WorkSessionWorkdirMode,
} from '@tm8/contract';
import type { HttpClient } from '../data/real/http';
import type { Seam } from '../data/seam';

/*
 * THE LOOPS CLIENT — the one place the UI reaches `loops.*`.
 *
 * Every loop surface (the form, the list, the loop page) talks through
 * `LoopsClient`, never through `entities.create`/`entities.patch`: the server
 * owns scheduling (design 01a182d4 §3.1), so nothing here computes a next run
 * or validates a schedule — `schedulePreview` asks the server.
 *
 * TYPES: mirrored from design §4.2 until PR1's contract commit lands
 * (packages/contract/src/loops.ts); on that rebase this block becomes a
 * re-export and nothing that imports from `./api` changes.
 */

export type LoopAction = 'spawn' | 'dispatch' | 'tool';
export type LoopConcurrency = 'skip' | 'queue';
export type LoopRunTrigger = 'schedule' | 'manual';
export type LoopRunStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'stopped' | 'timed_out';
export type LoopRunSkipReason = 'overlap' | 'paused' | 'schedule_invalid';
export type LoopSessionMode = 'worker' | 'coordinator' | 'coordinated-worker' | 'coordinated-coordinator';
type ActorRef = ActorSummary;

export interface LoopSpawnConfig {
  model?: string | null;
  agentTool?: string | null;
  reasoningEffort?: LaunchReasoningEffort | null;
  accessMode?: LaunchAccessMode | null;
  mode?: LoopSessionMode | null;
  projectId?: ProjectId | null;
  workdir?: { mode: WorkSessionWorkdirMode; baseRef?: string | null } | null;
  memoryIds?: EntityId[];
  credentialSource?: LaunchCredentialSource | null;
  interactionProfileId?: EntityId | null;
}

export interface LoopDefinition {
  title: string;
  schedule: string;
  timezone: string;
  action: LoopAction;
  teamMemberId: EntityId | null;
  subjectId: EntityId | null;
  toolId: EntityId | null;
  toolInputs: Record<string, unknown>;
  prompt: string;
  config: LoopSpawnConfig;
  concurrency: LoopConcurrency;
  maxRuntimeSeconds: number | null;
  retry: { attempts: number; delaySeconds: number };
}

export interface LoopSchedulePreview {
  valid: boolean;
  problem: string | null;
  summary: string;
  next: string[];
}

export interface LoopRun {
  id: string; loopId: EntityId; spaceId: SpaceId;
  firedAt: string; trigger: LoopRunTrigger; requestedBy: ActorRef | null;
  action: LoopAction; attempt: number;
  status: LoopRunStatus; skipReason: LoopRunSkipReason | null; error: string | null;
  taskId: EntityId | null; sessionId: EntityId | null;
  startedAt: string | null; endedAt: string | null; durationMs: number | null;
  exitCode: number | null; outputTail: string | null;
  actedAs: ActorRef | null;
  endedKind: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null; source: 'harness' | null } | null;
}

export interface LoopView {
  id: EntityId; spaceId: SpaceId; version: number;
  definition: LoopDefinition;
  schedule: LoopSchedulePreview;
  state: {
    enabled: boolean; pausedUntil: string | null;
    nextRunAt: string | null; lastRunAt: string | null; lastError: string | null;
    armedBy: ActorRef | null; armedAt: string | null;
    actingAs: { identity: ActorRef | null; via: 'armer' | 'fallback' | 'none' };
    waitingOnRunId: string | null;
  };
  runs: {
    total: number; last: LoopRun | null;
    last24h: { fired: number; failed: number; skipped: number };
    usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  };
  createdBy: ActorRef; createdAt: string; updatedAt: string;
  capabilities: { canEdit: boolean; canControl: boolean; canRun: boolean; canDelete: boolean };
}

/** What `loops.create` takes: timezone/config/concurrency/retry/toolInputs have server defaults. */
export type LoopCreateDefinition =
  Omit<LoopDefinition, 'timezone' | 'config' | 'concurrency' | 'retry' | 'toolInputs'>
  & Partial<Pick<LoopDefinition, 'timezone' | 'config' | 'concurrency' | 'retry' | 'toolInputs'>>;

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
  update(loop: Pick<LoopView, 'id' | 'version'>, definition: Partial<LoopDefinition>): Promise<LoopView>;
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
  /* The `loops.*` names join `OperationName` with PR1's catalog rows; the
     cast keeps this file compiling on a base that predates them. */
  const call = <T>(name: string, options: Parameters<HttpClient['call']>[1]) =>
    http.call<T>(name as OperationName, options);
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
