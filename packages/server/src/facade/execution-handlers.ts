/**
 * The execution.* handler family (R16) — where the graph meets the terminal.
 *
 * This file is the ONLY place in the server that knows both `Db` and
 * `PtyHostService`. `@tm8/execution` deliberately has no database driver, so the
 * SQL for the spawn loop lives here, behind the `GraphPort` interface that
 * package declares. That is not ceremony: it is what lets SpawnService's real
 * tests — the ones that assert on PTY bytes — run against a fake graph with no
 * Postgres at all, which is the only way the `execution.prompt` seam gets an
 * honest oracle (see below).
 *
 * Every write goes through one of Cygnus's 007 RPCs. None of them is a
 * convenience wrapper around an UPDATE: `execution_spawn` creates the
 * work_session row and its `working_on` edges in one transaction,
 * `work_session_transition` is R29's SINGLE WRITER of status (the table trigger
 * refuses any other path), and `record_execution_command` is the audit row for
 * prompt/terminate. A hand-rolled INSERT that appears to work would silently
 * skip the command ledger, the event-capture trigger and the F1/F2 guards.
 */

import {
  NODE_BOOT_ID,
  SpawnError,
  SpawnService,
  PtyHostService,
  PromptSettlementWaiter,
  type CreateWorkSessionInput,
  type CreateWorkSessionResult,
  type GraphAuth,
  type GraphPort,
  type LoadSpawnContextInput,
  type Logger,
  type PtyExitInfo,
  type PtySessionStatus,
  type RecordCommandInput,
  type ResolvedInteractionProfileContext,
  type SpawnContext,
  type SpawnRequest,
  type Tm8Manifest,
  type TransitionInput,
  type WorkSessionStatus,
} from '@tm8/execution';
import { CollabError } from '@tm8/contract';
import type {
  ExecutionLiveness,
  ExecutionPromptInput,
  ExecutionSpawnInput,
  ExecutionStreamsAttachInput,
  ExecutionTerminateInput,
} from '@tm8/contract';
import type { Db, DbClaims } from '../db/types.js';
import type { ServerConfig } from '../http/config.js';
import { fail } from '../http/errors.js';
import type { RequestContext } from '../http/types.js';
import { json } from '../http/types.js';
import { claimsFor, commandEnvelope, requireUuidParam } from './context.js';
import { toCommandResult, type RpcCommandResult } from './handlers/entities.js';
import { createLoopbackOwnerResolver, type LoopbackOwner } from '../identity/loopback.js';
import type { HandlerRegistry } from './registry.js';
import { refusePublicExecutionPrompt } from './services/w2/execution.js';
import {
  recordInteractionProfilePin as persistInteractionProfilePin,
  resolveInteractionProfileForLaunch,
} from '../profiles/w2-profile-resolver.js';

// Claims come from ./context.ts, deliberately NOT from a local helper.
//
// This file used to build its own, and it was wrong in two ways that both
// present as authorization bugs rather than as claims bugs:
//   - it read `identityId` off the request instead of the resolved loopback
//     owner, so the auto-owner path could bind nothing at all;
//   - it bound `actorId` on EVERY transaction. A member row belongs to ONE
//     space, so a globally-bound actor from space A used on a request touching
//     space B fails `can_act_as` and raises 42501 for the space's own owner
//     (context.ts's header documents exactly this). The actor must be left
//     unset so `internal.resolve_actor` can pick the correct per-space member
//     row itself.
// A second claims path is how two handlers disagree about who the caller is.

// --- the graph, over Db ------------------------------------------------------

interface ProjectRow {
  id: string;
  name: string;
  working_dir: string;
  trust: string;
}

interface TeamMemberRow {
  entity_id: string;
  name: string;
  role: string;
  identity: string;
  memories: unknown;
  model: string | null;
  agent_tool: string | null;
  mode: string | null;
  permission_mode: string | null;
  avatar: string | null;
  capabilities: Record<string, unknown>;
  command_permissions: Record<string, unknown>;
}

interface TaskRow {
  entity_id: string;
  title: string;
  description: string;
  priority: string;
  work_status: string;
  acceptance_criteria: unknown;
}

