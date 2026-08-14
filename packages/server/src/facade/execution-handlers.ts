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
  readSessionTranscript,
  knownAgentConfigDirs,
  type CreateWorkSessionInput,
  type ShellSessionContext,
  type ShellSessionRequest,
  type StartShellSessionResult,
  type CreateWorkSessionResult,
  type GraphAuth,
  type GraphPort,
  type LoadSpawnContextInput,
  type Logger,
  type PtyActivity,
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
  WorktreeManager,
  type WorktreeAllocationRow,
  type WorktreeAllocationState,
  type WorktreeReconcileReport,
} from '@tm8/execution';
import { CollabError, SessionJournalRecordSchema } from '@tm8/contract';
import { BudgetExceededError } from '@tm8/prompt';
import { dispatchRequestInjection } from '@tm8/prompt';
import type { LoopExecutorPort } from '../scheduler/jobs/loops.js';
import type { W2MessagesHandoffsServiceOptions } from './services/w2/messages-handoffs.js';
import type {
  ExecutionDispatchInput,
  ExecutionDispatchResult,
  ExecutionLiveness,
  ExecutionPromptInput,
  ExecutionSpawnInput,
  ExecutionTerminalStartInput,
  ExecutionStreamsAttachInput,
  ExecutionTerminateInput,
  SessionJournalPage,
  SessionJournalRecord,
  SessionLaunchRecord,
} from '@tm8/contract';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import type { Db, DbClaims } from '../db/types.js';
import { DbAgentCredentialHome } from '../credentials/agent-credential-injection.js';
import { DbGitHubCredentialStore } from '../credentials/github-credential-store.js';
import type { ServerConfig } from '../http/config.js';
import { fail } from '../http/errors.js';
import type { RequestContext } from '../http/types.js';
import { json } from '../http/types.js';
import { claimsFor, commandEnvelope, requireUuidParam } from './context.js';
import { toCommandResult, type RpcCommandResult } from './handlers/entities.js';
import { createLoopbackOwnerResolver, type LoopbackOwner } from '../identity/loopback.js';
import type { HandlerRegistry } from './registry.js';
import { refusePublicExecutionPrompt } from './services/w2/execution.js';
import { issuePtyGrantToken } from '../pty/grant-token.js';
import {
  recordInteractionProfilePin as persistInteractionProfilePin,
  resolveInteractionProfileForLaunch,
} from '../profiles/w2-profile-resolver.js';
import { formatToken, generateSecret, hashToken } from '../identity/crypto.js';
import { SESSION_TTL_MS } from '../identity/pg-auth.js';

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
  version: number;
  title: string;
  description: string;
  priority: string;
  work_status: string;
  acceptance_criteria: unknown;
  /** Set when the task was derived from a thread message (064/099): the
   * thread's root message and the channel it lives on, for the prompt
   * envelope's <source>/<thread> elements. */
  thread_root_message_id: string | null;
  thread_channel_id: string | null;
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

interface MemoryRow {
  entity_id: string;
  statement: string;
  version: number;
  /** In the teammate's `remembers` working set (vs. only requested by id). */
  remembered: boolean;
  /** In some spawn task's `remembers` working set (D9: remembers(task → memory)). */
  task_remembered: boolean;
  superseded: boolean;
  disputed: boolean;
  verified: boolean;
  created_at: Date | string;
}

/**
 * Memory entities → the manifest's `agent.memory` strings, with their
 * epistemic state visible (design §4.2: the receiving agent must see what is
 * verified vs disputed rather than trusting everything equally).
 *
 * Superseded memories are DROPPED from the working set — the 056 read rule is
 * "reads resolve to the chain head", and the head is either also remembered or
 * the working-set edge has not been moved yet, in which case injecting the
 * stale predecessor would be injecting known-replaced context. An explicitly
 * requested id is different: the caller named THAT memory, so it is injected
 * with its `[superseded]` marker instead of second-guessing the request.
 */
