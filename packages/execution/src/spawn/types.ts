// @tm8/execution — SpawnService seam types.
//
// THE DEPENDENCY RULE THIS FILE EXISTS TO ENFORCE:
// packages/execution has no database driver and must never gain one. `pg` lives
// in packages/server alone. So everything the spawn flow needs from the graph
// arrives through `GraphPort` — a narrow port declared HERE and implemented
// over `Db` in packages/server/src/facade/execution-handlers.ts.
//
// Two things fall out of that, both deliberate:
//   1. SpawnService is unit-testable against a fake graph, so the PTY assertions
//      (the ones that actually matter — R17) run with no Postgres at all.
//   2. The SQL stays where the RPCs are reviewed. A handler that hand-rolls an
//      UPDATE against work_sessions would bypass the command ledger, the event
//      capture trigger and the F1/F2 guards; keeping SQL out of this package
//      makes that mistake impossible to make here.

/** Agent execution mode — mirrors work_sessions.mode's CHECK constraint. */
export type AgentMode = 'worker' | 'coordinator' | 'coordinated-worker' | 'coordinated-coordinator';

/** work_sessions.status — the five states 001_core_graph.sql:703 allows. */
export type WorkSessionStatus = 'spawning' | 'running' | 'idle' | 'exited' | 'failed';

/**
 * Permission posture handed to the agent. Named for old maestro's vocabulary
 * because the personas carry these exact strings in team_members.permission_mode
 * and an import must not have to translate them.
 *
 * `auto` is the one posture maestro never had, because the CLI it maps to did
 * not have it either: Claude Code's `--permission-mode auto` lets the agent run
 * the actions it judges safe and escalates only the risky ones. It sits between
 * `acceptEdits` (edits free, every command asked) and `bypassPermissions` (ask
 * nothing) and it is tm8's DEFAULT — see `DEFAULT_PERMISSION_MODE`.
 */
export type PermissionMode = 'auto' | 'acceptEdits' | 'interactive' | 'readOnly' | 'bypassPermissions';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AccessMode = 'safe' | 'acceptEdits' | 'auto' | 'plan' | 'fullAccess';

/** Working-directory semantics (contract `SpawnWorkdir`). */
export type WorkdirMode = 'project' | 'scratch';

/**
 * Opaque per-request authorization, passed straight through to the graph
 * implementation. SpawnService never inspects it — it only has to CARRY it,
 * including across the async gap to PTY exit (see `SpawnService` docs).
 *
 * Typed as `unknown` on purpose: the concrete shape is the server's `DbClaims`,
 * and importing that here would drag a server type into the execution package
 * for no benefit.
 */
export type GraphAuth = unknown;

// --- what the graph must be able to do for us --------------------------------

export interface LoadSpawnContextInput {
  spaceId: string;
  teamMemberId: string;
  projectId?: string | null;
  taskIds?: string[];
}

/**
 * How an EXISTING session was launched, read back from its recorded manifest.
 *
 * This is the fact a child needs in order to inherit its parent's posture, and
 * the fact a resume needs in order not to silently downgrade its own. Both
 * fields are nullable because the source is a stored JSON document: a session
 * whose manifest row was never written (a spawn that died before step 4), or
 * one written by an older build, answers "I don't know" rather than a wrong
 * default.
 */
export interface SessionLaunchPosture {
  accessMode: AccessMode | null;
  permissionMode: PermissionMode | null;
}

/** A project as the server computed it — `workingDir` is graph truth (S11). */
export interface ProjectContext {
  id: string;
  name: string;
  /** Absolute path, from public.projects.working_dir. NEVER client-supplied. */
  workingDir: string;
  trust: 'trusted' | 'untrusted';
}

/** The persona the session runs as, from public.team_members. */
export interface TeamMemberContext {
  id: string;
  name: string;
  role: string;
  identity: string;
  memories: unknown[];
  model: string | null;
  agentTool: string | null;
  mode: AgentMode | null;
  permissionMode: string | null;
  avatar: string | null;
  capabilities: Record<string, unknown>;
  commandPermissions: Record<string, unknown>;
}

export interface TaskContext {
  id: string;
  title: string;
  description: string;
  priority: string;
  workStatus: string;
  acceptanceCriteria: unknown[];
}

/**
 * Everything read from the graph BEFORE `execution_spawn` runs.
 *
 * The ordering matters and is easy to get backwards: the RPC persists the
 * resolved model/agentTool/mode onto the work_session row, but resolving them
 * needs the persona's defaults. So the reads come first, precedence resolves
 * in-process, and only then does the session get created — which is why this
 * type has no sessionId.
 */