export class DbGraphPort implements GraphPort {
  constructor(
    private readonly db: Db,
    /** Governance cap (S10). Refused loudly at capacity, never queued. */
    private readonly sessionCap = 8,
  ) {}

  private claims(auth: GraphAuth): DbClaims {
    return auth as DbClaims;
  }

  /**
   * The pre-spawn reads, in ONE transaction.
   *
   * One transaction rather than three round trips because the three answers must
   * describe the same instant: a persona deleted between the persona read and
   * the task read would produce a manifest describing a session that could never
   * have been authorised.
   */
  async loadSpawnContext(auth: GraphAuth, input: LoadSpawnContextInput): Promise<SpawnContext> {
    return this.db.tx(this.claims(auth), async (q) => {
      const members = await q.query<TeamMemberRow>(
        `select tm.entity_id, tm.name, tm.role, tm.identity, tm.memories, tm.model,
                tm.agent_tool, tm.mode, tm.permission_mode, tm.avatar,
                tm.capabilities, tm.command_permissions
           from public.team_members tm
           join public.entities e on e.id = tm.entity_id
          where tm.entity_id = $1 and e.space_id = $2 and e.deleted_at is null`,
        [input.teamMemberId, input.spaceId],
      );
      const member = members[0];
      if (!member) {
        throw fail('not_found', `team member ${input.teamMemberId} not found in this space`);
      }

      let project: SpawnContext['project'] = null;
      if (input.projectId) {
        const rows = await q.query<ProjectRow>(
          `select p.id, p.name, p.working_dir, p.trust
             from public.projects p
             join public.space_projects sp
               on sp.project_id = p.id and sp.space_id = $2
            where p.id = $1`,
          [input.projectId, input.spaceId],
        );
        const row = rows[0];
        if (!row) {
          // Not-linked and not-found are the same answer to a caller who may not
          // be a member of the other space — distinguishing them would leak the
          // existence of projects outside this space.
          throw fail('not_found', `project ${input.projectId} is not linked to this space`);
        }
        project = {
          id: row.id,
          name: row.name,
          workingDir: row.working_dir,
          trust: row.trust === 'trusted' ? 'trusted' : 'untrusted',
        };
      }

      const taskIds = input.taskIds ?? [];
      const tasks =
        taskIds.length === 0
          ? []
          : await q.query<TaskRow>(
              `select t.entity_id, t.title, t.description, t.priority, t.work_status,
                      t.acceptance_criteria
                 from public.tasks t
                 join public.entities e on e.id = t.entity_id
                where t.entity_id = any($1::uuid[])
                  and e.space_id = $2 and e.deleted_at is null`,
              [taskIds, input.spaceId],
            );

      return {
        spaceId: input.spaceId,
        project,
        teamMember: {
          id: member.entity_id,
          name: member.name,
          role: member.role,
          identity: member.identity,
          memories: Array.isArray(member.memories) ? member.memories : [],
          model: member.model,
          agentTool: member.agent_tool,
          mode: (member.mode as SpawnContext['teamMember']['mode']) ?? null,
          permissionMode: member.permission_mode,
          avatar: member.avatar,
          capabilities: member.capabilities ?? {},
          commandPermissions: member.command_permissions ?? {},
        },
        // Preserve the caller's task order; `any(...)` does not.
        tasks: taskIds
          .map((id) => tasks.find((t) => t.entity_id === id))
          .filter((t): t is TaskRow => t !== undefined)
          .map((t) => ({
            id: t.entity_id,
            title: t.title,
            description: t.description,
            priority: t.priority,
            workStatus: t.work_status,
            acceptanceCriteria: Array.isArray(t.acceptance_criteria) ? t.acceptance_criteria : [],
          })),
      };
    });
  }

