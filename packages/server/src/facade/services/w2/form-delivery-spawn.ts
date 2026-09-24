/**
 * Forms W2 — the spawn modes (FORMS-DESIGN §7.3; migration 215): the handlers
 * the delivery core's seam (`dispatchNotLiveDelivery`) calls for a claimed row
 * whose session is not live, or whose target is a new session.
 *
 *   resume       (default) resume the exited session; the drain then injects
 *                the response as its first turn after resume.
 *   spawn_new    spawn a fresh session for the same teammate, working on the
 *                same task(s), with the form_response envelope in its first
 *                turn; the row settles `spawned` with spawned_session_id.
 *   new_session  the TARGET, not a fallback: the same spawn, even when the
 *                requesting session is live, and even when it was deleted.
 *
 * EXACTLY ONE resume or spawn per delivery. The claim (214) already gives one
 * claimer per row; on top of it:
 *   * resume releases its row BEFORE resuming, so the drain-on-live listener
 *     that the resume fires can claim and inject it. A second resumer gets
 *     SpawnError 'conflict', which means "someone else is resuming".
 *   * spawn pins `spawn_mutation_id` and stretches the lease over the spawn
 *     (215 B). A re-claim after a crash replays execution.spawn from the
 *     ledger (same session, no second PTY). A replay that lands on a FAILED
 *     session drops the key, so the next attempt spawns fresh.
 *
 * BOUNDED, WITHOUT SPINNING. A transient failure defers the row (215 D:
 * backoff through a future lease); a permanent SpawnError, or the tenth
 * attempt, settles it `cancelled` with the reason. A session that cannot be
 * resumed is `resume_unavailable`; it is never silently spawned instead —
 * that is the respondent's "Send to a new session" to choose (§7.3).
 *
 * AUTHORITY (coordinator ruling): the server's claims resume and spawn, and
 * the spawned session inherits the REQUESTER's recorded posture, never its
 * parent's or the persona default — it must not exceed what the requester ran.
 */
import { SpawnError, type SessionLaunchPosture, type SpawnRequest } from '@tm8/execution';
import { BYTE_BUDGETS, formSessionInputInjection } from '@tm8/prompt';

import type { DbClaims } from '../../../db/types.js';
import { sessionLaunchPostureFromRecord } from '../../execution-handlers.js';
import type {
  ClaimedFormDelivery,
  NotLiveContext,
  NotLiveHandler,
  NotLiveHandlers,
  NotLiveOutcome,
} from './form-delivery.js';

/** The slice of SpawnService these handlers drive. Faked in tests. */
export interface FormSpawnPort {
  spawn(auth: DbClaims, request: SpawnRequest): Promise<{ sessionId: string; reused: boolean }>;
  resume(auth: DbClaims, request: { sessionId: string; clientMutationId?: string | null }): Promise<unknown>;
}

/** 214's internal.form_delivery_max_attempts(), mirrored. */
export const FORM_DELIVERY_MAX_ATTEMPTS = 10;
/** A 'conflict' (someone else is resuming or spawning) waits this long. */
export const CONFLICT_DEFER_SECONDS = 30;
/** How long a spawn holds its row (215 B): past first-prompt settlement. */
export const SPAWN_HOLD_SECONDS = 900;

/** Codes after which another try cannot succeed. */
const PERMANENT_SPAWN_CODES: ReadonlySet<string> = new Set([
  'invalid_input', 'not_found', 'forbidden', 'not_implemented',
]);

/** 30s, 60s, 120s, 240s, then 300s: the wait before the next try (plus the lease). */
export function backoffSeconds(attemptNo: number): number {
  return Math.min(30 * 2 ** Math.max(attemptNo - 1, 0), 300);
}

export interface SpawnModeHandlerOptions {
  readonly spawner: FormSpawnPort;
}

export function createSpawnModeHandlers(options: SpawnModeHandlerOptions): Required<NotLiveHandlers> {
  const spawn: NotLiveHandler = (row, ctx) => spawnFor(row, ctx, options.spawner);
  return {
    resume: (row, ctx) => resumeFor(row, ctx, options.spawner),
    spawn_new: spawn,
    new_session: spawn,
  };
}

// -- resume ----------------------------------------------------------------------