function renderMemories(rows: MemoryRow[], requestedIds: string[]): string[] {
  const render = (r: MemoryRow): string => {
    const marks: string[] = [];
    if (r.superseded) marks.push('superseded');
    if (r.disputed) marks.push('disputed');
    if (r.verified) marks.push('verified');
    return marks.length > 0 ? `${r.statement} [${marks.join(', ')}]` : r.statement;
  };
  const emitted = new Set<string>();
  const out: string[] = [];
  // 1. The persona's own working set.
  for (const r of rows) {
    if (!r.remembered || r.superseded) continue;
    out.push(render(r));
    emitted.add(r.entity_id);
  }
  // 2. Task working sets (D9): what the spawn tasks remember, after the
  //    persona's set — the persona's standing knowledge frames task context,
  //    not the other way round. Same superseded-drop rule as the working set.
  for (const r of rows) {
    if (!r.task_remembered || r.superseded || emitted.has(r.entity_id)) continue;
    out.push(render(r));
    emitted.add(r.entity_id);
  }
  // 3. Requested extras follow the caller's order, after both sets.
  for (const id of requestedIds) {
    if (emitted.has(id)) continue;
    const row = rows.find((r) => r.entity_id === id);
    if (!row) continue; // absence already refused upstream
    out.push(render(row));
    emitted.add(id);
  }
  return out;
}

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
    /**
     * The VANILLA TERMINAL cap (101) — disjoint from `sessionCap` above and
     * from the credential cap, so no one kind of session can starve another.
     * See `resolveTerminalCap`.
     */
    private readonly terminalCap = resolveTerminalCap(),
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

      // The persona's working set lives in the graph: memory ENTITIES linked by
      // `remembers` edges (056), not the legacy `team_members.memories` jsonb.
      // Migration 084 moved the jsonb entries into the graph and emptied the
      // column; any jsonb remainder (written by a not-yet-updated editor path)
      // is still injected so a write never silently vanishes. Task working
      // sets (D9: remembers(task → memory)) ride the same query — what a
      // spawn task remembers reaches the session automatically. Requested
      // `memoryIds` (D3a) are validated hard — a spawn that names a memory the
      // caller cannot read, or that is not a memory, must refuse rather than
      // quietly inject less than was asked.
      const requestedIds = input.memoryIds ?? [];
      const spawnTaskIds = input.taskIds ?? [];
      const memoryRows = await q.query<MemoryRow>(
        `select m.entity_id, m.statement, e.version,
                (r.dst_id is not null) as remembered,
                exists (select 1 from public.edges t
                         where t.type = 'remembers' and t.src_id = any($4::uuid[])
                           and t.dst_id = m.entity_id) as task_remembered,
                exists (select 1 from public.edges s
                         where s.type = 'supersedes' and s.dst_id = m.entity_id) as superseded,
                exists (select 1 from public.edges d
                         where d.type = 'disputes' and d.dst_id = m.entity_id
                           and (d.props ->> 'pinnedVersion')::int = e.version) as disputed,
                exists (select 1 from public.edges v
                         where v.type = 'verifies' and v.dst_id = m.entity_id
                           and (v.props ->> 'pinnedVersion')::int = e.version) as verified,
                m.created_at
           from public.memories m
           join public.entities e on e.id = m.entity_id and e.deleted_at is null
           left join public.edges r
             on r.type = 'remembers' and r.src_id = $1 and r.dst_id = m.entity_id
          where e.space_id = $2
            and (r.dst_id is not null
                 or m.entity_id = any($3::uuid[])
                 or exists (select 1 from public.edges t2
                             where t2.type = 'remembers' and t2.src_id = any($4::uuid[])
                               and t2.dst_id = m.entity_id))
          order by m.created_at, m.entity_id`,
        [input.teamMemberId, input.spaceId, requestedIds, spawnTaskIds],
      );
      const foundIds = new Set(memoryRows.map((r) => r.entity_id));
      const missing = requestedIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw fail(
          'not_found',
          `memoryIds not found in this space (or not memory entities): ${missing.join(', ')}`,
        );
      }
      const injectedMemories = renderMemories(memoryRows, requestedIds);

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
              // The lateral join carries a THREAD-derived task's origin into
              // the prompt envelope: when the task was derived (064/099) from
              // a message, the agent is told the thread root and its channel
              // so it can read the LIVE thread rather than a stale snapshot.
              // `derived_from` targets thread roots since 099; the coalesce
              // covers pre-099 rows whose dst may be a reply.
              `select t.entity_id, e.version, t.title, t.description, t.priority, t.work_status,
                      t.acceptance_criteria,
                      dm.root_id as thread_root_message_id,
                      dm.anchor_id as thread_channel_id
                 from public.tasks t
                 join public.entities e on e.id = t.entity_id
                 left join lateral (
                   select coalesce(m.root_message_id, m.entity_id) as root_id,
                          m.anchor_id
                     from public.edges d
                     join public.messages m on m.entity_id = d.dst_id
                    where d.src_id = t.entity_id and d.type = 'derived_from'
                    limit 1
                 ) dm on true
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
          // Graph working set first; any legacy jsonb remainder (pre-084
          // writers) rides along so no entry silently vanishes mid-cutover.
          memories: [
            ...injectedMemories,
            ...(Array.isArray(member.memories) ? member.memories : []),
          ],
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
            version: t.version,
            title: t.title,
            description: t.description,
            priority: t.priority,
            workStatus: t.work_status,
            acceptanceCriteria: Array.isArray(t.acceptance_criteria) ? t.acceptance_criteria : [],
            threadRootMessageId: t.thread_root_message_id ?? null,
            threadChannelId: t.thread_channel_id ?? null,
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

  /**
   * The ONE read behind a vanilla terminal (101) — the project, or nothing.
   *
   * Query-for-query identical to `loadSpawnContext`'s project block, including
   * the not-linked/not-found conflation and the reason for it. What it does not
   * do is the other four reads: no persona, no memory working set, no skill
   * chain, no tasks. A shell session has no persona to read them for, and
   * reaching the big loader with a synthetic team member id to get one column
   * back is the "pretend it is an agent" shape this feature exists to avoid.
   *
   * No transaction, and unlike `loadSpawnContext` that is not a compromise: one
   * query already describes one instant.
   */
  async loadShellContext(
    auth: GraphAuth,
    input: { spaceId: string; projectId: string | null },
  ): Promise<ShellSessionContext> {
    if (!input.projectId) return { project: null };
    const rows = await this.db.query<ProjectRow>(
      this.claims(auth),
      `select p.id, p.name, p.working_dir, p.trust
         from public.projects p
         join public.space_projects sp
           on sp.project_id = p.id and sp.space_id = $2
        where p.id = $1`,
      [input.projectId, input.spaceId],
    );
    const row = rows[0];
    if (!row) {
      throw fail('not_found', `project ${input.projectId} is not linked to this space`);
    }
    return {
      project: {
        id: row.id,
        name: row.name,
        workingDir: row.working_dir,
        trust: row.trust === 'trusted' ? 'trusted' : 'untrusted',
      },
    };
  }

  /**
   * `public.start_shell_session` (101) — mint the `session_kind='shell'` row.
   *
   * Positional, in the migration's declared order, and the same warning applies
   * as on `createWorkSession`: getting the order wrong is a silent semantic
   * swap, not a type error. `p_title`, `p_node_id` and `p_workdir_path` are
   * three adjacent text parameters and are the set to watch.
   *
   * `this.terminalCap`, NOT `this.sessionCap`. They are separate ceilings on
   * purpose (see the migration's externality 1): a member with terminals open
   * must not find real spawns refusing with a capacity error.
   */
  async createShellSession(
    auth: GraphAuth,
    input: ShellSessionRequest & { nodeId: string | null; workdirPath: string | null },
  ): Promise<StartShellSessionResult> {
    const result = await this.db.rpc<Record<string, unknown>>(
      this.claims(auth),
      'public.start_shell_session',
      [
        input.spaceId,
        input.projectId,
        input.title ?? null,
        input.nodeId,
        input.workdirPath,
        input.confirmUntrusted ?? false,
        this.terminalCap,
        null, // p_actor_id — resolve_actor derives it from the claims
        input.clientMutationId ?? null,
      ],
    );

    const replayed = result?.__tm8_replayed === true;
    const { __tm8_replayed: _replayMarker, ...commandResult } = result ?? {};
    const entity = commandResult.entity as { id?: string } | undefined;
    const sessionId = entity?.id;
    if (typeof sessionId !== 'string') {
      throw fail('upstream_unavailable', 'start_shell_session returned no work_session id');
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

  async issueWorkSessionAgentToken(
    auth: GraphAuth,
    sessionId: string,
    teamMemberId: string,
  ): Promise<string> {
    const secret = generateSecret();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS.agent).toISOString();
    const row = await this.db.rpc<{ id?: string }>(
      this.claims(auth),
      'public.issue_work_session_agent_session',
      [sessionId, teamMemberId, hashToken(secret), expiresAt, `work-session:${sessionId}`],
    );
    if (typeof row?.id !== 'string') {
      throw fail('upstream_unavailable', 'work-session token mint returned no auth session id');
    }
    return formatToken(row.id, secret);
  }

  async recordManifest(
    auth: GraphAuth,
    sessionId: string,
    manifest: Tm8Manifest,
    envVarNames: string[],
    prompts: { system: string; task: string },
    agentConfigDir: string | null,
  ): Promise<void> {
    await this.db.rpc(this.claims(auth), 'public.record_session_manifest', [
      sessionId,
      JSON.stringify(manifest),
      envVarNames,
      prompts.system,
      prompts.task,
      agentConfigDir,
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
        parent_id: string | null;
        project_id: string | null;
        workdir_mode: string;
        workdir_path: string | null;
        mode: string | null;
        model: string | null;
        agent_tool: string | null;
        title: string;
        status: string;
        native_session_id: string | null;
        agent_config_dir: string | null;
      }>(
        `select ws.entity_id, e.space_id, e.parent_id, ws.project_id, ws.workdir_mode,
                ws.workdir_path, ws.mode, ws.model, ws.agent_tool, ws.title,
                ws.status, ws.native_session_id, ws.agent_config_dir
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
        parentSessionId: row.parent_id,
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
        agentConfigDir: row.agent_config_dir,
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
    const rows = await this.db.query<{
      access_mode: string | null;
      permission_mode: string | null;
      credential_source: string | null;
      anthropic_credential_source: string | null;
      openai_credential_source: string | null;
      github_credential_source: string | null;
    }>(
      this.claims(auth),
      `select sm.manifest #>> '{launch,accessMode}'       as access_mode,
              sm.manifest #>> '{launch,permissionMode}'   as permission_mode,
              sm.manifest #>> '{launch,credentialSource}' as credential_source,
              sm.manifest #>> '{launch,credentialSources,anthropic}' as anthropic_credential_source,
              sm.manifest #>> '{launch,credentialSources,openai}'    as openai_credential_source,
              sm.manifest #>> '{launch,credentialSources,github}'    as github_credential_source
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
      credentialSource: row.credential_source as SessionLaunchPosture['credentialSource'],
      credentialSources: {
        anthropic: row.anthropic_credential_source,
        openai: row.openai_credential_source,
        github: row.github_credential_source,
      } as SessionLaunchPosture['credentialSources'],
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
   * The session's lane fact (107) — NOT write-once, unlike the native id
   * above: a checkout legitimately changes branches, and the function bumps
   * `entities.version` only when the stored value actually changed, so a
   * refresh that re-measures the same branch is a no-op to every consumer.
   */
  async recordCheckoutBranch(
    auth: GraphAuth,
    sessionId: string,
    branch: string | null,
  ): Promise<boolean> {
    const changed = await this.db.rpc<boolean>(
      this.claims(auth),
      'public.execution_record_checkout_branch',
      [
        sessionId,
        branch,
        null, // p_actor_id — derived from claims
      ],
    );
    return changed === true;
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

  // --- worktree provisioning (design §4) --------------------------------------
  //
  // Six writes and two reads, one door call each. They are separate for the
  // reason the port declares them separately: every gap between two of them is
  // a crash boundary the reconciler has a named repair for, and collapsing them
  // into one RPC would erase the states rather than avoid them.
  //
  // NONE of these takes the per-project Git lock. The caller holds it,
  // in-process, OUTSIDE these calls — `internal.ledger_replay` is the first
  // statement of every ledgered door and already holds an advisory lock;
  // nesting beneath it is the documented deadlock (design §5.1).

  async reserveWorktreeAllocation(
    auth: GraphAuth,
    input: {
      worktreeId: string;
      spaceId: string;
      projectId: string;
      nodeId: string;
      path: string;
      branch: string;
      cap: number;
    },
  ): Promise<void> {
    await this.db.rpc(this.claims(auth), 'public.reserve_worktree_allocation', [
      input.worktreeId,
      input.spaceId,
      input.projectId,
      input.nodeId,
      input.path,
      input.branch,
      input.cap,
    ]);
  }

  async setWorktreeAllocationState(
    auth: GraphAuth,
    input: {
      worktreeId: string;
      state: WorktreeAllocationState;
      failureCode?: string | null;
      failureDetail?: Record<string, unknown> | null;
      countAttempt?: boolean;
    },
  ): Promise<void> {
    await this.db.rpc(this.claims(auth), 'public.set_worktree_allocation_state', [
      input.worktreeId,
      input.state,
      input.failureCode ?? null,
      input.failureDetail ? JSON.stringify(input.failureDetail) : null,
      input.countAttempt ?? false,
    ]);
  }

  async createWorktreeEntity(
    auth: GraphAuth,
    input: {
      worktreeId: string;
      spaceId: string;
      projectId: string;
      path: string;
      branch: string;
      baseRef: string;
      baseCommitOid: string;
    },
  ): Promise<void> {
    await this.db.rpc(this.claims(auth), 'public.create_worktree', [
      input.spaceId,
      input.projectId,
      input.path,
      input.branch,
      input.baseRef,
      input.baseCommitOid,
      null, // p_actor_id — resolve_actor derives it from the claims
      // Deliberately NOT the spawn's mutation id: the ledger binds one cmid to
      // one operation (DEV-9), and `execution_spawn` is about to claim it. The
      // worktree create is made idempotent by its own unique constraints
      // instead, which is what turns a retry into a 23505 rather than a
      // duplicate checkout.
      null,
      input.worktreeId,
    ]);
  }

  async acquireWorktreeLease(
    auth: GraphAuth,
    worktreeId: string,
    sessionId: string,
  ): Promise<void> {
    await this.db.rpc(this.claims(auth), 'public.acquire_worktree_lease', [worktreeId, sessionId]);
  }

  async releaseWorktreeLease(auth: GraphAuth, worktreeId: string): Promise<void> {
    await this.db.rpc(this.claims(auth), 'public.release_worktree_lease', [worktreeId]);
  }

  /**
   * The `in_worktree` edge, through its OWN door rather than generic
   * `write_edge`.
   *
   * 052 added `in_worktree` to the origin-stamping branch and minted a
   * `worktree_manager` writer token so that "a spawn-created association is
   * distinguishable from a hand-drawn one". `write_edge` sets no token, so an
   * edge written through it stamps `origin = 'user'` — right for a human
   * drawing the edge, wrong for this, and it would have quietly made 052's
   * token dead code. `props` is still never supplied: `origin` is Server-owned
   * and the trigger is what writes it.
   */
  async linkSessionToWorktree(
    auth: GraphAuth,
    input: { spaceId: string; sessionId: string; worktreeId: string },
  ): Promise<void> {
    await this.db.rpc(this.claims(auth), 'public.link_session_worktree', [
      input.sessionId,
      input.worktreeId,
    ]);
  }

  async listNodeWorktreeAllocations(
    auth: GraphAuth,
    nodeId: string,
  ): Promise<WorktreeAllocationRow[]> {
    const rows = await this.db.query<{
      worktree_entity_id: string;
      project_id: string | null;
      state: string;
      path: string | null;
      branch: string | null;
      lease_session_id: string | null;
      attempts: number;
      failure_code: string | null;
      entity_exists: boolean;
      worktree_status: string | null;
      lease_session_status: string | null;
      updated_at: string | null;
    }>(this.claims(auth), 'select * from public.node_worktree_allocations($1)', [nodeId]);
    return rows.map((r) => ({
      worktreeId: r.worktree_entity_id,
      projectId: r.project_id,
      state: r.state as WorktreeAllocationState,
      path: r.path,
      branch: r.branch,
      leaseSessionId: r.lease_session_id,
      attempts: Number(r.attempts),
      failureCode: r.failure_code,
      entityExists: r.entity_exists === true,
      worktreeStatus: r.worktree_status,
      leaseSessionStatus: r.lease_session_status,
      updatedAt: r.updated_at === null ? null : String(r.updated_at),
    }));
  }

  async loadProjectWorkingDir(auth: GraphAuth, projectId: string): Promise<string | null> {
    const rows = await this.db.query<{ working_dir: string }>(
      this.claims(auth),
      'select working_dir from public.projects where id = $1',
      [projectId],
    );
    return rows[0]?.working_dir ?? null;
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
    tokenHash: string,
  ): Promise<Record<string, unknown>> {
    return this.db.rpc<Record<string, unknown>>(this.claims(auth), 'public.grant_stream_attach', [
      sessionId,
      mode,
      tokenHash,
      '30 seconds',
      // A capability cannot be ledger-replayed: the bearer is returned once
      // and never stored, while replaying the old row with a freshly generated
      // bearer would return a token whose hash is not in the database.
      null,
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

/**
 * How many vanilla terminals (101) may be live on this node at once.
 *
 * A THIRD, DISJOINT CEILING, mirroring `resolveCredentialSessionCap`. The
 * default is deliberately small: a terminal is a human-driven session, one
 * person can only usefully watch a few, and a low default makes a runaway
 * client (a start button in a reconnect loop) refuse early and visibly instead
 * of filling the node with orphaned shells. Operators who want more say so.
 *
 * Shares `TM8_SESSION_CAP`'s parsing rules, including the saturating int4 for
 * "unlimited" and the refusal to let a typo become a SMALLER cap than the
 * default — see `resolveSessionCap` for why each of those is what it is.
 */
export const DEFAULT_TERMINAL_CAP = 4;

export function resolveTerminalCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['TM8_TERMINAL_CAP']?.trim();
  if (raw === undefined || raw === '') return DEFAULT_TERMINAL_CAP;
  if (/^(unlimited|none|off|0)$/i.test(raw)) return UNLIMITED_SESSION_CAP;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_TERMINAL_CAP;
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
  register(registry: HandlerRegistry, options?: RegisterHandlersOptions): void;
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
  /**
   * §6 — reconcile this node's worktree ALLOCATIONS. A sibling of
   * `reconcileGhosts`, called at the same point and with the same posture: the
   * composition root owns the ordering, and it never rejects. Kept separate
   * because they answer different questions (a stuck row versus a leaked Git
   * checkout) and a node with no worktree area still wants the first.
   */
  reconcileWorktrees(): Promise<WorktreeReconcileReport>;
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
    // Same lazy-closure reason as onSessionStatus above: the activity sink also
    // needs the SpawnService that holds the spawner's claims, and for the same
    // identity reason — an idle transition is written by the same RPC, through
    // the same require_identity path, as an exit transition.
    onActivityChange: (sessionId: string, activity: PtyActivity) =>
      spawnService.handlePtyActivity(sessionId, activity),
  });

  // The node's worktree area lives beside manifests/journals/scratch under the
  // same data root, so one confidentiality and backup boundary covers all four.
  // Its PRESENCE is what makes `workdir.mode:'worktree'` serviceable; a node
  // built without a data root simply does not advertise it (§7.4), rather than
  // quietly handing back the shared project directory.
  const worktrees = resolveWorktreeManager(deps.dataDir);

  spawnService = new SpawnService({
    graph,
    pty,
    baseUrl: `http://${deps.config.host}:${deps.config.port}`,
    ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
    nodeId: deps.nodeId ?? `${deps.config.host}:${deps.config.port}`,
    ...(deps.logger ? { logger: deps.logger } : {}),
    // Per-member credential delivery. Wired ONLY when this node has a data
    // root, because the credential home is a path underneath it: with no data
    // root there is nowhere a login terminal could have written a credential,
    // so there is nothing to read and the spawn loop behaves exactly as before.
    ...(deps.dataDir
      ? {
          credentialHome: new DbAgentCredentialHome({ db: deps.db, dataDir: deps.dataDir }),
          gitHubCredentials: new DbGitHubCredentialStore({
            db: deps.db,
            dataDir: deps.dataDir,
            ...(deps.logger ? { logger: deps.logger } : {}),
          }),
        }
      : {}),
    ...(worktrees ? { worktrees } : {}),
    worktreeCap: resolveWorktreeCap(process.env),
  });

  const owner = deps.owner ?? createLoopbackOwnerResolver(deps.db);

  return {
    pty,
    promptSettlement,
    spawnService,
    graph,
    register: (registry, options) =>
      registerHandlers(registry, spawnService, graph, deps.db, owner, pty, sessionCap, deps.dataDir, options),
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
    reconcileWorktrees: async () => {
      // Same identity story as ghost reconciliation and for the same reason:
      // the doors below go through `require_space_member`, which has no
      // node-admin bypass, and the node's owner is the honest actor — they are
      // whose node left the checkouts behind.
      try {
        const o = await owner();
        return await spawnService.reconcileNodeWorktrees({
          identityId: o.identityId,
          nodeAdmin: o.isNodeAdmin,
          requestId: 'startup-reconcile-worktrees',
        });
      } catch (error) {
        deps.logger?.warn?.('execution: worktree reconciliation skipped', {
          error: error instanceof Error ? error.message : String(error),
        });
        return { examined: 0, repaired: [], quarantined: [], errors: [] };
      }
    },
  };
}

