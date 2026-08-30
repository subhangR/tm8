/**
 * createFixtureSeam() — the fixture implementation of the co-owned Facade seam
 * (LLD §10, C-5). Drop-in interchangeable with createRealSeam():
 *
 * - Reads resolve from the FE-owned dataset in ../../fixtures (READ-ONLY —
 *   the whole dataset is deep-cloned once at seam creation, so commands never
 *   mutate the module-level fixture objects and every seam instance is
 *   isolated from every other).
 * - Commands mutate the in-memory clone and synthesize BOTH the authoritative
 *   `CommandResult.patches` AND an echo `DurableWorkspaceEvent` carrying the
 *   caller's `clientMutationId` with a strictly-increasing per-space seq,
 *   dispatched asynchronously (queueMicrotask) through `onEvent` — so FE
 *   stores exercise the REAL optimistic-reconcile path against fixtures.
 * - Events are delivered only for OPEN spaces, matching the seam guarantee
 *   ("durable events for open spaces").
 * - Honesty rules hold: presence is NEVER synthesized (R8 dormant), delivery
 *   facets pass through UNCOLLAPSED ('unknown' stays 'unknown'), menu()
 *   resolves null (C-4 — the UI substitutes its shipped default), and the
 *   liveness predicate is the R-UI-5 rule verbatim — sessionStale evaluates
 *   'stale' and sessionLive 'live' out of the box.
 *
 * Determinism: no Date.now() / Math.random(). Time advances on a fixed
 * 1-second tick from FIXTURE_NOW per mutation; ids and seqs are counters.
 */
import {
  type CreateInviteInput,
  type InvitePreview,
  type InviteRedemption,
  type RedeemInviteInput,
  type SpaceInviteView,
  type TaskAxis,
  type TaskAxisInput,
  type TaskWorkflow,
  type StatusCategory,
  type Workflow,
  type TaskWorkflowInput,
  type UpdateMemberRoleInput,
  bindPath,
  CollabError,
  FILE_MAX_SIZE_BYTES_DEFAULT,
  WORKSPACE_EVENT_SCHEMA_VERSION,
  type ActivityItem,
  type ArtifactsPreviewStartInput,
  type ActorSummary,
  type AttentionRequest,
  type AttentionRequestPage,
  type CollectionAddItemInput,
  type CollectionGroup,
  type CollectionQuery,
  type CollectionResult,
  type HomeSnapshot,
  type CommandContext,
  type CommandResult,
  type CompleteTaskInput,
  type CreateEdgeInput,
  type CreateEntityInput,
  type CreateTaskInput,
  type CustomEntityState,
  type CustomFieldDef,
  type DurableWorkspaceEvent,
  type EdgeView,
  type EntityContent,
  type EntityDetail,
  type EntityFeedPage,
  type EntityId,
  type EntityKindDef,
  type EntityState,
  type EntitySummary,
  type ExecutionPromptInput,
  type ExecutionDispatchInput,
  type ExecutionDispatchResult,
  type ExecutionSpawnInput,
  type ExecutionTerminalStartInput,
  type ExecutionResumeInput,
  type ExecutionTerminateInput,
  type FeedItem,
  type FileUploadGrant,
  type FileUploadInitInput,
  type GraphEdgeView,
  type GraphQuery,
  type GraphResult,
  type HandoffView,
  type IdentityProfileUpdateInput,
  type IdentityProfileView,
  type MenuConfig,
  type MessageBatchResult,
  type MessageDeliveryRecord,
  type MessageDeliveryView,
  type MessageView,
  type MoveEntityInput,
  type NotificationItem,
  type Page,
  type PatchEntityInput,
  type PatchMessageInput,
  type PatchTaskInput,
  type PostMessageInput,
  type CredentialsStatusView,
  type ContentionReport,
  type ProjectBranchTopology,
  type ProjectFileBlame,
  type ProjectFileHistory,
  type ProjectResource,
  type ReactionInput,
  type ExecutionGitCheckpointInput,
  type ExecutionGitCommitInput,
  type ExecutionGitMergeInput,
  type ExecutionGitCherryPickInput,
  type ExecutionGitBranchInput,
  type ExecutionGitStashInput,
  type ExecutionGitRollbackInput,
  type SessionGitCheckpointResult,
  type SessionGitCommitResult,
  type SessionGitDiff,
  type SessionGitFile,
  type SessionGitMergeResult,
  type SessionGitCherryPickResult,
  type SessionGitBranchResult,
  type SessionGitStashResult,
  type SessionGitStashEntry,
  type SessionGitRollbackResult,
  type SessionGitStatus,
  type SessionJournalPage,
  type SessionLaunchRecord,
  type SessionJournalRecord,
  type SessionTranscriptPage,
  type SpaceId,
  type SpaceKindCounts,
  type SpaceSettingsView,
  type SpaceSummary,
  type TrackingPrMergeInput,
  type TrackingPrMergeResult,
  type WorkInput,
  type WorkStatus,
} from '@tm8/contract';
import type {
  ConnectionState,
  FeedOpts,
  FixturePrMergeGuard,
  FixtureSeam,
  IdentityView,
  LivenessSnapshot,
  PageOpts,
  SessionLiveness,
  Unsubscribe,
} from '../seam';
import {
  FIXTURE_BRANCH_TOPOLOGY,
  FIXTURE_NOW,
  FIXTURE_SPACE_ID,
  SAMPLE_DIFF,
  ada,
  fixtureDetails,
  fixtureHandoffsBySession,
  fixtureSummaries,
  memberAda,
  memberNoor,
  noor,
  sessionCredentialLogin,
  sessionExited,
  sessionLive,
  sessionStale,
} from '../../fixtures';
import { SHIPPED_DEFAULT_MENU } from '../../domain';

export const FIXTURE_NODE_BOOT_ID = 'boot-fixture-1';


/** Transcript-observed file changes for the live session (files=1). */
const FIXTURE_FILE_CHANGES = {
  files: [
    {
      path: 'packages/execution/src/pty/PtyHostService.ts',
      edits: 2,
      linesAdded: 14,
      linesRemoved: 3,
      hunks: [
        { tool: 'edit' as const, linesAdded: 9, linesRemoved: 2, oldText: '  emit(frame);\n  return;', newText: '  if (!this.closed) {\n    emit(frame);\n  }\n  return;' },
        { tool: 'edit' as const, linesAdded: 5, linesRemoved: 1, oldText: 'const RETRY = 1;', newText: 'const RETRY = 3; // measured' },
      ],
      hunksTruncated: false,
    },
    {
      path: 'packages/execution/test/spawn-loop.test.ts',
      edits: 1,
      linesAdded: 22,
      linesRemoved: 0,
      hunks: [
        { tool: 'write' as const, linesAdded: 22, linesRemoved: 0, oldText: null, newText: null },
      ],
      hunksTruncated: true,
    },
  ],
  totalAdded: 36,
  totalRemoved: 3,
  filesTruncated: false,
  source: 'transcript' as const,
};

/**
 * THE LIVE SESSION'S TRANSCRIPT, LONG ENOUGH TO PAGE.
 *
 * 34 turns against a 20-turn window, so the walk backwards takes two pages and
 * the second one reaches the beginning — the only shape in which BOTH ends of
 * the feature are reachable from a fixture: a `hasOlder: true` boundary that
 * invites the walk, and the earned `hasOlder: false` claim that this really is
 * where the session started.
 *
 * `offset` stands in for the byte offset of the record behind each turn. Its
 * VALUES are arbitrary; what has to be true is the shape the real reader
 * guarantees — strictly increasing, and 0 for the first turn, so that walking
 * back terminates at the start of the file rather than at an arbitrary floor.
 * The offsets are spaced unevenly on purpose: an evenly-spaced fixture would
 * let a client that computed the next cursor arithmetically (`windowStart -
 * pageSize`) pass, and that client is broken against a real transcript, where
 * turns are wildly different sizes.
 */
interface FixtureTranscriptTurn {
  at: string;
  source: 'user' | 'assistant';
  text: string;
  truncated: boolean;
  offset: number;
}

function fixtureTranscriptTurns(): FixtureTranscriptTurn[] {
  const beats: [source: 'user' | 'assistant', text: string][] = [
    ['user', 'Take the failing spawn test and find why the PTY never emits.'],
    ['assistant', 'Reading the spawn service and its test harness to see which side owns the timeout.'],
    ['assistant', 'The harness builds the ring before the host is attached, so there is a window with no reader.'],
    ['user', 'Does it fail the same way under codex?'],
    ['assistant', 'Same failure, different timing — which points at the harness rather than at either adapter.'],
    ['assistant', 'Instrumenting the ring with a write counter to see whether the bytes arrive at all.'],
    ['assistant', 'They arrive. 4 frames land before the first read, so nothing is lost — it is only unread.'],
    ['user', 'Then the assertion is wrong, not the code.'],
    ['assistant', 'Agreed for the first flush. The second assertion is still measuring something real.'],
    ['assistant', 'Splitting the test: one case for the buffered frames, one for the live stream.'],
    ['assistant', 'The buffered case passes immediately. The live case still hangs at 5s.'],
    ['user', 'Do not raise the timeout to make it pass.'],
    ['assistant', 'No — a timeout raise would hide it. Tracing where the stream stops instead.'],
    ['assistant', 'The stream stops at the first resize: the host re-opens the fd and the old reader keeps the stale one.'],
    ['assistant', 'That is the bug. Resize swaps the descriptor without re-subscribing the consumer.'],
    ['user', 'Is that reachable outside the test?'],
    ['assistant', 'Yes — any terminal resize on a live session hits it, which matches the “terminal goes quiet” reports.'],
    ['assistant', 'Writing a regression that resizes mid-stream and asserts the bytes keep coming.'],
    ['assistant', 'The regression fails on main and passes with the re-subscribe, which is the pair worth having.'],
    ['user', 'Good. Keep the split tests too.'],
    ['assistant', 'Kept. The buffered case is what tells you WHICH half broke when this regresses again.'],
    ['assistant', 'Running the whole execution suite to see what else touched the resize path.'],
    ['assistant', 'One unrelated red, already red on main — recording it rather than folding it in here.'],
    ['user', 'Diff it by name against main before you believe that.'],
    ['assistant', 'Done. Same single test by name on both sides, so it is inherited and not mine.'],
    ['assistant', 'Tidying the instrumentation back out; the counter was a probe, not a feature.'],
    ['assistant', 'Re-reading the diff for anything I left behind. The probe is gone and the fix is three lines.'],
    ['user', 'Does the re-subscribe leak the old reader?'],
    ['assistant', 'It did. Closing the stale descriptor in the same step, with a test that counts open handles.'],
    ['assistant', 'Handle count is flat across 50 resizes now, where it grew by one per resize before.'],
    ['assistant', 'Full suite green apart from the inherited red.'],
    ['user', 'Ship it.'],
    ['assistant', 'Committed and pushed; the PR body carries the handle-count numbers.'],
    ['assistant', 'Linked to the task, so the status chips track it from here.'],
  ];
  // Uneven, strictly increasing, first turn at 0.
  let offset = 0;
  return beats.map(([source, text], i) => {
    const turn: FixtureTranscriptTurn = {
      at: new Date(Date.UTC(2026, 0, 4, 9, 15 + i * 3, 2)).toISOString(),
      source,
      text,
      truncated: false,
      offset,
    };
    offset += 180 + ((i * 137) % 420);
    return turn;
  });
}
/**
 * Re-exported because seam-level tests address the fixture space through the
 * SEAM module they exercise. This was imported here and NOT re-exported for a
 * while, and the failure mode is worth recording: importing the missing name
 * from this module did not throw under the test transform — it arrived as
 * `undefined`, `openSpace(undefined)` does not validate, and `createEntity`
 * then minted rows with `spaceId: undefined` that consistently matched
 * queries carrying the same undefined. Whole test files ran green against a
 * space that does not exist. The re-export makes the name real; the lens
 * test that caught this now queries the actual dataset space.
 */
export { FIXTURE_SPACE_ID };

const FIXTURE_PROJECTS: readonly ProjectResource[] = [
  {
    id: 'proj-tm8ui',
    name: 'tm8-ui',
    repoUrl: 'https://github.com/subhang/tm8',
    workingDir: '/fixture/tm8-ui',
    trust: 'trusted',
    defaults: {},
    activeLinkCount: 1,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
  },
];

const clone = <T>(x: T): T => structuredClone(x);

const FIXTURE_BASE_MS = Date.parse(FIXTURE_NOW);

/** Seeded attention history is dated off the fixture clock, never a real
 *  one: `Date.now()` here would make every relative timestamp in the
 *  gallery drift with the wall clock and no screenshot would reproduce. */
const FIXTURE_HISTORY_EPOCH = FIXTURE_NOW;

// -- Tier 1 file reads (Amendment 8) -----------------------------------------
// The SAME file the contention fixture flags as overlapping, so the git
// screens narrate one story. Attribution is deliberately mixed: a joined
// session, a plain non-tm8 commit (session: null), and an uncommitted hunk —
// the three states the blame overlay must distinguish honestly.
const FIXTURE_FILE_PATH = 'packages/server/src/facade/handlers/projects.ts';
const OID_A = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const OID_B = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const OID_C = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
const ZERO_OID = '0'.repeat(40);

const ATTR_LIVE = {
  commitEntityId: 'fx-commit-a',
  sessionId: sessionLive.id,
  sessionTitle: sessionLive.title,
  agentTool: 'claude-code',
  teamMemberId: 'tm-forge',
  teamMemberName: 'forge',
};
const ATTR_STALE = {
  commitEntityId: 'fx-commit-c',
  sessionId: sessionStale.id,
  sessionTitle: sessionStale.title,
  agentTool: 'claude-code',
  teamMemberId: 'tm-scout',
  teamMemberName: 'scout',
};

const FIXTURE_FILE_REVISIONS: ProjectFileHistory['revisions'] = [
  {
    oid: OID_A,
    author: 'forge',
    authorEmail: 'forge@fixture',
    committedAt: FIXTURE_NOW,
    subject: 'feat(projects): register the branches read',
    additions: 41,
    deletions: 3,
    path: FIXTURE_FILE_PATH,
    session: ATTR_LIVE,
  },
  {
    oid: OID_B,
    author: 'ada',
    authorEmail: 'ada@example.com',
    committedAt: new Date(FIXTURE_BASE_MS - 86_400_000).toISOString(),
    subject: 'chore: manual hotfix outside tm8',
    additions: 2,
    deletions: 2,
    path: FIXTURE_FILE_PATH,
    session: null,
  },
  {
    oid: OID_C,
    author: 'scout',
    authorEmail: 'scout@fixture',
    committedAt: new Date(FIXTURE_BASE_MS - 3 * 86_400_000).toISOString(),
    subject: 'feat(projects): first cut of the handlers',
    additions: 120,
    deletions: 0,
    path: 'packages/server/src/facade/handlers/projects-old.ts',
    session: ATTR_STALE,
  },
];

const FIXTURE_FILE_BLAME_HUNKS: ProjectFileBlame['hunks'] = [
  { oid: OID_A, startLine: 1, lineCount: 12, author: 'forge', committedAt: FIXTURE_NOW, summary: 'feat(projects): register the branches read', uncommitted: false, session: ATTR_LIVE },
  { oid: OID_B, startLine: 13, lineCount: 4, author: 'ada', committedAt: new Date(FIXTURE_BASE_MS - 86_400_000).toISOString(), summary: 'chore: manual hotfix outside tm8', uncommitted: false, session: null },
  { oid: ZERO_OID, startLine: 17, lineCount: 3, author: 'not yet committed', committedAt: '', summary: '', uncommitted: true, session: null },
  { oid: OID_C, startLine: 20, lineCount: 21, author: 'scout', committedAt: new Date(FIXTURE_BASE_MS - 3 * 86_400_000).toISOString(), summary: 'feat(projects): first cut of the handlers', uncommitted: false, session: ATTR_STALE },
];

const CAPS_FULL: EntityDetail['capabilities'] = {
  canEdit: true, canDelete: true, canAddChild: true, canLink: true,
  canPull: true, canReact: true, canGrantPoints: true, canComplete: true,
};

const NO_CONNECTIONS: EntityDetail['connections'] = {
  outgoing: [], incoming: [], unresolvedHardDependencyCount: 0,
};

