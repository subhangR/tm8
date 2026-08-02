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
  resolveSkills,
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
  type ResumeWorkSessionResult,
  type SessionLaunchPosture,
  type SpawnContext,
  type SpawnRequest,
  type Tm8Manifest,
  type TransitionInput,
  type WorkdirMode,
  type WorkSessionResumeInfo,
  type WorkSessionStatus,
} from '@tm8/execution';
import { CollabError, SessionJournalRecordSchema } from '@tm8/contract';
import type {
  ExecutionLiveness,
  ExecutionPromptInput,
  ExecutionSpawnInput,
  ExecutionStreamsAttachInput,
  ExecutionTerminateInput,
  SessionJournalPage,
  SessionJournalRecord,
} from '@tm8/contract';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
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

interface SkillRow {
  entity_id: string;
  name: string;
  content: string;
  /** pg returns `min(...)` over an int as a string via node-postgres. */
  depth: string | number;
}

/**
 * How far the skill resolver will walk up a team member hierarchy. These are
 * org charts, not trees, so this is a runaway guard rather than a real product
 * limit — but it is also what stops a recursive CTE spinning if the hierarchy's
 * acyclicity trigger is ever bypassed (a restore, a direct write).
 */
const MAX_HIERARCHY_DEPTH = 16;

export class DbGraphPort implements GraphPort {
  constructor(
    private readonly db: Db,
    /**
     * Governance cap (S10). Refused loudly at capacity, never queued.
     *
     * Defaults from `TM8_SESSION_CAP` rather than a literal, so a node cannot
     * end up with one cap on the spawn path and a different one in the capacity
     * the launch panel displays — the two disagreeing is how "8 of 8 free"
     * appears next to a refusal.
     */
    private readonly sessionCap = resolveSessionCap(),
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

      // Row #11. Walk the persona's ancestor chain and collect what each level
      // equips. In the SAME transaction as the persona read for the reason
      // given above: a skill unequipped between the two reads would otherwise
      // produce a manifest describing capability the persona no longer has.
      //
      // `depth` is hops from the invoked member (0 = itself). The recursion is
      // bounded by MAX_HIERARCHY_DEPTH rather than trusting the hierarchy to be
      // acyclic: 001_core_graph.sql's trigger does enforce acyclicity, but a
      // recursive CTE that meets a cycle anyway spins until it exhausts memory,
      // and this query runs on the spawn path.
      const skillRows = await q.query<SkillRow>(
        `with recursive chain as (
             select e.id, e.parent_id, 0 as depth
               from public.entities e
              where e.id = $1 and e.space_id = $2
                and e.kind = 'team_member' and e.deleted_at is null
             union all
             select p.id, p.parent_id, c.depth + 1
               from chain c
               join public.entities p on p.id = c.parent_id
              where p.space_id = $2 and p.kind = 'team_member'
                and p.deleted_at is null and c.depth < $3
           )
         select s.entity_id, s.name, s.content, min(chain.depth) as depth
           from chain
           join public.edges ed
             on ed.src_id = chain.id and ed.type = 'equips' and ed.space_id = $2
           join public.entities se
             on se.id = ed.dst_id and se.kind = 'skill' and se.deleted_at is null
           join public.skills s on s.entity_id = se.id
          group by s.entity_id, s.name, s.content
          order by depth, s.name`,
        [input.teamMemberId, input.spaceId, MAX_HIERARCHY_DEPTH],
      );

      const resolution = resolveSkills(
        skillRows.map((r) => ({
          entityId: r.entity_id,
          name: r.name,
          body: r.content,
          depth: Number(r.depth),
        })),
      );

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
        skills: resolution.skills,
        droppedSkills: resolution.dropped,
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
        input.parentSessionId,
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
   * The stored launch facts of one session, for resume. A read in one
   * transaction (row + persona edge + task edges must describe the same
   * instant), under the caller's claims — an unreadable session is a
   * not_found, indistinguishable from a missing one.
   */
  async loadWorkSessionForResume(
    auth: GraphAuth,
    sessionId: string,
  ): Promise<WorkSessionResumeInfo> {
    return this.db.tx(this.claims(auth), async (q) => {
      const rows = await q.query<{
        entity_id: string;
        space_id: string;
        project_id: string | null;
        workdir_mode: string;
        workdir_path: string | null;
        mode: string | null;
        model: string | null;
        agent_tool: string | null;
        title: string;
        status: string;
        native_session_id: string | null;
      }>(
        `select ws.entity_id, e.space_id, ws.project_id, ws.workdir_mode,
                ws.workdir_path, ws.mode, ws.model, ws.agent_tool, ws.title,
                ws.status, ws.native_session_id
           from public.work_sessions ws
           join public.entities e on e.id = ws.entity_id
          where ws.entity_id = $1 and e.deleted_at is null`,
        [sessionId],
      );
      const row = rows[0];
      if (!row) throw fail('not_found', `work session ${sessionId} not found`);

      const members = await q.query<{ dst_id: string }>(
        `select dst_id from public.edges
          where src_id = $1 and type = 'relates_to' limit 1`,
        [sessionId],
      );
      const tasks = await q.query<{ dst_id: string }>(
        `select dst_id from public.edges
          where src_id = $1 and type = 'working_on'`,
        [sessionId],
      );

      return {
        sessionId: row.entity_id,
        spaceId: row.space_id,
        teamMemberId: members[0]?.dst_id ?? null,
        projectId: row.project_id,
        taskIds: tasks.map((t) => t.dst_id),
        workdirMode: row.workdir_mode as WorkdirMode,
        workdirPath: row.workdir_path,
        mode: (row.mode as WorkSessionResumeInfo['mode']) ?? null,
        model: row.model,
        agentTool: row.agent_tool,
        title: row.title,
        status: row.status as WorkSessionStatus,
        nativeSessionId: row.native_session_id,
      };
    });
  }

  /**
   * The permission posture one session was launched with, read back out of its
   * recorded manifest.
   *
   * WHY THE MANIFEST AND NOT THE ROW. `work_sessions` persists the resolved
   * model, mode and agent_tool but has never had a permission column, while
   * `session_manifests.manifest -> 'launch'` has carried both `accessMode` and
   * `permissionMode` since the manifest existed. So the fact is already durable
   * for every session ever spawned, including the ones that ran before anything
   * read it back — a column added today would answer `null` for all of them.
   *
   * A PLAIN READ, deliberately. Nothing is written, and the catalog has no
   * "posture of a session" operation because this is not a caller-facing
   * surface. RLS still decides: `session_manifests_select` requires
   * `entity_readable(work_session_id)`, so a session the caller may not read is
   * simply absent, and absent means "do not inherit" rather than an error.
   */
  async loadSessionLaunchPosture(
    auth: GraphAuth,
    sessionId: string,
  ): Promise<SessionLaunchPosture | null> {
    const rows = await this.db.query<{ access_mode: string | null; permission_mode: string | null }>(
      this.claims(auth),
      `select sm.manifest #>> '{launch,accessMode}'     as access_mode,
              sm.manifest #>> '{launch,permissionMode}' as permission_mode
         from public.session_manifests sm
        where sm.work_session_id = $1`,
      [sessionId],
    );
    const row = rows[0];
    if (!row) return null;
    // The strings are VALIDATED downstream (resolveLaunchConfig), not here: a
    // manifest is a stored JSON document and an unrecognised posture in one must
    // fall through to the ordinary precedence chain, not launch on a value
    // nothing maps.
    return {
      accessMode: row.access_mode as SessionLaunchPosture['accessMode'],
      permissionMode: row.permission_mode as SessionLaunchPosture['permissionMode'],
    };
  }

  async resumeWorkSession(
    auth: GraphAuth,
    input: { sessionId: string; clientMutationId: string | null; nodeId: string | null },
  ): Promise<ResumeWorkSessionResult> {
    const result = await this.db.rpc<Record<string, unknown>>(
      this.claims(auth),
      'public.execution_resume',
      [
        input.sessionId,
        this.sessionCap,
        null, // p_actor_id — resolve_actor derives it from the claims
        input.clientMutationId,
        // p_node_id — the resuming node takes ownership of the row, because it
        // is the one about to own the PTY. Null leaves the stored value alone.
        input.nodeId,
      ],
    );
    const replayed = result?.__tm8_replayed === true;
    const { __tm8_replayed: _replayMarker, ...commandResult } = result ?? {};
    return { commandResult, replayed };
  }

  /**
   * Returns whether the id was actually stored. `false` means the row already
   * held a DIFFERENT id: write-once refused the overwrite. The caller must not
   * discard this — see SpawnService for why a silent `false` would hide a
   * genuine capture bug.
   */
  async recordNativeSessionId(
    auth: GraphAuth,
    sessionId: string,
    nativeSessionId: string,
  ): Promise<boolean> {
    const stored = await this.db.rpc<boolean>(
      this.claims(auth),
      'public.execution_record_native_session',
      [
        sessionId,
        nativeSessionId,
        null, // p_actor_id — derived from claims
      ],
    );
    return stored === true;
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

/**
 * The hard-coded 8 was never a resource measurement — it was a placeholder that
 * became a wall. It surfaces as `No session slots free (0 of 8 session slots
 * free)` in the launch panel with no way to raise it short of a rebuild, and on
 * a machine that can comfortably run more agents that is an invented limit.
 *
 * `TM8_SESSION_CAP` makes it the operator's decision:
 *   - unset      → 8, the previous behaviour, so nothing changes by upgrading
 *   - a number   → that many concurrent live sessions
 *   - `0` / `unlimited` / `none` → no practical ceiling
 *
 * "No practical ceiling" is a saturating NUMBER, not a disabled check, and that
 * is deliberate. The cap is enforced inside `internal.execution_spawn`, whose
 * guard is `live_work_session_count(null) >= greatest(coalesce(cap, 8), 1)` — it
 * CANNOT express "unlimited", and it clamps anything below 1 up to 1. So passing
 * 0 straight through would produce a cap of ONE, the exact opposite of what the
 * operator asked for. A saturating value is the honest way to say "never refuse
 * on capacity" through an interface that has no word for it.
 *
 * The saturating value is int4's maximum, NOT `Number.MAX_SAFE_INTEGER`, because
 * `p_session_cap` is declared `integer`: a JS-safe-integer would overflow int4
 * and turn "unlimited" into a spawn that fails on every request. The ceiling of
 * the narrowest type in the chain is the only value that survives the whole path.
 *
 * What removing the cap does NOT remove: each live session is a real PTY and a
 * real agent process, so the true limits are RAM, file descriptors and provider
 * rate limits. Those fail in their own way and this setting cannot help with
 * them — it only stops tm8 from being the thing that says no.
 */
/** int4 max — `internal.execution_spawn(p_session_cap integer)` is the narrowest
 *  type this value has to pass through, so it is the largest "unlimited" that
 *  cannot overflow on the way to the guard. */
const UNLIMITED_SESSION_CAP = 2_147_483_647;

export function resolveSessionCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['TM8_SESSION_CAP']?.trim();
  if (raw === undefined || raw === '') return 8;
  if (/^(unlimited|none|off|0)$/i.test(raw)) return UNLIMITED_SESSION_CAP;
  const parsed = Number.parseInt(raw, 10);
  // A typo must not silently become a SMALLER cap than the default: an
  // unparseable or negative value falls back rather than being coerced to 1.
  if (!Number.isFinite(parsed) || parsed < 1) return 8;
  return Math.min(parsed, UNLIMITED_SESSION_CAP);
}

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
  const sessionCap = deps.sessionCap ?? resolveSessionCap(process.env);
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
    register: (registry) => registerHandlers(registry, spawnService, graph, deps.db, owner, pty, sessionCap, deps.dataDir),
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
  registerHandlers(registry, spawnService, graph, deps.db, owner, deps.pty, resolveSessionCap(), deps.dataDir);
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

/**
 * Launch accepts ANY entity; a session's assignment anchor is always a task.
 *
 * The UI can now put a Run button on a doc, a teammate, a memory, an artifact,
 * a project, a pull request or a worktree, and every one of them arrives here
 * in the same `taskIds` field. This is the seam that makes that true: each id
 * is mapped through `public.derive_task_for_entity` (064), which returns a task
 * id — the entity itself when it already IS a task (writing nothing, so
 * existing task launches are bit-for-bit unchanged), otherwise an open task
 * derived from it, reused if one exists and created if not.
 *
 * Everything downstream therefore keeps its proven, task-shaped contract:
 * `loadSpawnContext`'s join to `public.tasks`, `execution_spawn`'s
 * `live_entity(task_id,'task')` assertion (048:92), the `working_on` edge whose
 * registry entry permits dst `['task']` only (001:905), and the
 * `<tm8_task_prompt>` envelope. None of them needed to change, and none of them
 * gained a second code path to keep correct.
 *
 * SEQUENTIAL ON PURPOSE. Each call is a write whose reuse branch reads what an
 * earlier call may have just written, so two ids naming the same entity — or
 * the same entity twice in one array — would race under `Promise.all` and mint
 * two tasks for it. The array is a handful of ids; the round trips are cheap
 * next to the process spawn that follows.
 */
async function resolveAssignmentAnchors(
  db: Db,
  claims: DbClaims,
  spaceId: string,
  subjectIds: readonly string[],
): Promise<string[]> {
  const anchors: string[] = [];
  for (const subjectId of subjectIds) {
    const derived = await db.rpc<{ taskId?: string } | null>(
      claims,
      'public.derive_task_for_entity',
      // p_actor_id is null: resolve_actor derives it from the claims, the same
      // convention createWorkSession uses.
      [spaceId, subjectId, null],
    );
    const taskId = derived?.taskId;
    if (typeof taskId !== 'string') {
      throw fail(
        'upstream_unavailable',
        `derive_task_for_entity returned no task id for ${subjectId}`,
      );
    }
    // De-duplicate on the ANCHOR, not the subject: two different entities can
    // legitimately resolve to one task, and `execution_spawn` would then try to
    // insert the same `working_on` edge twice.
    if (!anchors.includes(taskId)) anchors.push(taskId);
  }
  return anchors;
}

// --- execution.journal (read) -----------------------------------------------

const JOURNAL_LIMIT_DEFAULT = 100;
const JOURNAL_LIMIT_MAX = 500;

/**
 * `relative()`-based containment: true iff `candidate` is at or beneath `root`.
 * Copied from `files/w2-blob-store.ts` so the journal path can never escape the
 * journals dir even through a symlink (we realpath before trusting it).
 */
function journalContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

const emptyJournalTotals = (): SessionJournalPage['totals'] => ({
  invocations: 0,
  failed: 0,
  agentToCliEst: 0,
  cliToAgentEst: 0,
  estimator: 'chars/4',
  malformed: 0,
});

/**
 * Read one session's journal file and fold it into a `SessionJournalPage`.
 *
 * THE PATH NEVER COMES FROM THE REQUEST: the caller passes a UUID that has
 * already been validated AND authorized (the entity read is the authz gate),
 * and we join it under `<dataDir>/journals/` ourselves. A UUID cannot contain a
 * path separator, but we still realpath-check containment (defence in depth
 * against a symlinked journals dir) before trusting the resolved path.
 *
 * Totals are computed over the WHOLE file; `records` is only the newest window.
 * Lines are read one at a time via `readline` (never the whole file as one
 * string); the parsed records are retained in memory, which is bounded by the
 * per-session invocation count — pragmatic for a per-teammate CLI journal.
 *
 * PAGINATION IS ON LINE INDEX, NOT `seq`. `seq` is a per-process counter that
 * is 0 on almost every record (one invocation = one process = one line), so it
 * is neither unique nor monotonic across the file. The stable cursor is instead
 * the record's 0-based ordinal among the valid records in file (append) order —
 * oldest = 0. `before` returns the window ending just before that ordinal, and
 * `hasMore` is true when ordinal 0 was not reached. The client derives the next
 * cursor without a per-record field: the window's oldest ordinal is
 * `totals.invocations - records.length`.
 */
async function readSessionJournal(
  dataDir: string | undefined,
  sessionId: string,
  limit: number,
  before: number | null,
): Promise<SessionJournalPage> {
  const unavailable = (
    reason: 'no_journal_file' | 'unreadable',
  ): SessionJournalPage => ({
    sessionId,
    available: false,
    unavailableReason: reason,
    totals: emptyJournalTotals(),
    records: [],
    hasMore: false,
  });

  // A node without a data root cannot have written a journal. Treat it as a
  // genuine read failure rather than a missing file — it is a config fault, not
  // a session that simply predates journaling.
  if (!dataDir) return unavailable('unreadable');

  const journalsRoot = resolvePath(dataDir, 'journals');
  const filePath = resolvePath(journalsRoot, `${sessionId}.jsonl`);
  // Pre-open string check — impossible to fail for a UUID, but it keeps the
  // containment invariant local and obvious.
  if (!journalContained(journalsRoot, filePath)) {
    throw new CollabError('not_found', `no journal for session: ${sessionId}`);
  }

  const totals = emptyJournalTotals();
  const records: SessionJournalRecord[] = [];

  try {
    // Symlink defence: the real resolved file must still sit under the real
    // journals dir. realpath throws ENOENT for a missing file, which is the
    // no-journal case handled below.
    const realFile = await realpath(filePath);
    const realRoot = await realpath(journalsRoot);
    if (!journalContained(realRoot, realFile)) {
      throw new CollabError('not_found', `no journal for session: ${sessionId}`);
    }

    const rl = createInterface({
      input: createReadStream(realFile, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (line.trim() === '') continue; // blank line, not malformed
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        totals.malformed += 1;
        continue;
      }
      const result = SessionJournalRecordSchema.safeParse(parsed);
      if (!result.success) {
        totals.malformed += 1;
        continue;
      }
      const record = result.data;
      totals.invocations += 1;
      if (record.result.exitCode !== 0) totals.failed += 1;
      totals.agentToCliEst += record.tokens.agentToCli;
      totals.cliToAgentEst += record.tokens.cliToAgent;
      records.push(record);
    }
  } catch (err) {
    if (err instanceof CollabError) throw err;
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return unavailable('no_journal_file');
    // Any other error (permissions, I/O) is a genuine read failure — surfaced
    // as an explained empty, never a 500 for a session with no readable journal.
    return unavailable('unreadable');
  }

  // File (append) order IS oldest-first, so a record's array index is its line
  // ordinal. `before` is that ordinal; the window is the newest `limit` records
  // strictly older than it. hasMore means ordinal 0 was not included.
  const qualifying = before === null ? records : records.slice(0, Math.max(0, before));
  const hasMore = qualifying.length > limit;
  const window = hasMore ? qualifying.slice(qualifying.length - limit) : qualifying;

  return {
    sessionId,
    available: true,
    unavailableReason: null,
    totals,
    records: window,
    hasMore,
  };
}

function registerHandlers(
  registry: HandlerRegistry,
  spawnService: SpawnService,
  graph: DbGraphPort,
  db: Db,
  resolveOwner: () => Promise<LoopbackOwner>,
  pty: PtyHostService,
  sessionCap: number,
  dataDir: string | undefined,
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
  /**
   * execution.journal — the ONLY path from a teammate's on-disk CLI journal
   * (`<dataDir>/journals/<sessionId>.jsonl`) to a browser. The session id is
   * validated as a uuid and resolved as a `work_session` entity under the
   * caller's claims — that entity read IS the authorization gate (RLS answers
   * membership; an unreadable session is indistinguishable from a missing one,
   * exactly as `execution.liveness` treats a foreign space). The file path is
   * then constructed server-side; it never comes from the request.
   */
  registry.register('execution.journal', async (ctx) => {
    const owner = await resolveOwner();
    const claims = claimsFor(owner, ctx);
    const sessionId = requireUuidParam(ctx, 'workSessionId');
    const sessions = await db.query<{ id: string }>(
      claims,
      `select e.id from public.entities e
        where e.id = $1 and e.kind = 'work_session' and e.deleted_at is null`,
      [sessionId],
    );
    if (!sessions[0]) {
      throw new CollabError('not_found', `no such work session: ${sessionId}`);
    }

    const rawLimit = ctx.query.get('limit');
    let limit = JOURNAL_LIMIT_DEFAULT;
    if (rawLimit !== null && rawLimit !== '') {
      const parsed = Number.parseInt(rawLimit, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CollabError('invalid_input', `limit must be a positive integer, got ${rawLimit}`);
      }
      limit = Math.min(parsed, JOURNAL_LIMIT_MAX);
    }

    const rawBefore = ctx.query.get('before');
    let before: number | null = null;
    if (rawBefore !== null && rawBefore !== '') {
      const parsed = Number.parseInt(rawBefore, 10);
      // `before` is a 0-based line ordinal (see readSessionJournal), not a seq.
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new CollabError('invalid_input', `before must be a non-negative integer, got ${rawBefore}`);
      }
      before = parsed;
    }

    return json(await readSessionJournal(dataDir, sessionId, limit, before));
  });
  registry.register('execution.spawn', async (ctx) => {
    const input = ctx.body as ExecutionSpawnInput;

    const owner = await resolveOwner();
    const envelope = commandEnvelope(ctx);
    const claims = claimsFor(owner, ctx, envelope);

    // Any entity may be launched; the anchor is always a task. See
    // `resolveAssignmentAnchors` — a task passes through untouched.
    const taskIds = input.taskIds?.length
      ? await rethrowing(() =>
          resolveAssignmentAnchors(db, claims, input.spaceId, input.taskIds ?? []),
        )
      : undefined;

    const request: SpawnRequest = {
      spaceId: input.spaceId,
      teamMemberId: input.teamMemberId,
      parentSessionId: input.parentSessionId ?? null,
      ...(taskIds ? { taskIds } : {}),
      projectId: input.projectId ?? null,
      ...(input.workdir ? { workdir: input.workdir } : {}),
      ...(input.interactionProfileId ? { interactionProfileId: input.interactionProfileId } : {}),
      ...(input.confirmUntrusted ? { confirmUntrusted: true } : {}),
      mode: input.mode ?? null,
      model: input.model ?? null,
      agentTool: input.agentTool ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      accessMode: input.accessMode ?? null,
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

  /**
   * execution.resume — maestro-style same-session resume. All the semantics
   * live in SpawnService.resume (fail-closed native-id resolution, the
   * execution_resume resurrection RPC, provider resume flags); this handler is
   * the same thin claims-and-assembly shell every execution.* command uses.
   */
  registry.register('execution.resume', async (ctx) => {
    const owner = await resolveOwner();
    const envelope = commandEnvelope(ctx);
    const claims = claimsFor(owner, ctx, envelope);
    const result = await rethrowing(() =>
      spawnService.resume(claims, {
        sessionId: requireUuidParam(ctx, 'id'),
        clientMutationId: envelope.clientMutationId ?? null,
      }),
    );
    return json(await assembleCommandResult(db, claims, result.commandResult, owner.identityId));
  });

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