export interface SpawnContext {
  spaceId: string;
  project: ProjectContext | null;
  teamMember: TeamMemberContext;
  tasks: TaskContext[];
  /**
   * Skills resolved across the team member's ancestor chain, nearest-first, and
   * already de-duplicated — see `resolveSkills` in ./skills.ts. Optional only so
   * that existing SpawnContext producers (the fake graph in tests, and any
   * caller predating row #11) stay valid; absent is read as "none".
   */
  skills?: ManifestSkillContext[];
  /**
   * Skills the resolver dropped to stay inside its cap. Carried through to the
   * manifest so a truncated persona is visible rather than merely smaller.
   */
  droppedSkills?: string[];
}

export interface ManifestSkillContext {
  name: string;
  body: string;
}

export interface CreateWorkSessionInput {
  spaceId: string;
  teamMemberId: string;
  parentSessionId: string | null;
  taskIds: string[];
  projectId: string | null;
  workdirMode: WorkdirMode;
  /** Server-computed absolute path. The client never supplies this. */
  workdirPath: string;
  baseRef: string | null;
  mode: AgentMode;
  model: string | null;
  agentTool: string | null;
  title: string | null;
  nodeId: string | null;
  confirmUntrusted: boolean;
  clientMutationId: string | null;
}

export interface CreateWorkSessionResult {
  sessionId: string;
  /** The RPC's raw CommandResult, forwarded to the client untouched. */
  commandResult: unknown;
  /** True when the command ledger returned an earlier spawn result. */
  replayed: boolean;
}

export interface ResolvedInteractionProfileContext {
  profileId: string | null;
  profileVersion: number | null;
  templateKey: string;
  templateVersion: number;
  source: 'spawn_override' | 'teammate_default' | 'space_default' | 'core_default';
  resolvedHash: string;
  /** Canonical immutable policy snapshot selected by the server resolver. */
  snapshot: Record<string, unknown>;
}

export interface InteractionProfilePinContext extends ResolvedInteractionProfileContext {
  pinRevision: number;
}

export interface TransitionInput {
  sessionId: string;
  status: WorkSessionStatus;
  exitCode?: number | null;
  error?: string | null;
}

export interface RecordCommandInput {
  sessionId: string;
  operation: 'execution.prompt' | 'execution.terminate';
  payload: Record<string, unknown>;
  clientMutationId: string | null;
}

/**
 * The stored facts of an existing work_session, as resume needs them. This is
 * what the graph REMEMBERS about the launch — resume re-resolves everything
 * else (persona defaults, project cwd) through the same reads spawn uses, so
 * the two paths cannot drift.
 */
export interface WorkSessionResumeInfo {
  sessionId: string;
  spaceId: string;
  /** From the `relates_to` edge; null if the edge is somehow gone. */
  teamMemberId: string | null;
  projectId: string | null;
  taskIds: string[];
  workdirMode: WorkdirMode;
  workdirPath: string | null;
  mode: AgentMode | null;
  model: string | null;
  agentTool: string | null;
  title: string;
  status: WorkSessionStatus;
  /**
   * The PROVIDER-OWNED conversation id — Claude's session uuid (pre-minted at
   * spawn) or Codex's rollout id (captured from ~/.codex/sessions). Null means
   * this session predates capture, or its Codex rollout has not been located
   * yet.
   */
  nativeSessionId: string | null;
}

export interface ResumeWorkSessionResult {
  commandResult: unknown;
  replayed: boolean;
}

export interface ResumeRequest {
  sessionId: string;
  clientMutationId?: string | null;
  cols?: number;
  rows?: number;
}

/**
 * The graph, as the spawn flow needs it. Implemented over `Db` in
 * packages/server/src/facade/execution-handlers.ts; faked in tests.
 *
 * Every method takes `auth` explicitly rather than closing over it, because a
 * single GraphPort instance serves every request on the node — a port that
 * captured claims at construction would hand one caller's identity to the next.
 */