/**
 * `<dataDir>/worktrees`, or nothing.
 *
 * Returning null rather than defaulting to a path under `homedir()` is
 * deliberate: a node that was not told where its data lives should not start
 * inventing checkout locations in a user's home directory, and §7.4 would
 * rather the capability be absent than approximate.
 */
function resolveWorktreeManager(dataDir: string | undefined): WorktreeManager | null {
  if (!dataDir) return null;
  return new WorktreeManager({ worktreeRoot: resolvePath(dataDir, 'worktrees') });
}

/**
 * §5.2's worktree cap. Separate from the session cap because it bounds a
 * different scarce resource — disk and `.git/worktrees` metadata — and one
 * worktree outlives many sessions. Absent or unparseable means unbounded, which
 * matches the shipped posture for the session cap and keeps a typo from
 * silently throttling a node to zero.
 */
function resolveWorktreeCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TM8_WORKTREE_CAP?.trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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
  const worktrees = resolveWorktreeManager(deps.dataDir);
  const spawnService = new SpawnService({
    graph,
    pty: deps.pty,
    baseUrl: `http://${deps.config.host}:${deps.config.port}`,
    ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
    nodeId: `${deps.config.host}:${deps.config.port}`,
    ...(deps.logger ? { logger: deps.logger } : {}),
    // Same wiring as `createExecutionRuntime` above, deliberately duplicated
    // rather than shared: a node on the legacy shape must not silently lose
    // per-member credentials just because it wires the runtime differently.
    ...(deps.dataDir
      ? {
          credentialHome: new DbAgentCredentialHome({ db: deps.db, dataDir: deps.dataDir }),
          gitHubCredentials: new DbGitHubCredentialStore({
            db: deps.db,
            dataDir: deps.dataDir,
            ...(deps.logger ? { logger: deps.logger } : {}),
          }),
        }
      : {}),
    ...(worktrees ? { worktrees } : {}),
    worktreeCap: resolveWorktreeCap(process.env),
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
    reconcileWorktrees: async () => {
      try {
        const o = await owner();
        return await spawnService.reconcileNodeWorktrees({
          identityId: o.identityId,
          nodeAdmin: o.isNodeAdmin,
          requestId: 'startup-reconcile-worktrees',
        });
      } catch {
        return { examined: 0, repaired: [], quarantined: [], errors: [] };
      }
    },
  };
}

