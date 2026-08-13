// A GraphPort with no Postgres behind it.
//
// This is the payoff of declaring GraphPort in packages/execution instead of
// reaching for `Db`: the spawn loop's real assertions are about PTY BYTES, and
// bytes do not need a database to be wrong. Running them against a fake graph
// keeps the test honest about what it is proving (the terminal seam) and lets it
// run in CI with no sidecar.

import { randomUUID } from 'node:crypto';
import type {
  CreateWorkSessionInput,
  CreateWorkSessionResult,
  GraphAuth,
  GraphPort,
  LoadSpawnContextInput,
  RecordCommandInput,
  ResolvedInteractionProfileContext,
  ResumeWorkSessionResult,
  SessionLaunchPosture,
  ShellSessionContext,
  ShellSessionRequest,
  StartShellSessionResult,
  SpawnContext,
  Tm8Manifest,
  TransitionInput,
  WorkSessionResumeInfo,
  WorkSessionStatus,
  WorktreeAllocationRow,
  WorktreeAllocationState,
} from '../src/spawn/types.js';

export interface FakeGraphOptions {
  workingDir: string;
  /** Omit the project to exercise the projectless scratch-session path. */
  withProject?: boolean;
  /** Stable id for filesystem-boundary tests. Defaults to a fresh UUID. */
  sessionId?: string;
  model?: string | null;
  permissionMode?: string | null;
}

export class FakeGraph implements GraphPort {
  readonly created: CreateWorkSessionInput[] = [];
  /** Vanilla-terminal rows minted through `start_shell_session` (101). */
  readonly shellsCreated: Array<
    ShellSessionRequest & { nodeId: string | null; workdirPath: string | null }
  > = [];
  readonly transitions: TransitionInput[] = [];
  readonly commands: RecordCommandInput[] = [];
  readonly manifests: Array<{
    sessionId: string;
    manifest: Tm8Manifest;
    envVarNames: string[];
    prompts: { system: string; task: string };
  }> = [];
  readonly profilePins: Array<{ sessionId: string; profile: ResolvedInteractionProfileContext }> = [];
  readonly issuedAgentTokens: Array<{ sessionId: string; teamMemberId: string }> = [];
  readonly authSeen: GraphAuth[] = [];

  /** Set to make the next createWorkSession throw, for the rollback test. */
  failNextCreate: Error | null = null;
  /** Return this existing session from the next create attempt as a ledger replay. */
  replaySessionId: string | null = null;

  constructor(private readonly options: FakeGraphOptions) {}

  async loadSpawnContext(auth: GraphAuth, input: LoadSpawnContextInput): Promise<SpawnContext> {
    this.authSeen.push(auth);
    return {
      spaceId: input.spaceId,
      project:
        this.options.withProject === false
          ? null
          : {
              id: input.projectId ?? randomUUID(),
              name: 'tm8-fixture',
              workingDir: this.options.workingDir,
              trust: 'trusted',
            },
      teamMember: {
        id: input.teamMemberId,
        name: 'Draco',
        role: 'PTY engineer',
        identity: 'You own the terminal seam.',
        memories: [],
        model: this.options.model === undefined ? 'opus' : this.options.model,
        agentTool: null,
        mode: 'worker',
        permissionMode: this.options.permissionMode ?? null,
        avatar: '🖥️',
        capabilities: { canReportProgress: true },
        commandPermissions: {},
      },
      tasks: (input.taskIds ?? []).map((id, i) => ({
        id,
        version: 1,
        title: `fixture task ${i + 1}`,
        description: 'prove the loop',
        priority: 'high',
        workStatus: 'open',
        acceptanceCriteria: [],
      })),
    };
  }

