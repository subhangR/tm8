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
  SpawnError,
  SpawnService,
  PtyHostService,
  type CreateWorkSessionInput,
  type GraphAuth,
  type GraphPort,
  type LoadSpawnContextInput,
  type Logger,
  type PtySessionStatus,
  type RecordCommandInput,
  type SpawnContext,
  type SpawnRequest,
  type Tm8Manifest,
  type TransitionInput,
} from '@tm8/execution';
import type {
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
import type { HandlerRegistry } from './registry.js';

// --- claims ------------------------------------------------------------------

/**
 * Request identity → the four canonical claims, and nothing else.
 *
 * `nodeAdmin` is left unset rather than defaulted: the db client serialises it
 * through the shared claim binder, and the value is the literal string
 * `'true'`/`'false'` (001_core_graph.sql:166 tests `lower(claim) = 'true'`, so
 * `'on'` reads as "not an admin" instead of raising). Hand-rolling it here would
 * present as an RLS bug rather than a claims bug.
 */
function claimsFor(ctx: RequestContext): DbClaims {
  return {
    ...(ctx.identity.identityId === undefined ? {} : { identityId: ctx.identity.identityId }),
    ...(ctx.identity.actorId === undefined ? {} : { actorId: ctx.identity.actorId }),
    requestId: ctx.requestId,
  };
}

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
  ): Promise<{ sessionId: string; commandResult: unknown }> {
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

    const entity = result?.entity as { id?: string } | undefined;
    const sessionId = entity?.id;
    if (typeof sessionId !== 'string') {
      throw fail('upstream_unavailable', 'execution_spawn returned no work_session id');
    }
    return { sessionId, commandResult: result };
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
}

export interface ExecutionRuntime {
  /** Hand this to the WS layer — it is the instance the sessions live on. */
  pty: PtyHostService;
  spawnService: SpawnService;
  graph: DbGraphPort;
  register(registry: HandlerRegistry): void;
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
  const graph = new DbGraphPort(deps.db, deps.sessionCap ?? 8);

  let spawnService!: SpawnService;
  const pty = new PtyHostService({
    ...(deps.logger ? { logger: deps.logger } : {}),
    onSessionStatus: (sessionId: string, status: PtySessionStatus) =>
      spawnService.handlePtyExit(sessionId, status),
  });

  spawnService = new SpawnService({
    graph,
    pty,
    baseUrl: `http://${deps.config.host}:${deps.config.port}`,
    ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
    nodeId: deps.nodeId ?? `${deps.config.host}:${deps.config.port}`,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  return {
    pty,
    spawnService,
    graph,
    register: (registry) => registerHandlers(registry, spawnService, graph),
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
 */
export function registerExecutionHandlers(
  registry: HandlerRegistry,
  deps: { db: Db; pty: PtyHostService; config: ServerConfig; logger?: Logger; dataDir?: string },
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
  registerHandlers(registry, spawnService, graph);
  return { pty: deps.pty, spawnService, graph, register: () => {} };
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

function sessionIdFrom(ctx: RequestContext): string {
  const id = ctx.params.id;
  if (!id) throw fail('invalid_input', 'missing work session id in path');
  return id;
}

function registerHandlers(
  registry: HandlerRegistry,
  spawnService: SpawnService,
  graph: DbGraphPort,
): void {
  registry.register('execution.spawn', async (ctx) => {
    const input = ctx.body as ExecutionSpawnInput;
    const request: SpawnRequest = {
      spaceId: input.spaceId,
      teamMemberId: input.teamMemberId,
      ...(input.taskIds ? { taskIds: input.taskIds } : {}),
      projectId: input.projectId ?? null,
      ...(input.workdir ? { workdir: input.workdir } : {}),
      mode: input.mode ?? null,
      model: input.model ?? null,
      agentTool: input.agentTool ?? null,
      title: input.title ?? null,
      promptExtra: input.promptExtra ?? null,
      clientMutationId: input.clientMutationId ?? null,
    };

    const result = await rethrowing(() => spawnService.spawn(claimsFor(ctx), request));

    // 201: a spawn creates a work_session. The RPC's CommandResult is forwarded
    // untouched so the client's patch application is identical to every other
    // mutation's.
    return json(result.commandResult, { status: 201 });
  });

  registry.register('execution.prompt', async (ctx) => {
    const input = ctx.body as ExecutionPromptInput;
    const result = await rethrowing(() =>
      spawnService.prompt(claimsFor(ctx), sessionIdFrom(ctx), input.message, {
        clientMutationId: input.clientMutationId ?? null,
      }),
    );
    return json(result.commandResult);
  });

  registry.register('execution.terminate', async (ctx) => {
    const input = ctx.body as ExecutionTerminateInput;
    const result = await rethrowing(() =>
      spawnService.terminate(claimsFor(ctx), sessionIdFrom(ctx), {
        force: input.force ?? false,
        clientMutationId: input.clientMutationId ?? null,
      }),
    );
    return json(result.commandResult);
  });

  registry.register('execution.streams.attach', async (ctx) => {
    const input = ctx.body as ExecutionStreamsAttachInput;
    const sessionId = sessionIdFrom(ctx);
    const granted = await graph.grantStreamAttach(
      claimsFor(ctx),
      sessionId,
      input.mode,
      input.clientMutationId ?? null,
    );
    // The grant the RPC returns describes AUTHORIZATION; the URL is transport,
    // which only the server knows. Bytes never flow through this response.
    return json({
      ...granted,
      workSessionId: sessionId,
      url: `/v2/ws?sessionId=${encodeURIComponent(sessionId)}`,
      protocol: 'ws',
      mode: input.mode,
    });
  });
}