async function resumeFor(row: ClaimedFormDelivery, ctx: NotLiveContext, spawner: FormSpawnPort): Promise<NotLiveOutcome> {
  // Notices are claimed only while live (214); nothing here resumes for one.
  if (row.kind !== 'response' || !row.responseId) return { kind: 'left_pending', reason: 'queued' };
  const session = await readSession(ctx, row.workSessionId);
  if (!session || session.deleted) return { kind: 'cancelled', reason: 'session_deleted' };

  if (session.status === 'running' || session.status === 'idle') {
    // Live already — an earlier row in this batch, or someone else, resumed it.
    await release(ctx, row, 'session_live');
    await ctx.drainSession(row.workSessionId);
    return { kind: 'handled', reason: 'session_live' };
  }
  if (session.status !== 'exited' && session.status !== 'failed') {
    await defer(ctx, row, `session_${session.status}`, CONFLICT_DEFER_SECONDS);
    return { kind: 'handled', reason: `session_${session.status}` };
  }

  // Release FIRST: resume fires drain-on-live, and a row we still held would
  // be skipped by it and wait for the tick.
  await release(ctx, row, 'resuming');
  try {
    await spawner.resume(ctx.claims, { sessionId: row.workSessionId });
  } catch (error) {
    const code = spawnErrorCode(error);
    if (code === 'conflict') {
      await defer(ctx, row, `resume_conflict: ${describe(error)}`, CONFLICT_DEFER_SECONDS);
      return { kind: 'handled', reason: 'resume_conflict' };
    }
    if (code && PERMANENT_SPAWN_CODES.has(code)) {
      return { kind: 'cancelled', reason: `resume_unavailable: ${describe(error)}` };
    }
    return failTransient(ctx, row, `resume_failed: ${describe(error)}`, false);
  }
  // The first turn after resume: the ordinary live injection, under the claim.
  await ctx.drainSession(row.workSessionId);
  return { kind: 'handled', reason: 'resumed' };
}

// -- spawn_new / new_session -------------------------------------------------------

interface SpawnFacts {
  mutationId: string;
  message: {
    id: string;
    batchId: string;
    body: string;
    senderActorId: string;
    senderActorKind: string;
    sourceMessageId: string;
  };
  posture: Parameters<typeof sessionLaunchPostureFromRecord>[0] | null;
  spaceId: string;
  sessionDeleted: boolean;
  teamMemberId: string | null;
  parentSessionId: string | null;
  projectId: string | null;
  taskIds: string[];
  workdirMode: string | null;
  baseRef: string | null;
  mode: string | null;
  model: string | null;
  agentTool: string | null;
  title: string;
}

async function spawnFor(row: ClaimedFormDelivery, ctx: NotLiveContext, spawner: FormSpawnPort): Promise<NotLiveOutcome> {
  if (row.kind !== 'response' || !row.responseId) return { kind: 'left_pending', reason: 'queued' };
  const facts = await ctx.db.rpc<SpawnFacts | null>(ctx.claims, 'public.begin_form_delivery_spawn', [
    row.responseId, row.workSessionId, row.attemptNo, SPAWN_HOLD_SECONDS,
  ]);
  // Our claim lapsed and another drain holds the row: it is theirs to spawn.
  if (!facts) return { kind: 'handled', reason: 'claim_lost' };
  if (!facts.teamMemberId) return { kind: 'cancelled', reason: 'spawn_failed: the teammate is gone' };
  if (!facts.posture) return { kind: 'cancelled', reason: 'spawn_failed: the requesting session recorded no launch posture' };

  const request = spawnRequestFor(row, facts, sessionLaunchPostureFromRecord(facts.posture));
  let spawned: { sessionId: string; reused: boolean };
  try {
    spawned = await spawner.spawn(ctx.claims, request);
  } catch (error) {
    const code = spawnErrorCode(error);
    if (code === 'conflict') {
      await defer(ctx, row, `spawn_conflict: ${describe(error)}`, CONFLICT_DEFER_SECONDS, true);
      return { kind: 'handled', reason: 'spawn_conflict' };
    }
    if (code && PERMANENT_SPAWN_CODES.has(code)) {
      return { kind: 'cancelled', reason: `spawn_failed: ${describe(error)}` };
    }
    // The spawn under this key failed; replaying it would replay the failure.
    return failTransient(ctx, row, `spawn_failed: ${describe(error)}`, true);
  }

  if (spawned.reused) {
    // A ledger replay: the spawn under this key happened before (a crash, or a
    // drain whose lease lapsed). spawn() returning means nothing about THAT
    // run's first turn, so ask the session.
    const session = await readSession(ctx, spawned.sessionId);
    const status = session?.status ?? 'missing';
    if (status === 'spawning') {
      await defer(ctx, row, 'spawn_in_flight', CONFLICT_DEFER_SECONDS);
      return { kind: 'handled', reason: 'spawn_in_flight' };
    }
    // `exited` only follows `running`, which is written after the first turn
    // settled delivered. `failed` (or gone) never got there: spawn afresh.
    if (status !== 'running' && status !== 'idle' && status !== 'exited') {
      return failTransient(ctx, row, `spawn_replayed_${status}`, true);
    }
  }

  await ctx.db.rpc(ctx.claims, 'public.settle_form_delivery_spawned', [
    row.responseId, row.workSessionId, spawned.sessionId,
  ]);
  return { kind: 'spawned', spawnedSessionId: spawned.sessionId };
}

