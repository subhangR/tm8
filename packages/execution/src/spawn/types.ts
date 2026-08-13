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
export type AgentMode =
  | 'worker'
  | 'coordinator'
  | 'coordinated-worker'
  | 'coordinated-coordinator'
  | 'dispatcher';

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

/**
 * Effective command-network posture recorded in every launch manifest.
 *
 * This is deliberately separate from filesystem/approval posture. In
 * particular, Codex plan sessions use a workspace-write sandbox so their
 * commands can reach tm8 through the network proxy, while source edits remain
 * prohibited by the trusted launch authorization.
 */
export interface CommandNetworkPolicy {
  mode: 'loopback-proxy' | 'full-access' | 'provider-default' | 'operator-defined';
  commandNetworkAccess: boolean | null;
  proxyEnabled: boolean;
  allowedHosts: string[];
  /** Codex's current proxy rules are host-based, not port-scoped. */
  portScoped: boolean;
}

/** Working-directory semantics (contract `SpawnWorkdir`). */
export type WorkdirMode = 'project' | 'scratch' | 'worktree';

/**
 * The OPERATIONAL state of a checkout on disk — `worktree_allocations.state`.
 *
 * Deliberately NOT the vocabulary of the worktree ENTITY's status
 * (active/merged/abandoned/deleted). Two state machines, two tables: one
 * records what was decided, the other what has actually happened on disk.
 * Conflating them is how `deleted` comes to mean "we meant to delete it"
 * (worktree design §3.1).
 */
export type WorktreeAllocationState =
  | 'preparing'
  | 'ready'
  | 'cleanup_pending'
  | 'missing'
  | 'failed';

/** One row of `public.node_worktree_allocations` — reconciliation's DB-side source. */
export interface WorktreeAllocationRow {
  worktreeId: string;
  projectId: string | null;
  state: WorktreeAllocationState;
  path: string | null;
  branch: string | null;
  leaseSessionId: string | null;
  attempts: number;
  failureCode: string | null;
  /** False for a reservation whose step-6 transaction never committed. */
  entityExists: boolean;
  worktreeStatus: string | null;
  leaseSessionStatus: string | null;
  /**
   * When the allocation last changed. Reconciliation needs it to leave a
   * reservation that a live spawn is mid-way through ALONE — see the grace
   * period in `worktree-reconcile.ts`.
   */
  updatedAt: string | null;
}

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

/** A decrypted GitHub credential, held only long enough to compose one PTY env. */
export interface GitHubCredential {
  readonly provider: 'github';
  readonly login: string;
  readonly token: string;
}

/**
 * Spawn-side lookup for the calling identity's string-shaped GitHub credential.
 * The server implementation resolves the row under RLS and decrypts in-process;
 * execution never imports a database driver or a node key.
 */
export interface GitHubCredentialPort {
  resolve(auth: GraphAuth): Promise<GitHubCredential | null>;
}

/**
 * Server-owned credential minting. Execution carries opaque claims but never
 * imports a database driver or sees a human bearer token.
 */
export interface AgentCredentialPort {
  mint(
    auth: GraphAuth,
    input: { workSessionId: string; teamMemberId: string },
  ): Promise<{ token: string; authSessionId: string }>;
  revoke(auth: GraphAuth, workSessionId: string): Promise<void>;
}

// --- what the graph must be able to do for us --------------------------------

export interface LoadSpawnContextInput {
  spaceId: string;
  teamMemberId: string;
  projectId?: string | null;
  taskIds?: string[];
  /**
   * Memory entities explicitly named by the spawn request (D3a). The graph
   * validates them (same space, kind `memory`, live) and folds them into the
   * teammate's injected memory set for this session only.
   */
  memoryIds?: string[];
}

/**
 * A launch-time credential choice. `'member'` = the spawner's own connected
 * vendor credential, and ONLY their own; `'node'` = the node's machine
 * credential. There is deliberately no value naming another member — whose
 * credential a session may use is not a client-expressible decision.
 */
