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
  bindPath,
  CollabError,
  FILE_MAX_SIZE_BYTES_DEFAULT,
  WORKSPACE_EVENT_SCHEMA_VERSION,
  type ActivityItem,
  type ActorSummary,
  type AttentionRequest,
  type AttentionRequestPage,
  type CollectionQuery,
  type CollectionResult,
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
  type ExecutionSpawnInput,
  type ExecutionResumeInput,
  type ExecutionTerminateInput,
  type FeedItem,
  type FileUploadGrant,
  type FileUploadInitInput,
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
  type ProjectResource,
  type ReactionInput,
  type SessionJournalPage,
  type SessionLaunchRecord,
  type SessionJournalRecord,
  type SessionTranscriptPage,
  type SpaceId,
  type SpaceKindCounts,
  type SpaceSettingsView,
  type SpaceSummary,
  type WorkInput,
  type WorkStatus,
} from '@tm8/contract';
import type {
  ConnectionState,
  FeedOpts,
  FixtureSeam,
  IdentityView,
  LivenessSnapshot,
  PageOpts,
  SessionLiveness,
  Unsubscribe,
} from '../seam';
import {
  FIXTURE_NOW,
  FIXTURE_SPACE_ID,
  ada,
  fixtureDetails,
  fixtureHandoffsBySession,
  fixtureSummaries,
  sessionLive,
} from '../../fixtures';

export const FIXTURE_NODE_BOOT_ID = 'boot-fixture-1';

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
          workStatus: 'in_progress',
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
    default:
      // pull_request | commit | file | spell | skill — the open content variant
      return { kind: state.kind };
  }
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