/** Detail-only extras kept beside the summary; hierarchy is recomputed live. */
interface DetailExtras {
  content: EntityContent;
  connections: EntityDetail['connections'];
  capabilities: EntityDetail['capabilities'];
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function isCustomState(s: EntityState): s is CustomEntityState {
  return s.kind.startsWith('c:');
}

/**
 * A small, deterministic CLI journal for the live fixture session: a couple of
 * successful reads and one failed command, exercising the DEBUG surface's
 * expand/collapse, failure styling, truncation marker, and HTTP-call rows.
 */
function fixtureJournalRecords(sessionId: EntityId): SessionJournalRecord[] {
  const at = (offsetMs: number) => new Date(FIXTURE_BASE_MS - offsetMs).toISOString();
  const base = { v: 1 as const, sessionId, spaceId: FIXTURE_SPACE_ID, teamMemberId: null };
  return [
    {
      ...base,
      seq: 1,
      pid: 41001,
      startedAt: at(9000),
      durationMs: 214,
      command: { path: ['task', 'list'], argv: ['tm8', 'task', 'list', '--json'], cwd: '/work/tm8' },
      input: { stdinChars: 0 },
      output: {
        stdoutChars: 1840,
        stderrChars: 0,
        stdoutSample: '[{"id":"01900000-0000-7000-8000-0000000000aa","title":"Wire the DEBUG surface"}]',
        stderrSample: '',
        truncated: true,
      },
      calls: [
        {
          operation: 'collections.query',
          method: 'POST',
          path: '/v2/collections/query',
          baseUrl: 'http://127.0.0.1:4610',
          status: 200,
          requestChars: 132,
          responseChars: 1840,
          durationMs: 188,
        },
      ],
      result: { exitCode: 0, error: null },
      tokens: { estimator: 'chars/4', agentToCli: 8, cliToAgent: 460 },
    },
    {
      ...base,
      seq: 2,
      pid: 41002,
      startedAt: at(5200),
      durationMs: 96,
      command: { path: ['message', 'send'], argv: ['tm8', 'message', 'send', '--to', 'lead'], cwd: '/work/tm8' },
      input: { stdinChars: 512 },
      output: {
        stdoutChars: 64,
        stderrChars: 0,
        stdoutSample: '{"delivered":1}',
        stderrSample: '',
        truncated: false,
      },
      calls: [
        {
          operation: 'messages.post',
          method: 'POST',
          path: '/v2/messages',
          baseUrl: 'http://127.0.0.1:4610',
          status: 200,
          requestChars: 540,
          responseChars: 64,
          durationMs: 71,
        },
      ],
      result: { exitCode: 0, error: null },
      tokens: { estimator: 'chars/4', agentToCli: 138, cliToAgent: 16 },
    },
    {
      ...base,
      seq: 3,
      pid: 41003,
      startedAt: at(1200),
      durationMs: 41,
      command: { path: ['task', 'complete'], argv: ['tm8', 'task', 'complete', 'bad-id'], cwd: '/work/tm8' },
      input: { stdinChars: 0 },
      output: {
        stdoutChars: 0,
        stderrChars: 88,
        stdoutSample: '',
        stderrSample: 'error: entity not found (404)',
        truncated: false,
      },
      calls: [
        {
          operation: 'entities.commands.complete',
          method: 'POST',
          path: '/v2/entities/bad-id/complete',
          baseUrl: 'http://127.0.0.1:4610',
          status: 404,
          requestChars: 40,
          responseChars: 88,
          durationMs: 33,
        },
      ],
      result: { exitCode: 1, error: 'entity not found' },
      tokens: { estimator: 'chars/4', agentToCli: 12, cliToAgent: 22 },
    },
  ];
}

/**
 * The spawn-time configuration for the live fixture session: a manifest shaped
 * like the one `composeManifest` writes, the env var NAMES (values are never
 * recorded anywhere, so there is nothing here to omit), and the two prompt
 * channels as bytes.
 *
 * The manifest is deliberately typed `Record<string, unknown>` all the way from
 * the contract, so this fixture is not obliged to track `Tm8Manifest` — which is
 * the point: the DEBUG surface renders whatever document a node wrote, and a
 * fixture pinned to today's interface would hide that.
 */
function fixtureLaunchRecord(sessionId: EntityId): SessionLaunchRecord {
  return {
    sessionId,
    available: true,
    unavailableReason: null,
    manifest: {
      manifestVersion: '1',
      sessionId,
      spaceId: FIXTURE_SPACE_ID,
      generatedAt: new Date(FIXTURE_BASE_MS - 60_000).toISOString(),
      mode: 'worker',
      baseUrl: 'http://127.0.0.1:4610',
      agent: {
        teamMemberId: '01900000-0000-7000-8000-0000000000b1',
        name: 'Draco',
        avatar: '🖥️',
        role: 'PTY engineer',
        identity: 'You own the terminal seam. Read the bytes before believing a status.',
        memory: [],
        capabilities: { canReportProgress: true },
        commandPermissions: {},
      },
      launch: {
        tool: 'claude',
        model: 'opus',
        permissionMode: 'acceptEdits',
        accessMode: 'workspace-write',
        reasoningEffort: null,
        commandNetwork: 'enabled',
        command: 'claude --permission-mode acceptEdits --append-system-prompt <system> <task>',
      },
      session: {
        title: 'Wire the DEBUG surface',
        workingDirectory: '/work/tm8',
        workdirMode: 'project',
      },
      project: { id: '01900000-0000-7000-8000-0000000000c1', name: 'tm8', workingDir: '/work/tm8', trust: 'trusted' },
      interactionProfile: {
        profileId: null,
        profileVersion: null,
        templateKey: 'tm8.chat.core',
        templateVersion: 1,
        source: 'core_default',
        resolvedHash: 'sha256:fixture-core-profile-hash',
        pinRevision: 1,
      },
      tasks: [
        {
          id: '01900000-0000-7000-8000-0000000000aa',
          version: 3,
          title: 'Wire the DEBUG surface',
          description: 'Show the spawn-time configuration, not just the command journal.',
          priority: 'high',
          status: 'in_progress',
          acceptanceCriteria: [],
        },
      ],
      skills: [],
      coordinator: null,
      directive: null,
      promptExtra: null,
    },
    envVarNames: ['TM8_BASE_URL', 'TM8_SESSION_ID', 'TM8_SPACE_ID', 'TM8_AGENT_TOKEN', 'TM8_MANIFEST_PATH'],
    prompts: {
      system:
        '<tm8_system_prompt version="1.0" mode="worker">\n'
        + '  <identity>\n'
        + '    <name>Draco</name>\n'
        + '    <role>PTY engineer</role>\n'
        + '  </identity>\n'
        + '</tm8_system_prompt>',
      task:
        '<tm8_task_prompt>\nTitle: Wire the DEBUG surface\n'
        + 'Show the spawn-time configuration, not just the command journal.\n</tm8_task_prompt>',
      unavailableReason: null,
    },
    recordedAt: new Date(FIXTURE_BASE_MS - 60_000).toISOString(),
  };
}

/** Minimal kind-correct content for summaries the dataset gives no detail for. */
function synthesizeContent(s: EntitySummary): EntityContent {
  const state = s.state;
  if (isCustomState(state)) return { kind: state.kind, fields: { ...state.fields } };
  switch (state.kind) {
    case 'task':
      return { kind: 'task', description: s.excerpt ?? '', acceptanceCriteria: [], pointsEstimate: null };
    case 'channel':
      return { kind: 'channel', topic: state.topic, pinned: [], autoTabs: [] };
    case 'doc':
      return { kind: 'doc', body: s.excerpt ?? '', format: state.format };
    case 'message':
      return { kind: 'message', body: s.title, mentions: [], attachments: [] };
    case 'member':
      return { kind: 'member', teamMembers: [], work: [] };
    case 'team_member':
      return {
        kind: 'team_member', identity: s.excerpt ?? '', memories: [], capabilities: {},
        commandPermissions: {}, equipped: [], work: [],
      };
    case 'work_session':
      return { kind: 'work_session', nodeId: null, launchProjectId: null, workingOn: [], transcriptDoc: null };
    case 'collection':
      return { kind: 'collection', description: s.excerpt ?? '', items: [] };
    case 'project':
      return { kind: 'project', projectId: state.projectId, materializedVersion: state.materializedVersion };
    case 'interaction_profile':
      return {
        kind: 'interaction_profile', status: state.status, templateKey: 'fixture-template',
        templateVersion: 1, resolvedHash: state.activeHash, generatedByTeamMemberId: null,
      };
    case 'memory':
      return {
        kind: 'memory', statement: s.excerpt ?? s.title, mechanism: state.mechanism,
        subjectScope: state.subjectScope, doesNotEstablish: state.doesNotEstablish,
        measuredAt: state.measuredAt,
      };
    case 'artifact':
      // Manifest facts are publish-time server values; the fixture supplies a
      // minimal coherent bundle so the strict content shape is satisfied.
      return {
        kind: 'artifact', description: s.excerpt ?? null,
        currentRevisionNumber: state.revisionNumber, entrypoint: 'index.html',
        manifestSha256: 'f'.repeat(64), fileCount: 1, totalSizeBytes: 1024,
      };
    case 'worktree':
      // Path is server-computed in the real system; the fixture derives a
      // plausible one from the branch so the strict content shape is satisfied.
      return {
        kind: 'worktree', projectId: state.projectId, path: `/data/worktrees/${state.branch}`,
        branch: state.branch, baseRef: state.baseRef, baseCommitOid: state.baseCommitOid,
        status: state.status, statusChangedAt: null,
      };
    case 'loop':
      // The loop content arm is CLOSED (every field required), so the fixture
      // has to produce a whole one rather than falling through to the open
      // `{ kind }` variant below.
      return {
        kind: 'loop', schedule: state.schedule, enabled: state.enabled,
        teamMemberId: state.teamMemberId, subjectId: state.subjectId,
        prompt: '', config: {},
        nextRunAt: state.nextRunAt, lastRunAt: state.lastRunAt, lastError: state.lastError,
      };
    case 'graph':
      // The graph content arm is CLOSED like loop's — produce a whole one.
      return {
        kind: 'graph', graphType: state.graphType,
        nodes: [], edges: [], layout: {}, source: null,
      };
    default:
      // pull_request | commit | file | spell | skill — the open content variant
      return { kind: state.kind };
  }
}

/** Minimal HTML escaping for fixture titles landing inside the demo page. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Unicode-safe base64 for the data: URL — bare btoa throws past Latin-1. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * The fixture bundle's page — self-contained, CSS-only, deterministic. It
 * names its own revision in the markup so switching revisions in the viewer
 * produces a VISIBLY different page, not two identical frames the switcher
 * only claims are different.
 */
function artifactDemoPage(title: string, revisionNumber: number): string {
  const safe = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safe} — fixture preview</title>
<style>
  :root { color-scheme: dark; }
  * { margin: 0; box-sizing: border-box; }
  body {
    min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; color: #e6e9f2;
    background:
      radial-gradient(1100px 500px at 15% -10%, #223052 0%, transparent 60%),
      radial-gradient(900px 500px at 110% 110%, #2a1f45 0%, transparent 55%),
      #0c0f17;
  }
  main {
    width: min(560px, 92vw); padding: 40px 44px; border-radius: 18px;
    background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.09);
  }
  .rev {
    display: inline-block; font: 600 11px/1 ui-monospace, monospace;
    letter-spacing: .12em; color: #9fd4ff; padding: 6px 12px;
    border: 1px solid rgba(159,212,255,.35); border-radius: 999px; margin-bottom: 18px;
  }
  h1 { font-size: 30px; letter-spacing: -.02em; margin-bottom: 10px; }
  p { color: #aab3c7; }
  .meter { height: 6px; border-radius: 3px; margin-top: 26px; overflow: hidden; background: rgba(255,255,255,.08); }
  .meter i {
    display: block; height: 100%; width: ${40 + revisionNumber * 18}%; border-radius: 3px;
    background: linear-gradient(90deg, #5b8cff, #a06bff); animation: fill 1.2s ease-out;
  }
  @keyframes fill { from { width: 0 } }
  footer { margin-top: 26px; font: 11px/1.5 ui-monospace, monospace; color: #6b7385; }
</style>
</head>
<body>
<main>
  <span class="rev">REVISION ${revisionNumber}</span>
  <h1>${safe}</h1>
  <p>This page is the artifact's own bundle executing inside the sandboxed
     preview frame — fixture-served, so the whole render path runs with no
     server attached.</p>
  <div class="meter"><i></i></div>
  <footer>tm8 fixture seam &middot; sandbox="allow-scripts" &middot; data: URL</footer>
</main>
</body>
</html>`;
}

/** CRC-32 (IEEE), the zip checksum. Table built once, lazily. */
let CRC_TABLE: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (CRC_TABLE === null) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A REAL zip (stored, no compression): local headers, central directory,
 * EOCD. Real because the honest fixture answer for export is bytes a zip
 * reader actually opens — a fake blob "downloads" successfully and then fails
 * in the user's hands, which is the dishonest order. Deterministic: the DOS
 * stamp is the fixture epoch, never the wall clock (same law as tick()).
 */
function storedZip(entries: Array<{ path: string; bytes: Uint8Array }>): Blob {
  const enc = new TextEncoder();
  const le = (v: number, n: number): number[] => Array.from({ length: n }, (_, i) => (v >>> (8 * i)) & 0xff);
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (7 << 5) | 28; // 2026-07-28, FIXTURE_NOW's day
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { path, bytes } of entries) {
    const name = enc.encode(path);
    const crc = crc32(bytes);
    // versionNeeded, flags, method(0=stored), time, date, crc, csize, usize, nameLen, extraLen
    const common = [
      ...le(20, 2), ...le(0, 2), ...le(0, 2), ...le(dosTime, 2), ...le(dosDate, 2),
      ...le(crc, 4), ...le(bytes.length, 4), ...le(bytes.length, 4), ...le(name.length, 2), ...le(0, 2),
    ];
    const local = new Uint8Array([...le(0x04034b50, 4), ...common, ...name]);
    central.push(new Uint8Array([
      ...le(0x02014b50, 4), ...le(20, 2), ...common,
      ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(offset, 4), ...name,
    ]));
    parts.push(local, bytes);
    offset += local.length + bytes.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array([
    ...le(0x06054b50, 4), ...le(0, 2), ...le(0, 2),
    ...le(entries.length, 2), ...le(entries.length, 2), ...le(cdSize, 4), ...le(offset, 4), ...le(0, 2),
  ]);
  // One contiguous copy: BlobPart demands a plain ArrayBuffer, and the chunk
  // views above are typed over ArrayBufferLike.
  const chunks = [...parts, ...central, eocd];
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return new Blob([out.buffer], { type: 'application/zip' });
}

/** The artifact summary's current revision — state-carried, 1 when absent. */
function currentRevisionOf(s: EntitySummary): number {
  const state = s.state as { revisionNumber?: unknown };
  return typeof state.revisionNumber === 'number' ? state.revisionNumber : 1;
}

/**
 * How many entities carry seeded history. Small on purpose: this is a specimen,
 * not a load test, and every seeded row is a row some other lane's assertion
 * could trip over.
 */
const ATTENTION_HISTORY_ENTITIES = 3;

/**
 * Materialize the attention table once.
 *
 * TWO HALVES, AND THE SECOND ONE EXISTS BECAUSE THE FIRST FOUND NOTHING.
 *
 * The PENDING half is the old badge-synthesis, moved here verbatim, because its
 * arithmetic is load-bearing: `attention-model.ts` regroups these rows and its
 * result is asserted to equal `badges.attention`. Points are spread across
 * `pendingCount` rows with the largest pinned to `maxPoints`, so count/sum/max
 * survive the round trip.
 *
 * It produces ZERO ROWS TODAY. Not one summary in `fixtures/entities.ts`
 * carries a `badges.attention`, so the fixture seam has always answered the
 * attention queue with an empty page — the inbox, its grouping, and every
 * attention surface downstream have never once rendered real content off a
 * fixture. That was invisible precisely because empty is also the correct
 * answer for an entity with nothing waiting. The half is kept anyway: it is
 * correct, and the moment the dataset gains a badge it starts working.
 *
 * The HISTORY half seeds SETTLED rows directly, on a deterministic handful of
 * entities. Settled deliberately: `resolved` and `dismissed` contribute
 * NOTHING to the badge (`recomputeAttentionBadge` counts only open and
 * acknowledged), so seeding them gives the history surface real content without
 * putting an attention badge onto a fixture entity that other lanes' list,
 * graph and home assertions currently expect to be unflagged. A specimen must
 * not change what its neighbours measure.
 *
 * The pending state is still reachable from here — `updateAttentionRequest` can
 * move a row back to `open`, which is what the tests use to exercise the badge
 * appearing and dropping again.
 */
function seedAttentionRows(summaries: ReadonlyMap<EntityId, EntitySummary>): AttentionRequest[] {
  const rows: AttentionRequest[] = [];

  for (const s of summaries.values()) {
    if (s.deletedAt !== null) continue;
    const agg = s.badges.attention;
    if (!agg || agg.pendingCount <= 0) continue;

    const rest = Math.max(0, agg.totalPoints - agg.maxPoints);
    const others = Math.max(0, agg.pendingCount - 1);
    const each = others > 0 ? Math.max(1, Math.round(rest / others)) : 0;
    for (let i = 0; i < agg.pendingCount; i += 1) {
      const first = i === 0;
      rows.push({
        id: `att-${s.id}-${i}`,
        spaceId: s.spaceId,
        entityId: s.id,
        reason: first ? agg.latestReason : `${agg.latestReason} (${i + 1})`,
        points: first ? agg.maxPoints : Math.min(each, 100),
        status: 'open',
        version: 1,
        requestedBy: s.createdBy,
        acknowledgedBy: null,
        resolvedBy: null,
        resolutionNote: null,
        createdAt: agg.oldestRequestedAt,
        updatedAt: agg.oldestRequestedAt,
        acknowledgedAt: null,
        resolvedAt: null,
      });
    }
  }

  // Sorted by id so the same entities are chosen on every run — a specimen that
  // moves between runs is one nobody can write an assertion against.
  const subjects = [...summaries.values()]
    .filter((s) => s.deletedAt === null)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, ATTENTION_HISTORY_ENTITIES);

  for (const [index, s] of subjects.entries()) {
    const day = (n: number) => new Date(Date.parse(FIXTURE_HISTORY_EPOCH) - n * 86_400_000).toISOString();
    rows.push({
      id: `att-${s.id}-h0`,
      spaceId: s.spaceId,
      entityId: s.id,
      reason: 'Blocked on a decision only a human can make; the agent stopped rather than guess.',
      points: 80 - index * 5,
      status: 'resolved',
      version: 2,
      requestedBy: s.createdBy,
      acknowledgedBy: null,
      resolvedBy: s.createdBy,
      resolutionNote: 'Answered in the thread — the agent picked up from there.',
      createdAt: day(4),
      updatedAt: day(3),
      acknowledgedAt: null,
      resolvedAt: day(3),
    });
    rows.push({
      id: `att-${s.id}-h1`,
      spaceId: s.spaceId,
      entityId: s.id,
      reason: 'Second agent raised the same block a few minutes later.',
      points: 40 - index * 5,
      status: 'dismissed',
      version: 2,
      requestedBy: s.createdBy,
      acknowledgedBy: null,
      resolvedBy: s.createdBy,
      // No note: a declined request often has none, and the row has to render
      // honestly without one.
      resolutionNote: null,
      createdAt: day(2),
      updatedAt: day(1),
      acknowledgedAt: null,
      resolvedAt: day(1),
    });
  }

  return rows;
}

/**
 * Migration 147/150's ruled status → category mapping, mirrored so fixture
 * summaries carry the same denormalized `category` the node projects (the
 * server derives it in a trigger on every status write; `touch` is this
 * fixture's equivalent single seam). Every other kind honestly OMITS the key —
 * "no status" is a different fact from `to_do` — until phase 5 gives them one.
 */
const WORK_STATUS_CATEGORY: Readonly<Record<string, StatusCategory>> = {
  open: 'to_do',
  pulled: 'to_do',
  working: 'in_progress',
  in_review: 'in_progress',
  blocked: 'in_progress',
  done: 'done',
  cancelled: 'cancelled',
};

/**
 * MIGRATION 155's mapping, the session half of the same mirror.
 *
 * The docblock above says every other kind "honestly OMITS the key … until
 * phase 5 gives them one". Phase 5 GAVE work_session one — 155 installs
 * `internal.session_status_category` and an AFTER trigger on every writer, and
 * backfills — and this table never followed. The omission stopped being honest
 * the day that migration ran: on the node a running session reads
 * `category: 'in_progress'`, and in this fixture the same row read `undefined`,
 * which the category predicate below treats as matching NO tab at all.
 *
 * That gap is why the reported defect had no failing test. Four empty tabs
 * looks the same as a landing-tab bug from inside a fixture-backed test, so
 * neither could be asserted, and the panel walk above renders every kind
 * without ever reading a row into a band.
 *
 * `spawning -> to_do` is 155's ruling verbatim, including its reason: a
 * spawning session has been ASKED for, not started, and it is what makes
 * `session_resume` a legal `done -> to_do` reopen rather than a refused
 * `done -> in_progress`.
 */
const SESSION_STATUS_CATEGORY: Readonly<Record<string, StatusCategory>> = {
  spawning: 'to_do',
  running: 'in_progress',
  idle: 'in_progress',
  exited: 'done',
  failed: 'done',
};

function stampCategory(s: EntitySummary): void {
  if (s.state.kind === 'task') {
    const category = WORK_STATUS_CATEGORY[s.state.status];
    if (category) s.category = category;
    return;
  }
  if (s.state.kind === 'work_session') {
    const category = SESSION_STATUS_CATEGORY[s.state.status];
    if (category) s.category = category;
  }
}

export function createFixtureSeam(): FixtureSeam {
  // -- in-memory state (isolated clone of the FE dataset) --------------------
  const summaries = new Map<EntityId, EntitySummary>(
    clone(fixtureSummaries).map((s) => {
      stampCategory(s);
      return [s.id, s];
    }),
  );
  const extras = new Map<EntityId, DetailExtras>(
    Object.values(clone(fixtureDetails)).map((d) => [
      d.id,
      { content: d.content, connections: d.connections, capabilities: d.capabilities },
    ]),
  );

  /**
   * ATTENTION ROWS ARE STATE HERE, not a projection of the badge.
   *
   * They used to be synthesized per call from `summary.badges.attention`, and
   * that made one whole half of the feature unrepresentable: the badge counts
   * only `open` + `acknowledged` (server `entity-read.ts:520-523`), so a
   * fixture derived from it could never produce a `resolved` or `dismissed`
   * row — the exact rows an attention HISTORY surface exists to show. Every
   * test and the whole fixture gallery saw an empty history and could not tell
   * that from a broken one.
   *
   * So the direction is inverted to match the server's: rows are the truth and
   * the badge is DERIVED from them (`recomputeAttentionBadge`). The seed still
   * reproduces each entity's stored aggregate exactly — count, sum and max all
   * round-trip, which is what the inbox's grouping is checked against — and
   * history rows are added on top, where they cannot disturb it.
   */
  const attentionRows: AttentionRequest[] = seedAttentionRows(summaries);
  const openSpaces = new Set<SpaceId>();
  const seqBySpace = new Map<SpaceId, number>();
  const readMarks = new Map<EntityId, string>();
  const uploadSlots = new Map<string, { input: FileUploadInitInput; grant: FileUploadGrant; uploaded: boolean }>();

  const eventSubs = new Set<(e: DurableWorkspaceEvent) => void>();
  const connectionSubs = new Set<(s: ConnectionState) => void>();
  const resyncSubs = new Set<(spaceId: SpaceId) => void>();
  const livenessSubs = new Set<(snap: LivenessSnapshot) => void>();

  // The fixture seam IS its own server: it starts live. Scriptable via
  // fixtureControls.setConnection for the gate-screen honesty demos.
  let connection: ConnectionState = { phase: 'live' };

  let tickN = 0;
  const tick = (): string => new Date(FIXTURE_BASE_MS + ++tickN * 1000).toISOString();
  let idN = 0;
  const nextId = (kind: string): string => `fx-${kind.replace(/^c:/, 'c-')}-${++idN}`;

  /**
   * The three providers, drawn so that ALL THREE honest-degradation states are
   * on screen at once and a screen cannot pass by collapsing two of them.
   * Mutable, because `disconnect` writes to it.
   */
  const credentialsState: CredentialsStatusView = {
    providers: [
      // Connected, and its login is null FOREVER — not pending, not unknown.
      {
        provider: 'anthropic',
        connected: true,
        login: null,
        authMethod: 'oauth',
        status: 'active',
        connectedAt: FIXTURE_NOW,
        lastVerifiedAt: FIXTURE_NOW,
      },
      // The one true negative — so "not connected" has something real to mean.
      {
        provider: 'openai',
        connected: false,
        login: null,
        authMethod: null,
        status: null,
        connectedAt: null,
        lastVerifiedAt: null,
      },
      // `connected: false` here is UNKNOWN, not measured — see gitCredentialStore.
      {
        provider: 'github',
        connected: false,
        login: null,
        authMethod: null,
        status: null,
        connectedAt: null,
        lastVerifiedAt: null,
      },
    ],
    // 'absent' is the fixture's default deliberately: it is the state of the
    // deployed staging line, and the one a screen gets wrong silently.
    gitCredentialStore: 'absent',
  };

  /**
   * -- session git rail state (Git UI wave) ---------------------------------
   *
   * MUTABLE per-seam-instance, like `credentialsState`: only the live PTY
   * (C-5) has a worktree, and the rail's verbs move this state the way the
   * server's would move a real one, so FLOW A (status → diff → checkpoint →
   * rollback → diff reflects it) is drivable end-to-end against the fixture.
   *
   * Determinism rules, mirrored from the real verbs:
   *  - checkpoint on a clean tree is a SUCCESS that creates nothing;
   *  - rollback refuses while untracked files exist, unless `force`;
   *  - commit refuses an empty index by `conflict`;
   *  - merge with `fromRef: 'conflict/base'` answers `status:'conflict'`
   *    with conflicted paths and CHANGES NOTHING — the scripted conflict
   *    trigger, the same idea as fixtureControls.setConnection.
   */
  const fxOid = (n: number): string => n.toString(16).padStart(40, '0');
  const gitLane = {
    branch: 'tm8/fixture-lane',
    baseRef: 'main',
    baseOid: fxOid(0xa1),
    /** History of head oids since branch-off; index in it = commits ahead. */
    history: [fxOid(0xb2)] as string[],
    behind: 1,
    dirty: [
      // The modified path matches SAMPLE_DIFF so status, diff and checkpoint
      // narrate one coherent change.
      { status: ' M', path: 'packages/server/src/facade/handlers/projects.ts' },
      { status: '??', path: 'notes/scratch.md' },
    ] as SessionGitFile[],
    serial: 0xb2,
    /** Stash entries (Tier 2 completion); index 0 is the newest, like git. */
    stashes: [] as SessionGitStashEntry[],
    /** Branches beside the lane's own; 'main' is base (protected), and the
     *  lane branch itself is checked out — both refuse delete/rename. */
    branches: ['main'] as string[],
  };
  const gitHead = (): string => gitLane.history[gitLane.history.length - 1] as string;
  /**
   * Which branch `commands.mergePullRequest` takes. Default `'available'`:
   * the fixture's own PR is the mergeable one, so a screen wired against it
   * demonstrates the SUCCESS path without setup, and every refusal — including
   * the 501 an older node answers — is one `setPrMergeGuard` call away.
   */
  let prMergeGuard: FixturePrMergeGuard = 'available';
  /** oid → the files a stash entry holds, so pop restores what push took. */
  const stashedFiles = new Map<string, SessionGitFile[]>();
  const gitUnavailable = (
    sessionId: EntityId,
    kind: 'status' | 'diff',
  ): SessionGitStatus | SessionGitDiff => {
    const common = {
      sessionId,
      available: false as const,
      unavailableReason: 'no_worktree' as const,
      branch: null,
      baseRef: null,
      baseOid: null,
      checkedAt: FIXTURE_NOW,
    };
    return kind === 'status'
      ? {
          ...common,
          worktreeId: null,
          headOid: null,
          ahead: null,
          behind: null,
          dirty: { staged: 0, unstaged: 0, untracked: 0, total: 0 },
          files: [],
          filesTruncated: false,
        }
      : {
          ...common,
          mergeBaseOid: null,
          headOid: null,
          stat: { filesChanged: 0, additions: 0, deletions: 0 },
          files: [],
          filesTruncated: false,
          diff: '',
          diffTruncated: false,
        };
  };
  const requireGitLane = (sessionId: EntityId): void => {
    requireSummary(sessionId);
    if (sessionId !== sessionLive.id) {
      throw new CollabError('conflict', 'session has no operable worktree (no_worktree)', {
        details: { reason: 'no_worktree' },
      });
    }
  };

  // Out-of-the-box liveness truth (C-5): sessionLive is the ONLY live PTY;
  // sessionStale stays running-per-record but absent from the live set.
  const livenessBySpace = new Map<SpaceId, LivenessSnapshot>([
    [FIXTURE_SPACE_ID, {
      spaceId: FIXTURE_SPACE_ID,
      liveEntityIds: [sessionLive.id],
      nodeBootId: FIXTURE_NODE_BOOT_ID,
      checkedAt: FIXTURE_NOW,
      capacity: { used: 1, total: 8 },
    }],
  ]);

  // Deterministic delivery facets, UNCOLLAPSED: agent-batch messages carry one
  // delivered and one honestly-unknown record; everything else has none.
  const workSessionIds = [...summaries.values()]
    .filter((s) => s.kind === 'work_session')
    .map((s) => s.id);
  const deliveriesByMessage = new Map<EntityId, MessageDeliveryRecord[]>();
  for (const s of summaries.values()) {
    if (s.state.kind !== 'message' || s.state.messageBatchId === null) continue;
    deliveriesByMessage.set(s.id, [
      {
        deliveryId: `dlv-${s.id}-1`, messageId: s.id, sourceWorkSessionId: null,
        targetWorkSessionId: workSessionIds[0] ?? 'ws-unknown', status: 'delivered',
        attemptNo: 1, failureReason: null, reservedAt: s.createdAt,
        claimedAt: s.updatedAt, settledAt: s.updatedAt, updatedAt: s.updatedAt,
      },
      {
        deliveryId: `dlv-${s.id}-2`, messageId: s.id, sourceWorkSessionId: null,
        targetWorkSessionId: workSessionIds[1] ?? 'ws-unknown', status: 'unknown',
        attemptNo: 1, failureReason: null, reservedAt: s.createdAt,
        claimedAt: null, settledAt: null, updatedAt: s.updatedAt,
      },
    ]);
  }

  // -- internals -------------------------------------------------------------

  /**
   * The invite list, mutable — 109. Seeded EMPTY on purpose: a fixture that
   * shipped a plausible-looking `inv_…` code would put a credential-shaped
   * string in front of every demo reader, and the interesting states (created,
   * revoked, exhausted) are all reachable in two clicks from empty.
   */
  const invites: SpaceInviteView[] = [];
  let inviteSeq = 0;

  /**
   * The task-axis registry, MUTABLE — W2. Seeded with exactly what the node
   * seeds every space (001's `type` axis, kind 'default', position 0), so
   * the fixture-backed product draws the axis picker and the Settings > Axes
   * screen has real rows to curate. The array itself is the store the CRUD
   * verbs below mutate; `spaceSettings()` clones it per read.
   */
  const taskAxes: TaskAxis[] = [
    {
      id: 'axis-type',
      spaceId: FIXTURE_SPACE_ID,
      name: 'type',
      axisValues: ['default', 'code', 'design', 'review', 'test'],
      kind: 'default',
      position: 0,
    },
  ];
  let axisSeq = 0;

  /**
   * W4 — the task-workflow registry (132), MUTABLE like `taskAxes` above:
   * one row per (space, `type` value) naming the SUBSET of statuses tasks of
   * that type may be moved TO. Seeded empty because the node seeds none; the
   * CRUD verbs below curate it and `spaceSettings()` clones it per read.
   */
  const taskWorkflows: TaskWorkflow[] = [];
  let workflowSeq = 0;

  /**
   * 132's trigger (`internal.validate_task_workflow`), mirrored refusal for
   * refusal so a fixture-backed status write refuses exactly like the node:
   * fires only when the status actually CHANGES; a task with no `type` value
   * (the trigger reads `new.axes ->> 'type'`), a type with no rule, or a
   * space with no rules is never touched; moving FROM an illegal status is
   * free, moving TO one refuses in the trigger's own words (23514 →
   * invariant_violation through the node's SQLSTATE map).
   */
  function requireWorkflowAllows(s: EntitySummary, status: string): void {
    if (s.state.kind !== 'task') return;
    if (s.state.status === status) return;
    const typeValue = (s.state.axes ?? {})['type'];
    if (typeof typeValue !== 'string' || typeValue === '') return;
    const rule = taskWorkflows.find((w) => w.typeValue === typeValue);
    if (!rule) return;
    if (!(rule.statuses as readonly string[]).includes(status)) {
      throw new CollabError(
        'invariant_violation',
        `workflow for type ${typeValue} does not allow status ${status}`,
      );
    }
  }

  /**
   * The node's own in-use predicate, mirrored: does any task in the space
   * carry a value under this axis NAME (`tasks.axes ? name`)? Used by
   * delete/rename/value-removal exactly as `w2_delete_task_axis` /
   * `w2_update_task_axis` use it — refusal, never orphaning (measured
   * 2026-08-16; 132 relaxes only the default-kind special cases).
   */
  function axisInUse(name: string, keepingValues?: readonly string[]): boolean {
    return [...summaries.values()].some((s) => {
      if (s.state.kind !== 'task') return false;
      const value = (s.state.axes ?? {})[name];
      if (typeof value !== 'string') return false;
      return keepingValues === undefined ? true : !keepingValues.includes(value);
    });
  }

  /** The shared validation the three w2_* RPCs apply, in the node's words. */
  function validateAxisInput(input: TaskAxisInput): void {
    if (!input.name || input.name.trim().length < 1 || input.name.trim().length > 100) {
      throw new CollabError('invalid_input', 'task axis name must contain 1 to 100 characters');
    }
    const values = input.axisValues;
    if (
      !Array.isArray(values)
      || values.some((v) => typeof v !== 'string' || v.trim() === '')
      || new Set(values).size !== values.length
    ) {
      throw new CollabError('invalid_input', 'task axis values must be unique non-empty strings');
    }
    if (input.kind !== 'default' && input.kind !== 'manual') {
      throw new CollabError('invalid_input', 'invalid task axis kind');
    }
  }

  /** Mirrors the node's shape (`'inv_' + 32 hex`) without pretending to be one. */
  function newInviteCode(): string {
    inviteSeq += 1;
    return `inv_fixture${String(inviteSeq).padStart(24, '0')}`;
  }

  /** The role a member summary carries, read structurally like the settings port does. */
  function roleOfSummary(s: EntitySummary): string | null {
    const state = s.state as { role?: unknown };
    return typeof state?.role === 'string' ? state.role : null;
  }

  function membersOfSpace(spaceId: SpaceId): EntitySummary[] {
    return [...summaries.values()].filter(
      (s) => s.kind === 'member' && s.spaceId === spaceId && !s.deletedAt,
    );
  }

  function requireSummary(id: EntityId): EntitySummary {
    const s = summaries.get(id);
    if (!s) throw new CollabError('not_found', `entity ${id} not found`);
    return s;
  }

  function requireVersion(s: EntitySummary, expectedVersion: number): void {
    if (s.version !== expectedVersion) {
      throw new CollabError('version_conflict', `expected version ${expectedVersion}, have ${s.version}`, {
        current: detailOf(s.id),
      });
    }
  }

  function extrasOf(id: EntityId): DetailExtras {
    let e = extras.get(id);
    if (!e) {
      const s = requireSummary(id);
      e = { content: synthesizeContent(s), connections: clone(NO_CONNECTIONS), capabilities: { ...CAPS_FULL } };
      extras.set(id, e);
    }
    return e;
  }

  function childrenOf(id: EntityId): EntitySummary[] {
    return [...summaries.values()]
      .filter((s) => s.parentId === id && s.deletedAt === null)
      .sort((a, b) => a.position - b.position);
  }

  function pathOf(s: EntitySummary): EntitySummary[] {
    const path: EntitySummary[] = [];
    const seen = new Set<EntityId>([s.id]);
    let cur = s.parentId ? summaries.get(s.parentId) : undefined;
    while (cur && !seen.has(cur.id)) {
      path.unshift(cur);
      seen.add(cur.id);
      cur = cur.parentId ? summaries.get(cur.parentId) : undefined;
    }
    return path;
  }

  function detailOf(id: EntityId): EntityDetail {
    const s = requireSummary(id);
    const e = extrasOf(id);
    return {
      ...s,
      content: e.content,
      hierarchy: {
        parent: s.parentId ? summaries.get(s.parentId) ?? null : null,
        children: { items: childrenOf(id), nextCursor: null, total: childrenOf(id).length },
        path: pathOf(s),
      },
      connections: e.connections,
      capabilities: e.capabilities,
    };
  }

  function toMessageView(s: EntitySummary): MessageView {
    if (s.state.kind !== 'message') throw new CollabError('invariant_violation', `${s.id} is not a message`);
    const content = extrasOf(s.id).content;
    if (content.kind !== 'message') throw new CollabError('invariant_violation', `${s.id} content is not a message`);
    // The thread-footer rollup, same shape as the server's grouped query: a
    // root that carries one of these carries all three. Participants are
    // ordered by their FIRST reply so a facepile never reshuffles between
    // reads of unchanged data.
    const replies = [...summaries.values()]
      .filter((m) => m.state.kind === 'message' && m.state.rootMessageId === s.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const participants = new Map<string, ActorSummary>();
    for (const reply of replies) {
      const author = (reply.state.kind === 'message' ? reply.state.author : null) ?? reply.createdBy;
      if (author && !participants.has(author.id)) participants.set(author.id, author);
    }
    return {
      ...s,
      state: s.state,
      content,
      replyCount: replies.length,
      lastReplyAt: replies.length ? replies[replies.length - 1].createdAt : null,
      replyParticipants: [...participants.values()],
    };
  }

  /** Strictly increasing per space; the client's dedupe/order key. */
  function nextSeq(spaceId: SpaceId): number {
    const seq = (seqBySpace.get(spaceId) ?? 1000) + 1;
    seqBySpace.set(spaceId, seq);
    return seq;
  }

  // Distributive omit: plain Omit over the event union collapses to the keys
  // common to every variant and rejects variant-specific payload fields.
  type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
  type EventBody = OmitEach<DurableWorkspaceEvent, 'spaceId' | 'seq' | 'occurredAt' | 'schemaVersion'>;

  /** Envelope + async dispatch. Delivered only for OPEN spaces (seam guarantee). */
  function emit(spaceId: SpaceId, body: EventBody, ctx?: CommandContext): void {
    if (!openSpaces.has(spaceId)) return;
    const event = {
      ...body,
      ...(ctx?.clientMutationId !== undefined ? { clientMutationId: ctx.clientMutationId } : {}),
      spaceId,
      seq: nextSeq(spaceId),
      occurredAt: tick(),
      schemaVersion: WORKSPACE_EVENT_SCHEMA_VERSION,
    } as DurableWorkspaceEvent;
    queueMicrotask(() => {
      const frozen = clone(event);
      for (const cb of eventSubs) cb(frozen);
    });
  }

  /**
   * Rebuild one entity's `badges.attention` from its rows — the same aggregate
   * the server computes in SQL (`entity-read.ts:506-535`), including the part
   * that is easy to miss: `acknowledged` counts as PENDING. An entity with no
   * pending rows loses the badge key entirely rather than carrying a zeroed
   * one, because the contract schema declares those counts `.positive()`
   * (`schemas.ts:307-312`) — the badge is absent, never zero.
   */
  function recomputeAttentionBadge(s: EntitySummary): void {
    const pending = attentionRows.filter(
      (r) => r.entityId === s.id && (r.status === 'open' || r.status === 'acknowledged'),
    );
    if (pending.length === 0) {
      const { attention: _attention, ...badges } = s.badges;
      s.badges = badges;
      return;
    }
    const latest = [...pending].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    s.badges = {
      ...s.badges,
      attention: {
        pendingCount: pending.length,
        totalPoints: pending.reduce((sum, r) => sum + r.points, 0),
        maxPoints: Math.max(...pending.map((r) => r.points)),
        latestReason: latest.reason,
        oldestRequestedAt: pending.reduce(
          (oldest, r) => (r.createdAt < oldest ? r.createdAt : oldest),
          pending[0].createdAt,
        ),
      },
    };
  }

  function touch(s: EntitySummary): void {
    s.version += 1;
    const at = tick();
    s.updatedAt = at;
    s.activityAt = at;
    stampCategory(s);
  }

  function pageOf<T>(all: T[], opts?: PageOpts): Page<T> {
    const start = opts?.cursor ? Math.max(0, Number.parseInt(opts.cursor, 10) || 0) : 0;
    const limit = opts?.limit ?? 50;
    const end = Math.min(all.length, start + limit);
    return { items: all.slice(start, end), nextCursor: end < all.length ? String(end) : null, total: all.length };
  }

  /** The node's own group labels (collections.ts) — the fixture must hand
   *  back 'High', not 'high', or a label-rendering surface diverges. */
  const GROUP_STATUS_LABELS: Record<string, string> = {
    open: 'Open', pulled: 'Pulled', working: 'Working', in_review: 'In review',
    done: 'Done', blocked: 'Blocked', cancelled: 'Cancelled',
  };
  const GROUP_PRIORITY_LABELS: Record<string, string> = {
    urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low',
  };

  /**
   * `groupBy` answered for real, PAGE-SCOPED like the node's own.
   *
   * The fixture used to drop the member silently, so every board mounted over
   * it drew its columns and reported "0 shown" in all of them — indistinguish-
   * able from a genuinely empty tier, which is the one thing the board's
   * honesty rules exist to prevent. A query the fixture cannot group returns
   * NO `groups` member rather than an empty array, so the board's "no source
   * wired" path stays reachable and true.
   */
  function groupsFor(rows: EntitySummary[], input: CollectionQuery): { groups?: CollectionGroup[] } {
    const groupBy = input.groupBy;
    if (groupBy !== 'status' && groupBy !== 'priority' && groupBy !== 'assignee') return {};
    /**
     * The server's `groupItems` arms, mirrored (collections.ts): a
     * multi-assignee task appears in EVERY assignee column, no assignee is
     * the '' / "Unassigned" column, labels are the server's display words
     * (WORK_STATUS_LABELS / PRIORITY_LABELS), and a NON-task row lands in
     * the same default bucket the server gives it ('open' / 'medium' /
     * Unassigned) instead of vanishing from the groups it counts toward.
     */
    const keysOf = (row: EntitySummary): readonly (readonly [string, string])[] => {
      if (groupBy === 'status') {
        const status = row.state.kind === 'task' ? row.state.status : 'open';
        return [[status, GROUP_STATUS_LABELS[status] ?? status]];
      }
      if (groupBy === 'priority') {
        const priority = row.state.kind === 'task' ? row.state.priority : 'medium';
        return [[priority, GROUP_PRIORITY_LABELS[priority] ?? priority]];
      }
      const assignees = row.state.kind === 'task' ? row.state.assignees : [];
      if (assignees.length === 0) return [['', 'Unassigned']];
      return assignees.map((a) => [a.id, a.displayName] as const);
    };
    /**
     * `total` counts ALL filtered rows (the server's `groupTotals` CTE runs
     * before LIMIT); `items` stay page-scoped. Off-page groups (total > 0,
     * empty page slice) are kept for status/priority and dropped for
     * assignee — the server appends empty groups for closed vocabularies
     * only, never for the open actor axis.
     */
    const byKey = new Map<string, { label: string; items: EntitySummary[]; total: number }>();
    const paged = new Set(pageOf(rows, input).items.map((r) => r.id));
    for (const row of rows) {
      for (const [key, label] of keysOf(row)) {
        let bucket = byKey.get(key);
        if (!bucket) {
          bucket = { label, items: [], total: 0 };
          byKey.set(key, bucket);
        }
        bucket.total += 1;
        if (paged.has(row.id)) bucket.items.push(row);
      }
    }
    return {
      groups: [...byKey]
        .filter(([, g]) => groupBy !== 'assignee' || g.items.length > 0)
        .map(([key, g]) => ({ key, label: g.label, items: g.items, total: g.total })),
    };
  }

  function subtreeIds(rootId: EntityId): Set<EntityId> {
    const ids = new Set<EntityId>([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of summaries.values()) {
        if (s.parentId !== null && ids.has(s.parentId) && !ids.has(s.id)) {
          ids.add(s.id);
          grew = true;
        }
      }
    }
    ids.delete(rootId);
    return ids;
  }

  function commandResult(s: EntitySummary, over: Partial<CommandResult> = {}): CommandResult {
    return clone({ entity: detailOf(s.id), patches: [s], ...over });
  }

  /**
   * `state.assignees` is a PROJECTION of the `assigned_to` edges, not a field
   * a client writes (server `entity-read.ts:551`). The fixture recomputes it
   * from the same source so an assignment made here is visible through exactly
   * the read the UI already uses, rather than through a second parallel store
   * that could disagree with the edges.
   */
  function projectActorEdges(s: EntitySummary, type: string): ActorSummary[] {
    const group = extrasOf(s.id).connections.outgoing.find((g) => g.type === type);
    return (group?.edges ?? []).flatMap((edge) => {
      const target = summaries.get(edge.target.id);
      if (!target || (target.kind !== 'member' && target.kind !== 'team_member')) return [];
      return [{
        id: target.id,
        kind: target.kind,
        displayName: target.title,
        avatar: null,
        isAgent: target.kind === 'team_member',
      } satisfies ActorSummary];
    });
  }

  /**
   * The performer of an assignment, spoken in the ENTITY id vocabulary.
   *
   * This fixture has TWO id spaces for one person — `act-ada` the actor and
   * `ent-member-ada` the member entity (documented at `spaceSettings` below;
   * unifying them predates this change and is not its job). The real server
   * has ONE id, and `assigned_by` resolves through the same entity read as
   * the assignee, so an `assignments` record whose two arms spoke different
   * vocabularies would be a parity bug: the roster the assigned-by chips are
   * drawn from is built on ENTITY rows, and a filter that can never match is
   * indistinguishable from one that is broken. Every seam-written edge is
   * authored by the viewer, so the map only needs the humans the identity
   * can be.
   */
  function assignmentAuthor(author: ActorSummary): ActorSummary {
    const entityId = author.id === ada.id ? memberAda.id : author.id === noor.id ? memberNoor.id : author.id;
    const entity = summaries.get(entityId);
    if (!entity || (entity.kind !== 'member' && entity.kind !== 'team_member')) return clone(author);
    return {
      id: entity.id,
      kind: entity.kind,
      displayName: entity.title,
      avatar: null,
      isAgent: entity.kind === 'team_member',
    };
  }

  /**
   * Both actor rosters, recomputed from the edges that ARE them: a task's
   * `assigned_to` and a channel's `has_member` (migration 080). Two arms of one
   * function because the projection is identical and the meaning is not — the
   * server keeps them apart for the same reason (`entity-read.ts`
   * `relations.assignees` / `relations.members`).
   */
  function projectAssignees(s: EntitySummary): void {
    if (s.state.kind === 'task') {
      s.state.assignees = projectActorEdges(s, 'assigned_to');
      /* 129's provenance projection: one entry per CURRENT `assigned_to`
         edge, its `assignedBy` the actor who WROTE that edge — the server
         projects the same rows out of assigned_by/assigned_at
         (entity-read.ts). Additive field: a task this function never ran on
         keeps no `assignments`, exactly as pre-129 rows read NULL. */
      const group = extrasOf(s.id).connections.outgoing.find((g) => g.type === 'assigned_to');
      s.state.assignments = (group?.edges ?? []).flatMap((edge) => {
        const target = summaries.get(edge.target.id);
        if (!target || (target.kind !== 'member' && target.kind !== 'team_member')) return [];
        return [{
          assignee: {
            id: target.id,
            kind: target.kind,
            displayName: target.title,
            avatar: null,
            isAgent: target.kind === 'team_member',
          },
          assignedBy: assignmentAuthor(edge.createdBy),
          assignedAt: edge.createdAt,
        }];
      });
    } else if (s.state.kind === 'channel') s.state.members = projectActorEdges(s, 'has_member');
  }

  function defaultStateFor(input: CreateEntityInput): EntityState {
    const c = (input.content ?? {}) as Record<string, unknown>;
    const kind = input.kind;
    if (kind.startsWith('c:')) {
      return { kind: kind as `c:${string}`, fields: (c.fields as CustomEntityState['fields']) ?? {} };
    }
    switch (kind) {
      case 'task':
        return {
          kind: 'task', status: 'open', priority: 'medium', axes: {},
          dueDate: null, assignees: [], acceptance: { total: 0, completed: 0 },
        };
      case 'channel':
        // `members: []` and not a read of `input.connections`: the roster is a
        // PROJECTION of `has_member` edges, and those edges are written by the
        // create path itself. `projectAssignees` fills this in from them, so
        // seeding it here from the input would be a second source free to
        // disagree with the first.
        return { kind: 'channel', topic: (c.topic as string) ?? '', members: [], unreadCount: 0, workingAgentCount: 0 };
      // A freshly created voice room is EMPTY. `participantCount` is the whole
      // state arm — there is no topic and no unread axis to seed. Nothing here
      // reads the create input, because the content arm carries no field.
      case 'voice_channel':
        return { kind: 'voice_channel', participantCount: 0 };
      case 'doc':
        return { kind: 'doc', format: (c.format as 'markdown') ?? 'markdown', childCount: 0 };
      case 'team_member':
        // `defaultProfileId: null` — a freshly created teammate has no
        // `defaults_to_profile` edge yet, and the field's contract is that
        // absence means exactly that, so the fixture states it rather than
        // omitting it and leaving the UI to guess.
        return {
          kind: 'team_member', owner: viewerActor, model: null, agentTool: null,
          liveWork: null, defaultProfileId: null,
        };
      case 'file':
        return {
          kind: 'file', name: (c.name as string) ?? input.title,
          mimeType: (c.mimeType as string) ?? 'application/octet-stream',
          sizeBytes: (c.sizeBytes as number) ?? 0,
        };
      case 'spell':
      case 'skill':
        return { kind, description: c.description as string | undefined, equipped: false };
      case 'pull_request':
        return {
          kind: 'pull_request', repository: (c.repository as string) ?? '',
          number: (c.number as number) ?? 0, state: 'open', stale: false,
        };
      case 'commit':
        // `stale: true` matches the pull_request arm's shape and is the honest
        // value for a locally created mirror: nothing has fetched it from the
        // forge, which is exactly what a freshly linked commit looks like.
        return {
          kind: 'commit', repository: (c.repository as string) ?? '',
          sha: (c.sha as string) ?? '', message: input.title, committedAt: null,
          stale: true,
        };
      case 'collection':
        return { kind: 'collection', collectionType: (c.collectionType as string) ?? 'manual', itemCount: 0 };
      // The 056 scope fields ride in STATE, not content, so that a memory's
      // conditions arrive on every summary read in the same payload as its
      // title. `create_memory` (056) takes them off `content` on the wire and
      // the read projects them back into state — this mirrors both halves,
      // because a fixture that stored them only in content would let a working
      // set render its scope in jsdom and lose it against the node.
      case 'memory':
        return {
          kind: 'memory',
          mechanism: (c.mechanism as string) ?? '',
          subjectScope: (c.subjectScope as string) ?? '',
          doesNotEstablish: (c.doesNotEstablish as string) ?? '',
          measuredAt: (c.measuredAt as string | null) ?? null,
        };
      case 'graph':
        // Craft P1: counts mirror what the create carried; the row's real
        // body lives in content, exactly as the server projects it.
        return {
          kind: 'graph',
          graphType: (c.graphType as string) ?? 'entity',
          nodeCount: Array.isArray(c.nodes) ? c.nodes.length : 0,
          edgeCount: Array.isArray(c.edges) ? c.edges.length : 0,
        };
      default:
        throw new CollabError('invalid_input', `kind ${kind} is not client-creatable`);
    }
  }

  function insertSummary(partial: Pick<EntitySummary, 'id' | 'kind' | 'title' | 'state'> & Partial<EntitySummary>): EntitySummary {
    const at = tick();
    const s: EntitySummary = {
      spaceId: FIXTURE_SPACE_ID,
      parentId: null,
      position: partial.parentId ? childrenOf(partial.parentId).length : 0,
      visibility: 'space',
      version: 1,
      activityAt: at,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      createdBy: viewerActor,
      counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
      badges: {},
      ...partial,
    };
    summaries.set(s.id, s);
    return s;
  }

  const viewerActor: ActorSummary = clone(ada);

  const identityView: IdentityView = {
    identityId: 'idn-ada',
    accountId: 'acct-ada',
    username: 'ada',
    displayName: viewerActor.displayName,
    avatar: viewerActor.avatar ?? null,
    email: null,
    // NULL like every real row today (067 landed with no backfill) — the
    // fixture exercises the empty-profile default path, not the exception.
    globalId: null,
    isNodeAdmin: true,
    isOwner: true,
    status: 'active',
    actingAs: null,
    memberships: [{ spaceId: FIXTURE_SPACE_ID, memberId: viewerActor.id, role: 'owner' }],
  };

  const spaceSummary: SpaceSummary = {
    id: FIXTURE_SPACE_ID,
    name: 'atelier',
    description: 'Fixture space backing the tm8-ui gate screen.',
    memberCount: 2,
    unreadTotal: 12,
    githubRepo: 'subhang/tm8',
    createdAt: '2026-07-20T09:00:00.000Z',
  };

  // -- the seam --------------------------------------------------------------

  const seam: FixtureSeam = {
    async openSpace(spaceId) {
      openSpaces.add(spaceId);
      if (!seqBySpace.has(spaceId)) seqBySpace.set(spaceId, 1000);
    },
    closeSpace(spaceId) {
      openSpaces.delete(spaceId);
    },
    dispose() {
      openSpaces.clear();
      eventSubs.clear();
      connectionSubs.clear();
      resyncSubs.clear();
      livenessSubs.clear();
    },

    onEvent(cb) {
      eventSubs.add(cb);
      return () => eventSubs.delete(cb);
    },
    onChatTurn() {
      return () => undefined;
    },
    onConnection(cb) {
      connectionSubs.add(cb);
      return () => connectionSubs.delete(cb);
    },
    getConnection() {
      return clone(connection);
    },
    onResync(cb) {
      resyncSubs.add(cb);
      return () => resyncSubs.delete(cb);
    },

    async identity() {
      return clone(identityView);
    },
    async spaces() {
      return clone([spaceSummary]);
    },
    async spaceSettings(spaceId): Promise<SpaceSettingsView> {
      if (spaceId !== FIXTURE_SPACE_ID) throw new CollabError('not_found', `space ${spaceId} not found`);
      return clone({
        space: spaceSummary,
        // TWO ROWS, and the viewer's is keyed on `viewerActor.id` — NOT on the
        // member ENTITY's id. `useGateData` resolves the viewer by matching
        // `identity().memberships[].memberId` against these actors, so a row
        // carrying the entity id (`ent-member-ada`) instead of the actor id
        // (`act-ada`) resolves the viewer to null and every viewer-scoped
        // filter chip in the shell goes quiet. The two id spaces are a real
        // inconsistency in this fixture and predate 109; unifying them is not
        // this change's job, and stepping on it silently would have been.
        //
        // The second row is the fixture's own `noor`, which is what
        // `spaceSummary.memberCount: 2` has always claimed.
        members: [
          { actor: viewerActor, role: 'owner' as const, joinedAt: FIXTURE_NOW },
          { actor: clone(noor), role: 'member' as const, joinedAt: FIXTURE_NOW },
        ],
        invites,
        // The MUTABLE registry above — seeded with the node's own seed, and
        // the same rows the W2 CRUD verbs curate. Position order, exactly as
        // `spaces.settings` answers it.
        taskAxes: [...taskAxes].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
        // W4 ride-along, exactly as the node answers it: the same settings
        // round trip that carries the axes carries the workflows keyed on them.
        taskWorkflows: [...taskWorkflows].sort((a, b) => a.typeValue.localeCompare(b.typeValue)).map((w) => clone(w)),
        /* THE SAME MENU `menu()` ANSWERS WITH, because on the node they are
           the same row. `spaces.settings` reads `space_menu_configs` directly
           and `spaces.menu.get` reads it through `get_space_menu`; a node
           cannot serve two different menus for one space, so a fixture that
           does is lying about a shape its consumers now rely on.

           It used to, harmlessly: nothing read `settings.menu`, because boot
           took the menu from the separate `menu()` round trip. That read is
           gone (it was a duplicate — see `hydrate`), so this field is now the
           rail's actual source and the disagreement became visible as a tab
           row nobody designed. `menu()` resolves null here by C-4 and the UI
           substitutes its shipped default, so the shipped default is exactly
           what a consistent settings payload has to carry. */
        menu: SHIPPED_DEFAULT_MENU,
        defaultChannelId: null,
        defaultInteractionProfileId: 'ip-house-style',
        settingsRevision: 1,
      });
    },
    /**
     * `spaces.workflows.list` (migration 149), mirrored: ONE global default —
     * spaceId null, four display-named states each carrying its category, To
     * Do initial — plus this space's own workflows migrated from the mutable
     * `taskWorkflows` exactly as 149 migrates them: name = the type value,
     * kind 'task', states named by the RAW status literals (that equality is
     * phase 6's join key), categories per the ruled mapping, first state
     * initial. Zero transition rows — empty means "the ruled category-level
     * defaults apply", which is the normal case.
     */
    async workflows(_spaceId): Promise<Workflow[]> {
      const globalDefault: Workflow = {
        id: 'wf-global-default',
        spaceId: null,
        name: 'Default',
        kind: null,
        states: (
          [
            ['To Do', 'to_do'],
            ['In Progress', 'in_progress'],
            ['Done', 'done'],
            ['Cancelled', 'cancelled'],
          ] as const
        ).map(([name, category], i) => ({
          id: `wfs-default-${category}`,
          workflowId: 'wf-global-default',
          name,
          category,
          position: i,
          isInitial: i === 0,
          isDefault: i === 0,
        })),
        transitions: [],
      };
      const migrated: Workflow[] = [...taskWorkflows]
        .sort((a, b) => a.typeValue.localeCompare(b.typeValue))
        .map((w) => ({
          id: `wf-${w.id}`,
          spaceId: w.spaceId,
          name: w.typeValue,
          kind: 'task',
          states: w.statuses.map((status, i) => ({
            id: `wfs-${w.id}-${status}`,
            workflowId: `wf-${w.id}`,
            name: status,
            category: WORK_STATUS_CATEGORY[status] ?? 'to_do',
            position: i,
            isInitial: i === 0,
            isDefault: false,
          })),
          transitions: [],
        }));
      return [globalDefault, ...migrated];
    },
    /**
     * Amendment 11 mirror. Answers WITHOUT consulting the viewer, exactly like
     * the node's claim-free RPC, and reproduces its disclosure rule rather
     * than a friendlier one: an unresolvable code returns `{status:'unknown'}`
     * and nothing else, and a dead code names the space but never the inviter.
     * A fixture that leaked more than the node would let a join screen look
     * correct here and refuse to render against a real server.
     */
    async previewInvite(code: string): Promise<InvitePreview> {
      const invite = invites.find((i) => i.code === code);
      if (!invite) return { status: 'unknown' };
      if (invite.revoked) return { status: 'revoked', spaceName: spaceSummary.name };
      if (invite.expiresAt !== null && invite.expiresAt < tick()) {
        return { status: 'expired', spaceName: spaceSummary.name };
      }
      if (invite.uses >= invite.maxUses) return { status: 'exhausted', spaceName: spaceSummary.name };
      return {
        status: 'valid',
        spaceId: FIXTURE_SPACE_ID,
        spaceName: spaceSummary.name,
        role: invite.role,
        invitedBy: identityView.displayName,
        expiresAt: invite.expiresAt,
      };
    },

    /**
     * Counted from the fixture dataset and the fixture's OWN read marks, so
     * the demo rail behaves like the real one: opening a row clears its unseen
     * mark here too, rather than showing a frozen number that never responds.
     */
    async counts(spaceId): Promise<SpaceKindCounts> {
      if (spaceId !== FIXTURE_SPACE_ID) throw new CollabError('not_found', `space ${spaceId} not found`);
      const counts: SpaceKindCounts = {};
      for (const summary of summaries.values()) {
        if (summary.deletedAt) continue;
        const key = summary.kind as keyof SpaceKindCounts;
        const row = counts[key] ?? { total: 0, unseen: 0 };
        const mark = readMarks.get(summary.id);
        // Same predicate as the server RPC (063): never opened, or changed
        // since it was last opened.
        if (!mark || summary.activityAt > mark) row.unseen += 1;
        row.total += 1;
        counts[key] = row;
      }
      return counts;
    },
    /** C-4: the dataset ships no menu row — resolve null, UI uses its default. */
    async menu(_spaceId): Promise<MenuConfig | null> {
      return null;
    },
    async query(input: CollectionQuery): Promise<CollectionResult> {
      const deleted = input.filters?.deleted ?? 'exclude';
      const subtree = input.subtreeOf ? subtreeIds(input.subtreeOf) : null;
      let rows = [...summaries.values()].filter((s) => {
        if (s.spaceId !== input.spaceId) return false;
        if (deleted === 'exclude' && s.deletedAt !== null) return false;
        if (deleted === 'only' && s.deletedAt === null) return false;
        if (input.kinds && !input.kinds.includes(s.kind)) return false;
        if (input.parentId !== undefined && s.parentId !== input.parentId) return false;
        if (subtree && !subtree.has(s.id)) return false;
        /* A CREDENTIAL LOGIN TERMINAL IS NOT WORK (082, Ruling 16), and the
           query is where that rule lives — `collections.ts` pushes
           `ws.session_kind is distinct from 'credential'` into the same WHERE
           its `count(*)` runs over.

           This fixture used to seed `ws-credential-login` as `running` and
           COUNT it, while `projectRows` refused to render it. Every test that
           read a session band therefore saw `total: 3` over two rows and
           nobody noticed, because no assertion compared the two. That is the
           production defect in miniature: the live node's session list read
           "To Do 1" over an empty tab. */
        if ((s.state as { sessionKind?: unknown }).sessionKind === 'credential') return false;
        const f = input.filters;
        /* Empty lists are NO constraint — the server guards every arm with
           `length > 0` (collections.ts), so `priority: []` must not read as
           "match nothing" here while the node reads it as "unfiltered". */
        if (f?.status?.length && !(s.state.kind === 'task' && f.status.includes(s.state.status))) return false;
        /* Phase 1's category predicate (PR #353): NULL never matches, so the
           filter's PRESENCE restricts to entities that have a status at all —
           `NULL = any(...)` server semantics, mirrored. */
        if (f?.category?.length && !(s.category !== undefined && f.category.includes(s.category))) return false;
        if (f?.priority?.length && !(s.state.kind === 'task' && f.priority.includes(s.state.priority))) return false;
        if (f?.sessionStatus?.length && !(s.state.kind === 'work_session'
          && f.sessionStatus.includes(s.state.status))) return false;
        if (f?.assigneeIds?.length && !(s.state.kind === 'task'
          && s.state.assignees.some((a) => f.assigneeIds!.includes(a.id)))) return false;
        /* 129's provenance filter: a task matches when ANY of its CURRENT
           assignments was performed by a listed actor. `assignments` is the
           additive contract field; a task without it (pre-provenance data)
           matches nothing, exactly as its rows have NULL assigned_by. */
        if (f?.assignedByIds?.length && !(s.state.kind === 'task'
          && (s.state.assignments ?? []).some((a) => a.assignedBy !== null
            && f.assignedByIds!.includes(a.assignedBy.id)))) return false;
        /* The clock window (`collections.ts`: `e.activity_at >= $n`). Honoured
           here because the graph canvas's whole scope is this predicate — a
           fixture that ignored it would hand back the entire space and let a
           test prove a window that does nothing. Compared as strings: `tick()`
           and the caller both produce `toISOString()`, which is always UTC and
           fixed-width, so lexical order IS chronological order. */
        if (f?.activeSince && s.activityAt < f.activeSince) return false;
        /* The `edge` clause the server executes as an EXISTS over
           public.edges (collections.ts): keep this row exactly when it has an
           edge of `type` in `direction` whose OTHER endpoint is `entityId`.
           The collection lens rides this — members of collection X are the
           rows with an INCOMING `contains` from X — and a fixture that
           ignored the clause would render the lens as a silent no-op. */
        if (f?.edge) {
          const { type, direction, entityId } = f.edge;
          const groups = direction === 'incoming'
            ? extrasOf(s.id).connections.incoming
            : extrasOf(s.id).connections.outgoing;
          const hit = groups.some((group) => group.type === type && group.edges.some((edge) =>
            (direction === 'incoming' ? edge.source.id : edge.target.id) === entityId));
          if (!hit) return false;
        }
        return true;
      });
      const sort = input.sort ?? 'activityAt_desc';
      rows = rows.sort((a, b) => {
        switch (sort) {
          case 'position': return a.position - b.position;
          case 'createdAt_desc': return b.createdAt.localeCompare(a.createdAt);
          case 'dueDate': {
            const da = a.state.kind === 'task' ? a.state.dueDate ?? '9999' : '9999';
            const db = b.state.kind === 'task' ? b.state.dueDate ?? '9999' : '9999';
            return da.localeCompare(db);
          }
          case 'priority': {
            const pa = a.state.kind === 'task' ? PRIORITY_RANK[a.state.priority] : 9;
            const pb = b.state.kind === 'task' ? PRIORITY_RANK[b.state.priority] : 9;
            return pa - pb;
          }
          default: return b.activityAt.localeCompare(a.activityAt);
        }
      });
      return clone({ query: input, page: pageOf(rows, input), ...groupsFor(rows, input) });
    },
    async graph(input: GraphQuery): Promise<GraphResult> {
      const collection = await seam.query({ ...input, limit: input.limit ?? 150 });
      let nodes = collection.page.items;
      const candidateIds = new Set(nodes.map((node) => node.id));

      const byEdgeId = new Map<string, EdgeView>();
      for (const node of nodes) {
        const connections = extrasOf(node.id).connections;
        for (const edge of [...connections.outgoing, ...connections.incoming].flatMap((group) => group.edges)) {
          if (!candidateIds.has(edge.source.id) || !candidateIds.has(edge.target.id)) continue;
          if (input.mode === 'dependency' && edge.type !== 'depends_on') continue;
          if (input.edgeTypes?.length && !input.edgeTypes.includes(edge.type)) continue;
          byEdgeId.set(edge.id, edge);
        }
      }
      let edges = [...byEdgeId.values()];

      if (input.focusId) {
        const visible = new Set<EntityId>([input.focusId]);
        let frontier = new Set<EntityId>([input.focusId]);
        for (let hop = 0; hop < (input.hops ?? 1); hop += 1) {
          const next = new Set<EntityId>();
          for (const edge of edges) {
            if (frontier.has(edge.source.id) && !visible.has(edge.target.id)) next.add(edge.target.id);
            if (frontier.has(edge.target.id) && !visible.has(edge.source.id)) next.add(edge.source.id);
          }
          for (const id of next) visible.add(id);
          frontier = next;
        }
        nodes = nodes.filter((node) => visible.has(node.id));
        edges = edges.filter((edge) => visible.has(edge.source.id) && visible.has(edge.target.id));
      }

      const clustersByParent = new Map<EntityId, EntityId[]>();
      for (const node of nodes) {
        if (!node.parentId) continue;
        const children = clustersByParent.get(node.parentId) ?? [];
        children.push(node.id);
        clustersByParent.set(node.parentId, children);
      }
      return clone({
        nodes,
        // Project to the WIRE shape (`GraphEdgeView`): endpoint ids, not
        // embedded summaries. The traversal above works in `EdgeView` because
        // that is what the fixture's connection extras hold; what leaves this
        // seam must match what the node sends, or the fixture stops being a
        // stand-in for it. Both endpoints are in `nodes` by the filters above.
        edges: edges.map(({ source, target, ...rest }): GraphEdgeView => ({
          ...rest,
          sourceId: source.id,
          targetId: target.id,
        })),
        clusters: [...clustersByParent].map(([parentId, childIds]) => ({ parentId, childIds })),
      });
    },
    /** LLD §14: custom-kind (`c:*`) existence + naming metadata ONLY. */
    async entityKinds(spaceId): Promise<EntityKindDef[]> {
      const custom = new Map<string, EntitySummary>();
      for (const s of summaries.values()) {
        if (s.kind.startsWith('c:') && !custom.has(s.kind)) custom.set(s.kind, s);
      }
      return clone([...custom.entries()].map(([kind, sample]): EntityKindDef => {
        const fields = isCustomState(sample.state) ? sample.state.fields : {};
        const fieldSchema: CustomFieldDef[] = Object.entries(fields).map(([name, v]) => ({
          name,
          type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'text',
        }));
        return {
          id: `kind-${kind}`, kind: kind as `c:${string}`, origin: 'custom', spaceId,
          icon: null, fieldSchema, capabilities: {}, createdBy: null, createdAt: FIXTURE_NOW,
        };
      }));
    },
    async projects(): Promise<ProjectResource[]> {
      return clone([...FIXTURE_PROJECTS]);
    },
    /**
     * Amendment 6. `opts` are honoured HERE too, not only on the wire — a
     * fixture that ignored `limit` would let a caller's bound go unexercised
     * and still pass. `staleAfterDays` re-derives `stale` from the fixed
     * fixture dates (never Date.now()), so a caller's threshold visibly
     * changes the answer the way the server's would.
     */
    /**
     * The contention map (Git UI wave), deterministic and honest by design:
     * two readable lanes that OVERLAP on one path (the same file SAMPLE_DIFF
     * changes, so the project screen and the session rail narrate one story),
     * plus one lane the node cannot read, reported SKIPPED with its reason —
     * the state a careless screen silently drops.
     */
    async projectContention(projectId): Promise<ContentionReport> {
      if (projectId !== FIXTURE_BRANCH_TOPOLOGY.projectId) {
        throw new CollabError('not_found', `project ${projectId} not found`);
      }
      const overlap = 'packages/server/src/facade/handlers/projects.ts';
      return clone({
        projectId,
        generatedAt: FIXTURE_NOW,
        lanes: [
          {
            worktreeId: 'fx-worktree-1',
            branch: gitLane.branch,
            path: '/fixture/worktrees/proj-tm8ui/fx-worktree-1',
            sessionId: sessionLive.id,
            touchedCount: 2,
            touchedPaths: [overlap, 'notes/scratch.md'],
            skipped: null,
          },
          {
            worktreeId: 'fx-worktree-2',
            branch: 'tm8/sweep-lane',
            path: '/fixture/worktrees/proj-tm8ui/fx-worktree-2',
            sessionId: sessionStale.id,
            touchedCount: 3,
            touchedPaths: [overlap, 'packages/cli/src/commands/task.ts', 'docs/notes.md'],
            skipped: null,
          },
          {
            worktreeId: 'fx-worktree-3',
            branch: 'tm8/orphan-lane',
            path: '/fixture/worktrees/proj-tm8ui/fx-worktree-3',
            sessionId: null,
            touchedCount: 0,
            touchedPaths: [],
            skipped: 'worktree is not readable on this node',
          },
        ],
        pairs: [
          {
            aWorktreeId: 'fx-worktree-1',
            bWorktreeId: 'fx-worktree-2',
            aBranch: gitLane.branch,
            bBranch: 'tm8/sweep-lane',
            overlappingPaths: [overlap],
          },
        ],
      });
    },
    /**
     * Tier 1 file reads (Amendment 8), deterministic and HONOURING their
     * arguments: maxRevisions/maxLines really cut and really set `truncated`,
     * diffOid really selects, an unknown path really refuses — a fixture that
     * echoes its inputs would let a component test pass against behaviour the
     * real server does not have.
     */
    async projectFileHistory(projectId, path, opts): Promise<ProjectFileHistory> {
      if (projectId !== FIXTURE_BRANCH_TOPOLOGY.projectId) {
        throw new CollabError('not_found', `project ${projectId} not found`);
      }
      if (path !== FIXTURE_FILE_PATH) {
        // Real git answers an empty history for a never-committed path.
        return { projectId, workingDir: '/fixture/tm8-ui', path, revisions: [], truncated: false, diff: null };
      }
      let revisions = clone(FIXTURE_FILE_REVISIONS) as ProjectFileHistory['revisions'];
      let truncated = false;
      if (opts?.maxRevisions !== undefined && opts.maxRevisions < revisions.length) {
        revisions = revisions.slice(0, opts.maxRevisions);
        truncated = true;
      }
      let diff: ProjectFileHistory['diff'] = null;
      if (opts?.diffOid !== undefined) {
        if (!/^[0-9a-f]{40}$/.test(opts.diffOid)) {
          throw new CollabError('invalid_input', `not a full commit oid: ${opts.diffOid}`);
        }
        // An oid outside the walk answers an empty patch, like git diff-tree.
        const known = FIXTURE_FILE_REVISIONS.some((r) => r.oid === opts.diffOid);
        diff = { oid: opts.diffOid, diff: known ? SAMPLE_DIFF : '', truncated: false };
      }
      return { projectId, workingDir: '/fixture/tm8-ui', path, revisions, truncated, diff };
    },
    async projectFileBlame(projectId, path, opts): Promise<ProjectFileBlame> {
      if (projectId !== FIXTURE_BRANCH_TOPOLOGY.projectId) {
        throw new CollabError('not_found', `project ${projectId} not found`);
      }
      if (path !== FIXTURE_FILE_PATH) {
        throw new CollabError('invalid_input', `no such path in the working tree: ${path}`);
      }
      const all = clone(FIXTURE_FILE_BLAME_HUNKS) as ProjectFileBlame['hunks'];
      const totalLines = all.reduce((n, h) => n + h.lineCount, 0);
      let hunks = all;
      let blamedLines = totalLines;
      if (opts?.maxLines !== undefined && opts.maxLines < totalLines) {
        hunks = [];
        let budget = opts.maxLines;
        for (const h of all) {
          if (budget <= 0) break;
          if (h.lineCount <= budget) { hunks.push(h); budget -= h.lineCount; }
          else { hunks.push({ ...h, lineCount: budget }); budget = 0; }
        }
        blamedLines = opts.maxLines;
      }
      return {
        projectId,
        workingDir: '/fixture/tm8-ui',
        path,
        hunks,
        blamedLines,
        totalLines,
        truncated: blamedLines < totalLines,
      };
    },
    async projectBranches(projectId, opts): Promise<ProjectBranchTopology> {
      if (projectId !== FIXTURE_BRANCH_TOPOLOGY.projectId) {
        throw new CollabError('not_found', `project ${projectId} not found`);
      }
      const t = clone(FIXTURE_BRANCH_TOPOLOGY);
      if (opts?.staleAfterDays !== undefined) {
        t.staleAfterDays = opts.staleAfterDays;
        const cutoff = FIXTURE_BASE_MS - opts.staleAfterDays * 86_400_000;
        for (const b of t.branches) b.stale = Date.parse(b.lastCommitAt) < cutoff;
      }
      if (opts?.limit !== undefined && opts.limit < t.branches.length) {
        t.branches = t.branches.slice(0, opts.limit);
        t.truncated = true;
      }
      return t;
    },
    async entity(id) {
      return clone(detailOf(id));
    },
    async children(id, opts) {
      requireSummary(id);
      return clone(pageOf(childrenOf(id), opts));
    },
    async connections(id, opts): Promise<Page<EdgeView>> {
      requireSummary(id);
      const c = extrasOf(id).connections;
      // `ConnectionOpts`'s filters are honoured HERE too, not only on the
      // wire. A fixture that ignored `types` would let a caller's filter go
      // unexercised and still pass — which is exactly how the unfiltered read
      // stayed invisible until it mattered.
      const groups = [
        ...(opts?.direction === 'incoming' ? [] : c.outgoing),
        ...(opts?.direction === 'outgoing' ? [] : c.incoming),
      ];
      const types = opts?.types;
      const edges = groups
        .filter((g) => types === undefined || types.length === 0 || types.includes(g.type))
        .flatMap((g) => g.edges);
      return clone(pageOf(edges, opts));
    },
    async activity(id, opts): Promise<Page<ActivityItem>> {
      const s = requireSummary(id);
      const items: ActivityItem[] = [{
        id: `act-${id}-created`, entityId: id, actor: s.createdBy, verb: 'created',
        summary: { title: s.title }, createdAt: s.createdAt, refId: null, workSessionId: null,
      }];
      if (s.updatedAt !== s.createdAt) {
        items.unshift({
          id: `act-${id}-updated`, entityId: id, actor: s.createdBy, verb: 'updated',
          summary: { title: s.title, version: s.version }, createdAt: s.updatedAt,
          refId: null, workSessionId: null,
        });
      }
      return clone(pageOf(items, opts));
    },
    /**
     * Amendment 10: minimal honest fixture arm. The chat-home surface never
     * reads this — in fixture mode it resolves the fixture PORT before any
     * seam call — so an empty snapshot keeps the type satisfied without
     * inventing home data no test asserts.
     */
    async home(spaceId): Promise<HomeSnapshot> {
      const empty = (): CollectionResult => ({
        query: { spaceId },
        page: { items: [], nextCursor: null },
      });
      return {
        readyToPull: empty(),
        inFlight: empty(),
        needsMe: empty(),
        activity: { items: [], nextCursor: null },
        chatThreads: [],
      };
    },

    async messages(anchorId, opts): Promise<Page<MessageView>> {
      requireSummary(anchorId);
      // `rootMessageId` reads the branch under a root, oldest-first, exactly
      // like the server. WITHOUT it this fixture still returns every message
      // on the anchor (roots AND replies) where the server returns roots
      // only — pre-existing divergence, left alone because the Discussion
      // surfaces read it that way; the thread pane always passes the filter.
      const rows = [...summaries.values()]
        .filter((s) => s.state.kind === 'message' && s.state.anchorId === anchorId && s.deletedAt === null)
        .filter((s) => opts?.rootMessageId === undefined
          || (s.state.kind === 'message' && s.state.rootMessageId === opts.rootMessageId))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(toMessageView);
      return clone(pageOf(rows, opts));
    },
    async handoffs(workSessionId, opts): Promise<Page<HandoffView>> {
      requireSummary(workSessionId);
      // FE's A1c dataset: the complete legal deliveryStatus × recordStatus
      // matrix, keyed by target work session — sessions without rows page empty.
      return clone(pageOf(fixtureHandoffsBySession[workSessionId] ?? [], opts));
    },
    async journal(workSessionId, opts): Promise<SessionJournalPage> {
      requireSummary(workSessionId);
      // Only the live PTY (C-5) has a journal file in the fixture dataset;
      // every other session honestly reports the common `no_journal_file`
      // state, which the DEBUG surface renders as an explained empty.
      if (workSessionId !== sessionLive.id) {
        return clone({
          sessionId: workSessionId,
          available: false,
          unavailableReason: 'no_journal_file',
          totals: {
            invocations: 0,
            failed: 0,
            agentToCliEst: 0,
            cliToAgentEst: 0,
            estimator: 'chars/4',
            malformed: 0,
          },
          records: [],
          hasMore: false,
        });
      }
      const all = fixtureJournalRecords(workSessionId);
      const before = opts?.before;
      const limit = opts?.limit ?? 100;
      const windowed = all
        .filter((r) => (before === undefined ? true : r.seq < before))
        .slice(-limit);
      return clone({
        sessionId: workSessionId,
        available: true,
        unavailableReason: null,
        totals: {
          invocations: all.length,
          failed: all.filter((r) => r.result.exitCode !== 0).length,
          agentToCliEst: all.reduce((sum, r) => sum + r.tokens.agentToCli, 0),
          cliToAgentEst: all.reduce((sum, r) => sum + r.tokens.cliToAgent, 0),
          estimator: 'chars/4',
          malformed: 1,
        },
        records: windowed,
        hasMore: windowed.length < all.length,
      });
    },
    async launch(workSessionId): Promise<SessionLaunchRecord> {
      requireSummary(workSessionId);
      // Same shape as the journal above: only the live PTY (C-5) carries a
      // recorded manifest, so every other session exercises the explained
      // empty rather than an empty manifest that looks like a real one.
      if (workSessionId !== sessionLive.id) {
        return clone({
          sessionId: workSessionId,
          available: false,
          unavailableReason: 'no_manifest_row',
          manifest: null,
          envVarNames: [],
          prompts: { system: null, task: null, unavailableReason: 'not_recorded' },
          recordedAt: null,
        });
      }
      return clone(fixtureLaunchRecord(workSessionId));
    },
    async transcript(workSessionId, opts): Promise<SessionTranscriptPage> {
      requireSummary(workSessionId);
      // Third face of the DEBUG surface, and the same honesty contract as the
      // two above: only the live PTY (C-5) has an agent that has written a
      // native transcript, so every other session renders the explained empty.
      // `stats: null` rather than a zeroed object — there are no statistics
      // about a file that was never found, and zeros read as "did nothing".
      /*
       * THE EXITED SESSION'S POST-MORTEM STORY (HANDOVER-SessionAnatomy.md §8
       * F1). Every session but the live PTY used to answer the explained empty,
       * which meant the exited canvas could only ever be seen in its
       * no-transcript form — the one state where the stats panel renders no
       * numbers at all.
       *
       * This arm is shaped around the ONE rule the panel exists to keep:
       * HOLLOW IS NOT ZERO. `outputTokens: 0` is a measured zero and must reach
       * the DOM as `0`; `cacheReadTokens`/`cacheCreationTokens` are null and
       * must reach it as `—`. A fixture with four populated numbers would let a
       * renderer that gates on truthiness pass every test in the package.
       *
       * `partial: false` and a non-zero `malformed` are deliberate too: they are
       * the combination that proves the two caveat markers are independent
       * rather than one flag rendered twice.
       */
      if (workSessionId === sessionExited.id) {
        return clone({
          sessionId: workSessionId,
          available: true,
          unavailableReason: null,
          searchedPaths: [],
          agentTool: 'claude-code' as const,
          entries: [
            {
              at: '2026-01-02T11:02:00.000Z',
              source: 'user' as const,
              text: 'Move the token scale onto the shared ramp and keep both themes legible.',
              truncated: false,
            },
            {
              at: '2026-01-02T11:41:00.000Z',
              source: 'assistant' as const,
              text: 'Done — the ramp is shared and the dark values fall out of it rather than being authored twice.',
              truncated: false,
            },
          ],
          stats: {
            partial: false,
            userMessages: 1,
            assistantMessages: 1,
            // A REAL ZERO, next to two hollows. This is the whole point of the
            // arm: `0` and `—` are different claims and must render differently.
            toolCalls: 0,
            inputTokens: 12_400,
            outputTokens: 0,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            tools: [],
            models: ['claude-fable-5'],
          },
          stuck: null,
          lastActivityAt: '2026-01-02T11:41:00.000Z',
          // Non-zero: the "some lines did not parse" marker has a story, and it
          // is the honest explanation for why a count looks low.
          malformed: 3,
          // A SHORT transcript read whole: the window reaches byte 0, so the
          // top of this one is the real beginning of the session. This is the
          // arm that proves the earned `hasOlder: false` claim renders.
          windowStart: 0,
          hasOlder: false,
          ...(opts?.files ? { fileChanges: clone(FIXTURE_FILE_CHANGES) } : {}),
        });
      }
      if (workSessionId !== sessionLive.id) {
        return clone({
          sessionId: workSessionId,
          available: false,
        unavailableReason: 'no_transcript_file',
        searchedPaths: [],
          agentTool: null,
          entries: [],
          stats: null,
          stuck: null,
          lastActivityAt: null,
          malformed: 0,
          // No file was opened, so there is no byte to page back from.
          windowStart: null,
          hasOlder: false,
        });
      }
      /*
       * THE PAGING ARM — and it pages for real.
       *
       * A fixture that cannot answer a `before` request with a genuinely
       * EARLIER window makes every paging test theatre: the test would pass
       * against a seam that quietly returned the same turns forever. So this
       * arm models the server's actual cursor rule rather than approximating
       * it — each turn gets a synthetic byte offset, a window is the newest
       * `last` turns below the cursor, and the page reports the offset of the
       * FIRST TURN IT RETURNED. Windows therefore abut exactly as the reader's
       * do, and walking back to `hasOlder: false` reaches turn 0 and no
       * further.
       *
       * Long enough (34 turns against a 20-turn window) that the walk takes
       * two pages and the second one lands on the beginning.
       */
      const liveTurns = fixtureTranscriptTurns();
      const last = opts?.last ?? 20;
      const before = opts?.before ?? Number.POSITIVE_INFINITY;
      const below = liveTurns.filter((t) => t.offset < before);
      const window = last > 0 ? below.slice(-last) : below;
      // The offset of the first turn RETURNED, never the first turn read: a
      // cursor at the window's own start would leave the turns the `last`
      // slice dropped unreachable, which is the one bug this feature exists to
      // not have.
      const windowStart = window[0]?.offset ?? 0;
      return clone({
        sessionId: workSessionId,
        available: true,
      unavailableReason: null,
      searchedPaths: [],
        agentTool: 'claude-code',
        entries: window.map(({ offset: _offset, ...entry }) => entry),
        windowStart,
        hasOlder: windowStart > 0,
        stats: {
          // True on purpose: the reader tails a bounded slice, so the honest
          // default state of this surface is "you are looking at a window".
          partial: true,
          userMessages: 1,
          assistantMessages: 2,
          toolCalls: 6,
          inputTokens: 4820,
          outputTokens: 640,
          cacheReadTokens: 18200,
          cacheCreationTokens: 1100,
          tools: [
            { name: 'Read', count: 3 },
            { name: 'Grep', count: 2 },
            { name: 'Bash', count: 1 },
          ],
          models: ['claude-opus-4-6'],
        },
        // Null, not a zeroed object: the heuristic does not fire on this
        // session, and a `{ silentMs: 0 }` would render as a stuck badge.
        stuck: null,
        lastActivityAt: liveTurns[liveTurns.length - 1]?.at ?? null,
        malformed: 0,
        // The transcript-derived file accounting — attached only when asked,
        // like the real server's `files=1`. Observed tool calls, not git.
        ...(opts?.files ? { fileChanges: clone(FIXTURE_FILE_CHANGES) } : {}),
      });
    },
    /**
     * The git rail reads (Git UI wave). Only the live PTY (C-5) has a
     * worktree; every other session answers the explained `no_worktree`
     * empty, exactly as the journal/launch/transcript trio above answers
     * theirs — the honest-degradation state is the fixture's default posture.
     */
    async gitStatus(workSessionId): Promise<SessionGitStatus> {
      requireSummary(workSessionId);
      if (workSessionId !== sessionLive.id) {
        return clone(gitUnavailable(workSessionId, 'status') as SessionGitStatus);
      }
      const untracked = gitLane.dirty.filter((f) => f.status === '??').length;
      const unstaged = gitLane.dirty.filter((f) => f.status !== '??' && f.status[1] !== ' ').length;
      const staged = gitLane.dirty.filter((f) => f.status !== '??' && f.status[0] !== ' ').length;
      return clone({
        sessionId: workSessionId,
        available: true,
        unavailableReason: null,
        worktreeId: 'fx-worktree-1' as EntityId,
        branch: gitLane.branch,
        baseRef: gitLane.baseRef,
        baseOid: gitLane.baseOid,
        headOid: gitHead(),
        ahead: gitLane.history.length - 1,
        behind: gitLane.behind,
        dirty: { staged, unstaged, untracked, total: gitLane.dirty.length },
        files: [...gitLane.dirty],
        filesTruncated: false,
        stashes: gitLane.stashes.map((e, index) => ({ ...e, index })),
        checkedAt: FIXTURE_NOW,
      });
    },
    /**
     * Honours `maxBytes` HERE too (the projectBranches rule): a fixture that
     * ignored the cap would let a caller's bound go unexercised and still
     * pass. The diff text is SAMPLE_DIFF while the lane has work (dirty or
     * ahead), and honestly empty after a rollback to base.
     */
    async gitDiff(workSessionId, opts): Promise<SessionGitDiff> {
      requireSummary(workSessionId);
      if (workSessionId !== sessionLive.id) {
        return clone(gitUnavailable(workSessionId, 'diff') as SessionGitDiff);
      }
      const hasWork = gitLane.dirty.length > 0 || gitLane.history.length > 1;
      let diff = hasWork ? SAMPLE_DIFF : '';
      let diffTruncated = false;
      if (opts?.maxBytes !== undefined && diff.length > opts.maxBytes) {
        diff = diff.slice(0, opts.maxBytes);
        diffTruncated = true;
      }
      return clone({
        sessionId: workSessionId,
        available: true,
        unavailableReason: null,
        branch: gitLane.branch,
        baseRef: gitLane.baseRef,
        baseOid: gitLane.baseOid,
        mergeBaseOid: gitLane.baseOid,
        headOid: gitHead(),
        stat: hasWork
          ? { filesChanged: 2, additions: 9, deletions: 2 }
          : { filesChanged: 0, additions: 0, deletions: 0 },
        files: hasWork
          ? [
              { path: 'packages/server/src/facade/handlers/projects.ts', additions: 7, deletions: 2 },
              { path: 'notes/scratch.md', additions: 2, deletions: 0 },
            ]
          : [],
        filesTruncated: false,
        diff,
        diffTruncated,
        checkedAt: FIXTURE_NOW,
      });
    },
    async inbox(opts): Promise<Page<NotificationItem>> {
      // The dataset carries no notification rows: the inbox is honestly empty.
      return clone(pageOf<NotificationItem>([], opts));
    },
    /**
     * Served from the row store, filtered the way the server filters
     * (`entities-commands-tracking.ts:1214-1240`). NOTE WHAT IS ABSENT: no
     * status filter is applied unless the caller asks for one, so the default
     * answer is the FULL history including `resolved` and `dismissed`. That is
     * the server's behaviour too — the badge is the only place that narrows to
     * pending — and a history surface depends on it.
     */
    async attentionRequests(input): Promise<AttentionRequestPage> {
      const filtered = attentionRows
        .filter((r) => r.spaceId === input.spaceId)
        .filter((r) => (input.entityId ? r.entityId === input.entityId : true))
        // A row whose entity was deleted is gone: the real table cascades on
        // `entities`, so a tombstoned entity has no history to show.
        .filter((r) => summaries.get(r.entityId)?.deletedAt == null)
        .filter((r) => (input.status ? r.status === input.status : true))
        .filter((r) => (input.minPoints ? r.points >= input.minPoints : true))
        // The server's order, mirrored: points desc, createdAt asc, id asc.
        .sort((a, b) => b.points - a.points
          || a.createdAt.localeCompare(b.createdAt)
          || a.id.localeCompare(b.id));
      return clone(pageOf(filtered, { limit: input.limit, cursor: input.cursor }));
    },
    async feed(id, opts?: FeedOpts): Promise<EntityFeedPage> {
      const anchor = requireSummary(id);
      // `channel_threads_v1` is `direct_v1` minus `replies`: THREAD ROOTS
      // ONLY. The fixture honours the partition the server enforces —
      // otherwise the roots-only channel read would go unexercised here and
      // still pass, exactly the unfiltered-read failure the connections
      // fixture comment above records.
      const rootsOnly = opts?.scope === 'channel_threads_v1';
      const items: FeedItem[] = [...summaries.values()]
        .filter((s) => s.state.kind === 'message' && s.state.anchorId === id && s.deletedAt === null)
        .filter((s) => !rootsOnly || (s.state.kind === 'message' && s.state.rootMessageId === null))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((s) => {
          const view = toMessageView(s);
          return {
            itemId: `feed-${s.id}`,
            createdAt: s.createdAt,
            sortId: `${s.createdAt}#${s.id}`,
            via: ['anchored' as const],
            actor: view.state.author,
            // Honest G2 gap: authored_from is null through public writes.
            sourceWorkSessionId: null,
            anchor,
            logicalOperationId: null,
            itemKind: 'message' as const,
            message: view,
            delivery: (deliveriesByMessage.get(s.id) ?? []).map((d) => ({
              deliveryId: d.deliveryId, targetWorkSessionId: d.targetWorkSessionId,
              status: d.status, attemptNo: d.attemptNo, failureReason: d.failureReason,
              updatedAt: d.updatedAt,
            })),
          };
        });
      return clone({
        resolvedScope: opts?.scope ?? 'direct_v1',
        predicates: rootsOnly
          ? ['anchored' as const, 'subject' as const]
          : ['anchored' as const],
        items,
        nextCursor: null,
      });
    },
    /** Facets pass through UNCOLLAPSED — 'unknown' stays exactly 'unknown'. */
    async delivery(messageId): Promise<MessageDeliveryView> {
      const s = requireSummary(messageId);
      return clone({
        message: toMessageView(s),
        deliveries: deliveriesByMessage.get(messageId) ?? [],
      });
    },