export type CredentialSource = 'member' | 'node';
export type CredentialProvider = 'anthropic' | 'openai' | 'github';
export type CredentialSources = Partial<Record<CredentialProvider, CredentialSource>>;
export type ResolvedCredentialSources = Record<CredentialProvider, CredentialSource | null>;
export type StoredCredentialSources = Partial<Record<CredentialProvider, CredentialSource | null>>;

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
  /**
   * Deprecated common source written by pre-split manifests. Current readers
   * use it only as a fallback for provider keys that are absent.
   */
  credentialSource?: CredentialSource | null;
  /** Provider-specific posture written by current manifests. */
  credentialSources?: StoredCredentialSources | null;
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
  version: number;
  title: string;
  description: string;
  priority: string;
  workStatus: string;
  acceptanceCriteria: unknown[];
  /**
   * Set when the task was derived from a thread message (064/099): the thread
   * root and the channel it is anchored on. Rendered into the assignment
   * envelope's <source>/<thread> elements so the agent can read the LIVE
   * thread (`tm8 message list <channel> --root <root>`) instead of trusting a
   * snapshot in the task body.
   */
  threadRootMessageId?: string | null;
  threadChannelId?: string | null;
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

// --- vanilla terminals (101) -------------------------------------------------

/**
 * What `SpawnService.startShell` needs, and the shape is the argument.
 *
 * Set this beside {@link SpawnRequest} and read the difference: no
 * `teamMemberId`, no `mode`, no `model`, no `agentTool`, no
 * `interactionProfileId`, no `memoryIds`, no `promptExtra`, no `taskIds`, no
 * `parentSessionId`, no `workdir`. Every one of those is agent configuration,
 * and a vanilla terminal has no agent to configure. They are ABSENT rather than
 * optional-and-ignored, so there is no field for a later edit to start reading.
 */
export interface ShellSessionRequest {
  spaceId: string;
  /** Null ⇒ a projectless terminal in a server-owned scratch directory. */
  projectId: string | null;
  /** Explicit consent for an untrusted project, as spawn's carrier is. */
  confirmUntrusted?: boolean;
  title?: string | null;
  clientMutationId?: string | null;
  cols?: number;
  rows?: number;
}

/**
 * The project read a vanilla terminal needs — and ONLY that.
 *
 * Deliberately not `loadSpawnContext`, which also reads the persona, its
 * ancestor skill chain, and the memory working set across three more queries.
 * None of that exists for a shell session, and calling the big loader with a
 * synthetic team member id to get one field back would be the exact "pretend it
 * is an agent" shape this feature exists to avoid.
 */
export interface ShellSessionContext {
  project: ProjectContext | null;
}

export interface StartShellSessionResult {
  sessionId: string;
  /** The RPC's raw CommandResult, forwarded to the client untouched. */
  commandResult: unknown;
  /** True when the command ledger returned an earlier start result. */
  replayed: boolean;
}

