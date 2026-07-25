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
 */
export type PermissionMode = 'acceptEdits' | 'interactive' | 'readOnly' | 'bypassPermissions';

/** Working-directory semantics (contract `SpawnWorkdir`). */
export type WorkdirMode = 'project' | 'worktree';

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
}

export interface CreateWorkSessionInput {
  spaceId: string;
  teamMemberId: string;
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
  /** `public.record_session_manifest` — names only, never values (S-redaction). */
  recordManifest(
    auth: GraphAuth,
    sessionId: string,
    manifest: Tm8Manifest,
    envVarNames: string[],
  ): Promise<void>;
  /** `public.work_session_transition` — R29's single writer. Never UPDATE directly. */
  transition(auth: GraphAuth, input: TransitionInput): Promise<void>;
  /** `public.record_execution_command` — the ledger row for prompt/terminate. */
  recordCommand(auth: GraphAuth, input: RecordCommandInput): Promise<unknown>;
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

  tasks: TaskContext[];

  /** Skills the agent should load. G1A composes none — the graph-side skill
   *  resolution is post-loop work. Emitted as an empty array rather than
   *  omitted so the CLI's shape stays stable. */
  skills: Array<{ name: string; body: string }>;

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
  taskIds?: string[];
  projectId?: string | null;
  workdir?: { mode?: WorkdirMode; baseRef?: string | null };
  mode?: AgentMode | null;
  model?: string | null;
  agentTool?: string | null;
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