export interface GraphPort {
  /** Reads. Runs before the session exists. */
  loadSpawnContext(auth: GraphAuth, input: LoadSpawnContextInput): Promise<SpawnContext>;
  /** `public.execution_spawn` — work_session row + `working_on` edges, one tx. */
  createWorkSession(auth: GraphAuth, input: CreateWorkSessionInput): Promise<CreateWorkSessionResult>;
  /** Resolve the immutable profile selection before launch. */
  resolveInteractionProfile(
    auth: GraphAuth,
    input: { spaceId: string; teamMemberId: string; interactionProfileId?: string | null },
  ): Promise<ResolvedInteractionProfileContext>;
  /** Persist the immutable profile pin against the new work session. */
  recordInteractionProfilePin(
    auth: GraphAuth,
    sessionId: string,
    profile: ResolvedInteractionProfileContext,
  ): Promise<InteractionProfilePinContext>;
  /** `public.record_session_manifest` — names only, never values (S-redaction). */
  recordManifest(
    auth: GraphAuth,
    sessionId: string,
    manifest: Tm8Manifest,
    envVarNames: string[],
  ): Promise<void>;
  /** `public.work_session_transition` — R29's single writer. Never UPDATE directly. */
  transition(auth: GraphAuth, input: TransitionInput): Promise<void>;
  /** Read the stored launch facts of an existing session, for resume. */
  loadWorkSessionForResume(auth: GraphAuth, sessionId: string): Promise<WorkSessionResumeInfo>;
  /**
   * The recorded permission posture of an existing session — the parent half of
   * posture inheritance, and the session's own half on resume.
   *
   * A READ of `session_manifests`, under the caller's claims, because that row
   * is where the resolved posture is already durable; `work_sessions` persists
   * model/mode/agent_tool but has never had a permission column. Resolves
   * `null` when there is no readable manifest — inheritance then simply does
   * not apply, which is the same answer a root session gets.
   */
  loadSessionLaunchPosture(
    auth: GraphAuth,
    sessionId: string,
  ): Promise<SessionLaunchPosture | null>;
  /**
   * `public.execution_resume` — the ONE legal path back from `exited`/`failed`
   * to `spawning`. Enforces persona authorization, the concurrency cap, and
   * clears the previous run's exit evidence, all inside the single-writer guard.
   */
  resumeWorkSession(
    auth: GraphAuth,
    input: { sessionId: string; clientMutationId: string | null; nodeId: string | null },
  ): Promise<ResumeWorkSessionResult>;
  /**
   * `public.execution_record_native_session` — write-once native-id capture.
   * Resolves `false` when the row already held a DIFFERENT id, which is a
   * capture bug upstream and must be surfaced, never swallowed.
   */
  recordNativeSessionId(
    auth: GraphAuth,
    sessionId: string,
    nativeSessionId: string,
  ): Promise<boolean>;
  /** `public.record_execution_command` — the ledger row for prompt/terminate. */
  recordCommand(auth: GraphAuth, input: RecordCommandInput): Promise<unknown>;
  /**
   * Work sessions THIS node still believes are alive (status not terminal).
   *
   * A read, used only by startup ghost reconciliation. Scoped by `node_id`
   * because a non-terminal session belonging to ANOTHER node may be perfectly
   * alive over there — only the node that owns a PTY can say whether it is gone.
   */
  listNodeActiveSessions(
    auth: GraphAuth,
    nodeId: string,
  ): Promise<Array<{ sessionId: string; status: WorkSessionStatus }>>;
}

// --- the manifest ------------------------------------------------------------

/**
 * The composed manifest: what the agent reads at boot, and what the graph
 * records alongside it.
 *
 * RE-AUTHORED, not lifted. Old maestro produced this by shelling out to
 * `maestro manifest generate` — a CLI subprocess that re-fetched every entity
 * over HTTP, wrote a file, and handed the path back through a 60s-timeout pipe.
 * tm8 composes it in-process from a single graph read. Same information, one
 * process, no shared-disk handshake, no partial-write window.
 *
 * The FILE is what the agent reads; the ROW (record_session_manifest) is what
 * the graph knows. Both are written, and neither is derived from the other.
 */
export interface Tm8Manifest {
  manifestVersion: '1';
  sessionId: string;
  spaceId: string;
  /** RFC3339. Stamped by the composer. */
  generatedAt: string;
  mode: AgentMode;
  /** Where the agent reports back to — the loopback tm8-server. */
  baseUrl: string;

  /**
   * The PERSONA. Named `agent` and shaped to match Phoenix's CLI reader
   * (packages/cli/src/manifest.ts) field-for-field — `teamMemberId` doubles as
   * his default completerIds on task completion.
   *
   * Everything in here is graph-authored free text, which means it is
   * attacker-authorable the moment a space has a second member. The composer
   * therefore emits DATA and never pre-formats a prompt fragment: the CLI's
   * prompt composer escapes it at interpolation time, and formatting it here
   * would slip text past that escaping.
   */
  agent: {
    teamMemberId: string;
    name: string;
    avatar: string | null;
    role: string;
    identity: string;
    memory: unknown[];
    capabilities: Record<string, unknown>;
    commandPermissions: Record<string, unknown>;
  };