/** The requester's launch, replayed for a new session (advisor Q2). */
export function spawnRequestFor(row: ClaimedFormDelivery, facts: SpawnFacts, posture: SessionLaunchPosture): SpawnRequest {
  const workdirMode = facts.workdirMode === 'worktree' || facts.workdirMode === 'project' || facts.workdirMode === 'scratch'
    ? facts.workdirMode
    : undefined;
  return {
    spaceId: facts.spaceId,
    teamMemberId: facts.teamMemberId!,
    parentSessionId: facts.parentSessionId,
    projectId: facts.projectId,
    taskIds: facts.taskIds,
    ...(workdirMode ? { workdir: { mode: workdirMode, baseRef: facts.baseRef } } : {}),
    mode: (facts.mode as SpawnRequest['mode']) ?? null,
    model: facts.model,
    agentTool: facts.agentTool,
    reasoningEffort: null,
    // Not asked for: inherited, below, from the requester's recorded posture.
    accessMode: null,
    inheritPosture: posture,
    title: facts.title ? `${facts.title} · form response` : 'Form response',
    promptExtra: null,
    clientMutationId: facts.mutationId,
    firstTurnAppendix: (sessionId, maxBytes) => formSessionInputInjection({
      kind: 'form_response',
      messageId: facts.message.id,
      messageBatchId: facts.message.batchId,
      deliveryAttemptId: facts.mutationId,
      deliveryAttemptNo: row.attemptNo,
      senderActorId: facts.message.senderActorId,
      senderActorKind: facts.message.senderActorKind,
      destinationSessionId: sessionId,
      formId: row.formId,
      formStatus: row.form.status,
      structureVersion: row.form.structureVersion,
      sourceMessageId: facts.message.sourceMessageId,
      ...(row.response
        ? {
            response: {
              id: row.responseId!,
              submittedAt: row.response.submittedAt,
              answered: row.response.answered,
              of: row.response.total,
              revision: row.response.revision,
              supersedesId: row.response.supersedesId,
            },
          }
        : {}),
      body: facts.message.body,
      // What the task turn left, never more than one injection's ceiling: a
      // large task turn cuts the ENVELOPE body (the fetch pointer survives).
      maxBytes: Math.min(maxBytes, BYTE_BUDGETS.incomingMessageInjection),
      transport: 'spawn_initial_turn',
    }),
  };
}

// -- shared ------------------------------------------------------------------------

async function failTransient(
  ctx: NotLiveContext,
  row: ClaimedFormDelivery,
  error: string,
  forgetSpawn: boolean,
): Promise<NotLiveOutcome> {
  if (row.attemptNo >= FORM_DELIVERY_MAX_ATTEMPTS) return { kind: 'cancelled', reason: error };
  await defer(ctx, row, error, backoffSeconds(row.attemptNo), forgetSpawn);
  return { kind: 'handled', reason: error };
}

async function readSession(
  ctx: NotLiveContext,
  sessionId: string,
): Promise<{ status: string; deleted: boolean } | null> {
  const rows = await ctx.db.query<{ status: string; deleted: boolean }>(
    ctx.claims,
    `select ws.status, e.deleted_at is not null as deleted
       from public.work_sessions ws join public.entities e on e.id = ws.entity_id
      where ws.entity_id = $1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

async function release(ctx: NotLiveContext, row: ClaimedFormDelivery, reason: string): Promise<void> {
  await ctx.db.rpc(ctx.claims, 'public.release_form_delivery', [
    row.kind, row.responseId, row.workSessionId, reason, false,
  ]);
}

async function defer(
  ctx: NotLiveContext,
  row: ClaimedFormDelivery,
  error: string,
  seconds: number,
  forgetSpawn = false,
): Promise<void> {
  await ctx.db.rpc(ctx.claims, 'public.defer_form_delivery', [
    row.responseId, row.workSessionId, error.slice(0, 200), seconds, forgetSpawn,
  ]);
}

function spawnErrorCode(error: unknown): string | null {
  if (error instanceof SpawnError) return error.code;
  // A port from another realm (or a fake) may carry the code without the class.
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