export function createFixtureSeam(): FixtureSeam {
  // -- in-memory state (isolated clone of the FE dataset) --------------------
  const summaries = new Map<EntityId, EntitySummary>(
    clone(fixtureSummaries).map((s) => [s.id, s]),
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
    const replyCount = [...summaries.values()]
      .filter((m) => m.state.kind === 'message' && m.state.rootMessageId === s.id).length;
    return { ...s, state: s.state, content, replyCount };
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
  }

  function pageOf<T>(all: T[], opts?: PageOpts): Page<T> {
    const start = opts?.cursor ? Math.max(0, Number.parseInt(opts.cursor, 10) || 0) : 0;
    const limit = opts?.limit ?? 50;
    const end = Math.min(all.length, start + limit);
    return { items: all.slice(start, end), nextCursor: end < all.length ? String(end) : null, total: all.length };
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
  function projectAssignees(s: EntitySummary): void {
    if (s.state.kind !== 'task') return;
    const group = extrasOf(s.id).connections.outgoing.find((g) => g.type === 'assigned_to');
    s.state.assignees = (group?.edges ?? []).flatMap((edge) => {
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

  function defaultStateFor(input: CreateEntityInput): EntityState {
    const c = (input.content ?? {}) as Record<string, unknown>;
    const kind = input.kind;
    if (kind.startsWith('c:')) {
      return { kind: kind as `c:${string}`, fields: (c.fields as CustomEntityState['fields']) ?? {} };
    }
    switch (kind) {
      case 'task':
        return {
          kind: 'task', workStatus: 'open', priority: 'medium', axes: {},
          dueDate: null, assignees: [], acceptance: { total: 0, completed: 0 },
        };
      case 'channel':
        return { kind: 'channel', topic: (c.topic as string) ?? '', unreadCount: 0, workingAgentCount: 0 };
      // A freshly created voice room is EMPTY. `participantCount` is the whole
      // state arm — there is no topic and no unread axis to seed. Nothing here
      // reads the create input, because the content arm carries no field.
      case 'voice_channel':
        return { kind: 'voice_channel', participantCount: 0 };
      case 'doc':
        return { kind: 'doc', format: (c.format as 'markdown') ?? 'markdown', childCount: 0 };
      case 'team_member':
        return { kind: 'team_member', owner: viewerActor, model: null, agentTool: null, liveWork: null };
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
        return {
          kind: 'commit', repository: (c.repository as string) ?? '',
          sha: (c.sha as string) ?? '', message: input.title, committedAt: null,
        };
      case 'collection':
        return { kind: 'collection', collectionType: (c.collectionType as string) ?? 'manual', itemCount: 0 };
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
        members: [{ actor: viewerActor, role: 'owner', joinedAt: FIXTURE_NOW }],
        invites: [],
        taskAxes: [],
        menu: {
          schemaVersion: 1,
          revision: 1,
          groups: [{ id: 'fixture', label: 'Fixture', items: [{ type: 'view', ref: 'settings' }] }],
        },
        defaultChannelId: null,
        defaultInteractionProfileId: 'ip-house-style',
        settingsRevision: 1,
      });
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
        const f = input.filters;
        if (f?.workStatus && !(s.state.kind === 'task' && f.workStatus.includes(s.state.workStatus))) return false;
        if (f?.sessionStatus && !(s.state.kind === 'work_session'
          && f.sessionStatus.includes(s.state.status))) return false;
        if (f?.assigneeIds && !(s.state.kind === 'task'
          && s.state.assignees.some((a) => f.assigneeIds!.includes(a.id)))) return false;
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
      return clone({ query: input, page: pageOf(rows, input) });
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
        edges,
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
      const edges = [...c.outgoing, ...c.incoming].flatMap((g) => g.edges);
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
    async messages(anchorId, opts): Promise<Page<MessageView>> {
      requireSummary(anchorId);
      const rows = [...summaries.values()]
        .filter((s) => s.state.kind === 'message' && s.state.anchorId === anchorId && s.deletedAt === null)
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
      if (workSessionId !== sessionLive.id) {
        return clone({
          sessionId: workSessionId,
          available: false,
          unavailableReason: 'no_transcript_file',
          agentTool: null,
          entries: [],
          stats: null,
          stuck: null,
          lastActivityAt: null,
          malformed: 0,
        });
      }
      // Oldest-first, as the contract requires of a tail, and short enough that
      // the default window (20) never trims it — a fixture that silently paged
      // would hide the renderer's ordering bug rather than expose it.
      const entries = [
        {
          at: '2026-01-04T09:15:02.000Z',
          source: 'user' as const,
          text: 'Take the failing spawn test and find why the PTY never emits.',
          truncated: false,
        },
        {
          at: '2026-01-04T09:15:44.000Z',
          source: 'assistant' as const,
          text: 'Reading the spawn service and its test harness to see which side owns the timeout.',
          truncated: false,
        },
        {
          at: '2026-01-04T09:18:10.000Z',
          source: 'assistant' as const,
          text: 'The harness asserts on a ring that is only filled after the first flush, so the read races the write.',
          truncated: false,
        },
      ];
      const last = opts?.last ?? 20;
      return clone({
        sessionId: workSessionId,
        available: true,
        unavailableReason: null,
        agentTool: 'claude-code',
        entries: entries.slice(-last),
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
        lastActivityAt: '2026-01-04T09:18:10.000Z',
        malformed: 0,
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
      const items: FeedItem[] = [...summaries.values()]
        .filter((s) => s.state.kind === 'message' && s.state.anchorId === id && s.deletedAt === null)
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
        predicates: ['anchored' as const],
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
        const s = insertSummary({
          id: nextId(input.kind),
          kind: input.kind,
          title: input.title,
          spaceId: input.spaceId,
          parentId: input.parentId ?? null,
          ...(input.position !== undefined ? { position: input.position } : {}),
          state: defaultStateFor(input),
        });
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
            kind: 'task', workStatus: 'open', priority: input.priority ?? 'medium',
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
      async patchTask(id, input: PatchTaskInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'task') throw new CollabError('invariant_violation', `${id} is not a task`);
        requireVersion(s, input.expectedVersion);
        if (input.title !== undefined) s.title = input.title;
        if (input.workStatus !== undefined) s.state.workStatus = input.workStatus;
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
      async complete(id, input: CompleteTaskInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'task') throw new CollabError('invariant_violation', `${id} is not a task`);
        requireVersion(s, input.expectedVersion);
        s.state.workStatus = 'done';
        s.state.acceptance = { ...s.state.acceptance, completed: s.state.acceptance.total };
        touch(s);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      async work(id, input: WorkInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'task') throw new CollabError('invariant_violation', `${id} is not a task`);
        s.state.workStatus = input.status;
        touch(s);
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
      async deleteEdge(edgeId, ctx) {
        for (const [ownerId, e] of extras) {
          for (const group of e.connections.outgoing) {
            const at = group.edges.findIndex((edge) => edge.id === edgeId);
            if (at < 0) continue;
            group.edges.splice(at, 1);
            const src = requireSummary(ownerId);
            projectAssignees(src);
            touch(src);
            emit(src.spaceId, { type: 'entity.upsert', entity: clone(src) }, ctx);
            return commandResult(src);
          }
        }
        throw new CollabError('not_found', `edge ${edgeId} not found`);
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
      async previewArtifact(id: string) {
        requireSummary(id);
        // The fixture has no preview listener and no bundle bytes — a fake
        // URL here would render a broken iframe that reads as a product bug.
        throw new CollabError('not_implemented', 'fixture data cannot execute artifact previews');
      },
      async spawn(input: ExecutionSpawnInput) {
        requireSummary(input.teamMemberId);
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
       *   workStatus ∉ {running, idle} → 'not-running'
       *   no snapshot for the space → 'unknown' (rendered neutral, NEVER live)
       *   id ∈ liveEntityIds        → 'live'
       *   otherwise                 → 'stale'
       * 'idle' belongs on the live side — see the twin in data/real/liveness.ts
       * for why. This predicate is written in TWO files; they must agree.
       * NOTE (flagged to bridge, not fixed here — seam.ts is locked): the seam
       * types `workStatus` with the task `WorkStatus` vocabulary, which cannot
       * express the work_session `'running'` literal; the comparison widens.
       */
      statusOf(session): SessionLiveness {
        const recorded = session.workStatus as string | null;
        if (recorded !== 'running' && recorded !== 'idle') return 'not-running';
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