  /**
   * The LAUNCH POSTURE — how this session was started, as resolved by the
   * precedence chain. Deliberately NOT called `agent`: that key belongs to the
   * persona above, and the two carrying the same name in different halves of
   * the system is exactly how an agent boots with an empty identity.
   */
  launch: {
    tool: string;
    model: string | null;
    permissionMode: PermissionMode;
    accessMode: AccessMode;
    reasoningEffort: ReasoningEffort | null;
    /**
     * Set when `permissionMode` asked for OS-level confinement and the node
     * could not provide it, so the agent was launched UNCONFINED. Holds the
     * one-sentence reason; null when the posture was honoured as written.
     *
     * It exists because the manifest is otherwise a liar in exactly this case:
     * `permissionMode` records what was ASKED FOR, and on a node whose sandbox
     * cannot start that is not what happened. Reading the two fields together
     * is the only way to tell a confined codex session from an unconfined one,
     * and before this there was no way at all — the deployed node had codex
     * agents running with no filesystem confinement and no approval gate, and
     * nothing in the graph, the manifest or the session row said so.
     */
    sandboxDegraded?: string | null;
    /** The exact shell command line the PTY runs. Reproducibility, not decoration. */
    command: string;
  };

  session: {
    title: string;
    /** Absolute, server-computed, graph-sourced. */
    workingDirectory: string;
    workdirMode: WorkdirMode;
  };

  project: { id: string; name: string; workingDir: string; trust: string } | null;

  /** Immutable interaction-profile provenance resolved and pinned at launch. */
  interactionProfile: InteractionProfilePinContext;

  tasks: TaskContext[];

  /** Skills the agent should load, resolved across the persona's ancestor
   *  chain and de-duplicated nearest-first. Emitted as an empty array rather
   *  than omitted so the CLI's shape stays stable. */
  skills: Array<{ name: string; body: string }>;

  /**
   * Names the skill resolver dropped to stay inside its cap, or [] when it
   * kept everything.
   *
   * Emitted for the same reason as `launch.sandboxDegraded`: without it a
   * persona truncated from 80 skills to 64 reaches the CLI looking exactly
   * like a persona that only ever had 64, and nothing anywhere records which
   * of the two happened. A smaller persona is survivable; a smaller persona
   * that reports itself as complete is the defect.
   */
  droppedSkills: string[];

  /** Coordinator re-rooting (R27) is post-G1A; always null in this wave. */
  coordinator: { sessionId: string; displayName: string } | null;

  /** Coordinator directive delivery is post-G1A; always null in this wave. */
  directive: { subject: string; message: string; fromSessionId: string } | null;

  /** Extra prompt context from `ExecutionSpawnInput.promptExtra`. */
  promptExtra: string | null;
}

// --- SpawnService inputs/outputs ---------------------------------------------

/** `ExecutionSpawnInput` plus the things only the server knows. */
export interface SpawnRequest {
  spaceId: string;
  teamMemberId: string;
  /** Session that invoked this spawn; null/absent means a human-launched root. */
  parentSessionId?: string | null;
  taskIds?: string[];
  projectId?: string | null;
  workdir?: { mode?: WorkdirMode; baseRef?: string | null };
  interactionProfileId?: string | null;
  mode?: AgentMode | null;
  model?: string | null;
  agentTool?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  accessMode?: AccessMode | null;
  title?: string | null;
  promptExtra?: string | null;
  /** S12: untrusted projects require per-spawn consent. */
  confirmUntrusted?: boolean;
  clientMutationId?: string | null;
  /** Terminal geometry from the browser, so the agent's TUI boots at the right width. */
  cols?: number;
  rows?: number;
}

export interface SpawnResult {
  sessionId: string;
  manifestPath: string;
  manifest: Tm8Manifest;
  command: string;
  cwd: string;
  /** Names only — values are never returned, logged or recorded. */
  envVarNames: string[];
  reused: boolean;
  commandResult: unknown;
}

/** Raised for every spawn-flow failure that has a contract error code. */
export class SpawnError extends Error {
  constructor(
    message: string,
    /** Maps to the contract error taxonomy in the handler layer. */
    readonly code:
      | 'invalid_input'
      | 'not_found'
      | 'forbidden'
      | 'conflict'
      | 'not_implemented'
      | 'internal',
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SpawnError';
  }
}