  async createWorkSession(
    auth: GraphAuth,
    input: CreateWorkSessionInput,
  ): Promise<CreateWorkSessionResult> {
    // Positional, in 007_rpc_catalog.sql:2027's declared order. Getting this
    // wrong is a silent semantic swap, not a type error — the two text
    // parameters either side of p_mode are the ones to watch.
    const result = await this.db.rpc<Record<string, unknown>>(
      this.claims(auth),
      'public.execution_spawn',
      [
        input.spaceId,
        input.teamMemberId,
        input.taskIds,
        input.projectId,
        input.workdirMode,
        input.workdirPath,
        input.baseRef,
        input.mode,
        input.model,
        input.agentTool,
        input.title,
        input.nodeId,
        input.confirmUntrusted,
        this.sessionCap,
        null, // p_actor_id — resolve_actor derives it from the claims
        input.clientMutationId,
      ],
    );

    const replayed = result?.__tm8_replayed === true;
    const { __tm8_replayed: _replayMarker, ...commandResult } = result ?? {};
    const entity = commandResult.entity as { id?: string } | undefined;
    const sessionId = entity?.id;
    if (typeof sessionId !== 'string') {
      throw fail('upstream_unavailable', 'execution_spawn returned no work_session id');
    }
    return { sessionId, commandResult, replayed };
  }

  async resolveInteractionProfile(
    auth: GraphAuth,
    input: { spaceId: string; teamMemberId: string; interactionProfileId?: string | null },
  ): Promise<ResolvedInteractionProfileContext> {
    const resolved = await resolveInteractionProfileForLaunch(this.db, this.claims(auth), input);
    return {
      profileId: resolved.profileId,
      profileVersion: resolved.profileVersion,
      templateKey: resolved.templateKey,
      templateVersion: resolved.templateVersion,
      source: resolved.source,
      resolvedHash: resolved.resolvedHash,
      snapshot: resolved.snapshot,
    };
  }

  async recordInteractionProfilePin(
    auth: GraphAuth,
    sessionId: string,
    profile: ResolvedInteractionProfileContext,
  ) {
    const pin = await persistInteractionProfilePin(this.db, this.claims(auth), {
      workSessionId: sessionId,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      source: profile.source,
      resolvedHash: profile.resolvedHash,
    });
    return {
      profileId: pin.profileId,
      profileVersion: pin.profileVersion,
      templateKey: pin.templateKey,
      templateVersion: pin.templateVersion,
      source: pin.source,
      resolvedHash: pin.resolvedHash,
      pinRevision: pin.pinRevision,
      snapshot: profile.snapshot,
    };
  }

  async recordManifest(
    auth: GraphAuth,
    sessionId: string,
    manifest: Tm8Manifest,
    envVarNames: string[],
  ): Promise<void> {
    await this.db.rpc(this.claims(auth), 'public.record_session_manifest', [
      sessionId,
      JSON.stringify(manifest),
      envVarNames,
    ]);
  }

  async transition(auth: GraphAuth, input: TransitionInput): Promise<void> {
    await this.db.rpc(this.claims(auth), 'public.work_session_transition', [
      input.sessionId,
      input.status,
      input.exitCode ?? null,
      input.error ?? null,
      null, // p_transcript_doc_id — transcripts are post-G1A
      null, // p_client_mutation_id — an exit is not a client mutation
    ]);
  }

  /**
   * Non-terminal work sessions recorded against `nodeId` — the ghost candidates
   * startup reconciliation retires.
   *
   * A plain READ rather than an RPC: nothing is written here, and the catalog
   * has no "sessions on a node" operation because this is node-local
   * maintenance, not a contract surface. RLS still applies through the caller's
   * claims, so it can only ever see rows the caller is entitled to.
   *
   * `deleted_at is null` is load-bearing: a soft-deleted session is already gone
   * as far as the graph is concerned, and transitioning it would write a ledger
   * row resurrecting something nobody asked about.
   */
  async listNodeActiveSessions(
    auth: GraphAuth,
    nodeId: string,
  ): Promise<Array<{ sessionId: string; status: WorkSessionStatus }>> {
    const rows = await this.db.query<{ entity_id: string; status: string }>(
      this.claims(auth),
      `select ws.entity_id, ws.status
         from public.work_sessions ws
         join public.entities e on e.id = ws.entity_id
        where ws.node_id = $1
          and ws.status in ('spawning', 'running', 'idle')
          and e.deleted_at is null`,
      [nodeId],
    );
    return rows.map((r) => ({ sessionId: r.entity_id, status: r.status as WorkSessionStatus }));
  }