/** What `startShell` answers with once the PTY is live. */
export interface ShellSessionResult {
  sessionId: string;
  /** The resolved login shell. */
  shell: string;
  /** The exact line the PTY ran. */
  command: string;
  cwd: string;
  envVarNames: string[];
  /** True when a live PTY already existed and was reattached to. */
  reused: boolean;
  commandResult: unknown;
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
  /** The project read behind a vanilla terminal. See {@link ShellSessionContext}. */
  loadShellContext(
    auth: GraphAuth,
    input: { spaceId: string; projectId: string | null },
  ): Promise<ShellSessionContext>;
  /** `public.start_shell_session` (101) — the `session_kind='shell'` row. */
  createShellSession(
    auth: GraphAuth,
    input: ShellSessionRequest & {
      nodeId: string | null;
      /**
       * The project's recorded `working_dir`, already re-validated by the
       * caller. NULL for a projectless terminal, whose directory is named for
       * a session id that does not exist yet — see the migration.
       */
      workdirPath: string | null;
    },
  ): Promise<StartShellSessionResult>;
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
  /** Mint a credential bound to this exact work-session/persona pair. */
  issueWorkSessionAgentToken(
    auth: GraphAuth,
    sessionId: string,
    teamMemberId: string,
  ): Promise<string>;
  /**
   * `public.record_session_manifest` — names only, never values (S-redaction).
   *
   * `prompts` carries the two composed launch prompts VERBATIM, because they
   * exist nowhere else once the child process starts: they are appended to its
   * argv and the composer's output is not otherwise retained. Recording them
   * here is what lets a reader later show what the agent was actually told,
   * rather than what re-running today's composer would produce.
   */
  recordManifest(
    auth: GraphAuth,
    sessionId: string,
    manifest: Tm8Manifest,
    envVarNames: string[],
    prompts: { system: string; task: string },
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
  /**
   * `public.execution_record_checkout_branch` (107) — the session's lane
   * fact. NOT write-once (a checkout legitimately changes branches; the fact
   * is refreshed opportunistically), and NEVER load-bearing for the launch:
   * callers fire-and-log, because a session that cannot report its branch is
   * degraded, not broken. `null` records a MEASURED absence (no repo,
   * detached HEAD). Resolves whether the stored value actually changed.
   */
  recordCheckoutBranch(
    auth: GraphAuth,
    sessionId: string,
    branch: string | null,
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

  // --- worktree provisioning (design §4) --------------------------------------
  //
  // Six calls, in saga order. They are separate rather than one `provision()`
  // because each is a distinct crash boundary: the reconciler's whole job is
  // the states you land in when the process dies between two of them, and a
  // port that hid the boundaries would hide the states.
  //
  // NONE of them takes the per-project Git lock. That lock lives in
  // WorktreeManager, OUTSIDE the ledgered transaction, because
  // `internal.ledger_replay` is the first statement of every ledgered door and
  // already holds an advisory lock — nesting beneath it is the documented
  // deadlock (§5.1).

  /**
   * §4.5 step 4 — reserve. Inserts `worktree_allocations` in `preparing` under
   * the caller's pre-generated id. Nothing exists on disk yet; a `preparing`
   * row with no directory is the canonical safe partial (§6.2 row 1).
   */
  reserveWorktreeAllocation(
    auth: GraphAuth,
    input: {
      worktreeId: string;
      spaceId: string;
      projectId: string;
      nodeId: string;
      path: string;
      branch: string;
      /** §5.2's separate worktree cap. 0 means unbounded. */
      cap: number;
    },
  ): Promise<void>;

  /** The one writer of `worktree_allocations.state`. Saga steps 5-8 and every §6.2 repair. */
  setWorktreeAllocationState(
    auth: GraphAuth,
    input: {
      worktreeId: string;
      state: WorktreeAllocationState;
      failureCode?: string | null;
      failureDetail?: Record<string, unknown> | null;
      /** Bounded-backoff bookkeeping for `cleanup_pending` retries (§5.3). */
      countAttempt?: boolean;
    },
  ): Promise<void>;

  /**
   * §4.7 step 6 — `public.create_worktree`, carrying the node-generated id so
   * the entity and the reservation are the same row's two halves.
   */
  createWorktreeEntity(
    auth: GraphAuth,
    input: {
      worktreeId: string;
      spaceId: string;
      projectId: string;
      path: string;
      branch: string;
      baseRef: string;
      baseCommitOid: string;
      clientMutationId: string | null;
    },
  ): Promise<void>;

  /** §3.4 — one write-capable live session per worktree. Contention is a refusal, never a queue. */
  acquireWorktreeLease(auth: GraphAuth, worktreeId: string, sessionId: string): Promise<void>;
  releaseWorktreeLease(auth: GraphAuth, worktreeId: string): Promise<void>;

  /** The `in_worktree` edge — the mutable association, origin-stamped `system`. */
  linkSessionToWorktree(
    auth: GraphAuth,
    input: { spaceId: string; sessionId: string; worktreeId: string },
  ): Promise<void>;

  /** §6.1 — this node's allocations, with the facts only SQL can answer. */
  listNodeWorktreeAllocations(auth: GraphAuth, nodeId: string): Promise<WorktreeAllocationRow[]>;

  /**
   * `public.projects.working_dir` for one project.
   *
   * Reconciliation needs a repository root to run `git worktree list/remove/
   * prune` against, and an allocation carries only a project id. `null` when
   * the project is gone or unreadable — which narrows the sweep, and must
   * never widen a repair.
   */
  loadProjectWorkingDir(auth: GraphAuth, projectId: string): Promise<string | null>;
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
     * Deprecated common source. Null when providers differ or run in auto.
     */
    credentialSource: CredentialSource | null;
    /** Provider-specific choices, recorded for debug, child inheritance and resume. */
    credentialSources: ResolvedCredentialSources;
    /** Effective shell-command networking, independent of filesystem posture. */
    commandNetwork: CommandNetworkPolicy;
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
  /** Deprecated global compatibility carrier; provider keys below win. */
  credentialSource?: CredentialSource | null;
  /**
   * Independent provider choices; an absent key means auto/inherit. A member
   * source can only resolve the CALLER'S OWN RLS-scoped credential.
   */
  credentialSources?: CredentialSources | null;
  title?: string | null;
  promptExtra?: string | null;
  /** Spawn-time memory hand-off (D3a); see `LoadSpawnContextInput.memoryIds`. */
  memoryIds?: string[];
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