  async createWorkSession(
    auth: GraphAuth,
    input: CreateWorkSessionInput,
  ): Promise<CreateWorkSessionResult> {
    this.authSeen.push(auth);
    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = null;
      throw err;
    }
    if (this.replaySessionId) {
      const sessionId = this.replaySessionId;
      this.replaySessionId = null;
      return {
        sessionId,
        commandResult: { entityId: sessionId, patches: [sessionId] },
        replayed: true,
      };
    }
    this.created.push(input);
    const sessionId = this.options.sessionId ?? randomUUID();
    return { sessionId, commandResult: { entityId: sessionId, patches: [sessionId] }, replayed: false };
  }

  // --- vanilla terminals (101) ------------------------------------------------

  async loadShellContext(
    auth: GraphAuth,
    input: { spaceId: string; projectId: string | null },
  ): Promise<ShellSessionContext> {
    this.authSeen.push(auth);
    return {
      project:
        this.options.withProject === false
          ? null
          : {
              id: input.projectId ?? randomUUID(),
              name: 'tm8-fixture',
              workingDir: this.options.workingDir,
              trust: 'trusted',
            },
    };
  }

  async createShellSession(
    auth: GraphAuth,
    input: ShellSessionRequest & { nodeId: string | null; workdirPath: string | null },
  ): Promise<StartShellSessionResult> {
    this.authSeen.push(auth);
    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = null;
      throw err;
    }
    if (this.replaySessionId) {
      const sessionId = this.replaySessionId;
      this.replaySessionId = null;
      return { sessionId, commandResult: { entityId: sessionId, patches: [sessionId] }, replayed: true };
    }
    this.shellsCreated.push(input);
    const sessionId = this.options.sessionId ?? randomUUID();
    return { sessionId, commandResult: { entityId: sessionId, patches: [sessionId] }, replayed: false };
  }

  async resolveInteractionProfile(
    auth: GraphAuth,
    input: { spaceId: string; teamMemberId: string; interactionProfileId?: string | null },
  ): Promise<ResolvedInteractionProfileContext> {
    this.authSeen.push(auth);
    return input.interactionProfileId
      ? {
          profileId: input.interactionProfileId,
          profileVersion: 1,
          templateKey: 'tm8.chat.core',
          templateVersion: 1,
          source: 'spawn_override',
          resolvedHash: 'fixture-profile-hash',
          snapshot: { profile: { source: 'spawn_override' } },
        }
      : {
          profileId: null,
          profileVersion: null,
          templateKey: 'tm8.chat.core',
          templateVersion: 1,
          source: 'core_default',
          resolvedHash: 'fixture-core-profile-hash',
          snapshot: { profile: { source: 'core_default' } },
        };
  }

  async recordInteractionProfilePin(
    auth: GraphAuth,
    _sessionId: string,
    profile: ResolvedInteractionProfileContext,
  ) {
    this.authSeen.push(auth);
    this.profilePins.push({ sessionId: _sessionId, profile });
    return { ...profile, pinRevision: 1 };
  }

  async issueWorkSessionAgentToken(
    auth: GraphAuth,
    sessionId: string,
    teamMemberId: string,
  ): Promise<string> {
    this.authSeen.push(auth);
    this.issuedAgentTokens.push({ sessionId, teamMemberId });
    return `tm8s_${sessionId}.fixture-agent-secret`;
  }

  async recordManifest(
    auth: GraphAuth,
    sessionId: string,
    manifest: Tm8Manifest,
    envVarNames: string[],
    prompts: { system: string; task: string },
  ): Promise<void> {
    this.authSeen.push(auth);
    this.manifests.push({ sessionId, manifest, envVarNames, prompts });
  }

  async transition(auth: GraphAuth, input: TransitionInput): Promise<void> {
    this.authSeen.push(auth);
    this.transitions.push(input);
  }

  async recordCommand(auth: GraphAuth, input: RecordCommandInput): Promise<unknown> {
    this.authSeen.push(auth);
    if (this.failTerminateFor.has(input.sessionId)) {
      throw new Error(`injected failure for ${input.sessionId}`);
    }
    this.commands.push(input);
    return { entityId: input.sessionId, patches: [input.sessionId] };
  }

  /** Rows startup reconciliation should find. Set by the test. */
  nodeActiveSessions: Array<{ sessionId: string; status: WorkSessionStatus }> = [];
  /** Node ids `listNodeActiveSessions` was asked about. */
  readonly nodeSessionQueries: string[] = [];
  /** When set, the listing REJECTS — the unreadable-graph case at boot. */
  listNodeActiveSessionsError: Error | null = null;
  /** Session ids whose `terminate` should blow up, to prove one bad row cannot
   *  stop the sweep. */
  failTerminateFor = new Set<string>();

  async listNodeActiveSessions(
    auth: GraphAuth,
    nodeId: string,
  ): Promise<Array<{ sessionId: string; status: WorkSessionStatus }>> {
    this.authSeen.push(auth);
    this.nodeSessionQueries.push(nodeId);
    if (this.listNodeActiveSessionsError) throw this.listNodeActiveSessionsError;
    return this.nodeActiveSessions;
  }

  statusesFor(sessionId: string): string[] {
    return this.transitions.filter((t) => t.sessionId === sessionId).map((t) => t.status);
  }

  // --- resume seam -----------------------------------------------------------

  /** The stored session facts `loadWorkSessionForResume` answers with. Set by the test. */
  resumeInfo: WorkSessionResumeInfo | null = null;
  /** Resume calls the RPC saw. */
  readonly resumes: Array<{
    sessionId: string;
    clientMutationId: string | null;
    nodeId: string | null;
  }> = [];
  /** Native ids recorded, in order. */
  readonly nativeIds: Array<{ sessionId: string; nativeSessionId: string }> = [];
  /** Set false to simulate write-once refusing a colliding native id. */
  nativeIdWriteAccepted = true;
  /** Set true to make the resume RPC answer as a ledger replay. */
  resumeReplayed = false;

  async loadWorkSessionForResume(
    auth: GraphAuth,
    sessionId: string,
  ): Promise<WorkSessionResumeInfo> {
    this.authSeen.push(auth);
    if (!this.resumeInfo || this.resumeInfo.sessionId !== sessionId) {
      throw new Error(`work session ${sessionId} not found`);
    }
    return this.resumeInfo;
  }

  async resumeWorkSession(
    auth: GraphAuth,
    input: { sessionId: string; clientMutationId: string | null; nodeId: string | null },
  ): Promise<ResumeWorkSessionResult> {
    this.authSeen.push(auth);
    this.resumes.push(input);
    return {
      commandResult: { entityId: input.sessionId, patches: [input.sessionId] },
      replayed: this.resumeReplayed,
    };
  }

  async recordNativeSessionId(
    auth: GraphAuth,
    sessionId: string,
    nativeSessionId: string,
  ): Promise<boolean> {
    this.authSeen.push(auth);
    this.nativeIds.push({ sessionId, nativeSessionId });
    return this.nativeIdWriteAccepted;
  }

  /** Lane facts recorded (107), in order. */
  readonly checkoutBranches: Array<{ sessionId: string; branch: string | null }> = [];
  /** Set to make the lane-fact write throw — spawns must survive it. */
  checkoutBranchError: Error | null = null;

  async recordCheckoutBranch(
    auth: GraphAuth,
    sessionId: string,
    branch: string | null,
  ): Promise<boolean> {
    this.authSeen.push(auth);
    if (this.checkoutBranchError) throw this.checkoutBranchError;
    this.checkoutBranches.push({ sessionId, branch });
    return true;
  }

  // --- posture inheritance seam ----------------------------------------------

  /** Recorded postures by session id — what a parent session was launched with. */
  readonly postures = new Map<string, SessionLaunchPosture>();
  /** Session ids `loadSessionLaunchPosture` was asked about, in order. */
  readonly postureQueries: string[] = [];
  /** When set, the posture read REJECTS — the unreadable-parent case. */
  postureError: Error | null = null;

  async loadSessionLaunchPosture(
    auth: GraphAuth,
    sessionId: string,
  ): Promise<SessionLaunchPosture | null> {
    this.authSeen.push(auth);
    this.postureQueries.push(sessionId);
    if (this.postureError) throw this.postureError;
    return this.postures.get(sessionId) ?? null;
  }

  // --- worktree provisioning seam ---------------------------------------------
  //
  // An ordered LOG rather than a reimplemented state machine, deliberately: the
  // saga's assertions are about which calls happened and in what order relative
  // to the work_session row, and a fake that re-derived the design would let a
  // test pass against the fake's opinion of it.

  readonly worktreeCalls: Array<{ call: string; worktreeId: string; detail?: unknown }> = [];
  readonly worktreeAllocations = new Map<string, WorktreeAllocationRow>();
  /** Make the next reservation / entity create / lease blow up, per saga boundary. */
  failWorktreeReserve: Error | null = null;
  failWorktreeEntity: Error | null = null;
  failWorktreeLease: Error | null = null;
  /** What `listNodeWorktreeAllocations` answers. Set by the reconciliation tests. */
  nodeWorktreeAllocations: WorktreeAllocationRow[] = [];
  readonly projectWorkingDirs = new Map<string, string>();

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
    this.authSeen.push(auth);
    if (this.failWorktreeReserve) throw this.failWorktreeReserve;
    this.worktreeCalls.push({ call: 'reserve', worktreeId: input.worktreeId, detail: input });
    this.worktreeAllocations.set(input.worktreeId, {
      worktreeId: input.worktreeId,
      projectId: input.projectId,
      state: 'preparing',
      path: input.path,
      branch: input.branch,
      leaseSessionId: null,
      attempts: 0,
      failureCode: null,
      entityExists: false,
      worktreeStatus: null,
      leaseSessionStatus: null,
      updatedAt: new Date().toISOString(),
    });
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
    this.authSeen.push(auth);
    this.worktreeCalls.push({
      call: `state:${input.state}`,
      worktreeId: input.worktreeId,
      detail: input,
    });
    const row = this.worktreeAllocations.get(input.worktreeId);
    if (row) {
      row.state = input.state;
      row.failureCode = input.failureCode ?? row.failureCode;
      if (input.countAttempt) row.attempts += 1;
    }
  }

  async createWorktreeEntity(
    auth: GraphAuth,
    input: { worktreeId: string; spaceId: string; projectId: string; path: string; branch: string },
  ): Promise<void> {
    this.authSeen.push(auth);
    if (this.failWorktreeEntity) throw this.failWorktreeEntity;
    this.worktreeCalls.push({ call: 'createEntity', worktreeId: input.worktreeId, detail: input });
    const row = this.worktreeAllocations.get(input.worktreeId);
    if (row) row.entityExists = true;
  }

  async acquireWorktreeLease(
    auth: GraphAuth,
    worktreeId: string,
    sessionId: string,
  ): Promise<void> {
    this.authSeen.push(auth);
    if (this.failWorktreeLease) throw this.failWorktreeLease;
    this.worktreeCalls.push({ call: 'lease', worktreeId, detail: sessionId });
    const row = this.worktreeAllocations.get(worktreeId);
    if (row) row.leaseSessionId = sessionId;
  }

  async releaseWorktreeLease(auth: GraphAuth, worktreeId: string): Promise<void> {
    this.authSeen.push(auth);
    this.worktreeCalls.push({ call: 'unlease', worktreeId });
    const row = this.worktreeAllocations.get(worktreeId);
    if (row) row.leaseSessionId = null;
  }

  async linkSessionToWorktree(
    auth: GraphAuth,
    input: { spaceId: string; sessionId: string; worktreeId: string },
  ): Promise<void> {
    this.authSeen.push(auth);
    this.worktreeCalls.push({ call: 'edge', worktreeId: input.worktreeId, detail: input.sessionId });
  }

  async listNodeWorktreeAllocations(
    auth: GraphAuth,
    _nodeId: string,
  ): Promise<WorktreeAllocationRow[]> {
    this.authSeen.push(auth);
    return this.nodeWorktreeAllocations;
  }

  async loadProjectWorkingDir(auth: GraphAuth, projectId: string): Promise<string | null> {
    this.authSeen.push(auth);
    return this.projectWorkingDirs.get(projectId) ?? null;
  }
}