  async recordCommand(auth: GraphAuth, input: RecordCommandInput): Promise<unknown> {
    return this.db.rpc(this.claims(auth), 'public.record_execution_command', [
      input.sessionId,
      input.operation,
      JSON.stringify(input.payload),
      null, // p_actor_id — derived from claims
      input.clientMutationId,
    ]);
  }

  /** execution.streams.attach — the graph authorises and returns a GRANT; bytes
   *  never pass through here (T-L10). */
  async grantStreamAttach(
    auth: GraphAuth,
    sessionId: string,
    mode: 'view' | 'drive',
    clientMutationId: string | null,
  ): Promise<Record<string, unknown>> {
    return this.db.rpc<Record<string, unknown>>(this.claims(auth), 'public.grant_stream_attach', [
      sessionId,
      mode,
      null, // p_token_hash — bearer tokens for streams are post-G1A (AM-4)
      '15 minutes',
      clientMutationId,
    ]);
  }
}

// --- runtime -----------------------------------------------------------------

export interface ExecutionRuntimeDeps {
  db: Db;
  config: ServerConfig;
  logger?: Logger;
  /** Node data root; manifests land in `<dataDir>/manifests/`. */
  dataDir?: string;
  nodeId?: string;
  sessionCap?: number;
  /**
   * The v1 loopback auto-owner. Pass the SAME memoized resolver the facade
   * uses; omitted, one is created here. Sharing it matters only for efficiency
   * — both resolve the same row — but two identity paths is the failure mode
   * this whole file just stopped having.
   */
  owner?: () => Promise<LoopbackOwner>;
}

export interface ExecutionRuntime {
  /** Hand this to the WS layer — it is the instance the sessions live on. */
  pty: PtyHostService;
  /**
   * The two-signal prompt-delivery completion bridge `pty` above was
   * constructed with (its `onPromptSettled` closes over this instance's
   * `resolve`). Hand this to `createW2ExecutionDelivery` so the delivery saga
   * can `awaitOutcome` a deliveryId instead of settling on admission — see
   * `PromptSettlementWaiter`'s own docs in `@tm8/execution` for why
   * construction order forces this instance to be built here, before the
   * delivery service exists, rather than by the delivery service itself.
   */
  promptSettlement: PromptSettlementWaiter;
  spawnService: SpawnService;
  graph: DbGraphPort;
  register(registry: HandlerRegistry): void;
  /**
   * Retire sessions this node left behind when it last died. Call ONCE at
   * startup, before serving: a fresh process has an empty PTY map, so any row
   * this node owns that still claims to be running provably has no process.
   *
   * Exposed rather than run inside the constructor so the composition root owns
   * the ordering (and so tests can drive it deliberately). Resolves to the count
   * retired and NEVER rejects — see `SpawnService.reconcileNodeGhosts`.
   */
  reconcileGhosts(): Promise<number>;
}

/**
 * Build the execution block. THIS is the wiring main.ts should use:
 *
 *   const execution = createExecutionRuntime({ db, config });
 *   execution.register(registry);
 *   // hand execution.pty to the WS layer
 *
 * Why the runtime constructs the PTY host rather than accepting one:
 * `PtyHostService` takes `onSessionStatus` ONLY at construction, and that sink
 * must close over the SpawnService instance holding the spawner's claims.
 * `work_session_transition` → `require_space_member` → `require_identity` has NO
 * node-admin bypass (002_identity.sql:297), so a PTY that exits with no captured
 * claims raises 42501, the transition is dropped, and the row sits at 'running'
 * forever — a ghost session the UI paints as a live agent and the concurrency
 * cap counts against every future spawn. A host built elsewhere and passed in
 * cannot have that sink, so the cycle is closed here with a lazy closure.
 */