// --- handlers ----------------------------------------------------------------

/** SpawnService speaks its own error vocabulary; the wire speaks the taxonomy. */
export function toCollabError(error: unknown): unknown {
  if (error instanceof BudgetExceededError) {
    return fail('payload_too_large', error.message, {
      material: error.material,
      bytes: error.bytes,
      cap: error.cap,
    });
  }
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
  forceNewTask = false,
): Promise<string[]> {
  const anchors: string[] = [];
  for (const subjectId of subjectIds) {
    const derived = await db.rpc<{ taskId?: string } | null>(
      claims,
      'public.derive_task_for_entity',
      // p_actor_id is null: resolve_actor derives it from the claims, the same
      // convention createWorkSession uses. p_force_new mints a fresh derived
      // task past the reuse branch (099) — the "new task in this thread"
      // gesture; a subject that already IS a task ignores it (fast path).
      [spaceId, subjectId, null, forceNewTask],
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

// --- execution.transcript (read) ---------------------------------------------
// Far smaller than the journal's window because a transcript TURN is prose, not
// a fixed-size record: 500 of them is a wall of text no debug surface renders
// and no coordinator reads. The reader's own tail window bounds the bytes; this
// bounds the turns.
const TRANSCRIPT_LAST_DEFAULT = 20;
const TRANSCRIPT_LAST_MAX = 200;

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

/**
 * How long `execution.dispatch` waits for a dispatcher it just spawned to
 * actually own a PTY before giving up on pushing the envelope at it.
 *
 * Bounded and short. A spawn that has not produced a terminal in this window is
 * not necessarily broken — a cold agent CLI can be slow — but this is an HTTP
 * request, and that request's job is done once the message is durably stored.
 * Timing out here costs the caller a `delivery: 'undelivered'`, not the work.
 */
const DISPATCHER_SETTLE_TIMEOUT_MS = 15_000;
const DISPATCHER_SETTLE_POLL_MS = 250;

/**
 * The durable half of a dispatch request — what a human reads on the task, and
 * what the dispatcher re-reads if it wakes without having received the push.
 * Plain prose on purpose: the trusted envelope is the machine-addressed copy.
 */
function dispatchRequestBody(subjectId: string, taskId: string, note: string | null): string {
  const lines = [
    `Dispatch requested for this task (subject \`${subjectId}\`, anchor \`${taskId}\`).`,
    '',
    'Pick the teammate, attach the memories they need to this task, spawn them on it, and reply here with who and why.',
  ];
  if (note) lines.push('', `Requester note: ${note}`);
  return lines.join('\n');
}

export interface DispatchRequestSend {
  db: Db;
  claims: DbClaims;
  seam?: DispatchDelivery;
  taskId: string;
  subjectId: string;
  dispatcherSessionId: string;
  note: string | null;
  requesterActorId: string | null;
  requesterActorKind: string;
  requestId: string;
  clientMutationId: string;
}

/**
 * Store a dispatch request on the task AND push it at the dispatcher's terminal.
 *
 * ONE implementation, two callers — `execution.dispatch` and the loop executor.
 * They were briefly two, and the loop one simply forgot the second half: it
 * resolved a dispatcher and told it nothing, so a null-runner loop fired
 * silently forever. Two copies of "how do you ask a dispatcher for something"
 * is exactly the drift this collapses.
 *
 * Order is failure-cost order: STORE first, push second. A stored request that
 * was never delivered is recoverable — the dispatcher reads its anchor when it
 * next wakes — while a delivered request with no durable row is not. Delivery
 * is therefore REPORTED, never thrown on.
 */
async function sendDispatchRequest(
  args: DispatchRequestSend,
): Promise<{ requestMessageId: string | undefined; delivered: boolean }> {
  const { db, claims, seam, taskId, subjectId, dispatcherSessionId, note } = args;

  const posted = await db.tx(claims, async (q) =>
    q.rpc<{ messageIds: string[] }>('w2_post_message_batch', [
      [taskId],
      dispatchRequestBody(subjectId, taskId, note),
      null,
      [],
      [],
      null,
      args.requesterActorId,
      args.clientMutationId,
    ]),
  );
  const requestMessageId = posted.messageIds[0];
  if (!seam || !requestMessageId) return { requestMessageId, delivered: false };

  const content = dispatchRequestInjection({
    messageId: requestMessageId,
    taskId,
    subjectId,
    requesterActorId: args.requesterActorId,
    requesterActorKind: args.requesterActorKind,
    destinationSessionId: dispatcherSessionId,
    note,
  });
  try {
    const reservation = await seam.reserve({
      messageId: requestMessageId,
      targetWorkSessionId: dispatcherSessionId,
      content,
      mode: 'send',
      requestId: args.requestId,
    });
    if (!reservation) return { requestMessageId, delivered: false };
    await seam.adapter.dispatch({
      ...reservation,
      content,
      requestId: args.requestId,
      principal: seam.principalFor(reservation),
    });
    return { requestMessageId, delivered: true };
  } catch {
    // The durable row already exists; an adapter failure downgrades the report,
    // it does not roll back the dispatch.
    return { requestMessageId, delivered: false };
  }
}

/**
 * The live dispatcher session for a space, or null.
 *
 * PROBES; never reads `work_sessions.status`, which is the column this function
 * exists to distrust. A session that died with its node keeps whatever status
 * it had forever — nothing is left running to write a new one — and `idle` is a
 * perfectly legal status for a session that IS alive and simply waiting for
 * input. So neither `running` nor `idle` nor their absence answers the
 * question. The PTY map does, because it IS the terminals.
 *
 * Scoped under the caller's claims, so a live dispatcher the caller cannot read
 * is invisible rather than leaked — the posture `execution.liveness` takes.
 */
async function findLiveDispatcherSession(
  db: Db,
  claims: DbClaims,
  spaceId: string,
  pty: PtyHostService,
): Promise<string | null> {
  const live = pty.liveSessionIds();
  if (live.length === 0) return null;
  const rows = await db.query<{ id: string }>(
    claims,
    `select ws.entity_id::text id
       from public.work_sessions ws
       join public.entities e on e.id = ws.entity_id
      where e.space_id = $1
        and e.deleted_at is null
        and ws.mode = 'dispatcher'
        and ws.entity_id = any($2::uuid[])
      order by ws.created_at desc
      limit 1`,
    [spaceId, live],
  );
  return rows[0]?.id ?? null;
}

/** Wait for a freshly spawned session to actually own a terminal. */
async function awaitDispatcherSettlement(pty: PtyHostService, sessionId: string): Promise<boolean> {
  const deadline = Date.now() + DISPATCHER_SETTLE_TIMEOUT_MS;
  for (;;) {
    if (pty.liveSessionIds().includes(sessionId)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, DISPATCHER_SETTLE_POLL_MS));
  }
}

/**
 * The delivery seam `execution.dispatch` pushes its envelope through.
 *
 * Structurally the messages seam's `messageDelivery`, and optional for the same
 * reason: it carries the second database identity (`tm8_delivery_worker`) that
 * `tm8_app` provably cannot assume, so a node without that role configured must
 * still be able to dispatch. Without it the request message is still stored on
 * the task and the result says `undelivered` — a degraded mode the caller can
 * SEE, rather than a silent one.
 */
export type DispatchDelivery = NonNullable<
  W2MessagesHandoffsServiceOptions['messageDelivery']
>;

export interface RegisterHandlersOptions {
  readonly dispatchDelivery?: DispatchDelivery;
}

/**
 * Find the space's live dispatcher session, or spawn one and wait for it.
 *
 * Shared by `execution.dispatch` and the loop executor rather than written
 * twice: two copies of "is there a dispatcher" would eventually disagree about
 * the liveness rule, and the whole reason this is server-side is that the
 * liveness rule is the part everyone gets wrong.
 */
async function resolveDispatcherSession(
  db: Db,
  claims: DbClaims,
  pty: PtyHostService,
  spawnService: SpawnService,
  spaceId: string,
  clientMutationId: string,
): Promise<{ sessionId: string; spawned: boolean }> {
  const live = await findLiveDispatcherSession(db, claims, spaceId, pty);
  if (live) return { sessionId: live, spawned: false };

  // Agents can never seed teammates (that is boot's job), so a space with no
  // dispatcher teammate is a configuration fact to report, not a thing to fix
  // by inventing a persona.
  const teammates = await db.query<{ id: string }>(
    claims,
    `select tm.entity_id::text id
       from public.team_members tm
       join public.entities e on e.id = tm.entity_id
      where e.space_id = $1 and e.deleted_at is null and tm.mode = 'dispatcher'
      order by tm.created_at
      limit 1`,
    [spaceId],
  );
  const teammateId = teammates[0]?.id;
  if (!teammateId) {
    throw fail(
      'not_found',
      'this space has no dispatcher teammate; it is seeded at boot and cannot be created at runtime',
    );
  }
  const spawned = await rethrowing(() =>
    spawnService.spawn(claims, {
      spaceId,
      teamMemberId: teammateId,
      parentSessionId: null,
      projectId: null,
      mode: 'dispatcher',
      model: null,
      agentTool: null,
      reasoningEffort: null,
      accessMode: null,
      title: 'Dispatcher',
      promptExtra: null,
      clientMutationId,
    }),
  );
  await awaitDispatcherSettlement(pty, spawned.sessionId);
  return { sessionId: spawned.sessionId, spawned: true };
}

/**
 * The live `LoopExecutorPort` (dreamer-dispatcher §4.4).
 *
 * This is the seam that keeps `scheduler/jobs/loops.ts` testable: the job
 * itself imports no PTY host and no SpawnService, so it can be exercised
 * against fakes. This factory is where the real ones get attached, and it lives
 * in this file because this file is already the ONLY place that knows both
 * `Db` and `PtyHostService`.
 *
 * A firing does three things, in an order chosen so a crash between any two
 * leaves the graph honest rather than lying:
 *   1. derive the task (064) — idempotent, reused if one already exists;
 *   2. `triggered_by` from that task to the loop, BEFORE spawning, so a firing
 *      that dies mid-spawn still shows in the loop's run history;
 *   3. spawn (or route to the dispatcher), then `triggered_by` from the
 *      session too.
 */
export function createLoopExecutorPort(deps: {
  db: Db;
  pty: PtyHostService;
  spawnService: SpawnService;
  resolveOwner: () => Promise<LoopbackOwner>;
  /** Same seam `execution.dispatch` uses; absent ⇒ stored-but-undelivered. */
  dispatchDelivery?: DispatchDelivery;
}): LoopExecutorPort {
  const { db, pty, spawnService, resolveOwner } = deps;

  const claimsForOwner = async (): Promise<DbClaims> => {
    const owner = await resolveOwner();
    // The node's loopback owner, exactly as ghost reconciliation does it: a
    // scheduled firing has no HTTP request and therefore no caller identity,
    // and `require_space_member` has no node-admin bypass.
    return {
      identityId: owner.identityId,
      nodeAdmin: owner.isNodeAdmin,
      requestId: 'loop-executor',
    };
  };

  return {
    claimsFor: claimsForOwner,
    liveSessionIds: () => pty.liveSessionIds(),
    async fire(loop, claims, firedAt) {
      // The loop is its OWN launchable subject when it names none (§4.4), so
      // there is always something to derive a task from.
      const [taskId] = await resolveAssignmentAnchors(
        db, claims, loop.spaceId, [loop.subjectId ?? loop.entityId],
      );
      if (!taskId) {
        throw new Error(`derive_task_for_entity returned no task for loop ${loop.entityId}`);
      }

      /**
       * THE firing key, and the reason it carries the instant.
       *
       * `derive_task_for_entity` REUSES an open derived task, so `taskId` is
       * stable across every firing of a loop whose task nobody closed. A
       * mutation id built from (loop, task) is therefore also stable — and
       * `execution_spawn` opens with `internal.ledger_replay(cmid,
       * 'execution.spawn')` (043) unconditionally, gated only by
       * `internal.idempotency_enabled()`, which DEFAULTS ON (046; the server
       * pool sends `tm8.idempotency_enabled=on` unless
       * `TM8_IDEMPOTENCY_ENABLED=0`). On a replay hit SpawnService takes its
       * `replayed` branch, returns the ORIGINAL session id with `reused: true`
       * and boots no PTY at all.
       *
       * So a stable id makes every firing after the first a silent no-op that
       * looks like a success: the seeded Dreamer daily loop would spawn once
       * and then quietly never again. And the command ledger is not pruned on
       * this node — `retention.command-ledger` is registered as an inert stub —
       * so the poisoning is permanent, not a 24h window.
       *
       * A firing is a DISTINCT INTENT, so it gets a distinct id. Idempotency is
       * not what stops a pile-up here; the overlap guard is, and that is
       * precisely what it is for.
       */
      const firingKey = `${loop.entityId}:${firedAt.toISOString()}`;

      // STABLE on purpose, and the contrast with `firingKey` is the point: this
      // edge asserts "this task belongs to this loop", which is one fact no
      // matter how many times it fires. A replay here is the correct outcome.
      await writeTriggeredBy(db, claims, taskId, loop.entityId, `loop-task:${loop.entityId}:${taskId}`);

      let sessionId: string;
      if (loop.teamMemberId) {
        sessionId = (await spawnService.spawn(claims, {
          spaceId: loop.spaceId,
          teamMemberId: loop.teamMemberId,
          parentSessionId: null,
          taskIds: [taskId],
          projectId: null,
          mode: null,
          model: (loop.config?.['model'] as string | undefined) ?? null,
          agentTool: (loop.config?.['agentTool'] as string | undefined) ?? null,
          reasoningEffort: null,
          accessMode: (loop.config?.['accessMode'] as never) ?? null,
          title: loop.title,
          // The loop's instruction is launch-manifest context, not a runtime
          // prompt — the same channel `--context` uses.
          promptExtra: loop.prompt === '' ? null : loop.prompt,
          clientMutationId: `loop-fire:${firingKey}`,
        })).sessionId;
      } else {
        // A null runner means "route through the dispatcher" (§4.4). Resolving
        // one is only half of it: a dispatcher that is never TOLD anything sits
        // idle while the loop records a successful firing. It goes through the
        // same `sendDispatchRequest` the HTTP op uses, so the two callers
        // cannot drift.
        const resolved = await resolveDispatcherSession(
          db, claims, pty, spawnService, loop.spaceId,
          `loop-dispatcher-spawn:${firingKey}`,
        );
        sessionId = resolved.sessionId;
        await sendDispatchRequest({
          db,
          claims,
          ...(deps.dispatchDelivery ? { seam: deps.dispatchDelivery } : {}),
          taskId,
          subjectId: loop.subjectId ?? loop.entityId,
          dispatcherSessionId: sessionId,
          note: loop.prompt === '' ? null : loop.prompt,
          requesterActorId: null,
          requesterActorKind: 'work_session',
          requestId: `loop-fire:${loop.entityId}`,
          clientMutationId: `loop-dispatch-request:${firingKey}`,
        });
      }

      await writeTriggeredBy(db, claims, sessionId, loop.entityId, `loop-session:${firingKey}:${sessionId}`);
      return { taskId, sessionId };
    },
  };
}

/** Run history is the loop's inbound edge set; best-effort, never fatal. */
async function writeTriggeredBy(
  db: Db,
  claims: DbClaims,
  srcId: string,
  loopId: string,
  clientMutationId: string,
): Promise<void> {
  try {
    await db.tx(claims, async (q) => {
      await q.rpc('write_edge', [
        srcId, loopId, 'triggered_by',
        JSON.stringify({ firedAt: new Date().toISOString() }),
        null, clientMutationId,
      ]);
    });
  } catch {
    // A duplicate edge (a re-derived task firing twice) is not a failure, and
    // provenance is never worth failing a live firing for.
  }
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
  options: RegisterHandlersOptions = {},
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
  /**
   * execution.launch — the session's stored spawn configuration.
   *
   * NO ENTITY PRE-CHECK, unlike `execution.journal` above, and that is not an
   * oversight. The journal handler has to resolve the entity first because its
   * payload comes from the FILESYSTEM, where RLS cannot reach; here the payload
   * IS a row, and `session_manifests_select` already requires
   * `entity_readable(work_session_id)`. A second read would only re-answer the
   * question the policy is about to answer anyway, and would introduce a
   * difference between "no such session" and "no manifest for it" that this
   * surface must not expose: a session the caller cannot read must look exactly
   * like a session that has no manifest.
   *
   * The prompts are returned VERBATIM and are NOT recomposed when absent. A
   * pre-073 session has no recorded prompt and says so; the alternative —
   * running `composePrompt` over the stored manifest — would render today's
   * build's output as though it were the text that agent received.
   */
  registry.register('execution.launch', async (ctx) => {
    const owner = await resolveOwner();
    const claims = claimsFor(owner, ctx);
    const sessionId = requireUuidParam(ctx, 'workSessionId');

    const rows = await db.query<{
      manifest: unknown;
      env_var_names: string[] | null;
      system_prompt: string | null;
      task_prompt: string | null;
      created_at: Date | string;
    }>(
      claims,
      `select sm.manifest, sm.env_var_names, sm.system_prompt, sm.task_prompt, sm.created_at
         from public.session_manifests sm
        where sm.work_session_id = $1`,
      [sessionId],
    );

    const row = rows[0];
    if (!row) {
      const empty: SessionLaunchRecord = {
        sessionId,
        available: false,
        unavailableReason: 'no_manifest_row',
        manifest: null,
        envVarNames: [],
        prompts: { system: null, task: null, unavailableReason: 'not_recorded' },
        recordedAt: null,
      };
      return json(empty);
    }

    // `manifest` is jsonb and arrives parsed. It is passed through UNVALIDATED
    // on purpose (see SessionLaunchRecord) — but it must still be an object,
    // because the DB CHECK guarantees that and a reader is entitled to rely on
    // it rather than defending against a bare scalar.
    const manifest =
      typeof row.manifest === 'object' && row.manifest !== null && !Array.isArray(row.manifest)
        ? (row.manifest as Record<string, unknown>)
        : null;

    const result: SessionLaunchRecord = {
      sessionId,
      available: true,
      unavailableReason: null,
      manifest,
      envVarNames: row.env_var_names ?? [],
      prompts: {
        system: row.system_prompt,
        task: row.task_prompt,
        // One reason for both, because they are recorded together: either this
        // launch was captured or it predates capture. A launch that genuinely
        // sent no system prompt still has a recorded (empty-trimmed → null)
        // value, which is indistinguishable here — and is the reason the UI
        // labels this "not recorded" rather than "no prompt was sent".
        unavailableReason:
          row.system_prompt === null && row.task_prompt === null ? 'not_recorded' : null,
      },
      recordedAt:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
    return json(result);
  });
  /**
   * execution.transcript — what the agent SAID, completing told/did/said beside
   * `execution.launch` and `execution.journal`.
   *
   * Authorized exactly like `execution.journal`, and for the same reason: the
   * payload comes from the FILESYSTEM, where RLS cannot reach, so the
   * work_session entity read under the caller's claims IS the gate. Every
   * component of the path is then derived from that row's own columns — the
   * request contributes nothing but a uuid.
   *
   * A scratch session's `workdir_path` is the pre-mint scratch ROOT, not its
   * final directory (SpawnService re-resolves once the session id exists), so
   * `workdir_mode` decides which of the two is the real cwd. Reading the stale
   * column for a projectless session would point claude's project-directory
   * encoder at a directory that has never existed.
   */
  registry.register('execution.transcript', async (ctx) => {
    const owner = await resolveOwner();
    const claims = claimsFor(owner, ctx);
    const sessionId = requireUuidParam(ctx, 'workSessionId');

    const rows = await db.query<{
      native_session_id: string | null;
      workdir_path: string | null;
      workdir_mode: string | null;
      agent_tool: string | null;
      agent_config_dir: string | null;
    }>(
      claims,
      `select ws.native_session_id, ws.workdir_path, ws.workdir_mode, ws.agent_tool,
              ws.agent_config_dir
         from public.entities e
         join public.work_sessions ws on ws.entity_id = e.id
        where e.id = $1 and e.kind = 'work_session' and e.deleted_at is null`,
      [sessionId],
    );
    const session = rows[0];
    if (!session) {
      throw new CollabError('not_found', `no such work session: ${sessionId}`);
    }

    const rawLast = ctx.query.get('last');
    let last = TRANSCRIPT_LAST_DEFAULT;
    if (rawLast !== null && rawLast !== '') {
      const parsed = Number.parseInt(rawLast, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CollabError('invalid_input', `last must be a positive integer, got ${rawLast}`);
      }
      last = Math.min(parsed, TRANSCRIPT_LAST_MAX);
    }

    const cwd =
      session.workdir_mode === 'scratch'
        ? dataDir === undefined
          ? null
          : resolvePath(dataDir, 'scratch', sessionId)
        : session.workdir_path;
    const fallbackAgentConfigDirs = await knownAgentConfigDirs({
      agentTool: session.agent_tool,
      ...(dataDir ? { dataDir } : {}),
      home: process.env.HOME ?? homedir(),
    });

    // `files=1` also scans the WHOLE transcript for Edit/Write tool calls —
    // "what did this session change", answerable without a worktree, labelled
    // source:'transcript' (observed tool calls, not git).
    const includeFileChanges = ctx.query.get('files') === '1';

    return json(
      await readSessionTranscript({
        sessionId,
        agentTool: session.agent_tool,
        nativeSessionId: session.native_session_id,
        cwd,
        home: process.env.HOME ?? homedir(),
        agentConfigDir: session.agent_config_dir,
        fallbackAgentConfigDirs,
        last,
        includeFileChanges,
      }),
    );
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
          resolveAssignmentAnchors(
            db, claims, input.spaceId, input.taskIds ?? [], input.forceNewTask ?? false,
          ),
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
      credentialSources: input.credentialSources ?? null,
      credentialSource: input.credentialSource ?? null,
      title: input.title ?? null,
      promptExtra: input.promptExtra ?? null,
      ...(input.memoryIds?.length ? { memoryIds: input.memoryIds } : {}),
      clientMutationId: envelope.clientMutationId ?? null,
    };

    const result = await rethrowing(() => spawnService.spawn(claims, request));

    /**
     * `dispatched_by` provenance (§4.3), written by the SERVER rather than
     * asked of the dispatcher.
     *
     * The dispatcher spawning this session is, at this moment, the one actor
     * guaranteed to be busy doing something else — and a provenance edge an
     * agent must remember to write is an edge that is missing precisely when
     * the routing went wrong and you want to know who chose. The spawner's
     * session id is server-authoritative (it comes off the pinned credential,
     * never the body), so no caller can forge itself a dispatcher lineage.
     *
     * Best-effort on purpose: the session is already spawned and running by
     * here. A failed edge write must not turn a live spawn into a 5xx.
     */
    const spawnerSessionId =
      ctx.identity.kind === 'bearer' ? ctx.identity.workSessionId ?? null : null;
    if (spawnerSessionId) {
      try {
        const spawner = await db.query<{ mode: string | null }>(
          claims,
          'select mode from public.work_sessions where entity_id = $1',
          [spawnerSessionId],
        );
        if (spawner[0]?.mode === 'dispatcher') {
          await db.tx(claims, async (q) => {
            await q.rpc('write_edge', [
              result.sessionId,
              spawnerSessionId,
              'dispatched_by',
              JSON.stringify({}),
              envelope.actorId ?? null,
              `${envelope.clientMutationId ?? result.sessionId}:dispatched-by`,
            ]);
          });
        }
      } catch {
        // Provenance is worth attempting, never worth failing a live spawn for.
      }
    }

    // 201: a spawn creates a work_session.
    return json(
      await assembleCommandResult(db, claims, result.commandResult, owner.identityId),
      { status: 201 },
    );
  });

  /**
   * execution.terminal.start (101) — a VANILLA TERMINAL.
   *
   * Compare this handler with `execution.spawn` above. Spawn resolves
   * assignment anchors, threads twelve launch fields into a `SpawnRequest`, and
   * writes `dispatched_by` provenance afterwards. None of that has a meaning
   * here: there is no persona, no launch configuration, and no dispatcher
   * lineage, because a human pressed a button.
   *
   * THE BODY IS `.strict()`-PARSED and carries no command field — see
   * `ExecutionTerminalStartInputSchema`. Nothing in this handler builds an
   * argv; `ShellSessionLauncher` owns the only one, and it is closed.
   *
   * 201, same as spawn: this creates a work_session.
   */
  registry.register('execution.terminal.start', async (ctx) => {
    const input = ctx.body as ExecutionTerminalStartInput;
    const owner = await resolveOwner();
    const envelope = commandEnvelope(ctx);
    const claims = claimsFor(owner, ctx, envelope);

    const result = await rethrowing(() =>
      spawnService.startShell(claims, {
        spaceId: input.spaceId,
        projectId: input.projectId ?? null,
        ...(input.confirmUntrusted ? { confirmUntrusted: true } : {}),
        title: input.title ?? null,
        clientMutationId: envelope.clientMutationId ?? null,
        ...(input.cols ? { cols: input.cols } : {}),
        ...(input.rows ? { rows: input.rows } : {}),
      }),
    );

    return json(
      await assembleCommandResult(db, claims, result.commandResult, owner.identityId),
      { status: 201 },
    );
  });

  /**
   * execution.dispatch (§4.3, D2/D4) — "someone should do this; you work out
   * who".
   *
   * Resolution is server-side for one reason: a client doing it would have to
   * reimplement the liveness rule, and every client that has tried has reached
   * for `work_sessions.status` and been wrong. See `findLiveDispatcherSession`.
   *
   * The order below is the failure-cost order, not a narrative one. The task is
   * derived and the request STORED before anything is pushed at a terminal,
   * because a stored request with no delivery is recoverable (the dispatcher
   * reads its anchor when it next wakes) while a delivered request with no
   * durable row is not. `delivery` is reported, never thrown on.
   */
  registry.register('execution.dispatch', async (ctx) => {
    const input = ctx.body as ExecutionDispatchInput;
    const owner = await resolveOwner();
    const envelope = commandEnvelope(ctx);
    const claims = claimsFor(owner, ctx, envelope);

    // Any launchable entity, exactly as execution.spawn treats taskIds — a task
    // passes through untouched.
    const [taskId] = await rethrowing(() =>
      resolveAssignmentAnchors(
        db, claims, input.spaceId, [input.subjectId], input.forceNewTask ?? false,
      ),
    );
    if (!taskId) {
      throw fail('upstream_unavailable', `could not derive a task for ${input.subjectId}`);
    }

    const resolved = await resolveDispatcherSession(
      db, claims, pty, spawnService, input.spaceId,
      `${envelope.clientMutationId ?? input.clientMutationId}:dispatcher-spawn`,
    );
    const dispatcherSessionId = resolved.sessionId;
    const dispatcherSpawned = resolved.spawned;

    const sent = await sendDispatchRequest({
      db,
      claims,
      ...(options.dispatchDelivery ? { seam: options.dispatchDelivery } : {}),
      taskId,
      subjectId: input.subjectId,
      dispatcherSessionId,
      note: input.note ?? null,
      // NULL, never the owner's `identityId`. This reaches SQL as
      // `w2_post_message_batch(p_actor_id uuid)`, and an identity id is
      // deliberately NOT a uuid (`identity/ids.ts`: `id_` + random) — the
      // fallback raised 22P02 `invalid input syntax for type uuid` on every
      // dispatch whose caller did not name an actor, which is every dispatch
      // from the UI. Null is also the RIGHT value, not merely a safe one:
      // `internal.resolve_actor(null, space)` (002:277) falls back to the
      // caller's own actor claim and then to their member row in this space,
      // so the request message is authored by the requester either way.
      requesterActorId: envelope.actorId ?? null,
      requesterActorKind: ctx.identity.kind === 'bearer' ? 'team_member' : 'member',
      requestId: ctx.requestId,
      clientMutationId: `${envelope.clientMutationId ?? input.clientMutationId}:dispatch-request`,
    });

    const result: ExecutionDispatchResult = {
      taskId,
      dispatcherSessionId,
      dispatcherSpawned,
      ...(sent.requestMessageId ? { requestMessageId: sent.requestMessageId } : {}),
      delivery: sent.delivered ? 'delivered' : 'undelivered',
    };
    return json(result, { status: 202 });
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
    const issued = issuePtyGrantToken();
    const granted = await graph.grantStreamAttach(
      claims,
      sessionId,
      input.mode,
      issued.tokenHash,
    );

    // NOT an EntityDetail — `StreamAttachGrant` is its own small contract DTO,
    // so it is mapped explicitly here rather than run through the entity
    // assembler. The RPC's `grant` is a raw `to_jsonb(stream_grants)` row
    // (snake_case, token_hash already stripped), and the URL is transport that
    // only the server knows. Bytes never flow through this response (T-L10).
    const grant = (granted.grant ?? {}) as { expires_at?: string; mode?: string };
    if (typeof grant.expires_at !== 'string' || grant.mode !== input.mode) {
      throw fail('upstream_unavailable', 'stream grant mint returned an invalid scope');
    }
    const expiresAt = new Date(grant.expires_at);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw fail('upstream_unavailable', 'stream grant mint returned an invalid expiration');
    }
    return json({
      workSessionId: sessionId,
      url: `/v2/ws?sessionId=${encodeURIComponent(sessionId)}&mode=${grant.mode}`,
      protocol: 'ws',
      mode: grant.mode,
      token: issued.token,
      expiresAt: expiresAt.toISOString(),
    }, {
      // The response contains a short-lived bearer capability. Browsers and
      // intermediary caches must never retain it for a later attach/replay.
      headers: { 'cache-control': 'no-store' },
    });
  });
}