    files: {
      async uploadInit(input) {
        if (input.sizeBytes > FILE_MAX_SIZE_BYTES_DEFAULT) {
          throw new CollabError('payload_too_large', `${input.name} exceeds the fixture upload limit`);
        }
        const uploadId = nextId('upload');
        const grant: FileUploadGrant = {
          uploadId,
          uploadUrl: `/v2/files/uploads/${encodeURIComponent(uploadId)}/content`,
          token: `fixture-grant-${uploadId}`,
          expiresAt: new Date(FIXTURE_BASE_MS + 60 * 60 * 1000).toISOString(),
          maxSizeBytes: FILE_MAX_SIZE_BYTES_DEFAULT,
        };
        uploadSlots.set(uploadId, { input: clone(input), grant, uploaded: false });
        return clone(grant);
      },
      async putBytes(grant, bytes) {
        const slot = uploadSlots.get(grant.uploadId);
        if (slot === undefined) throw new CollabError('not_found', `upload ${grant.uploadId} not found`);
        if (!(bytes instanceof Blob)) throw new CollabError('invalid_input', 'fixture uploads require a Blob body');
        if (bytes.size !== slot.input.sizeBytes) {
          throw new CollabError('invalid_input', `uploaded size does not match ${slot.input.sizeBytes}`);
        }
        slot.uploaded = true;
      },
      async complete(uploadId, input) {
        const slot = uploadSlots.get(uploadId);
        if (slot === undefined) throw new CollabError('not_found', `upload ${uploadId} not found`);
        if (!slot.uploaded) throw new CollabError('conflict', `upload ${uploadId} has no bytes`);
        for (const target of input.targets ?? []) requireSummary(target);
        const file = insertSummary({
          id: nextId('file'),
          kind: 'file',
          title: slot.input.name,
          spaceId: slot.input.spaceId,
          state: {
            kind: 'file',
            name: slot.input.name,
            mimeType: slot.input.mime,
            sizeBytes: slot.input.sizeBytes,
          },
        });
        extras.set(file.id, {
          content: { kind: 'file' },
          connections: clone(NO_CONNECTIONS),
          capabilities: { ...CAPS_FULL },
        });
        uploadSlots.delete(uploadId);
        emit(file.spaceId, { type: 'entity.upsert', entity: clone(file) }, input);
        return commandResult(file);
      },
      async abort(uploadId) {
        if (!uploadSlots.delete(uploadId)) throw new CollabError('not_found', `upload ${uploadId} not found`);
        return { patches: [] };
      },
      /**
       * The same RELATIVE path the real seam builds, minus a base URL the
       * fixture has no business inventing. A fixture-driven UI therefore
       * renders real, well-formed hrefs that resolve to nothing — which is the
       * honest fixture behaviour for a route that serves bytes off a node.
       */
      downloadHref(fileEntityId) {
        return bindPath('files.download', { fileEntityId });
      },
    },