export function createExecutionRuntime(deps: ExecutionRuntimeDeps): ExecutionRuntime {
  const sessionCap = deps.sessionCap ?? 8;
  const graph = new DbGraphPort(deps.db, sessionCap);

  let spawnService!: SpawnService;
  // See PromptSettlementWaiter's own docs (@tm8/execution) for why this exists:
  // PtyHostService's onPromptSettled fires per-delivery completion, but the
  // delivery saga that needs to AWAIT a specific deliveryId's outcome is built
  // after this host (createW2ExecutionDelivery, from main.ts). This instance is
  // the closure that lets construction stay host-first without either side
  // reaching into the other's internals.
  const promptSettlement = new PromptSettlementWaiter();
  const pty = new PtyHostService({
    ...(deps.logger ? { logger: deps.logger } : {}),
    onSessionStatus: (sessionId: string, status: PtySessionStatus, exitInfo: PtyExitInfo) =>
      spawnService.handlePtyExit(sessionId, status, exitInfo),
    onPromptSettled: promptSettlement.resolve,
  });

  spawnService = new SpawnService({
    graph,
    pty,
    baseUrl: `http://${deps.config.host}:${deps.config.port}`,
    ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
    nodeId: deps.nodeId ?? `${deps.config.host}:${deps.config.port}`,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  const owner = deps.owner ?? createLoopbackOwnerResolver(deps.db);

  return {
    pty,
    promptSettlement,
    spawnService,
    graph,
    register: (registry) => registerHandlers(registry, spawnService, graph, deps.db, owner, pty, sessionCap),
    reconcileGhosts: async () => {
      // Runs as the loopback OWNER. `work_session_transition` goes through
      // `require_space_member` → `require_identity` with no node-admin bypass,
      // so reconciliation needs a real identity; the node's owner is the honest
      // one — they are whose node left the rows behind.
      //
      // Wrapped because resolving the owner touches the database, and a node
      // whose graph is briefly unreachable at boot must still start.
      try {
        const o = await owner();
        return await spawnService.reconcileNodeGhosts({
          identityId: o.identityId,
          nodeAdmin: o.isNodeAdmin,
          requestId: 'startup-reconcile',
        });
      } catch (error) {
        deps.logger?.warn?.('execution: ghost reconciliation skipped', {
          error: error instanceof Error ? error.message : String(error),
        });
        return 0;
      }
    },
  };
}

/**
 * The signature from the lane brief, kept so main.ts can use either shape.
 *
 * ⚠ It CANNOT wire the exit sink, because the `pty` it is handed was already
 * constructed. Use it only when that host came from `createExecutionRuntime`
 * (or was built with `onSessionStatus` pointing at the returned service);
 * otherwise sessions will never transition off 'running' when their agent
 * exits. Prefer `createExecutionRuntime`.
 *
 * ⚠ SAME GAP, ONE MORE TIME: the returned `promptSettlement` is a freshly
 * constructed, DISCONNECTED `PromptSettlementWaiter` — `deps.pty` was not built
 * with its `resolve` wired as `onPromptSettled` (it could not have been; the
 * pty already existed), so nothing will ever call it and any `awaitOutcome`
 * registered against it hangs forever. Returned rather than omitted only so
 * `ExecutionRuntime`'s shape stays uniform; a caller of THIS function must not
 * wire it into `createW2ExecutionDelivery`.
 */
export function registerExecutionHandlers(
  registry: HandlerRegistry,
  deps: {
    db: Db;
    pty: PtyHostService;
    config: ServerConfig;
    logger?: Logger;
    dataDir?: string;
    owner?: () => Promise<LoopbackOwner>;
  },
): ExecutionRuntime {
  const graph = new DbGraphPort(deps.db);
  const spawnService = new SpawnService({
    graph,
    pty: deps.pty,
    baseUrl: `http://${deps.config.host}:${deps.config.port}`,
    ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
    nodeId: `${deps.config.host}:${deps.config.port}`,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
  const owner = deps.owner ?? createLoopbackOwnerResolver(deps.db);
  registerHandlers(registry, spawnService, graph, deps.db, owner, deps.pty, 8);
  return {
    pty: deps.pty,
    // See the docblock above this function — disconnected, never resolves.
    promptSettlement: new PromptSettlementWaiter(),
    spawnService,
    graph,
    register: () => {},
    // Same reconciliation as createExecutionRuntime — a node wired through the
    // legacy shape leaves the same ghosts behind and deserves the same cleanup.
    reconcileGhosts: async () => {
      try {
        const o = await owner();
        return await spawnService.reconcileNodeGhosts({
          identityId: o.identityId,
          nodeAdmin: o.isNodeAdmin,
          requestId: 'startup-reconcile',
        });
      } catch {
        return 0;
      }
    },
  };
}

// --- handlers ----------------------------------------------------------------

/** SpawnService speaks its own error vocabulary; the wire speaks the taxonomy. */
function toCollabError(error: unknown): unknown {
  if (!(error instanceof SpawnError)) return error;
  switch (error.code) {
    case 'invalid_input':
      return fail('invalid_input', error.message, error.detail);
    case 'not_found':
      return fail('not_found', error.message, error.detail);
    case 'forbidden':
      return fail('forbidden', error.message, error.detail);
    case 'conflict':
      return fail('invariant_violation', error.message, error.detail);
    case 'not_implemented':
      return fail('not_implemented', error.message, error.detail);
    default:
      return fail('upstream_unavailable', error.message, error.detail);
  }
}

async function rethrowing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toCollabError(error);
  }
}

/**
 * Every execution.* command result goes through the SAME assembler the reads
 * use, and this is the whole point of the function.
 *
 * `internal.command_result` hands back the DATABASE's shape: `to_jsonb(e)` on
 * the entities row, so snake_case columns (`space_id`, `created_at`) and none
 * of the derived truth — no title, state, badges, capabilities, connections or
 * hierarchy. Returning that straight to the wire is what made a spawned
 * work_session fail the contract schema on `spaceId` and render as an untitled
 * session that client-side grouping silently dropped.
 *
 * The fix is reuse, not a second mapping. `toCommandResult` also rebuilds
 * `patches` into real EntitySummary DTOs — which the raw jsonb likewise
 * returns snake_case, so fixing only `entity` would have left the same bug one
 * field deeper.
 *
 * It runs in its own transaction AFTER the flow completes rather than inside
 * the RPC's: holding a transaction open across a process spawn is its own
 * problem, and re-reading afterwards means the client sees the session as it
 * finally IS (status `running`) rather than mid-flight (`spawning`).
 */
async function assembleCommandResult(
  db: Db,
  claims: DbClaims,
  raw: unknown,
  viewerIdentityId: string,
): Promise<unknown> {
  return db.tx(claims, (q) => toCommandResult(q, (raw ?? {}) as RpcCommandResult, viewerIdentityId));
}

function registerHandlers(
  registry: HandlerRegistry,
  spawnService: SpawnService,
  graph: DbGraphPort,
  db: Db,
  resolveOwner: () => Promise<LoopbackOwner>,
  pty: PtyHostService,
  sessionCap: number,
): void {
  /**
   * A21 — execution.liveness (C-1). The ONE authority on "is there a live
   * terminal" is this process's PTY map; recorded work_sessions.status can be
   * stale between boots (ghost reconciliation runs at startup only). Answered
   * point-in-time, never cached.
   */
  registry.register('execution.liveness', async (ctx) => {
    const owner = await resolveOwner();
    const claims = claimsFor(owner, ctx);
    const spaceId = requireUuidParam(ctx, 'spaceId');
    // Authorization IS the space read under the caller's claims: RLS answers
    // membership, and an unreadable space is indistinguishable from a missing
    // one — the spaces.get precedent, leaking nothing about foreign spaces.
    const spaces = await db.query<{ id: string }>(
      claims,
      'select s.id from public.spaces s where s.id = $1',
      [spaceId],
    );
    if (!spaces[0]) throw new CollabError('not_found', `no such space: ${spaceId}`);
    // Scope the process-wide PTY map to THIS space's work_sessions, still
    // under the caller's claims — a live id the caller cannot read stays
    // invisible rather than leaking another space's session id.
    const live = pty.liveSessionIds();
    const rows = live.length === 0
      ? []
      : await db.query<{ id: string }>(
          claims,
          `select e.id from public.entities e
            where e.space_id = $1 and e.kind = 'work_session'
              and e.deleted_at is null and e.id = any($2::uuid[])`,
          [spaceId, live],
        );
    const capacityRows = await db.query<{ used: number | string }>(
      claims,
      'select internal.live_work_session_count(null) as used',
    );
    const capacity = capacityRows?.[0];
    const result: ExecutionLiveness = {
      liveEntityIds: rows.map((r) => r.id),
      nodeBootId: NODE_BOOT_ID,
      checkedAt: new Date().toISOString(),
      capacity: { used: Number(capacity?.used ?? 0), total: sessionCap },
    };
    return json(result);
  });
  registry.register('execution.spawn', async (ctx) => {
    const input = ctx.body as ExecutionSpawnInput;

    const owner = await resolveOwner();
    const envelope = commandEnvelope(ctx);
    const claims = claimsFor(owner, ctx, envelope);
    const request: SpawnRequest = {
      spaceId: input.spaceId,
      teamMemberId: input.teamMemberId,
      ...(input.taskIds ? { taskIds: input.taskIds } : {}),
      projectId: input.projectId ?? null,
      ...(input.workdir ? { workdir: input.workdir } : {}),
      ...(input.interactionProfileId ? { interactionProfileId: input.interactionProfileId } : {}),
      ...(input.confirmUntrusted ? { confirmUntrusted: true } : {}),
      mode: input.mode ?? null,
      model: input.model ?? null,
      agentTool: input.agentTool ?? null,
      title: input.title ?? null,
      promptExtra: input.promptExtra ?? null,
      clientMutationId: envelope.clientMutationId ?? null,
    };

    const result = await rethrowing(() => spawnService.spawn(claims, request));

    // 201: a spawn creates a work_session.
    return json(
      await assembleCommandResult(db, claims, result.commandResult, owner.identityId),
      { status: 201 },
    );
  });

  /**
   * B1 — `execution.prompt` is Server-internal-only, so the PUBLIC route is a
   * refusal and nothing else.
   *
   * Read what is NOT here, because that is the assertion. No `resolveOwner()`
   * (a database round trip), no `commandEnvelope`, no `requireUuidParam`, no
   * `ctx.body`. The refusal is the first and only statement, so there is no
   * early return, no branch and no ordering for a later edit to get wrong —
   * the failure this program keeps finding is an authorization check that some
   * other path steps around, and a handler with one statement has no other
   * path. Zero queue (no `record_execution_command`) and zero bytes (no
   * `deliverPrompt`) are consequences of that, not extra guards.
   *
   * It stays REGISTERED. `execution.prompt` is a v1 catalog operation; leaving
   * it unregistered would answer 501 and tell the client the node has not built
   * an operation it has in fact closed on purpose.
   *
   * The real write lives in `promptInternal` (facade/services/w2/execution.ts),
   * reachable only with an object `mintSystemDeliveryPrincipal` produced — a
   * thing no request body can be.
   */
  registry.register('execution.prompt', async () => refusePublicExecutionPrompt());

  registry.register('execution.terminate', async (ctx) => {
    const owner = await resolveOwner();
    const envelope = commandEnvelope(ctx);
    const claims = claimsFor(owner, ctx, envelope);
    const input = ctx.body as ExecutionTerminateInput;
    const result = await rethrowing(() =>
      spawnService.terminate(claims, requireUuidParam(ctx, 'id'), {
        force: input.force ?? false,
        clientMutationId: envelope.clientMutationId ?? null,
      }),
    );
    return json(await assembleCommandResult(db, claims, result.commandResult, owner.identityId));
  });

  registry.register('execution.streams.attach', async (ctx) => {
    const owner = await resolveOwner();
    const envelope = commandEnvelope(ctx);
    const claims = claimsFor(owner, ctx, envelope);
    const input = ctx.body as ExecutionStreamsAttachInput;
    const sessionId = requireUuidParam(ctx, 'id');
    const granted = await graph.grantStreamAttach(
      claims,
      sessionId,
      input.mode,
      envelope.clientMutationId ?? null,
    );

    // NOT an EntityDetail — `StreamAttachGrant` is its own small contract DTO,
    // so it is mapped explicitly here rather than run through the entity
    // assembler. The RPC's `grant` is a raw `to_jsonb(stream_grants)` row
    // (snake_case, token_hash already stripped), and the URL is transport that
    // only the server knows. Bytes never flow through this response (T-L10).
    const grant = (granted.grant ?? {}) as { expires_at?: string; mode?: string };
    return json({
      workSessionId: sessionId,
      url: `/v2/ws?sessionId=${encodeURIComponent(sessionId)}`,
      protocol: 'ws',
      mode: input.mode,
      ...(grant.expires_at ? { expiresAt: new Date(grant.expires_at).toISOString() } : {}),
    });
  });
}
