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
  SpawnContext,
  Tm8Manifest,
  TransitionInput,
  WorkSessionResumeInfo,
  WorkSessionStatus,
} from '../src/spawn/types.js';

export interface FakeGraphOptions {
  workingDir: string;
  /** Omit the project to exercise the projectless scratch-session path. */
  withProject?: boolean;
  model?: string | null;
  permissionMode?: string | null;
}

export class FakeGraph implements GraphPort {
  readonly created: CreateWorkSessionInput[] = [];
  readonly transitions: TransitionInput[] = [];
  readonly commands: RecordCommandInput[] = [];
  readonly manifests: Array<{ sessionId: string; manifest: Tm8Manifest; envVarNames: string[] }> = [];
  readonly profilePins: Array<{ sessionId: string; profile: ResolvedInteractionProfileContext }> = [];
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
    const sessionId = randomUUID();
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

  async recordManifest(
    auth: GraphAuth,
    sessionId: string,
    manifest: Tm8Manifest,
    envVarNames: string[],
  ): Promise<void> {
    this.authSeen.push(auth);
    this.manifests.push({ sessionId, manifest, envVarNames });
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
  readonly resumes: Array<{ sessionId: string; clientMutationId: string | null }> = [];
  /** Native ids recorded, in order. */
  readonly nativeIds: Array<{ sessionId: string; nativeSessionId: string }> = [];

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
    input: { sessionId: string; clientMutationId: string | null },
  ): Promise<ResumeWorkSessionResult> {
    this.authSeen.push(auth);
    this.resumes.push(input);
    return {
      commandResult: { entityId: input.sessionId, patches: [input.sessionId] },
      replayed: false,
    };
  }

  async recordNativeSessionId(
    auth: GraphAuth,
    sessionId: string,
    nativeSessionId: string,
  ): Promise<void> {
    this.authSeen.push(auth);
    this.nativeIds.push({ sessionId, nativeSessionId });
  }
}