    commands: {
      async createEntity(input) {
        if (input.parentId) requireSummary(input.parentId);
        /*
         * `create_memory` (056) takes NO title argument — the title IS the
         * statement, derived server-side. Mirroring that here is not cosmetic:
         * a fixture that kept the caller's title would let a composer send a
         * separate title and look correct in jsdom while the node overwrote it.
         * The excerpt carries the statement for the same reason the server
         * does — summaries are how a memory's claim travels.
         */
        const statement = (input.content as Record<string, unknown> | undefined)?.statement;
        const derivedTitle =
          input.kind === 'memory' && typeof statement === 'string' && statement.length > 0
            ? statement
            : input.title;
        const s = insertSummary({
          id: nextId(input.kind),
          kind: input.kind,
          title: derivedTitle,
          spaceId: input.spaceId,
          parentId: input.parentId ?? null,
          ...(input.position !== undefined ? { position: input.position } : {}),
          ...(input.kind === 'memory' ? { excerpt: derivedTitle } : {}),
          state: defaultStateFor(input),
        });
        if (input.kind === 'graph') {
          /* The row IS the graph (Craft P1 R1): the create's content is the
             body a detail read must hand back, so it cannot be synthesized
             from state alone the way the light kinds are. */
          const c = (input.content ?? {}) as Record<string, unknown>;
          extras.set(s.id, {
            content: {
              kind: 'graph',
              graphType: (c.graphType as string) ?? 'entity',
              nodes: Array.isArray(c.nodes) ? (c.nodes as never[]) : [],
              edges: Array.isArray(c.edges) ? (c.edges as never[]) : [],
              layout: (c.layout as Record<string, { x: number; y: number }>) ?? {},
              source: (c.source as string | null) ?? null,
            },
            connections: clone(NO_CONNECTIONS),
            capabilities: { ...CAPS_FULL },
          });
        }
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      async createTask(input: CreateTaskInput) {
        if (input.parentId) requireSummary(input.parentId);
        const criteria = (input.acceptanceCriteria ?? []).map((c, i) => ({
          id: c.id ?? `ac-fx-${i + 1}`, text: c.text, done: c.done ?? false,
        }));
        const s = insertSummary({
          id: nextId('task'),
          kind: 'task',
          title: input.title,
          spaceId: input.spaceId,
          parentId: input.parentId ?? null,
          ...(input.position !== undefined ? { position: input.position } : {}),
          excerpt: input.description,
          state: {
            kind: 'task', status: 'open', priority: input.priority ?? 'medium',
            axes: input.axes ?? {}, dueDate: input.dueDate ?? null, assignees: [],
            acceptance: { total: criteria.length, completed: criteria.filter((c) => c.done).length },
          },
        });
        extras.set(s.id, {
          content: {
            kind: 'task', description: input.description ?? '',
            acceptanceCriteria: criteria, pointsEstimate: input.pointsEstimate ?? null,
          },
          connections: clone(NO_CONNECTIONS),
          capabilities: { ...CAPS_FULL },
        });
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      async patchEntity(id, input: PatchEntityInput) {
        const s = requireSummary(id);
        requireVersion(s, input.expectedVersion);
        if (input.title !== undefined) s.title = input.title;
        if (input.content !== undefined) {
          const e = extrasOf(id);
          e.content = { ...e.content, ...input.content } as EntityContent;
          /**
           * `dueDate` IS PATCHED INTO CONTENT AND READ OUT OF STATE, so the
           * double has to make the same crossing the node does. Server-side
           * `update_task_content` writes `tasks.due_date` and `stateOf`
           * projects it (`entity-read.ts:1112`) while `contentOf` never
           * carries it — so a fixture that merged this into content alone
           * would leave the list tile, the `dueDate` sort and the next open
           * of the dialog all reading the OLD date while the write reported
           * success. That is the fixture lying about a real write, which is
           * worse than not supporting it.
           *
           * An explicit `null` clears, exactly as it does at the node; an
           * ABSENT key changes nothing, which is `coalesce`'s behaviour there.
           */
          const patched = input.content as Record<string, unknown>;
          if (s.state.kind === 'task' && 'dueDate' in patched) {
            const due = patched.dueDate;
            s.state.dueDate = typeof due === 'string' ? due : null;
          }
          /**
           * Same crossing for `priority`: the node's `update_task_content`
           * writes `tasks.priority` and `stateOf` projects it, so a fixture
           * that banked it in content alone would let the board's priority
           * drop report success while every fresh read said 'medium' — an
           * optimistic move that could never settle NOR roll back.
           */
          if (s.state.kind === 'task' && 'priority' in patched) {
            const p = patched.priority;
            if (p === 'low' || p === 'medium' || p === 'high' || p === 'urgent') s.state.priority = p;
          }
          /* `axes` makes the same content→state crossing as `dueDate`, and
             with the server's own replace-wholesale semantics
             (`update_task_content`: `axes = coalesce(p_axes, axes)`): a
             present object REPLACES the stored record — the MERGE is the
             writer's job — and an absent key changes nothing. A fixture that
             merged here would pass a writer that forgets to merge, which the
             real node would quietly data-lose. */
          if (s.state.kind === 'task' && 'axes' in patched) {
            const axes = patched.axes;
            if (axes !== null && typeof axes === 'object') {
              s.state.axes = { ...(axes as Record<string, string>) };
            }
          }
          /**
           * And the crossing is a MOVE, not a copy: the node's `contentOf`
           * never carries these state-projected keys (task content is
           * kind/description/acceptanceCriteria/pointsEstimate, strict), so
           * a fixture that left them merged into content would hand back a
           * detail `EntityDetailSchema` refuses — contract-invalid in a way
           * the real server never is.
           *
           * `axes` joins that list on the merge: it is an EntityState field
           * with no home in the strict task content, so the block main added
           * above has to clear it here for the same reason the other two are
           * cleared. Leaving it would make every axis write hand back a
           * contract-invalid detail.
           */
          if (s.state.kind === 'task') {
            const c = e.content as Record<string, unknown>;
            delete c.priority;
            delete c.dueDate;
            delete c.axes;
          }
        }
        touch(s);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      /**
       * The bulk verb, mirroring `resolve_entity_attention` (050:208-212):
       * every open OR acknowledged row on the entity flips to `resolved`, and
       * the rows are RETAINED with their reason, points and requester intact.
       * It is a status flip, not a delete — which is the whole reason a
       * history surface has anything to show after you open an entity.
       */
      async resolveAttention(id, input) {
        const s = requireSummary(id);
        const pending = attentionRows.filter(
          (r) => r.entityId === id && (r.status === 'open' || r.status === 'acknowledged'),
        );
        const at = tick();
        for (const row of pending) {
          row.status = 'resolved';
          row.resolvedBy = clone(viewerActor);
          row.resolvedAt = at;
          row.updatedAt = at;
          // The RPC bumps `version` on every row it touches, which is why a
          // client holding rows fetched before an open will fail its next
          // update with a version conflict rather than silently overwriting.
          row.version += 1;
          if (input.resolutionNote !== undefined) row.resolutionNote = input.resolutionNote;
        }
        const affectedCount = pending.length;
        if (affectedCount > 0) {
          recomputeAttentionBadge(s);
          touch(s);
          emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        }
        return { request: null, entity: clone(s), affectedCount };
      },
      /**
       * The per-request verb, mirroring `update_attention_request` (050:97-179)
       * — including the part that is easy to get wrong: moving a row BACK to
       * open or acknowledged CLEARS the resolution stamps rather than leaving a
       * resolved-by on a row that is not resolved (050:148-167).
       */
      async updateAttentionRequest(requestId, input) {
        const row = attentionRows.find((r) => r.id === requestId);
        if (!row) throw new CollabError('not_found', `attention request ${requestId} not found`);
        if (row.version !== input.expectedVersion) {
          throw new CollabError(
            'version_conflict',
            `expected version ${input.expectedVersion}, have ${row.version}`,
          );
        }
        const s = requireSummary(row.entityId);
        const at = tick();
        if (input.reason !== undefined) row.reason = input.reason;
        if (input.points !== undefined) row.points = input.points;
        if (input.resolutionNote !== undefined) row.resolutionNote = input.resolutionNote;
        if (input.status !== undefined) {
          row.status = input.status;
          const settled = input.status === 'resolved' || input.status === 'dismissed';
          row.resolvedBy = settled ? clone(viewerActor) : null;
          row.resolvedAt = settled ? at : null;
          row.acknowledgedBy = input.status === 'acknowledged' ? clone(viewerActor) : row.acknowledgedBy;
          row.acknowledgedAt = input.status === 'acknowledged' ? at : row.acknowledgedAt;
          if (input.status === 'open') {
            row.acknowledgedBy = null;
            row.acknowledgedAt = null;
          }
        }
        row.updatedAt = at;
        row.version += 1;
        recomputeAttentionBadge(s);
        touch(s);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return { request: clone(row), entity: clone(s), affectedCount: 1 };
      },
      /**
       * Amendment 4 mirror: writes the VIEWER's profile — the only row this
       * seam has, exactly like the real op. Only provided fields are written,
       * and the `globalId` check-constraint shape is enforced here too so the
       * fixture path exercises the same refusal the node would issue.
       */
      async updateProfile(input: IdentityProfileUpdateInput): Promise<IdentityProfileView> {
        if (input.globalId !== undefined && !/^[^:\s]+:\S+$/.test(input.globalId)) {
          throw new CollabError('invalid_input', 'globalId must be issuer:subject with no whitespace');
        }
        if (input.displayName !== undefined) identityView.displayName = input.displayName;
        if (input.avatar !== undefined) identityView.avatar = input.avatar;
        if (input.email !== undefined) identityView.email = input.email;
        if (input.globalId !== undefined) identityView.globalId = input.globalId;
        // The viewer's actor mirrors the profile so feeds attribute with it.
        if (input.displayName !== undefined) viewerActor.displayName = input.displayName;
        if (input.avatar !== undefined) viewerActor.avatar = input.avatar;
        return clone({
          identityId: identityView.identityId,
          displayName: identityView.displayName,
          avatar: identityView.avatar,
          email: identityView.email,
          globalId: identityView.globalId,
        });
      },
      /**
       * Amendment 11 mirror — and it reproduces ALL FOUR of 109's rules, not
       * just the happy path. That is the fixture's standing discipline (see
       * `updateProfile` above, which enforces the `globalId` check constraint):
       * a screen that only ever meets the fixture must meet the same refusals
       * it will meet on a node, or the refusal states are drawn from
       * imagination and are wrong in exactly the places that matter.
       */
      async setMemberRole(
        spaceId: SpaceId,
        memberId: EntityId,
        input: UpdateMemberRoleInput,
      ): Promise<CommandResult> {
        const target = requireSummary(memberId);
        if (target.kind !== 'member' || target.spaceId !== spaceId) {
          throw new CollabError('not_found', `member ${memberId} not found in this space`);
        }
        const previous = roleOfSummary(target);
        // R1 — the viewer must be an admin of this space.
        const viewer = membersOfSpace(spaceId).find((m) => m.id === viewerActor.id)
          ?? membersOfSpace(spaceId).find((m) => roleOfSummary(m) === 'owner');
        const viewerRole = viewer ? roleOfSummary(viewer) : null;
        if (viewerRole !== 'owner' && viewerRole !== 'admin') {
          throw new CollabError('forbidden', 'space admin required');
        }
        // R2 — only an owner may grant or revoke the owner role.
        if ((input.role === 'owner' || previous === 'owner') && viewerRole !== 'owner') {
          throw new CollabError('forbidden', 'only an owner may grant or revoke the owner role');
        }
        if (previous === input.role) return commandResult(target);
        // R3 — the last owner cannot be demoted.
        if (previous === 'owner' && input.role !== 'owner') {
          const owners = membersOfSpace(spaceId).filter((m) => roleOfSummary(m) === 'owner');
          if (owners.length <= 1) {
            throw new CollabError('forbidden',
              'a space must keep at least one owner: promote a successor first');
          }
        }
        (target.state as { role?: string }).role = input.role;
        touch(target);
        emit(spaceId, { type: 'entity.upsert', entity: clone(target) }, input);
        return commandResult(target);
      },

      async createInvite(spaceId: SpaceId, input: CreateInviteInput): Promise<SpaceInviteView> {
        if (spaceId !== FIXTURE_SPACE_ID) {
          throw new CollabError('not_found', `space ${spaceId} not found`);
        }
        // R4, mirrored: an invite may confer admin or member, never owner. The
        // TYPE already excludes it, and this is the runtime half — a caller
        // reaching here from untyped JSON meets the same refusal a node gives.
        const role = input.role ?? 'member';
        if (role !== 'admin' && role !== 'member') {
          throw new CollabError('invalid_input',
            "role must be 'admin' or 'member': an invite cannot confer ownership");
        }
        const invite: SpaceInviteView = {
          id: `inv-fixture-${invites.length + 1}`,
          code: newInviteCode(),
          role,
          maxUses: input.maxUses ?? 1,
          uses: 0,
          expiresAt: input.expiresAt ?? null,
          revoked: false,
        };
        invites.unshift(invite);
        return clone(invite);
      },

      /** Revoking KEEPS the row. A list that forgot it could not stay truthful. */
      async revokeInvite(spaceId: SpaceId, inviteId: string): Promise<SpaceInviteView> {
        if (spaceId !== FIXTURE_SPACE_ID) {
          throw new CollabError('not_found', `space ${spaceId} not found`);
        }
        const invite = invites.find((i) => i.id === inviteId);
        if (!invite) throw new CollabError('not_found', `invite ${inviteId} not found`);
        invite.revoked = true;
        return clone(invite);
      },

      /**
       * W2 — the axis registry's writes, mirroring the w2_* RPCs refusal for
       * refusal: shared input validation, the (space,name) uniqueness, the
       * three in-use refusals AND the two default-axis refusals (delete and
       * demote — 016, KEPT by the amended ruling 2026-08-16), all in the
       * node's own words.
       */
      async createTaskAxis(spaceId: SpaceId, input: TaskAxisInput): Promise<TaskAxis> {
        if (spaceId !== FIXTURE_SPACE_ID) {
          throw new CollabError('not_found', `space ${spaceId} not found`);
        }
        validateAxisInput(input);
        if (taskAxes.some((a) => a.name === input.name)) {
          throw new CollabError('conflict', `a task axis named ${input.name} already exists`);
        }
        axisSeq += 1;
        const axis: TaskAxis = {
          id: `axis-fixture-${axisSeq}`,
          spaceId,
          name: input.name,
          axisValues: [...input.axisValues],
          kind: input.kind,
          position: input.position,
        };
        taskAxes.push(axis);
        return clone(axis);
      },

      async updateTaskAxis(spaceId: SpaceId, axisId: string, input: TaskAxisInput): Promise<TaskAxis> {
        if (spaceId !== FIXTURE_SPACE_ID) {
          throw new CollabError('not_found', `space ${spaceId} not found`);
        }
        const axis = taskAxes.find((a) => a.id === axisId);
        if (!axis) throw new CollabError('not_found', 'task axis not found');
        validateAxisInput(input);
        if (axis.kind === 'default' && input.kind !== 'default') {
          throw new CollabError('invariant_violation', 'the default task axis cannot be demoted');
        }
        if (input.name !== axis.name && axisInUse(axis.name)) {
          throw new CollabError('invariant_violation', 'cannot rename a task axis that tasks still use');
        }
        if (axis.axisValues.length > 0 && axisInUse(axis.name, input.axisValues)) {
          throw new CollabError('invariant_violation', 'cannot remove a task axis value that tasks still use');
        }
        axis.name = input.name;
        axis.axisValues = [...input.axisValues];
        axis.kind = input.kind;
        axis.position = input.position;
        return clone(axis);
      },

      async deleteTaskAxis(spaceId: SpaceId, axisId: string): Promise<{ axisId: string }> {
        if (spaceId !== FIXTURE_SPACE_ID) {
          throw new CollabError('not_found', `space ${spaceId} not found`);
        }
        const index = taskAxes.findIndex((a) => a.id === axisId);
        if (index < 0) throw new CollabError('not_found', 'task axis not found');
        if (taskAxes[index]!.kind === 'default') {
          throw new CollabError('invariant_violation', 'the default task axis cannot be deleted');
        }
        if (axisInUse(taskAxes[index]!.name)) {
          throw new CollabError('invariant_violation', 'task axis is still in use by tasks');
        }
        taskAxes.splice(index, 1);
        return { axisId };
      },

      /**
       * W4 — the workflow registry's writes, mirroring `upsert_task_workflow`
       * / `delete_task_workflow` (132) refusal for refusal, in the ORDER the
       * SQL raises them: the RPC's own duplicate check (22023 →
       * invalid_input) fires before the insert, whose two check constraints
       * (23514 → invariant_violation) carry Postgres's own message shape. The
       * admin gate is NOT mirrored: the fixture viewer is the space owner,
       * exactly as in the axis verbs above.
       */
      async upsertTaskWorkflow(spaceId: SpaceId, input: TaskWorkflowInput): Promise<TaskWorkflow> {
        if (spaceId !== FIXTURE_SPACE_ID) {
          throw new CollabError('not_found', `space ${spaceId} not found`);
        }
        const statuses = input.statuses;
        if (new Set(statuses).size !== statuses.length) {
          throw new CollabError('invalid_input', 'workflow statuses must be unique');
        }
        const seven = ['open', 'pulled', 'working', 'in_review', 'done', 'blocked', 'cancelled'];
        if (statuses.some((v) => !seven.includes(v))) {
          throw new CollabError(
            'invariant_violation',
            'new row for relation "task_workflows" violates check constraint "task_workflows_statuses_valid"',
          );
        }
        // ⚠ NO LONGER MIRRORS THE SERVER, DELIBERATELY. Migration 151 (phase 4)
        // DROPPED `task_workflows_structural_statuses` — the doors resolve a
        // state by category and the completion gate rides the →done transition,
        // so the schema no longer needs the three. The rule survives on the
        // client (`domain/workflows.ts` STRUCTURAL_STATUSES, rendered as
        // always-included checkboxes in WorkflowsSection) because 132's
        // `tasks_validate_workflow` trigger still polices the legacy column
        // against this vocabulary until phase 6 retires `task_workflows`. This
        // arm is the fixture standing in for that client rule, in the old
        // constraint's words; delete it with the rule, in phase 6.
        if (!(['open', 'working', 'done'] as const).every((v) => (statuses as readonly string[]).includes(v))) {
          throw new CollabError(
            'invariant_violation',
            'new row for relation "task_workflows" violates check constraint "task_workflows_structural_statuses"',
          );
        }
        const typeValue = input.typeValue.trim();
        const existing = taskWorkflows.find((w) => w.typeValue === typeValue);
        if (existing) {
          existing.statuses = [...statuses];
          return clone(existing);
        }
        workflowSeq += 1;
        const row: TaskWorkflow = {
          id: `workflow-fixture-${workflowSeq}`,
          spaceId,
          typeValue,
          statuses: [...statuses],
        };
        taskWorkflows.push(row);
        return clone(row);
      },

      /** Deleting a rule widens the vocabulary back to the seven; no task row changes. */
      async deleteTaskWorkflow(spaceId: SpaceId, workflowId: string): Promise<{ workflowId: string }> {
        if (spaceId !== FIXTURE_SPACE_ID) {
          throw new CollabError('not_found', `space ${spaceId} not found`);
        }
        const index = taskWorkflows.findIndex((w) => w.id === workflowId);
        if (index < 0) throw new CollabError('not_found', 'task workflow not found');
        taskWorkflows.splice(index, 1);
        return { workflowId };
      },

      /**
       * The viewer is already a member of the fixture space, so this answers
       * `joined: false` — which is the node's own answer for an existing
       * member and NOT a stub. A fixture cannot mint a second human.
       */
      async redeemInvite(input: RedeemInviteInput): Promise<InviteRedemption> {
        const invite = invites.find((i) => i.code === input.code);
        // THE NODE'S OWN LADDER, IN THE NODE'S OWN ORDER (migration 118),
        // because the join screen renders a different sentence per rung and a
        // fixture that answered `forbidden` for all of them could exercise
        // none of it. The sqlstates map through `http/errors.ts`:
        // P0002 -> not_found, 42501 -> forbidden, 53400 -> limit_exceeded.
        if (!invite) throw new CollabError('not_found', 'invite not found');
        if (invite.revoked) throw new CollabError('forbidden', 'invite was revoked');
        if (invite.expiresAt !== null && Date.parse(invite.expiresAt) < Date.parse(tick())) {
          throw new CollabError('forbidden', 'invite has expired');
        }
        // Exhaustion is checked ONLY for a non-member on the node — an existing
        // member spends no use — and the fixture viewer is always already a
        // member, so this rung is unreachable here for the same reason
        // `joined` is always false. Written out rather than omitted so the
        // fixture and the RPC can be read side by side.
        if (invite.uses >= invite.maxUses) {
          throw new CollabError('limit_exceeded', 'invite is exhausted');
        }
        return { spaceId: FIXTURE_SPACE_ID, memberId: viewerActor.id, joined: false };
      },

      async patchTask(id, input: PatchTaskInput) {
        const s = requireSummary(id);
        // A work session is a title-ONLY door here, mirroring what the node
        // does (085 / rename_work_session): every other member belongs to the
        // execution block, so accepting one would let a fixture-backed screen
        // pass where the real node refuses.
        if (s.state.kind === 'work_session') {
          const envelope = new Set(['expectedVersion', 'actorId', 'clientMutationId', 'title']);
          const rejected = Object.entries(input)
            .filter(([member, value]) => !envelope.has(member) && value !== undefined)
            .map(([member]) => member);
          if (rejected.length > 0) {
            throw new CollabError('invalid_input',
              `work_session patch accepts title only, not: ${rejected.join(', ')}`);
          }
          if (input.title === undefined) {
            throw new CollabError('invalid_input', 'work_session patch requires title');
          }
          requireVersion(s, input.expectedVersion);
          s.title = input.title;
          touch(s);
          emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
          return commandResult(s);
        }
        if (s.state.kind !== 'task') throw new CollabError('invariant_violation', `${id} is not a task`);
        requireVersion(s, input.expectedVersion);
        // W4 — the 132 trigger mirror: a status write outside the row's type
        // vocabulary refuses here exactly as `public.tasks`'s trigger does.
        if (input.status !== undefined) requireWorkflowAllows(s, input.status);
        if (input.title !== undefined) s.title = input.title;
        if (input.status !== undefined) s.state.status = input.status;
        if (input.priority !== undefined) s.state.priority = input.priority;
        if (input.axes !== undefined) s.state.axes = input.axes;
        if (input.dueDate !== undefined) s.state.dueDate = input.dueDate;
        const e = extrasOf(id);
        if (e.content.kind === 'task') {
          if (input.description !== undefined) e.content.description = input.description;
          if (input.pointsEstimate !== undefined) e.content.pointsEstimate = input.pointsEstimate;
          if (input.acceptanceCriteria !== undefined) {
            e.content.acceptanceCriteria = input.acceptanceCriteria;
            s.state.acceptance = {
              total: input.acceptanceCriteria.length,
              completed: input.acceptanceCriteria.filter((c) => c.done).length,
            };
          }
        }
        touch(s);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      async moveEntity(id, input: MoveEntityInput) {
        const s = requireSummary(id);
        requireVersion(s, input.expectedVersion);
        if (input.parentId !== null) requireSummary(input.parentId);
        s.parentId = input.parentId;
        s.position = input.position;
        touch(s);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      async deleteEntity(id, ctx) {
        const s = requireSummary(id);
        if (s.deletedAt !== null) throw new CollabError('conflict', `${id} is already deleted`);
        s.deletedAt = tick();
        touch(s);
        emit(s.spaceId, { type: 'entity.deleted', entity: clone(s) }, ctx);
        return commandResult(s, { undo: { token: `undo-${s.id}-${s.version}`, label: `Restore ${s.title}` } });
      },
      async restoreEntity(id, ctx) {
        const s = requireSummary(id);
        if (s.deletedAt === null) throw new CollabError('conflict', `${id} is not deleted`);
        s.deletedAt = null;
        touch(s);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, ctx);
        return commandResult(s);
      },
      /**
       * Detach. Fixture edges are stored per-endpoint inside `extras`, so the
       * SAME edge id appears twice — once outgoing on the source, once
       * incoming on the target. Removing one copy would leave the peer's panel
       * still listing the attachment, which is precisely the split-brain a
       * real DELETE cannot produce; both copies go, and a group emptied by the
       * removal goes with them so `attached_to · 0` is never rendered.
       *
       * It also serves UNASSIGN, which reached this op from the other side:
       * `state.assignees` is projected from `assigned_to` edges, so every
       * touched summary is re-projected here exactly as the node's read path
       * does. One implementation, two callers — an outgoing-only variant would
       * leave the target's panel still listing an assignment that is gone.
       */
      async deleteEdge(edgeId, ctx) {
        let removed: EdgeView | null = null;
        const touched: EntitySummary[] = [];
        for (const [id, e] of extras) {
          let hit = false;
          for (const side of ['outgoing', 'incoming'] as const) {
            for (const group of e.connections[side]) {
              const found = group.edges.find((edge) => edge.id === edgeId);
              if (!found) continue;
              removed ??= found;
              group.edges = group.edges.filter((edge) => edge.id !== edgeId);
              hit = true;
            }
            e.connections[side] = e.connections[side].filter((group) => group.edges.length > 0);
          }
          if (hit) touched.push(requireSummary(id));
        }
        if (removed === null) throw new CollabError('not_found', `edge ${edgeId} not found`);
        for (const s of touched) {
          projectAssignees(s);
          touch(s);
          emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, ctx);
        }
        return { patches: touched.map((s) => clone(s)) };
      },
      async complete(id, input: CompleteTaskInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'task') throw new CollabError('invariant_violation', `${id} is not a task`);
        requireVersion(s, input.expectedVersion);
        s.state.status = 'done';
        s.state.acceptance = { ...s.state.acceptance, completed: s.state.acceptance.total };
        touch(s);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      async work(id, input: WorkInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'task') throw new CollabError('invariant_violation', `${id} is not a task`);
        // W4 — the 132 trigger mirror. `complete` next door is deliberately
        // unguarded: `done` is structural, so no vocabulary can exclude it.
        requireWorkflowAllows(s, input.status);
        s.state.status = input.status;
        touch(s);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      /**
       * A VANILLA TERMINAL (101).
       *
       * `agentTool: null` AND `sessionKind: 'shell'`, both written out, because
       * the fixture is what every list test reads and this row is the one that
       * proves an allow-list filter. A fixture that only ever produced agent
       * sessions would let `sessionKind === 'agent'` pass the whole suite.
       *
       * No teammate to `requireSummary`, no task, and no parent: a terminal is
       * a root started by a human, not work descending from something.
       */
      async startTerminal(input: ExecutionTerminalStartInput) {
        const startedAt = tick();
        const s = insertSummary({
          id: nextId('ws'),
          kind: 'work_session',
          title: input.title ?? 'Terminal',
          spaceId: input.spaceId,
          parentId: null,
          state: {
            kind: 'work_session', status: 'running',
            agentTool: null, model: null,
            shareMode: 'none', startedAt, exitedAt: null,
            sessionKind: 'shell',
          },
        });
        extras.set(s.id, {
          content: {
            kind: 'work_session', nodeId: 'node-fixture',
            launchProjectId: input.projectId ?? null,
            workingOn: [], transcriptDoc: null,
          },
          connections: clone(NO_CONNECTIONS),
          capabilities: { ...CAPS_FULL },
        });
        const snap = livenessBySpace.get(input.spaceId);
        setLiveness(input.spaceId, [...(snap?.liveEntityIds ?? []), s.id], snap?.nodeBootId);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      /**
       * Mirrors `write_edge`: an UPSERT on (src, dst, type), and it re-projects
       * `state.assignees` the way the node's read path does — the fixture would
       * otherwise create an edge that no surface could see, which is precisely
       * the half-built seam this operation exists to close.
       */
      async createEdge(input: CreateEdgeInput) {
        const src = requireSummary(input.srcId);
        const dst = requireSummary(input.dstId);
        const c = extrasOf(src.id).connections;
        let group = c.outgoing.find((g) => g.type === input.type);
        if (!group) {
          group = { type: input.type, direction: 'outgoing', label: input.type, edges: [] };
          c.outgoing.push(group);
        }
        const existing = group.edges.find((e) => e.target.id === dst.id);
        if (existing) {
          existing.props = input.props ?? {};
          existing.updatedAt = tick();
        } else {
          const at = tick();
          group.edges.push({
            id: nextId('edge'), type: input.type, source: clone(src), target: clone(dst),
            props: input.props ?? {}, createdBy: viewerActor, createdAt: at, updatedAt: at,
          });
        }
        projectAssignees(src);
        touch(src);
        emit(src.spaceId, { type: 'entity.upsert', entity: clone(src) }, input);
        return commandResult(src);
      },
      /**
       * Mirrors `set_collection_item`: an UPSERT on the `contains` triple with
       * `props.position` appended after the current maximum when the caller
       * names none. Unlike `createEdge` above, BOTH endpoint copies are
       * written (outgoing on the collection, incoming on the member) — the
       * member's panel lists its collections from its own incoming edges, and
       * a fixture that wrote one side would render the split-brain a real node
       * cannot produce. The two read projections move with the write:
       * `state.itemCount` and `content.items`, exactly as the node's read
       * path computes them.
       */
      async addToCollection(collectionId: EntityId, input: CollectionAddItemInput) {
        const collection = requireSummary(collectionId);
        if (collection.state.kind !== 'collection') {
          throw new CollabError('invariant_violation', `${collectionId} is not a collection`);
        }
        const member = requireSummary(input.entityId);
        // Same refusal as `set_collection_item` (migration 101): `contains`
        // is registered non-acyclic, so nothing else stops a collection from
        // listing itself in its own items.
        if (member.id === collection.id) {
          throw new CollabError('invalid_input', 'a collection cannot contain itself');
        }
        const c = extrasOf(collection.id).connections;
        let group = c.outgoing.find((g) => g.type === 'contains');
        if (!group) {
          group = { type: 'contains', direction: 'outgoing', label: 'contains', edges: [] };
          c.outgoing.push(group);
        }
        const position = input.position
          ?? Math.max(0, ...group.edges.map((e) => Number(e.props.position ?? 0))) + 1;
        const existing = group.edges.find((e) => e.target.id === member.id);
        let edge: EdgeView;
        if (existing) {
          existing.props = { ...existing.props, position };
          existing.updatedAt = tick();
          edge = existing;
        } else {
          const at = tick();
          edge = {
            id: nextId('edge'), type: 'contains', source: clone(collection), target: clone(member),
            props: { position }, createdBy: viewerActor, createdAt: at, updatedAt: at,
          };
          group.edges.push(edge);
        }
        const mc = extrasOf(member.id).connections;
        let inGroup = mc.incoming.find((g) => g.type === 'contains');
        if (!inGroup) {
          inGroup = { type: 'contains', direction: 'incoming', label: 'contains (incoming)', edges: [] };
          mc.incoming.push(inGroup);
        }
        if (!inGroup.edges.some((e) => e.id === edge.id)) inGroup.edges.push(clone(edge));

        collection.state = { ...collection.state, itemCount: group.edges.length };
        const content = extrasOf(collection.id).content;
        if (content.kind === 'collection') {
          content.items = group.edges
            .slice()
            .sort((a, b) => Number(a.props.position ?? 0) - Number(b.props.position ?? 0))
            .map((e) => clone(e.target));
        }
        touch(collection);
        touch(member);
        emit(collection.spaceId, { type: 'entity.upsert', entity: clone(collection) }, input);
        emit(member.spaceId, { type: 'entity.upsert', entity: clone(member) }, input);
        return commandResult(collection, { patches: [clone(collection), clone(member)] });
      },
      /** Mirrors `remove_collection_item`: addressed by the pair, not the edge id. */
      async removeFromCollection(collectionId: EntityId, entityId: EntityId, ctx?: CommandContext) {
        const collection = requireSummary(collectionId);
        if (collection.state.kind !== 'collection') {
          throw new CollabError('invariant_violation', `${collectionId} is not a collection`);
        }
        const member = requireSummary(entityId);
        const c = extrasOf(collection.id).connections;
        const group = c.outgoing.find((g) => g.type === 'contains');
        const edge = group?.edges.find((e) => e.target.id === entityId);
        if (!group || !edge) {
          throw new CollabError('not_found', `${entityId} is not in collection ${collectionId}`);
        }
        group.edges = group.edges.filter((e) => e.id !== edge.id);
        c.outgoing = c.outgoing.filter((g) => g.edges.length > 0);
        const mc = extrasOf(member.id).connections;
        for (const inGroup of mc.incoming) {
          inGroup.edges = inGroup.edges.filter((e) => e.id !== edge.id);
        }
        mc.incoming = mc.incoming.filter((g) => g.edges.length > 0);

        collection.state = { ...collection.state, itemCount: group.edges.length };
        const content = extrasOf(collection.id).content;
        if (content.kind === 'collection') {
          content.items = content.items.filter((item) => item.id !== entityId);
        }
        touch(collection);
        touch(member);
        emit(collection.spaceId, { type: 'entity.upsert', entity: clone(collection) }, ctx);
        emit(member.spaceId, { type: 'entity.upsert', entity: clone(member) }, ctx);
        return commandResult(collection, { patches: [clone(collection), clone(member)] });
      },
      /** Amendment 10: fixture echo of `chat.threads.start` (never turn-running). */
      async startChatThread(input) {
        const root = requireSummary(input.rootMessageId);
        return {
          thread: {
            rootMessageId: input.rootMessageId,
            anchorId: root.parentId ?? input.rootMessageId,
            teammateId: input.teammateId,
            model: input.model,
            mode: input.mode,
            createdAt: new Date().toISOString(),
            lastReplyAt: null,
            // Echoed rather than invented: the real RPC refuses a projectId
            // that does not pair with the mode, so a fixture that normalised
            // the pair here would be the one place the rule does not hold.
            projectId: input.projectId ?? null,
            workdirMode: input.workdirMode,
          },
        };
      },

      async postMessage(input: PostMessageInput): Promise<CommandResult | MessageBatchResult> {
        if (input.anchorIds.length === 0) throw new CollabError('invalid_input', 'anchorIds must not be empty');
        const anchors = input.anchorIds.map(requireSummary);
        const batchId = anchors.length > 1 ? `fx-batch-${++idN}` : null;
        const views: MessageView[] = [];
        for (const anchor of anchors) {
          const s = insertSummary({
            id: nextId('msg'),
            kind: 'message',
            title: input.body.slice(0, 80),
            spaceId: anchor.spaceId,
            parentId: anchor.id,
            state: {
              kind: 'message', anchorId: anchor.id,
              rootMessageId: input.parentMessageId ?? null,
              author: viewerActor, messageBatchId: batchId, editedAt: null,
            },
          });
          extras.set(s.id, {
            content: {
              kind: 'message', body: input.body,
              mentions: (input.mentionIds ?? []).flatMap((mid) => {
                const m = summaries.get(mid);
                return m && (m.kind === 'member' || m.kind === 'team_member')
                  ? [{ entityId: mid, kind: m.kind, display: m.title }] : [];
              }),
              attachments: (input.attachmentIds ?? []).flatMap((fid) => {
                const f = summaries.get(fid);
                return f && f.state.kind === 'file'
                  ? [{ fileEntityId: fid, name: f.state.name, mime: f.state.mimeType }] : [];
              }),
            },
            connections: clone(NO_CONNECTIONS),
            capabilities: { ...CAPS_FULL },
          });
          anchor.counters = { ...anchor.counters, messages: anchor.counters.messages + 1 };
          anchor.activityAt = s.createdAt;
          const view = toMessageView(s);
          views.push(view);
          emit(anchor.spaceId, { type: 'message.created', anchorId: anchor.id, message: clone(view) }, input);
        }
        if (batchId !== null) return clone({ messageBatchId: batchId, messages: views });
        const s = summaries.get(views[0].id)!;
        return commandResult(s, { patches: [s, anchors[0]] });
      },
      async editMessage(id, input: PatchMessageInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'message') throw new CollabError('invariant_violation', `${id} is not a message`);
        requireVersion(s, input.expectedVersion);
        const e = extrasOf(id);
        if (e.content.kind === 'message') {
          e.content.body = input.body;
          if (input.mentions !== undefined) e.content.mentions = input.mentions;
        }
        s.title = input.body.slice(0, 80);
        touch(s);
        s.state.editedAt = s.updatedAt;
        emit(s.spaceId, { type: 'message.updated', anchorId: s.state.anchorId, message: clone(toMessageView(s)) }, input);
        return commandResult(s);
      },
      async react(id, input: ReactionInput) {
        const s = requireSummary(id);
        const key = { like: 'likes', dislike: 'dislikes', star: 'stars' } as const;
        const counters = { ...s.counters };
        const prev = counters.viewerReaction;
        if (input.enabled) {
          if (prev && prev !== input.reaction) counters[key[prev]] -= 1;
          if (prev !== input.reaction) counters[key[input.reaction]] += 1;
          counters.viewerReaction = input.reaction;
        } else if (prev === input.reaction) {
          counters[key[input.reaction]] -= 1;
          counters.viewerReaction = null;
        }
        s.counters = counters;
        emit(s.spaceId, { type: 'counter.changed', entityId: id, counters: clone(counters) }, input);
        return clone({ patches: [s] });
      },
      async markRead(notificationId) {
        // The fixture inbox is honestly empty (no notification rows exist),
        // so every markRead is a not_found — exercising the rollback path.
        throw new CollabError('not_found', `notification ${notificationId} not found`);
      },
      async upsertReadMark(anchorId, lastReadAt) {
        requireSummary(anchorId);
        readMarks.set(anchorId, lastReadAt);
      },
      async previewArtifact(id: string, input: ArtifactsPreviewStartInput) {
        const s = requireSummary(id);
        const current = currentRevisionOf(s);
        const revisionNumber = input.revisionNumber ?? current;
        if (revisionNumber < 1 || revisionNumber > current) {
          throw new CollabError('not_found', `revision ${revisionNumber} does not exist`);
        }
        // A data: URL is a previewUrl the viewer must treat as OPAQUE, which
        // makes the fixture a proof of that rule: any code path that parses
        // or re-bases the URL breaks here first, not in production.
        const mintedAt = tick();
        return {
          previewSessionId: nextId('preview'),
          token: `fx-preview-${revisionNumber}`,
          revisionNumber,
          // The fixture clock ~600s out — the server's own TTL, so the
          // viewer's re-mint scheduling runs against fixture data too.
          expiresAt: new Date(Date.parse(mintedAt) + 600_000).toISOString(),
          previewUrl: `data:text/html;base64,${toBase64(artifactDemoPage(s.title, revisionNumber))}`,
        };
      },
      async listArtifactRevisions(id: string) {
        const s = requireSummary(id);
        const current = currentRevisionOf(s);
        const revisions = [];
        for (let n = current; n >= 1; n--) {
          revisions.push({
            revisionNumber: n,
            manifestSha256: n.toString(16).padStart(2, '0').repeat(32),
            entrypoint: 'index.html',
            fileCount: 1,
            totalSizeBytes: 1024 + n * 512,
            sourceProvenance: null,
            // Newest first like the server orders it; one fixture day apart.
            createdAt: new Date(FIXTURE_BASE_MS - (current - n) * 86_400_000).toISOString(),
            publishedBy: s.createdBy.id,
          });
        }
        return { revisions };
      },
      async exportArtifactRevision(id: string, revisionNumber: number) {
        const s = requireSummary(id);
        const current = currentRevisionOf(s);
        if (revisionNumber < 1 || revisionNumber > current) {
          throw new CollabError('not_found', `revision ${revisionNumber} does not exist`);
        }
        const html = artifactDemoPage(s.title, revisionNumber);
        return storedZip([{ path: 'index.html', bytes: new TextEncoder().encode(html) }]);
      },
      async spawn(input: ExecutionSpawnInput) {
        const teamMember = requireSummary(input.teamMemberId);
        const tasks = (input.taskIds ?? []).map(requireSummary);
        const startedAt = tick();
        const s = insertSummary({
          id: nextId('ws'),
          kind: 'work_session',
          title: input.title ?? `session · ${input.teamMemberId}`,
          spaceId: input.spaceId,
          parentId: tasks[0]?.id ?? null,
          state: {
            kind: 'work_session', status: 'running',
            agentTool: input.agentTool ?? 'claude-code', model: input.model ?? null,
            shareMode: 'space', startedAt, exitedAt: null,
            /* The persona the run acts as — the node projects it from the
               session's `participates_in` edge. A spawn HAS a team member by
               construction, so omitting it here would give the fixture the one
               shape the server never produces: an agent session nobody runs. */
            teammate: {
              id: teamMember.id, kind: 'team_member', displayName: teamMember.title,
              avatar: null, isAgent: true,
            },
          },
        });
        extras.set(s.id, {
          content: {
            kind: 'work_session', nodeId: 'node-fixture',
            launchProjectId: input.projectId ?? null,
            workingOn: clone(tasks), transcriptDoc: null,
          },
          connections: clone(NO_CONNECTIONS),
          capabilities: { ...CAPS_FULL },
        });
        const snap = livenessBySpace.get(input.spaceId);
        setLiveness(input.spaceId, [...(snap?.liveEntityIds ?? []), s.id], snap?.nodeBootId);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      /**
       * `execution.dispatch` — the fixture mirror of the resident-dispatcher
       * saga (DESIGN §4.3).
       *
       * IT MODELS THE PARTS A UI CAN GET WRONG:
       *   · a dispatcher may have to be SPAWNED first, so `dispatcherSpawned`
       *     is sometimes true and a surface that ignores it cannot claim it
       *     "reused the existing dispatcher";
       *   · the answer is a DELIVERY VERDICT, not a session — dispatch is
       *     asynchronous by construction and there is nothing to open;
       *   · the request MESSAGE IS REALLY STORED, anchored to the derived task.
       *     `requestMessageId` therefore resolves to an entity that exists.
       *
       * RESIDENCY IS DECIDED BY LIVENESS, NOT BY STORED STATUS — §5's hazard,
       * stated as a rule the design repeats twice: "never trust
       * `work_sessions.status` for is-the-dispatcher-alive; sessions die in
       * 40ms with a NULL exit_code, so probe, don't read." A fixture that
       * matched on `state.status === 'running'` would reproduce exactly the bug
       * the design forbids, and would do it invisibly, so it reads the same
       * liveness snapshot the rest of this seam serves.
       *
       * WHAT IT DOES NOT MODEL, said plainly rather than implied: `delivery` is
       * always `'delivered'` here. A fixture session becomes live the moment it
       * is inserted — there is no boot latency to lose a request to — so the
       * `'undelivered'` branch is NOT reachable through this seam. On a real
       * node it happens when the dispatcher has not settled or has died between
       * resolution and delivery, and the request is stored anyway. An earlier
       * revision of this comment claimed the branch was reachable while the
       * code returned `'delivered'` unconditionally; that claim was false and
       * is corrected here rather than made true by inventing a failure mode
       * this seam has no honest way to produce.
       *
       * It deliberately does NOT invent the dispatcher's DECISION: no teammate
       * is chosen and no session is spawned for the work, because on a real
       * node that happens later, in another agent, and a fixture that faked it
       * would let a surface render a launch that never happened.
       */
      async dispatch(input: ExecutionDispatchInput): Promise<ExecutionDispatchResult> {
        const subject = requireSummary(input.subjectId);
        // 064 derives a task for any launchable subject before dispatch; a
        // subject that IS a task is its own derivation.
        const task = subject.state.kind === 'task'
          ? subject
          : insertSummary({
              id: nextId('task'),
              kind: 'task',
              title: subject.title,
              spaceId: subject.spaceId,
              parentId: subject.id,
              state: {
                kind: 'task', status: 'open', priority: 'medium', axes: {},
                dueDate: null, assignees: [], acceptance: { total: 0, completed: 0 },
              },
            });
        const live = new Set(livenessBySpace.get(input.spaceId)?.liveEntityIds ?? []);
        const existing = [...summaries.values()].find(
          (row) => row.spaceId === input.spaceId
            && row.state.kind === 'work_session'
            && row.title.startsWith('dispatcher')
            // LIVENESS, not `state.status` — see the docblock. A dispatcher row
            // that is merely recorded as running is not a dispatcher.
            && live.has(row.id),
        );
        const dispatcher = existing ?? insertSummary({
          id: nextId('ws'),
          kind: 'work_session',
          title: 'dispatcher',
          spaceId: input.spaceId,
          state: {
            kind: 'work_session', status: 'running', agentTool: 'claude-code',
            model: null, shareMode: 'space', startedAt: tick(), exitedAt: null,
          },
        });
        if (!existing) {
          extras.set(dispatcher.id, {
            content: {
              kind: 'work_session', nodeId: 'node-fixture', launchProjectId: null,
              workingOn: [], transcriptDoc: null,
            },
            connections: clone(NO_CONNECTIONS),
            capabilities: { ...CAPS_FULL },
          });
          const snap = livenessBySpace.get(input.spaceId);
          setLiveness(input.spaceId, [...(snap?.liveEntityIds ?? []), dispatcher.id], snap?.nodeBootId);
          emit(dispatcher.spaceId, { type: 'entity.upsert', entity: clone(dispatcher) }, input);
        }
        /*
         * THE DURABLE REQUEST, stored for real. The handler posts the dispatch
         * request as a message on the derived task, and it survives whether or
         * not delivery lands — that is what makes `undelivered` a non-fatal
         * outcome. Minting a bare id here (the previous behaviour) handed
         * callers an identifier that resolved to nothing.
         */
        const request = insertSummary({
          id: nextId('msg'),
          kind: 'message',
          title: input.note ?? `dispatch request \u00b7 ${task.title}`,
          spaceId: task.spaceId,
          parentId: task.id,
          state: {
            kind: 'message', anchorId: task.id, rootMessageId: null,
            author: viewerActor, messageBatchId: null, editedAt: null,
          },
        });
        extras.set(request.id, {
          content: {
            kind: 'message',
            body: input.note ?? `Dispatch requested for ${task.title}.`,
            mentions: [], attachments: [],
          },
          connections: clone(NO_CONNECTIONS),
          capabilities: { ...CAPS_FULL },
        });
        emit(task.spaceId, { type: 'entity.upsert', entity: clone(request) }, input);

        return {
          taskId: task.id,
          dispatcherSessionId: dispatcher.id,
          dispatcherSpawned: existing === undefined,
          requestMessageId: request.id,
          delivery: 'delivered',
        };
      },
      async prompt(id, _input: ExecutionPromptInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'work_session') throw new CollabError('invariant_violation', `${id} is not a work_session`);
        if (s.state.status !== 'running') {
          throw new CollabError('invariant_violation', `session ${id} is not running`);
        }
        // PTY delivery, not graph state — only activity moves.
        s.activityAt = tick();
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, _input);
        return clone({ patches: [s] });
      },
      async terminate(id, input: ExecutionTerminateInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'work_session') throw new CollabError('invariant_violation', `${id} is not a work_session`);
        s.state.status = 'exited';
        s.state.exitedAt = tick();
        touch(s);
        const snap = livenessBySpace.get(s.spaceId);
        if (snap?.liveEntityIds.includes(id)) {
          setLiveness(s.spaceId, snap.liveEntityIds.filter((x) => x !== id), snap.nodeBootId);
        }
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      /**
       * The inverse of terminate, and it refuses on the same terms: only a
       * TERMINAL session can be resumed. The server refuses a live one with
       * `conflict`, so the fixture must too — a fixture that cheerfully
       * resumed a running session would let the UI ship a button the real
       * seam rejects.
       */
      async resume(id, input: ExecutionResumeInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'work_session') throw new CollabError('invariant_violation', `${id} is not a work_session`);
        if (s.state.status !== 'exited' && s.state.status !== 'failed') {
          throw new CollabError('invariant_violation', `session ${id} is not resumable from ${s.state.status}`);
        }
        s.state.status = 'running';
        s.state.exitedAt = null;
        touch(s);
        const snap = livenessBySpace.get(s.spaceId);
        const live = snap?.liveEntityIds ?? [];
        if (!live.includes(id)) {
          setLiveness(s.spaceId, [...live, id], snap?.nodeBootId ?? FIXTURE_NODE_BOOT_ID);
        }
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      /**
       * The git rail verbs, mirroring the real ones' refusal shapes (a
       * fixture that cheerfully rolled back over untracked files would let
       * the UI ship a flow the real seam refuses). State moves on the SAME
       * lane the reads answer from, so FLOW A composes end-to-end.
       */
      async gitCheckpoint(id, input: ExecutionGitCheckpointInput): Promise<SessionGitCheckpointResult> {
        requireGitLane(id);
        void input;
        if (gitLane.dirty.length === 0) {
          return clone({
            sessionId: id, worktreeId: 'fx-worktree-1' as EntityId,
            oid: gitHead(), branch: gitLane.branch, created: false, files: [],
          });
        }
        const files = [...gitLane.dirty];
        gitLane.serial += 1;
        gitLane.history.push(fxOid(gitLane.serial));
        gitLane.dirty = [];
        return clone({
          sessionId: id, worktreeId: 'fx-worktree-1' as EntityId,
          oid: gitHead(), branch: gitLane.branch, created: true, files,
        });
      },
      async gitRollback(id, input: ExecutionGitRollbackInput): Promise<SessionGitRollbackResult> {
        requireGitLane(id);
        const isBase = input.to === gitLane.baseOid;
        if (!isBase && !gitLane.history.includes(input.to)) {
          throw new CollabError('not_found', `not a commit in this worktree: ${input.to}`);
        }
        const untracked = gitLane.dirty.filter((f) => f.status === '??').map((f) => f.path);
        if (untracked.length > 0 && input.force !== true) {
          throw new CollabError('conflict', 'rollback would delete untracked files', {
            details: { untracked, hint: 'pass force to delete them' },
          });
        }
        const previousOid = gitHead();
        if (isBase) {
          // Rolling to base keeps the branch-off commit as the floor — the
          // real reset lands ON the given oid; the fixture's floor is close
          // enough only if it lands there too:
          gitLane.history = [gitLane.baseOid];
        } else {
          gitLane.history = gitLane.history.slice(0, gitLane.history.indexOf(input.to) + 1);
        }
        gitLane.dirty = [];
        return clone({
          sessionId: id, worktreeId: 'fx-worktree-1' as EntityId,
          oid: gitHead(), branch: gitLane.branch, previousOid, deletedUntracked: untracked,
        });
      },
      async gitCommit(id, input: ExecutionGitCommitInput): Promise<SessionGitCommitResult> {
        requireGitLane(id);
        const staging = input.all === true
          ? [...gitLane.dirty]
          : gitLane.dirty.filter((f) => input.paths?.includes(f.path));
        if (staging.length === 0) {
          throw new CollabError('conflict', 'nothing is staged', {
            details: { hint: 'stage changes first' },
          });
        }
        gitLane.serial += 1;
        gitLane.history.push(fxOid(gitLane.serial));
        gitLane.dirty = gitLane.dirty.filter((f) => !staging.includes(f));
        return clone({
          sessionId: id, worktreeId: 'fx-worktree-1' as EntityId,
          oid: gitHead(), branch: gitLane.branch, files: staging,
        });
      },
      async gitMerge(id, input: ExecutionGitMergeInput): Promise<SessionGitMergeResult> {
        requireGitLane(id);
        const fromRef = input.fromRef ?? gitLane.baseRef;
        // The scripted conflict trigger — same idea as setConnection: the
        // conflict UI is only provable if some deterministic input causes one.
        if (fromRef === 'conflict/base') {
          return clone({
            sessionId: id, worktreeId: 'fx-worktree-1' as EntityId,
            status: 'conflict' as const, fromRef, fromOid: fxOid(0xcc),
            conflictedPaths: ['packages/server/src/facade/handlers/projects.ts'],
          });
        }
        if (gitLane.dirty.length > 0) {
          throw new CollabError('conflict', 'merge refused: the worktree has uncommitted changes', {
            details: { hint: 'checkpoint or commit first, so a conflicted merge can abort to a clean state' },
          });
        }
        if (gitLane.behind === 0) {
          return clone({
            sessionId: id, worktreeId: 'fx-worktree-1' as EntityId,
            status: 'up_to_date' as const, fromRef, fromOid: fxOid(0xcd), oid: gitHead(),
          });
        }
        gitLane.serial += 1;
        gitLane.history.push(fxOid(gitLane.serial));
        gitLane.behind = 0;
        return clone({
          sessionId: id, worktreeId: 'fx-worktree-1' as EntityId,
          status: 'merged' as const, fromRef, fromOid: fxOid(0xcd), oid: gitHead(),
        });
      },
      /**
       * Tier 2 completion verbs. Each HONOURS its arguments rather than
       * echoing them, and mirrors the real refusal shapes: the scripted
       * conflict triggers ('conflict/pick' commitish, a stash whose subject
       * contains 'conflict') exist so the conflict UI is provable, the same
       * idea as gitMerge's 'conflict/base'.
       */
      async gitCherryPick(id, input: ExecutionGitCherryPickInput): Promise<SessionGitCherryPickResult> {
        requireGitLane(id);
        if (input.commits.length === 0) {
          throw new CollabError('invalid_input', 'cherry-pick needs at least one commit');
        }
        if (gitLane.dirty.length > 0) {
          throw new CollabError('conflict', 'cherry-pick refused: the worktree has uncommitted changes', {
            details: { hint: 'checkpoint or commit first, so a conflicted pick can abort to a clean state' },
          });
        }
        if (input.commits.includes('conflict/pick')) {
          return clone({
            sessionId: id, worktreeId: 'fx-worktree-1' as EntityId,
            status: 'conflict' as const, branch: gitLane.branch,
            fromOids: input.commits.map((_, i) => fxOid(0xd0 + i)),
            conflictedPaths: ['packages/server/src/facade/handlers/projects.ts'],
          });
        }
        const newOids: string[] = [];
        for (const _ of input.commits) {
          gitLane.serial += 1;
          const oid = fxOid(gitLane.serial);
          gitLane.history.push(oid);
          newOids.push(oid);
        }
        return clone({
          sessionId: id, worktreeId: 'fx-worktree-1' as EntityId,
          status: 'picked' as const, branch: gitLane.branch,
          fromOids: input.commits.map((_, i) => fxOid(0xd0 + i)), newOids,
        });
      },
      async gitBranch(id, input: ExecutionGitBranchInput): Promise<SessionGitBranchResult> {
        requireGitLane(id);
        const wtId = 'fx-worktree-1' as EntityId;
        const refuseTouching = (name: string, verb: string): void => {
          if (name === gitLane.branch) {
            throw new CollabError('conflict', `${verb} refused: branch ${JSON.stringify(name)} is checked out in a worktree`, {
              details: { reason: 'branch_checked_out' },
            });
          }
          if (name === gitLane.baseRef) {
            throw new CollabError('conflict', `${verb} refused: ${JSON.stringify(name)} is a protected branch (project default/base)`, {
              details: { reason: 'branch_protected' },
            });
          }
        };
        if (input.action === 'create') {
          if (gitLane.branches.includes(input.name) || input.name === gitLane.branch) {
            throw new CollabError('conflict', `branch already exists: ${JSON.stringify(input.name)}`);
          }
          gitLane.branches.push(input.name);
          return clone({ sessionId: id, worktreeId: wtId, action: 'create' as const, name: input.name, oid: gitHead() });
        }
        if (input.action === 'rename') {
          refuseTouching(input.from, 'rename');
          if (!gitLane.branches.includes(input.from)) {
            throw new CollabError('not_found', `no such branch: ${JSON.stringify(input.from)}`);
          }
          gitLane.branches = gitLane.branches.map((b) => (b === input.from ? input.to : b));
          return clone({ sessionId: id, worktreeId: wtId, action: 'rename' as const, from: input.from, to: input.to, oid: gitHead() });
        }
        refuseTouching(input.name, 'delete');
        if (!gitLane.branches.includes(input.name)) {
          throw new CollabError('not_found', `no such branch: ${JSON.stringify(input.name)}`);
        }
        // Any 'unmerged/…' name models an unmerged branch — the force gate.
        const unmerged = input.name.startsWith('unmerged/');
        if (unmerged && input.force !== true) {
          throw new CollabError('conflict',
            `branch ${JSON.stringify(input.name)} is not merged into ${JSON.stringify(gitLane.branch)} (the worktree's HEAD branch); refuse without force`, {
              details: { reason: 'branch_unmerged', measuredAgainst: gitLane.branch },
            });
        }
        gitLane.branches = gitLane.branches.filter((b) => b !== input.name);
        return clone({
          sessionId: id, worktreeId: wtId, action: 'delete' as const,
          name: input.name, deletedOid: fxOid(0xde), measuredAgainst: gitLane.branch, forced: unmerged,
        });
      },
      async gitStash(id, input: ExecutionGitStashInput): Promise<SessionGitStashResult> {
        requireGitLane(id);
        const wtId = 'fx-worktree-1' as EntityId;
        if (input.action === 'push') {
          if (gitLane.dirty.length === 0) {
            return clone({ sessionId: id, worktreeId: wtId, action: 'push' as const, status: 'clean' as const, branch: gitLane.branch });
          }
          const files = [...gitLane.dirty];
          gitLane.serial += 1;
          const oid = fxOid(gitLane.serial);
          gitLane.stashes.unshift({
            index: 0, oid, date: FIXTURE_NOW,
            subject: `On ${gitLane.branch}: ${input.message ?? 'WIP'}`,
          });
          gitLane.dirty = [];
          // The stashed files ride in the subject-keyed side map so pop can
          // honour them without a parallel git object store.
          stashedFiles.set(oid, files);
          return clone({ sessionId: id, worktreeId: wtId, action: 'push' as const, status: 'stashed' as const, oid, branch: gitLane.branch, files });
        }
        const index = input.action === 'pop' ? (input.index ?? 0) : input.index;
        const entry = gitLane.stashes[index];
        if (entry === undefined) {
          throw new CollabError('not_found', `no stash entry at index ${index}`);
        }
        if (input.action === 'pop') {
          if (gitLane.dirty.length > 0) {
            throw new CollabError('conflict', 'stash pop refused: the worktree has uncommitted changes', {
              details: { hint: 'checkpoint, commit, or stash first, so a conflicted pop can abort to a clean state' },
            });
          }
          if (entry.subject.includes('conflict')) {
            // Scripted conflict: aborted + verified server-side, entry RETAINED.
            return clone({
              sessionId: id, worktreeId: wtId, action: 'pop' as const, status: 'conflict' as const,
              oid: entry.oid, branch: gitLane.branch,
              conflictedPaths: ['packages/server/src/facade/handlers/projects.ts'],
            });
          }
          gitLane.stashes.splice(index, 1);
          const files = stashedFiles.get(entry.oid) ?? [];
          stashedFiles.delete(entry.oid);
          gitLane.dirty = [...gitLane.dirty, ...files];
          return clone({ sessionId: id, worktreeId: wtId, action: 'pop' as const, status: 'popped' as const, oid: entry.oid, branch: gitLane.branch, files });
        }
        if (input.force !== true) {
          throw new CollabError('conflict', `stash drop destroys stash@{${index}} (${entry.subject}); refuse without force`, {
            details: { reason: 'stash_drop_needs_force', oid: entry.oid },
          });
        }
        gitLane.stashes.splice(index, 1);
        stashedFiles.delete(entry.oid);
        return clone({ sessionId: id, worktreeId: wtId, action: 'drop' as const, droppedOid: entry.oid, subject: entry.subject });
      },

      /**
       * `tracking.pr.merge` (Amendment 11). Every branch below is a REAL
       * `CollabError` carrying the same code and the same `details.reason` the
       * server throws (`facade/services/w2/tracking-write.ts:81-135`), because
       * the refusal vocabulary IS the contract a caller renders — a fixture
       * that answered a plain string here would let a screen pass in jsdom and
       * render nothing against a node.
       *
       * Which branch fires is chosen by `fixtureControls.setPrMergeGuard`
       * rather than derived from PR facts: the fixture holds no
       * `mergeable_state` / `ci_status` to derive from, and inventing them
       * would be a second, divergent model of a row only the server owns.
       * `not_implemented` is in the list on purpose — it is the state this
       * control actually ships into until the node restarts, not an error path.
       */
      async mergePullRequest(id, input: TrackingPrMergeInput): Promise<TrackingPrMergeResult> {
        const repo = 'tm8/tm8';
        const number = 42;
        const label = `PR ${repo}#${String(number)}`;
        switch (prMergeGuard) {
          case 'available':
            break;
          case 'not_implemented':
            throw new CollabError('not_implemented', 'tracking.pr.merge is not implemented on this node');
          case 'not_found':
            throw new CollabError('not_found', `no pull_request entity ${id}`);
          case 'not_open':
            throw new CollabError('invariant_violation', `${label} is closed, not open`, {
              details: { reason: 'not_open', state: 'closed' },
            });
          case 'conflicted':
            throw new CollabError('invariant_violation', `${label} has conflicts (observed mergeable_state=dirty)`, {
              details: { reason: 'conflicted' },
            });
          case 'ci_red':
            throw new CollabError('invariant_violation', `${label} has failing checks (observed ci_status=failing)`, {
              details: { reason: 'ci_red' },
            });
          case 'no_github_credential':
            throw new CollabError('forbidden', 'no GitHub credential stored for this account — connect one under Settings → Agent credentials', {
              details: { reason: 'no_github_credential' },
            });
          case 'forge_blocked':
            throw new CollabError('invariant_violation', 'the forge refused the merge: required review is missing', {
              details: { reason: 'forge_blocked' },
            });
          case 'head_moved':
            throw new CollabError('conflict', 'the branch moved after review: head is no longer the reviewed sha', {
              details: { reason: 'head_moved' },
            });
          // The vocabulary's TAIL: these three carry NO `details.reason`, which
          // is exactly why they are here — a renderer that keys off `reason`
          // alone shows an empty refusal for all of them.
          case 'unauthorized':
            throw new CollabError('forbidden', 'GitHub refused this credential: token lacks repo scope');
          case 'rate_limited':
            throw new CollabError('rate_limited', 'GitHub secondary rate limit — retry shortly');
          case 'upstream_unavailable':
            throw new CollabError('upstream_unavailable', 'GitHub is unreachable');
        }
        return clone({
          entityId: id,
          repo,
          number,
          merged: true as const,
          // Pinned-head honesty: the fixture's merge sha is derived from what
          // the caller pinned, so a test can prove the panel sent the sha the
          // human was SHOWN rather than an unpinned merge.
          mergeSha: `${(input.headSha ?? fxOid(0xc3)).slice(0, 8)}${fxOid(0xd4).slice(8)}`,
        });
      },
    },

    /**
     * CREDENTIALS — the fixture's answer models the HONEST-DEGRADATION
     * contract, not a happy path, because those states are the ones a careless
     * screen collapses:
     *
     *  - `gitCredentialStore: 'absent'` — 079 ships on the deployed staging
     *    line and is reachable from no local git object, so the github entry's
     *    `connected` is UNKNOWN here, not measured false. A fixture reporting
     *    'present' would let a screen that renders "Not connected" look right.
     *  - anthropic is connected with `login: null` — the shape of a row minted
     *    under the original R4 verb (`claude setup-token`, no `user:profile`).
     *    Post-amendment logins carry an email, but the null-login shape stays
     *    legal and a screen must keep rendering it without "Connected as null".
     *  - openai is genuinely not connected: the one true negative, so a screen
     *    that draws all three the same way has something to be wrong about.
     */
    credentials: {
      async status() {
        return clone(credentialsState);
      },

      async disconnect(provider) {
        const entry = credentialsState.providers.find((p) => p.provider === provider);
        if (entry) {
          entry.connected = false;
          entry.login = null;
          entry.authMethod = null;
          entry.status = 'revoked';
          entry.connectedAt = null;
          entry.lastVerifiedAt = null;
        }
        // A PARTIAL disconnect is the fixture's default for anthropic, because
        // it is the NORMAL outcome (R3) and the one a screen is most likely to
        // render as either a clean tick or a red error. `revoked: true` stands
        // alongside a non-empty `failures` and neither cancels the other.
        return {
          provider,
          revoked: true,
          terminatedCredentialSessionIds: [],
          terminatedAgentSessionIds: provider === 'anthropic' ? [sessionLive.id] : [],
          failures:
            provider === 'anthropic'
              ? [{ step: 'agentSession' as const, sessionId: sessionStale.id, reason: 'session did not acknowledge terminate' }]
              : [],
        };
      },

      async startLogin(spaceId, provider) {
        return {
          workSessionId: sessionCredentialLogin.id,
          spaceId,
          provider,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          command: `${provider} login`,
        };
      },

      async finishLogin(workSessionId) {
        return {
          workSessionId,
          provider: 'github' as const,
          // The correct-and-expected split (R5): a verified GitHub login has
          // nowhere to be written on a line without 079, so `connected: true`
          // with `stored: false` is a right answer, not a failure.
          connected: true,
          login: 'ada',
          authMethod: 'oauth',
          status: 'active' as const,
          stored: false,
          terminated: true,
        };
      },
    },

    liveness: {
      async refresh(spaceId) {
        let snap = livenessBySpace.get(spaceId);
        if (!snap) {
          snap = { spaceId, liveEntityIds: [], nodeBootId: FIXTURE_NODE_BOOT_ID, checkedAt: tick() };
          livenessBySpace.set(spaceId, snap);
        }
        return clone(snap);
      },
      onChange(cb) {
        livenessSubs.add(cb);
        return () => livenessSubs.delete(cb);
      },
      /**
       * THE R-UI-5 predicate — the only place liveness truth is computed:
       *   status !== 'running'  → 'not-running'
       *   no snapshot for the space → 'unknown' (rendered neutral, NEVER live)
       *   id ∈ liveEntityIds        → 'live'
       *   otherwise                 → 'stale'
       * NOTE (flagged to bridge, not fixed here — seam.ts is locked): the seam
       * types `status` with the task `WorkStatus` vocabulary, which cannot
       * express the work_session `'running'` literal; the comparison widens.
       */
      statusOf(session): SessionLiveness {
        if ((session.status as string | null) !== 'running') return 'not-running';
        const s = summaries.get(session.id);
        const snap = s ? livenessBySpace.get(s.spaceId) : undefined;
        if (!snap) return 'unknown';
        return snap.liveEntityIds.includes(session.id) ? 'live' : 'stale';
      },
    },

    fixtureControls: {
      setConnection(state) {
        connection = clone(state);
        for (const cb of connectionSubs) cb(clone(state));
      },
      setLiveness,
      triggerResync(spaceId) {
        for (const cb of resyncSubs) cb(spaceId);
      },
      setPrMergeGuard(guard) {
        prMergeGuard = guard;
      },
    },
  };

  function setLiveness(spaceId: SpaceId, liveEntityIds: string[], nodeBootId?: string): void {
    const snap: LivenessSnapshot = {
      spaceId,
      liveEntityIds: [...liveEntityIds],
      nodeBootId: nodeBootId ?? livenessBySpace.get(spaceId)?.nodeBootId ?? FIXTURE_NODE_BOOT_ID,
      checkedAt: tick(),
      capacity: {
        used: liveEntityIds.length,
        total: livenessBySpace.get(spaceId)?.capacity?.total ?? 8,
      },
    };
    livenessBySpace.set(spaceId, snap);
    for (const cb of livenessSubs) cb(clone(snap));
  }

  return seam;
}
