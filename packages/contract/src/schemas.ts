/**
 * Zod schemas for every contract shape — the single validation source
 * (server input validation, CLI `--json`, conformance response assertions,
 * future MCP tool schemas all derive from here).
 *
 * Every schema is compile-bound to its type in ./contract.ts via
 * `z.ZodType<T>` annotations, so a schema that drifts from the declared DTO
 * fails `tsc`. DTO schemas are `.strict()` — an unexpected field in a server
 * response is contract drift, not garnish. Command-input schemas are also
 * `.strict()`: an unknown field is a typo, not a no-op (foundation validation
 * conventions, DEF-1/2/3).
 */
import { z } from 'zod';
import { isOperationName } from './catalog.js';
import type { OperationName } from './catalog.js';
import { MAX_CONTROL_FRAME_SPACES, SHA256_HEX_RE } from './contract.js';
import { ArtifactManifestSchema } from './artifact-manifest.js';
import type {
  ArtifactsCreateInput, ArtifactsPreviewStartInput,
  ArtifactsPublishInput, ArtifactsRestoreInput,
} from './artifact-manifest.js';
import type {
  AcceptanceCriterion, ActionDiscoveryResult, ActivateInteractionProfileInput,
  AmendmentErrorReason,
  ActivityItem, ActorSummary, AddMessageAttachmentsInput,
  AuthAccountView, AuthLoginInput, AuthLoginResult, AuthLogoutInput,
  AuthLogoutResult, AuthSessionGetResult, AuthSessionView, AuthSignupInput,
  AuthSignupResult, ChannelTab,
  ClosedPromptPolicy, CollectionGroup, CollectionQuery, CollectionResult,
  CommandContext, CommandErrorCode, CommandResult, CompleteTaskInput,
  ComposerInteractionPolicy, Connections, CorrectProjectAssociationInput,
  CreateEdgeInput, CreateEntityInput, CreateSpaceInput, CreateTaskInput, CreateVoiceTokenInput,
  CredentialConnectionView, CredentialProviderName, CredentialsDeleteInput,
  CredentialsDeleteResult, CredentialsLoginSessionFinishInput,
  CredentialsLoginSessionFinishResult, CredentialsLoginSessionStartInput,
  CredentialsLoginSessionStartResult, CredentialsStatusView,
  CustomEntityKind, CustomFieldDef, CustomFieldValue, DeleteMessageInput,
  DeliverySummary, EdgeCorrectionResult, EdgeGroup, EdgeView,
  EntityBadges, EntityCapabilities, EntityConnectionsQuery, EntityContent,
  EntityContextQuery, EntityContextView, EntityCounters, EntityDetail,
  EntityFeedPage, EntityFeedQuery, EntityKind, EntityKindCreateInput,
  EntityKindDef, EntityKindUpdateInput, EntityStaleness, EntityState, EntitySummary, ErrorCode,
  ErrorDetails, ExecutionDispatchInput, ExecutionDispatchResult,
  ExecutionPromptInput, ExecutionResumeInput, ExecutionSpawnInput,
  ExecutionStreamsAttachInput, ExecutionTerminateInput, FeedItem, FeedPolicy,
  FileAttachment, FileUploadCompleteInput, FileUploadGrant, FileUploadInitInput,
  GateTaskInput,
  GraphQuery, GraphResult, GrantPointsInput, HandoffListQuery, HandoffView,
  Hierarchy, HomeSnapshot, IdentityProfileUpdateInput, IdentityProfileView,
  InboxListQuery, InboxMarkReadInput, InboxRecipient,
  InteractionProfileDraft, InteractionProfilePinView, InteractionProfilePreview,
  InteractionProfileView, LeaderboardRow, LinkCommitInput, LinkPrInput,
  LiveWork, MenuConfig, MenuConfigPayload, MenuGroup, MenuItem, MenuLeaf,
  Mention, MessageBatchResult, MessageDeliveryQuery, MessageDeliveryRecord,
  MessageDeliveryView, MessageView, MoveEntityInput, NavChannelNode,
  NotificationItem, Page, PaletteAction, PatchEdgeInput, PatchEntityInput,
  PatchMessageInput, PatchTaskInput, PlacementInput, PointEventView,
  PostMessageInput, PostMessageWireInput, PresenceSnapshot,
  PreviewInteractionProfileInput, ProfileValidationIssue, ProfileValidationView,
  ProjectBranch, ProjectBranchTopology,
  ProjectCreateInput, ProjectDefaults, ProjectDirectoryEntry, ProjectDirectoryListing,
  ProjectFileAttachInput, ProjectFileEntry, ProjectFileListing, ProjectFileReadResult,
  ProjectLinkInput, ProjectResource,
  ProjectTrustLevel, ProjectUpdateInput, ProposeInteractionProfileInput,
  PullInput, PullState, ReactionInput, RemoveMessageAttachmentsInput,
  RetireInteractionProfileInput, SavedView, SavedViewInput, SendHandoffInput,
  ServerConnection, ServerConnectionCreateInput, ServerConnectionDeleteInput,
  SetDefaultChannelInput, SetSpaceProfileDefaultInput,
  AttentionRequest, AttentionRequestListQuery, AttentionRequestMutationResult,
  CreateAttentionRequestInput, UpdateAttentionRequestInput, ResolveEntityAttentionInput,
  KindCounts, SpaceKindCounts,
  SetTeammateProfileDefaultInput, ShareProjectionEnvelope, SpaceNavigation,
  SpaceProfileDefaultView, SpaceSettings, SpaceSettingsView, SpaceSummary,
  ExecutionLiveness, SessionJournalCall, SessionJournalPage, SessionJournalRecord,
  SessionLaunchRecord,
  SessionTranscriptEntry, SessionTranscriptPage, SessionTranscriptStats,
  SessionTranscriptStuck,
  SpawnWorkdir, StreamAttachGrant, TaskAxis, TaskAxisInput,
  TeammateProfileDefaultView, ToolDiscoveryPolicy, TrackingRefreshInput,
  UndoToken, UpdateInteractionProfileDraftInput, UpdateMenuInput,
  UpdateSpaceInput, ValidateInteractionProfileInput, VoiceParticipant, VoiceTokenGrant, WithdrawHandoffInput,
  WorkInput, WorkSessionKind, WorkSessionShareMode, WorkSessionStatus, WorktreeStatus, WorkspaceControlAck, WorkspaceControlFrame,
  WorkspaceEvent,
} from './contract.js';
import type { WireErrorBody } from './envelope.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export const IsoTimestamp = z.string().regex(ISO_TIMESTAMP_RE, 'must be an ISO-8601 UTC timestamp');
export const EntityIdSchema = z.string().min(1);
export const SpaceIdSchema = z.string().min(1);
export const CursorSchema = z.string().min(1);

function uniqueArray<T extends z.ZodTypeAny>(item: T, minimum = 0, maximum?: number) {
  let schema = z.array(item).min(minimum);
  if (maximum !== undefined) schema = schema.max(maximum);
  return schema.refine((values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length,
    'items must be unique');
}

export const CoreEntityKindSchema = z.enum([
  'channel', 'task', 'message', 'member', 'team_member',
  'doc', 'file', 'spell', 'skill', 'pull_request', 'commit',
  'work_session', 'collection', 'project', 'interaction_profile',
  'voice_channel',
  'memory',
  'worktree',
  'artifact',
  'loop',
]);

export const CustomEntityKindSchema = z.custom<CustomEntityKind>(
  (v) => typeof v === 'string' && v.startsWith('c:') && v.length > 2,
  'custom kinds are namespaced "c:<name>"',
);

export const EntityKindSchema: z.ZodType<EntityKind> =
  z.union([CoreEntityKindSchema, CustomEntityKindSchema]);

export const WorkStatusSchema = z.enum(['open', 'pulled', 'working', 'in_review', 'done', 'blocked', 'cancelled']);
export const VisibilitySchema = z.enum(['space', 'restricted']);
export const PrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export const WorkSessionStatusSchema: z.ZodType<WorkSessionStatus> =
  z.enum(['spawning', 'running', 'idle', 'exited', 'failed']);
export const WorkSessionShareModeSchema: z.ZodType<WorkSessionShareMode> =
  z.enum(['none', 'space', 'explicit']);
/** Mirrors 083's `work_sessions.session_kind` CHECK exactly. */
export const WorkSessionKindSchema: z.ZodType<WorkSessionKind> =
  z.enum(['agent', 'credential']);
export const WorktreeStatusSchema: z.ZodType<WorktreeStatus> =
  z.enum(['active', 'merged', 'abandoned', 'deleted']);

// ---------------------------------------------------------------------------
// Actors, counters
// ---------------------------------------------------------------------------

export const ActorSummarySchema: z.ZodType<ActorSummary> = z.object({
  id: EntityIdSchema,
  kind: z.enum(['member', 'team_member', 'work_session']),
  displayName: z.string(),
  avatar: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  ownerMemberId: EntityIdSchema.optional(),
  isAgent: z.boolean(),
  via: z.object({ sessionId: EntityIdSchema }).strict().optional(),
}).strict();

export const EntityCountersSchema: z.ZodType<EntityCounters> = z.object({
  likes: z.number().int().nonnegative(),
  dislikes: z.number().int().nonnegative(),
  stars: z.number().int().nonnegative(),
  points: z.number().int(),
  messages: z.number().int().nonnegative(),
  viewerReaction: z.enum(['like', 'dislike', 'star']).nullable(),
}).strict();

// ---------------------------------------------------------------------------
// Recursive DTO cluster: EntitySummary / state / badges / detail / edges
// ---------------------------------------------------------------------------

export const CustomFieldValueSchema: z.ZodType<CustomFieldValue> =
  z.union([z.string(), z.number(), z.boolean(), z.null()]);

export function pageOf<T>(item: z.ZodType<T>): z.ZodType<Page<T>> {
  return z.object({
    items: z.array(item),
    nextCursor: CursorSchema.nullable(),
    total: z.number().int().nonnegative().optional(),
  }).strict();
}

export const EntityStateSchema: z.ZodType<EntityState> = z.lazy(() => z.union([
  z.object({
    kind: z.literal('task'),
    workStatus: WorkStatusSchema,
    priority: PrioritySchema,
    axes: z.record(z.string()),
    dueDate: z.string().nullable().optional(),
    assignees: z.array(ActorSummarySchema),
    acceptance: z.object({ total: z.number().int().nonnegative(), completed: z.number().int().nonnegative() }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('channel'),
    topic: z.string(),
    members: z.array(ActorSummarySchema),
    unreadCount: z.number().int().nonnegative(),
    workingAgentCount: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('doc'),
    format: z.enum(['markdown', 'mermaid', 'excalidraw']),
    childCount: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('message'),
    anchorId: EntityIdSchema,
    rootMessageId: EntityIdSchema.nullable(),
    author: ActorSummarySchema,
    messageBatchId: z.string().nullable(),
    editedAt: z.string().nullable().optional(),
    redactedAt: z.string().nullable().optional(),
  }).strict(),
  z.object({
    kind: z.literal('member'),
    role: z.enum(['owner', 'admin', 'member']),
    score: z.number(),
    taskDoneCount: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('team_member'),
    owner: ActorSummarySchema,
    model: z.string().nullable().optional(),
    agentTool: z.string().nullable().optional(),
    liveWork: LiveWorkSchema.nullable().optional(),
  }).strict(),
  z.object({
    kind: z.literal('pull_request'),
    repository: z.string(),
    number: z.number().int(),
    state: z.string(),
    url: z.string().optional(),
    fetchedAt: z.string().nullable().optional(),
    stale: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal('commit'),
    repository: z.string(),
    sha: z.string(),
    message: z.string(),
    committedAt: z.string().nullable().optional(),
  }).strict(),
  z.object({
    kind: z.literal('file'),
    name: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().nonnegative(),
  }).strict(),
  z.object({
    kind: z.enum(['spell', 'skill']),
    description: z.string().optional(),
    equipped: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal('work_session'),
    status: WorkSessionStatusSchema,
    agentTool: z.string().nullable(),
    model: z.string().nullable(),
    shareMode: WorkSessionShareModeSchema,
    startedAt: z.string().nullable(),
    exitedAt: z.string().nullable(),
    // OPTIONAL, not nullable: a pre-083 node omits it entirely, and callers
    // read that absence as `agent` so a frozen server keeps today's behaviour.
    // Clients filter with `!== 'credential'`; see the DTO note in contract.ts.
    sessionKind: WorkSessionKindSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('collection'),
    collectionType: z.string(),
    itemCount: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('project'),
    projectId: z.string().min(1),
    materializedVersion: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('interaction_profile'),
    status: z.enum(['draft', 'active', 'retired']),
    currentDraftVersion: z.number().int().positive(),
    activeVersion: z.number().int().positive().nullable(),
    activeHash: z.string().nullable(),
    retiredAt: IsoTimestamp.nullable(),
    initialContentSurface: z.enum(['terminal', 'chat']).optional(),
  }).strict(),
  z.object({
    kind: z.literal('voice_channel'),
    participantCount: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('memory'),
    mechanism: z.string(),
    subjectScope: z.string(),
    doesNotEstablish: z.string(),
    measuredAt: z.string().nullable(),
  }).strict(),
  z.object({
    kind: z.literal('worktree'),
    status: WorktreeStatusSchema,
    branch: z.string().min(1),
    baseRef: z.string().min(1),
    baseCommitOid: z.string().regex(/^[0-9a-f]{40}$/),
    projectId: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('loop'),
    schedule: z.string().min(1),
    enabled: z.boolean(),
    teamMemberId: z.string().min(1).nullable(),
    subjectId: z.string().min(1).nullable(),
    nextRunAt: z.string().nullable(),
    lastRunAt: z.string().nullable(),
    lastError: z.string().nullable(),
  }).strict(),
  z.object({
    kind: z.literal('artifact'),
    revisionNumber: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: CustomEntityKindSchema,
    fields: z.record(CustomFieldValueSchema),
  }).strict(),
]));

export const PullStateSchema: z.ZodType<PullState> = z.lazy(() => z.object({
  actor: ActorSummarySchema,
  localId: z.string().nullable().optional(),
  pinnedVersion: z.number().int(),
  contentStale: z.boolean(),
  discussionMoved: z.boolean(),
  workStatus: z.string().nullable().optional(),
  pulledAt: IsoTimestamp,
}).strict());

export const LiveWorkSchema: z.ZodType<LiveWork> = z.lazy(() => z.object({
  actor: ActorSummarySchema,
  task: EntitySummarySchema,
  startedAt: IsoTimestamp,
  note: z.string().nullable().optional(),
}).strict());

export const EntityBadgesSchema: z.ZodType<EntityBadges> = z.lazy(() => z.object({
  attention: z.object({
    pendingCount: z.number().int().positive(),
    totalPoints: z.number().int().positive(),
    maxPoints: z.number().int().min(1).max(100),
    latestReason: z.string().min(1).max(500),
    oldestRequestedAt: IsoTimestamp,
  }).strict().optional(),
  blocked: z.object({
    unresolvedHardDependencyCount: z.number().int().nonnegative(),
    waitingOn: z.array(EntitySummarySchema),
  }).strict().optional(),
  pulls: z.array(PullStateSchema).optional(),
  workingActors: z.array(LiveWorkSchema).optional(),
  completedBy: z.object({ actor: ActorSummarySchema, at: z.string() }).strict().optional(),
  restricted: z.boolean().optional(),
  staleness: EntityStalenessSchema.optional(),
}).strict());

/**
 * Derived at read time from mark edges and versions; never stored. ABSENT
 * MEANS UNFLAGGED — it does NOT mean verified or current. `reasons` is never
 * emitted empty: a memory with nothing to report carries no badge at all.
 */
export const EntityStalenessSchema: z.ZodType<EntityStaleness> = z.object({
  reasons: z.array(z.enum(['superseded', 'disputed', 'basisDeleted', 'basisMoved'])).min(1),
  superseded: z.object({
    byId: EntityIdSchema,
    headId: EntityIdSchema.nullable(),
    depthTruncated: z.boolean(),
  }).strict().optional(),
  disputed: z.object({
    openCount: z.number().int().positive(),
    latestAt: IsoTimestamp,
  }).strict().optional(),
  basisDeleted: z.object({ count: z.number().int().positive() }).strict().optional(),
  basisMoved: z.object({ count: z.number().int().positive() }).strict().optional(),
  verified: z.object({
    at: IsoTimestamp,
    atVersion: z.number().int().positive(),
    current: z.boolean(),
    independenceBasis: z.enum(['session', 'actor']),
  }).strict().optional(),
}).strict();

/** Raw field set of EntitySummary — reused by MessageView and EntityDetail. */
function entitySummaryShape() {
  return {
    id: EntityIdSchema,
    spaceId: SpaceIdSchema,
    kind: EntityKindSchema,
    title: z.string(),
    excerpt: z.string().optional(),
    parentId: EntityIdSchema.nullable(),
    position: z.number(),
    visibility: VisibilitySchema,
    version: z.number().int().positive(),
    activityAt: IsoTimestamp,
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
    deletedAt: IsoTimestamp.nullable(),
    createdBy: ActorSummarySchema,
    counters: EntityCountersSchema,
    state: EntityStateSchema,
    badges: EntityBadgesSchema,
  };
}

export const EntitySummarySchema: z.ZodType<EntitySummary> =
  z.lazy(() => z.object(entitySummaryShape()).strict());

export const EdgeViewSchema: z.ZodType<EdgeView> = z.lazy(() => z.object({
  id: z.string(),
  type: z.string(),
  source: EntitySummarySchema,
  target: EntitySummarySchema,
  props: z.record(z.unknown()),
  createdBy: ActorSummarySchema,
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  resolved: z.boolean().optional(),
  hard: z.boolean().optional(),
}).strict());

export const EntityConnectionsQuerySchema: z.ZodType<EntityConnectionsQuery> = z.object({
  types: uniqueArray(z.string().min(1)).optional(),
  direction: z.enum(['incoming', 'outgoing', 'both']).optional(),
  peerIds: uniqueArray(EntityIdSchema).optional(),
  peerKinds: uniqueArray(EntityKindSchema).optional(),
  createdByIds: uniqueArray(EntityIdSchema).optional(),
  createdAfter: IsoTimestamp.optional(),
  createdBefore: IsoTimestamp.optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'type']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  cursor: CursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export const EntityConnectionsPageSchema = pageOf(EdgeViewSchema);

export const EdgeGroupSchema: z.ZodType<EdgeGroup> = z.lazy(() => z.object({
  type: z.string(),
  direction: z.enum(['outgoing', 'incoming']),
  label: z.string(),
  edges: z.array(EdgeViewSchema),
  nextCursor: CursorSchema.optional(),
}).strict());

export const ConnectionsSchema: z.ZodType<Connections> = z.lazy(() => z.object({
  outgoing: z.array(EdgeGroupSchema),
  incoming: z.array(EdgeGroupSchema),
  unresolvedHardDependencyCount: z.number().int().nonnegative(),
}).strict());

export const AcceptanceCriterionSchema: z.ZodType<AcceptanceCriterion> = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
  doneBy: EntityIdSchema.optional(),
  doneAt: z.string().optional(),
}).strict();

export const MentionSchema: z.ZodType<Mention> = z.object({
  entityId: EntityIdSchema,
  kind: z.enum(['member', 'team_member']),
  display: z.string(),
}).strict();

export const FileAttachmentSchema: z.ZodType<FileAttachment> = z.object({
  fileEntityId: EntityIdSchema,
  name: z.string(),
  mime: z.string(),
}).strict();

export const EntityContentSchema: z.ZodType<EntityContent> = z.lazy(() => z.union([
  z.object({
    kind: z.literal('task'),
    description: z.string(),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema),
    pointsEstimate: z.number().nullable().optional(),
  }).strict(),
  z.object({
    kind: z.literal('channel'),
    topic: z.string(),
    pinned: z.array(EntitySummarySchema),
    autoTabs: z.array(ChannelTabSchema),
  }).strict(),
  z.object({
    kind: z.literal('doc'),
    body: z.string(),
    format: z.enum(['markdown', 'mermaid', 'excalidraw']),
  }).strict(),
  z.object({
    kind: z.literal('message'),
    body: z.string(),
    mentions: z.array(MentionSchema),
    attachments: z.array(FileAttachmentSchema),
  }).strict(),
  z.object({
    kind: z.literal('member'),
    teamMembers: z.array(EntitySummarySchema),
    work: z.array(EntitySummarySchema),
  }).strict(),
  z.object({
    kind: z.literal('team_member'),
    identity: z.string(),
    memories: z.array(z.unknown()),
    capabilities: z.record(z.unknown()),
    commandPermissions: z.record(z.unknown()),
    equipped: z.array(EntitySummarySchema),
    work: z.array(EntitySummarySchema),
  }).strict(),
  // Tracking mirrors + light kinds keep an open content bag (inherited shape).
  z.object({ kind: z.enum(['pull_request', 'commit', 'file', 'spell', 'skill']) }).passthrough(),
  z.object({
    kind: z.literal('work_session'),
    nodeId: z.string().nullable(),
    launchProjectId: z.string().nullable(),
    workingOn: z.array(EntitySummarySchema),
    transcriptDoc: EntitySummarySchema.nullable(),
    interactionProfile: z.lazy(() => WorkSessionInteractionProfileProjectionSchema).nullable().optional(),
  }).strict(),
  z.object({
    kind: z.literal('collection'),
    description: z.string(),
    items: z.array(EntitySummarySchema),
  }).strict(),
  z.object({
    kind: z.literal('project'),
    projectId: z.string().min(1),
    repoUrl: z.string().nullable().optional(),
    materializedVersion: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('interaction_profile'),
    status: z.enum(['draft', 'active', 'retired']),
    templateKey: z.string().min(1),
    templateVersion: z.number().int().positive(),
    resolvedHash: z.string().nullable(),
    generatedByTeamMemberId: EntityIdSchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal('voice_channel'),
  }).strict(),
  z.object({
    kind: z.literal('memory'),
    statement: z.string(),
    mechanism: z.string(),
    subjectScope: z.string(),
    doesNotEstablish: z.string(),
    measuredAt: z.string().nullable(),
  }).strict(),
  z.object({
    kind: z.literal('worktree'),
    projectId: z.string().min(1),
    path: z.string().min(1),
    branch: z.string().min(1),
    baseRef: z.string().min(1),
    baseCommitOid: z.string().regex(/^[0-9a-f]{40}$/),
    status: WorktreeStatusSchema,
    statusChangedAt: IsoTimestamp.nullable(),
  }).strict(),
  z.object({
    kind: z.literal('loop'),
    schedule: z.string().min(1),
    enabled: z.boolean(),
    teamMemberId: z.string().min(1).nullable(),
    subjectId: z.string().min(1).nullable(),
    prompt: z.string(),
    config: z.record(z.unknown()),
    nextRunAt: z.string().nullable(),
    lastRunAt: z.string().nullable(),
    lastError: z.string().nullable(),
  }).strict(),
  z.object({
    kind: z.literal('artifact'),
    description: z.string().nullable(),
    currentRevisionNumber: z.number().int().positive(),
    entrypoint: z.string().min(1),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    fileCount: z.number().int().positive(),
    totalSizeBytes: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: CustomEntityKindSchema,
    fields: z.record(CustomFieldValueSchema),
  }).strict(),
]) as z.ZodType<EntityContent>);

export const EntityCapabilitiesSchema: z.ZodType<EntityCapabilities> = z.object({
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  canAddChild: z.boolean(),
  canLink: z.boolean(),
  canPull: z.boolean(),
  canReact: z.boolean(),
  canGrantPoints: z.boolean(),
  canComplete: z.boolean(),
  allowedTransitions: z.array(z.string()).optional(),
}).strict();

export const HierarchySchema: z.ZodType<Hierarchy> = z.lazy(() => z.object({
  parent: EntitySummarySchema.nullable(),
  children: pageOf(EntitySummarySchema),
  path: z.array(EntitySummarySchema),
}).strict());

export const EntityDetailSchema: z.ZodType<EntityDetail> = z.lazy(() => z.object({
  ...entitySummaryShape(),
  content: EntityContentSchema,
  hierarchy: HierarchySchema,
  connections: ConnectionsSchema,
  capabilities: EntityCapabilitiesSchema,
}).strict());

// ---------------------------------------------------------------------------
// Collections & graph
// ---------------------------------------------------------------------------

const GroupBySchema = z.union([
  z.literal('workStatus'),
  z.literal('assignee'),
  z.custom<`axis:${string}`>((v) => typeof v === 'string' && v.startsWith('axis:'), 'must be "workStatus", "assignee" or "axis:<name>"'),
]);

const CollectionFiltersSchema = z.object({
  workStatus: z.array(WorkStatusSchema).optional(),
  axes: z.record(z.array(z.string())).optional(),
  assigneeIds: z.array(EntityIdSchema).optional(),
  edge: z.object({
    type: z.string(),
    direction: z.enum(['incoming', 'outgoing']),
    entityId: EntityIdSchema,
  }).strict().optional(),
  readyToPull: z.boolean().optional(),
  inReviewForActorId: EntityIdSchema.optional(),
  mentionedActorId: EntityIdSchema.optional(),
  workedByActorId: EntityIdSchema.optional(),
  inFlightForActorId: EntityIdSchema.optional(),
  needsActorId: EntityIdSchema.optional(),
  sessionStatus: z.array(WorkSessionStatusSchema).optional(),
  deleted: z.enum(['exclude', 'only', 'include']).optional(),
}).strict().superRefine((f, ctx) => {
  // A22: refused, not silently empty. The two filters are kind-disjoint (no
  // row is both a task and a work_session), so their conjunction can only
  // ever return the always-empty set — the confident-zero a caller reads as
  // "nothing matched" when the truth is "nothing COULD match". The pair was
  // unauthorable before sessionStatus existed, so refusing it is additive.
  if (f.workStatus && f.workStatus.length > 0 && f.sessionStatus && f.sessionStatus.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'workStatus and sessionStatus are kind-disjoint — no row is both a task and a work_session; pick one per query',
    });
  }
});

function collectionQueryShape() {
  return {
    spaceId: SpaceIdSchema,
    kinds: z.array(EntityKindSchema).optional(),
    subtreeOf: EntityIdSchema.optional(),
    parentId: EntityIdSchema.nullable().optional(),
    filters: CollectionFiltersSchema.optional(),
    layout: z.enum(['list', 'board', 'tree', 'feed', 'gallery', 'graph']).optional(),
    groupBy: GroupBySchema.optional(),
    sort: z.enum(['activityAt_desc', 'updatedAt_desc', 'createdAt_desc', 'position', 'dueDate', 'priority']).optional(),
    cursor: CursorSchema.optional(),
    limit: z.number().int().positive().optional(),
  };
}

export const CollectionQuerySchema: z.ZodType<CollectionQuery> =
  z.object(collectionQueryShape()).strict();

export const CollectionGroupSchema: z.ZodType<CollectionGroup> = z.lazy(() => z.object({
  key: z.string(),
  label: z.string(),
  items: z.array(EntitySummarySchema),
  nextCursor: CursorSchema.optional(),
  total: z.number().int().nonnegative().optional(),
}).strict());

export const CollectionResultSchema: z.ZodType<CollectionResult> = z.lazy(() => z.object({
  query: CollectionQuerySchema,
  page: pageOf(EntitySummarySchema),
  groups: z.array(CollectionGroupSchema).optional(),
}).strict());

export const GraphQuerySchema: z.ZodType<GraphQuery> = z.object({
  ...collectionQueryShape(),
  focusId: EntityIdSchema.optional(),
  hops: z.number().int().positive().optional(),
  edgeTypes: z.array(z.string()).optional(),
  mode: z.enum(['free', 'dependency']).optional(),
}).strict();

export const GraphResultSchema: z.ZodType<GraphResult> = z.lazy(() => z.object({
  nodes: z.array(EntitySummarySchema),
  edges: z.array(EdgeViewSchema),
  clusters: z.array(z.object({ parentId: EntityIdSchema, childIds: z.array(EntityIdSchema) }).strict()),
  layout: z.record(z.object({ x: z.number(), y: z.number() }).strict()).optional(),
}).strict());

// ---------------------------------------------------------------------------
// Threads, activity, presence, channel tabs
// ---------------------------------------------------------------------------

export const ChannelTabSchema: z.ZodType<ChannelTab> = z.lazy(() => z.object({
  key: z.string(),
  label: z.string(),
  count: z.number().int().nonnegative(),
  query: CollectionQuerySchema,
}).strict());

const MessageStateSchema = z.object({
  kind: z.literal('message'),
  anchorId: EntityIdSchema,
  rootMessageId: EntityIdSchema.nullable(),
  author: ActorSummarySchema,
  messageBatchId: z.string().nullable(),
  editedAt: z.string().nullable().optional(),
  redactedAt: z.string().nullable().optional(),
}).strict();

const MessageContentSchema = z.object({
  kind: z.literal('message'),
  body: z.string(),
  mentions: z.array(MentionSchema),
  attachments: z.array(FileAttachmentSchema),
}).strict();

export const MessageViewSchema: z.ZodType<MessageView> = z.lazy(() => z.object({
  ...entitySummaryShape(),
  state: MessageStateSchema,
  content: MessageContentSchema,
  replyCount: z.number().int().nonnegative(),
  replies: pageOf(MessageViewSchema).optional(),
  pending: z.boolean().optional(),
}).strict());

export const MessageBatchResultSchema: z.ZodType<MessageBatchResult> = z.lazy(() => z.object({
  messageBatchId: z.string().min(1),
  messages: z.array(MessageViewSchema).min(1).max(16),
}).strict());

export const ActivityItemSchema: z.ZodType<ActivityItem> = z.lazy(() => z.object({
  id: z.string(),
  entityId: EntityIdSchema.nullable().optional(),
  actor: ActorSummarySchema.nullable().optional(),
  verb: z.string(),
  summary: z.record(z.unknown()),
  createdAt: IsoTimestamp,
  refId: z.string().nullable().optional(),
  workSessionId: EntityIdSchema.nullable().optional(),
}).strict());

export const PresenceSnapshotSchema: z.ZodType<PresenceSnapshot> = z.object({
  viewers: z.array(ActorSummarySchema),
  typingActorIds: z.array(EntityIdSchema),
  updatedAt: IsoTimestamp,
}).strict();

export const VoiceParticipantSchema: z.ZodType<VoiceParticipant> = z.object({
  memberId: EntityIdSchema,
  name: z.string(),
  muted: z.boolean().optional(),
}).strict();

export const NotificationItemSchema: z.ZodType<NotificationItem> = z.lazy(() => z.object({
  id: z.string(),
  spaceId: SpaceIdSchema,
  kind: z.string(),
  actor: ActorSummarySchema.nullable().optional(),
  target: EntitySummarySchema.nullable().optional(),
  message: z.string().optional(),
  recipient: ActorSummarySchema,
  readAt: IsoTimestamp.nullable(),
  createdAt: IsoTimestamp,
}).strict());

// ---------------------------------------------------------------------------
// Realtime events
// ---------------------------------------------------------------------------

/** AM-2 §3: the envelope every event variant carries. */
const workspaceEventEnvelopeShape = {
  spaceId: SpaceIdSchema,
  seq: z.number().int().nonnegative(),
  occurredAt: IsoTimestamp,
  schemaVersion: z.number().int().positive(),
};

export const WorkspaceEventSchema: z.ZodType<WorkspaceEvent> = z.lazy(() => z.union([
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.enum(['entity.upsert', 'entity.deleted']),
    entity: EntitySummarySchema,
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.enum(['edge.upsert', 'edge.deleted']),
    edge: EdgeViewSchema,
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.enum(['message.created', 'message.updated', 'message.deleted']),
    anchorId: EntityIdSchema,
    // Optional + nullable so stored rows and older projectors that never emitted
    // this envelope-level provenance stay valid under `assertWorkspaceEvent`.
    sourceWorkSessionId: EntityIdSchema.nullable().optional(),
    message: MessageViewSchema,
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.literal('counter.changed'),
    entityId: EntityIdSchema,
    counters: EntityCountersSchema,
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.literal('activity.created'),
    activity: ActivityItemSchema,
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.enum(['notification.created', 'notification.read']),
    notification: NotificationItemSchema,
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.literal('menu.updated'),
    menu: MenuConfigSchema,
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.literal('space.default_channel.updated'),
    channelId: EntityIdSchema.nullable(),
    settingsRevision: z.number().int().positive(),
    clientMutationId: z.string().optional(),
  }).strict(),
  // Git facts (Tier 4 git×graph): RPC-authored passthrough — SQL authors in
  // db/migrations/083 build these payloads contract-shaped. STRICT, like every
  // passthrough arm, so an off-contract stored row fails the tripwire.
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.literal('git.commit_recorded'),
    commitEntityId: EntityIdSchema,
    repo: z.string(),
    sha: z.string(),
    provider: z.string(),
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.literal('git.pr_state_changed'),
    prEntityId: EntityIdSchema,
    repo: z.string(),
    number: z.number().int().positive(),
    previousState: z.enum(['open', 'merged', 'closed', 'draft']),
    state: z.enum(['open', 'merged', 'closed', 'draft']),
    headSha: z.string().nullable().optional(),
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.literal('git.worktree_status_changed'),
    worktreeEntityId: EntityIdSchema,
    projectId: z.string(),
    branch: z.string(),
    previousStatus: z.enum(['active', 'merged', 'abandoned', 'deleted']),
    status: z.enum(['active', 'merged', 'abandoned', 'deleted']),
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.literal('project.association.corrected'),
    result: EdgeCorrectionResultSchema,
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.enum(['handoff.prepared', 'handoff.delivery_settled', 'handoff.recorded', 'handoff.withdrawn']),
    handoff: HandoffViewSchema,
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.enum(['message.delivery_reserved', 'message.delivery_settled']),
    delivery: MessageDeliveryRecordSchema,
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.literal('message.attachments.updated'),
    message: MessageViewSchema,
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.enum([
      'interaction_profile.proposed', 'interaction_profile.updated',
      'interaction_profile.activated', 'interaction_profile.retired',
    ]),
    profile: InteractionProfileViewSchema,
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.literal('interaction_profile.validated'),
    validation: ProfileValidationViewSchema,
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.literal('interaction_profile.default_updated'),
    target: z.discriminatedUnion('type', [
      z.object({ type: z.literal('team_member'), value: TeammateProfileDefaultViewSchema }).strict(),
      z.object({ type: z.literal('space'), value: SpaceProfileDefaultViewSchema }).strict(),
    ]),
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.enum(['work_session.profile_pinned', 'work_session.profile_repinned']),
    pin: InteractionProfilePinViewSchema,
    clientMutationId: z.string().optional(),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.literal('presence.changed'),
    entityId: EntityIdSchema,
    presence: PresenceSnapshotSchema,
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.literal('typing.changed'),
    anchorId: EntityIdSchema,
    typingActorIds: z.array(EntityIdSchema),
  }).strict(),
  z.object({
    ...workspaceEventEnvelopeShape,
    type: z.literal('voice.participants.changed'),
    voiceChannelId: EntityIdSchema,
    spaceId: SpaceIdSchema,
    participants: z.array(VoiceParticipantSchema),
  }).strict(),
]));

// ---------------------------------------------------------------------------
// The client→server control channel (§5)
//
// `.strict()` like every other input schema: an unknown key is `invalid_input`,
// not a silently ignored field. This matters more here than on an HTTP body,
// because a mistyped control frame that parsed leniently would leave a client
// believing it is subscribed to a Space the server never added it to — the
// failure mode is silence, which reads exactly like "this Space is quiet".
// ---------------------------------------------------------------------------

/**
 * A `since` cursor: a non-negative safe integer per-Space `seq` (AM-2 §3).
 *
 * Validated rather than coerced, for the same reason `events.poll` validates
 * its `?since=`: `Number('abc')` is `NaN`, and `seq > NaN` is false for every
 * row, so a malformed cursor would return an empty replay that a client reads
 * as "you have missed nothing".
 */
const ControlSinceSchema = z.number().int().nonnegative().safe();

const ControlSpaceIdsSchema = z.array(SpaceIdSchema).min(1).max(MAX_CONTROL_FRAME_SPACES);

export const WorkspaceControlFrameSchema: z.ZodType<WorkspaceControlFrame> =
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('subscribe'), spaceIds: ControlSpaceIdsSchema }).strict(),
    z.object({ type: z.literal('unsubscribe'), spaceIds: ControlSpaceIdsSchema }).strict(),
    z.object({ type: z.literal('presence'), on: z.boolean() }).strict(),
    z.object({ type: z.literal('resume'), spaceId: SpaceIdSchema, since: ControlSinceSchema }).strict(),
    z.object({
      type: z.literal('presence.set'),
      spaceId: SpaceIdSchema,
      entityId: EntityIdSchema,
      viewing: z.boolean(),
      typing: z.boolean(),
    }).strict(),
  ]);

export const WorkspaceControlAckSchema: z.ZodType<WorkspaceControlAck> = z.object({
  type: z.literal('control.refused'),
  frame: z.enum(['subscribe', 'unsubscribe', 'presence', 'resume', 'presence.set']),
  spaceId: SpaceIdSchema.optional(),
  reason: z.enum(['forbidden', 'malformed']),
}).strict();

// ---------------------------------------------------------------------------
// Commands: shared envelope, results, undo
// ---------------------------------------------------------------------------

const commandContextShape = {
  actorId: EntityIdSchema.optional(),
  clientMutationId: z.string().optional(),
  workSessionId: EntityIdSchema.optional(),
};

export const CommandContextSchema: z.ZodType<CommandContext> =
  z.object(commandContextShape).strict();

export const ServerConnectionNameSchema = z.string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9-]*$/, 'name must start with a letter and contain only lowercase letters, digits, and hyphens');

export const ServerConnectionBaseUrlSchema = z.string().min(1).max(2048).url().superRefine((value, ctx) => {
  // `.url()` records its issue without ABORTING, so this refinement still runs
  // on a non-URL — and an unguarded `new URL(value)` then THROWS out of
  // safeParse (TypeError, not a ZodError). Refine only what parses.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'baseUrl must use http or https' });
  }
  if (url.username || url.password) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'baseUrl must not contain credentials' });
  }
  if (url.hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'baseUrl must not contain a fragment' });
  }
  if ((url.pathname && url.pathname !== '/') || url.search) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'baseUrl must be an origin without a path or query' });
  }
});

export const ServerConnectionSchema: z.ZodType<ServerConnection> = z.object({
  id: z.string().uuid(),
  name: ServerConnectionNameSchema,
  baseUrl: ServerConnectionBaseUrlSchema,
  username: z.string().min(1).max(100).nullable().optional(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
}).strict();

export const ServerConnectionCreateInputSchema: z.ZodType<ServerConnectionCreateInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  name: ServerConnectionNameSchema,
  baseUrl: ServerConnectionBaseUrlSchema,
  username: z.string().min(1).max(100).nullable().optional(),
}).strict();

export const ServerConnectionDeleteInputSchema: z.ZodType<ServerConnectionDeleteInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
}).strict();

/**
 * No `commandContextShape` here: the DTO declares no `actorId` on purpose
 * (see the interface), so an actor on the wire is refused by strictness.
 * The `globalId` shape mirrors the 067 check constraint exactly — a
 * non-empty issuer, one colon seam, a non-empty subject, no whitespace.
 */
export const IdentityProfileUpdateInputSchema: z.ZodType<IdentityProfileUpdateInput> = z.object({
  clientMutationId: z.string().min(1),
  displayName: z.string().min(1).max(200).optional(),
  avatar: z.string().min(1).max(2000).optional(),
  email: z.string().min(3).max(320).optional(),
  globalId: z.string().min(3).max(200).regex(/^[^:\s]+:\S+$/, {
    message: 'globalId must be issuer:subject with no whitespace',
  }).optional(),
}).strict();

export const IdentityProfileViewSchema: z.ZodType<IdentityProfileView> = z.object({
  identityId: z.string().min(1).max(200),
  displayName: z.string().nullable(),
  avatar: z.string().nullable(),
  email: z.string().nullable(),
  globalId: z.string().nullable(),
}).strict();

// ---------------------------------------------------------------------------
// auth.* (Identity v2 Stage 1). No `commandContextShape` on any input: the
// DTOs declare neither `actorId` nor `clientMutationId` on purpose (see the
// interfaces), so strictness refuses both on the wire.
// ---------------------------------------------------------------------------

/** Mirrors the 002 check constraint: 1–100 chars after trim. Normalized lower-case server-side. */
const AuthUsernameSchema = z.string().min(1).max(100).regex(/^\S+$/, {
  message: 'username must not contain whitespace',
});

/** The UI's MIN_PASSWORD_LENGTH is 8; the server refuses shorter outright. */
const AuthPasswordSchema = z.string().min(8).max(1024);

export const AuthSignupInputSchema: z.ZodType<AuthSignupInput> = z.object({
  username: AuthUsernameSchema,
  password: AuthPasswordSchema,
  displayName: z.string().min(1).max(200).optional(),
  email: z.string().min(3).max(320).optional(),
  isNodeAdmin: z.boolean().optional(),
}).strict();

export const AuthLoginInputSchema: z.ZodType<AuthLoginInput> = z.object({
  username: AuthUsernameSchema,
  password: z.string().min(1).max(1024),
  kind: z.enum(['browser', 'cli']).optional(),
  label: z.string().min(1).max(200).optional(),
}).strict();

export const AuthLogoutInputSchema: z.ZodType<AuthLogoutInput> = z.object({
  sessionId: z.string().uuid().optional(),
}).strict();

export const AuthAccountViewSchema: z.ZodType<AuthAccountView> = z.object({
  accountId: z.string().uuid(),
  identityId: z.string().min(1).max(200),
  username: z.string().min(1).max(100),
  displayName: z.string().nullable(),
  isNodeAdmin: z.boolean(),
  isOwner: z.boolean(),
}).strict();

export const AuthSessionViewSchema: z.ZodType<AuthSessionView> = z.object({
  sessionId: z.string().uuid(),
  kind: z.enum(['browser', 'cli', 'agent']),
  actingAsTeamMemberId: z.string().uuid().nullable(),
  label: z.string().nullable(),
  createdAt: IsoTimestamp.optional(),
  expiresAt: IsoTimestamp,
}).strict();

export const AuthSignupResultSchema: z.ZodType<AuthSignupResult> = z.object({
  account: AuthAccountViewSchema,
}).strict();

export const AuthLoginResultSchema: z.ZodType<AuthLoginResult> = z.object({
  token: z.string().min(1),
  account: AuthAccountViewSchema,
  session: AuthSessionViewSchema,
}).strict();

export const AuthLogoutResultSchema: z.ZodType<AuthLogoutResult> = z.object({
  sessionId: z.string().uuid(),
  revoked: z.boolean(),
}).strict();

export const AuthSessionGetResultSchema: z.ZodType<AuthSessionGetResult> = z.object({
  authKind: z.enum(['bearer', 'auto-owner']),
  account: AuthAccountViewSchema,
  session: AuthSessionViewSchema.nullable(),
}).strict();

// ---------------------------------------------------------------------------
// credentials.* (Tier B, sub-doc 11 §D).
//
// NO `commandContextShape` ON ANY INPUT HERE, and unlike `auth.*` the reason is
// a security property rather than a modelling one: `commandContextShape`
// carries `actorId`, and `.strict()` without it makes an acting-as claim a
// VALIDATION FAILURE instead of a field the server has to remember to ignore.
// That is finding D2's third and outermost layer — the wire, the service
// (`W2CredentialSessionsService.start` throws on a claims `actorId`) and the
// SQL (`internal.current_member_id`, never `internal.resolve_actor`).
//
// `clientMutationId` IS admitted, because `commandAcceptsClientMutationId`
// returns true for everything outside `auth.*`; refusing it here would make
// every credential command fail with `Unrecognized key(s)` the moment the
// ledger is enabled.
// ---------------------------------------------------------------------------

/** All three login-terminal providers. Wider than what 083 will STORE (R6). */
export const CredentialProviderNameSchema: z.ZodType<CredentialProviderName> =
  z.enum(['anthropic', 'openai', 'github']);

/** Mirrors 083's `account_agent_credentials.status` CHECK exactly. */
const CredentialStatusSchema = z.enum(['active', 'stale', 'revoked']);

export const CredentialConnectionViewSchema: z.ZodType<CredentialConnectionView> = z.object({
  provider: CredentialProviderNameSchema,
  connected: z.boolean(),
  // Nullable rather than optional, and never absent: anthropic can NEVER
  // populate it (R4), so a UI that treats "missing" and "null" differently
  // would render two different cards for one permanent fact.
  login: z.string().nullable(),
  authMethod: z.string().nullable(),
  status: CredentialStatusSchema.nullable(),
  connectedAt: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
}).strict();

export const CredentialsStatusViewSchema: z.ZodType<CredentialsStatusView> = z.object({
  providers: z.array(CredentialConnectionViewSchema),
  // The honest-degradation field. `absent` means the github entry's `connected`
  // is UNKNOWN, not measured false — 079 ships on the deployed staging line and
  // is reachable from no local git object.
  gitCredentialStore: z.enum(['present', 'absent']),
}).strict();

export const CredentialsDeleteInputSchema: z.ZodType<CredentialsDeleteInput> = z.object({
  clientMutationId: z.string().min(1).optional(),
}).strict();

export const CredentialsDeleteResultSchema: z.ZodType<CredentialsDeleteResult> = z.object({
  provider: CredentialProviderNameSchema,
  revoked: z.boolean(),
  terminatedCredentialSessionIds: z.array(z.string()),
  terminatedAgentSessionIds: z.array(z.string()),
  failures: z.array(z.object({
    step: z.enum(['revoke', 'credentialSession', 'agentSession']),
    sessionId: z.string().optional(),
    reason: z.string(),
  }).strict()),
}).strict();

export const CredentialsLoginSessionStartInputSchema:
  z.ZodType<CredentialsLoginSessionStartInput> = z.object({
    spaceId: EntityIdSchema,
    provider: CredentialProviderNameSchema,
    // Geometry is the ONLY client input this operation accepts, and it is
    // bounded so a hostile value cannot reach `pty.spawn` as a resource claim.
    // There is deliberately no command/args/flags field: see the DTO.
    cols: z.number().int().min(1).max(1000).optional(),
    rows: z.number().int().min(1).max(1000).optional(),
    clientMutationId: z.string().min(1).optional(),
  }).strict();

export const CredentialsLoginSessionStartResultSchema:
  z.ZodType<CredentialsLoginSessionStartResult> = z.object({
    workSessionId: EntityIdSchema,
    spaceId: EntityIdSchema,
    provider: CredentialProviderNameSchema,
    expiresAt: IsoTimestamp,
    command: z.string().min(1),
  }).strict();

export const CredentialsLoginSessionFinishInputSchema:
  z.ZodType<CredentialsLoginSessionFinishInput> = z.object({
    clientMutationId: z.string().min(1).optional(),
  }).strict();

export const CredentialsLoginSessionFinishResultSchema:
  z.ZodType<CredentialsLoginSessionFinishResult> = z.object({
    workSessionId: EntityIdSchema,
    provider: CredentialProviderNameSchema,
    // `connected` and `stored` are separate on purpose: a verified GitHub login
    // has nowhere to be written on this line, so `connected: true, stored:
    // false` is a correct and expected answer.
    connected: z.boolean(),
    login: z.string().nullable(),
    authMethod: z.string().nullable(),
    status: CredentialStatusSchema,
    stored: z.boolean(),
    terminated: z.boolean(),
  }).strict();

export const UndoTokenSchema: z.ZodType<UndoToken> = z.object({
  token: z.string(),
  label: z.string(),
  expiresAt: z.string().optional(),
}).strict();

export const CommandResultSchema: z.ZodType<CommandResult> = z.lazy(() => z.object({
  entity: EntityDetailSchema.optional(),
  edge: EdgeViewSchema.optional(),
  activity: ActivityItemSchema.optional(),
  patches: z.array(EntitySummarySchema),
  undo: UndoTokenSchema.optional(),
}).strict());

// ---------------------------------------------------------------------------
// Command inputs (all strict; unknown field ⇒ invalid_input)
// ---------------------------------------------------------------------------

const attachToSchema = z.object({
  entityId: EntityIdSchema,
  edgeType: z.enum(['attached_to', 'relates_to']),
}).strict();

export const InitialConnectionInputSchema = z.object({
  type: z.string().min(1),
  targetId: EntityIdSchema,
  props: z.record(z.unknown()).optional(),
}).strict();

export const CreateTaskInputSchema: z.ZodType<CreateTaskInput> = z.object({
  ...commandContextShape,
  spaceId: SpaceIdSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  axes: z.record(z.string()).optional(),
  parentId: EntityIdSchema.nullable().optional(),
  position: z.number().optional(),
  priority: PrioritySchema.optional(),
  acceptanceCriteria: z.array(z.object({
    text: z.string(),
    id: z.string().optional(),
    done: z.boolean().optional(),
    doneBy: EntityIdSchema.optional(),
    doneAt: z.string().optional(),
  }).strict()).optional(),
  pointsEstimate: z.number().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  attachTo: attachToSchema.optional(),
}).strict();

export const PatchTaskInputSchema: z.ZodType<PatchTaskInput> = z.object({
  ...commandContextShape,
  expectedVersion: z.number().finite(),
  title: z.string().optional(),
  description: z.string().optional(),
  axes: z.record(z.string()).optional(),
  workStatus: WorkStatusSchema.optional(),
  priority: PrioritySchema.optional(),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).optional(),
  pointsEstimate: z.number().nullable().optional(),
  dueDate: z.string().nullable().optional(),
}).strict();

/** The runtime half of `CreatableEntityKind` — the one place the set is stated. */
export const CreatableEntityKindSchema = z.union([
  CoreEntityKindSchema.exclude(['message', 'member', 'work_session', 'project', 'interaction_profile', 'worktree', 'artifact']),
  CustomEntityKindSchema,
]);

export const CreateEntityInputSchema: z.ZodType<CreateEntityInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  spaceId: SpaceIdSchema,
  kind: CreatableEntityKindSchema,
  title: z.string().min(1),
  parentId: EntityIdSchema.nullable().optional(),
  position: z.number().optional(),
  content: z.record(z.unknown()).optional(),
  attachTo: attachToSchema.optional(),
  connections: uniqueArray(InitialConnectionInputSchema).optional(),
}).strict() as z.ZodType<CreateEntityInput>;

export const PatchEntityInputSchema: z.ZodType<PatchEntityInput> = z.object({
  ...commandContextShape,
  expectedVersion: z.number().finite(),
  title: z.string().optional(),
  content: z.record(z.unknown()).optional(),
}).strict();

// artifacts — command inputs (TM8-ARTIFACTS-DESIGN §8.1). The manifest is the
// strict, model-agnostic bundle descriptor; see artifact-manifest.ts.
const ArtifactInlineFilesSchema = z.array(
  z.object({ path: z.string().min(1), contentBase64: z.string().min(1) }).strict(),
).min(1).max(128);
export const ArtifactsCreateInputSchema: z.ZodType<ArtifactsCreateInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  spaceId: SpaceIdSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  manifest: ArtifactManifestSchema,
  files: ArtifactInlineFilesSchema.optional(),
  sourceWorkSessionId: EntityIdSchema.nullable().optional(),
  parentId: EntityIdSchema.nullable().optional(),
  position: z.number().optional(),
}).strict();

export const ArtifactsPublishInputSchema: z.ZodType<ArtifactsPublishInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  manifest: ArtifactManifestSchema,
  files: ArtifactInlineFilesSchema.optional(),
  sourceWorkSessionId: EntityIdSchema.nullable().optional(),
}).strict();

export const ArtifactsPreviewStartInputSchema: z.ZodType<ArtifactsPreviewStartInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  revisionNumber: z.number().int().positive().optional(),
}).strict();

export const ArtifactsRestoreInputSchema: z.ZodType<ArtifactsRestoreInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  revisionNumber: z.number().int().positive(),
}).strict();

export const AttentionRequestStatusSchema = z.enum(['open', 'acknowledged', 'resolved', 'dismissed']);

export const AttentionRequestSchema: z.ZodType<AttentionRequest> = z.object({
  id: z.string().uuid(),
  spaceId: EntityIdSchema,
  entityId: EntityIdSchema,
  reason: z.string().min(1).max(500),
  points: z.number().int().min(1).max(100),
  status: AttentionRequestStatusSchema,
  version: z.number().int().positive(),
  requestedBy: ActorSummarySchema,
  acknowledgedBy: ActorSummarySchema.nullable(),
  resolvedBy: ActorSummarySchema.nullable(),
  resolutionNote: z.string().max(1000).nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  acknowledgedAt: IsoTimestamp.nullable(),
  resolvedAt: IsoTimestamp.nullable(),
}).strict();

export const AttentionRequestListQuerySchema: z.ZodType<AttentionRequestListQuery> = z.object({
  spaceId: EntityIdSchema,
  entityId: EntityIdSchema.optional(),
  status: AttentionRequestStatusSchema.optional(),
  minPoints: z.number().int().min(1).max(100).optional(),
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().optional(),
}).strict();

export const CreateAttentionRequestInputSchema: z.ZodType<CreateAttentionRequestInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
  points: z.number().int().min(1).max(100),
}).strict();

export const UpdateAttentionRequestInputSchema: z.ZodType<UpdateAttentionRequestInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500).optional(),
  points: z.number().int().min(1).max(100).optional(),
  status: AttentionRequestStatusSchema.optional(),
  resolutionNote: z.string().trim().max(1000).optional(),
}).strict().refine(
  (value) => value.reason !== undefined || value.points !== undefined || value.status !== undefined || value.resolutionNote !== undefined,
  { message: 'at least one attention request field must be updated' },
);

export const ResolveEntityAttentionInputSchema: z.ZodType<ResolveEntityAttentionInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  resolutionNote: z.string().trim().max(1000).optional(),
}).strict();

export const AttentionRequestMutationResultSchema: z.ZodType<AttentionRequestMutationResult> = z.lazy(() => z.object({
  request: AttentionRequestSchema.nullable(),
  entity: EntitySummarySchema,
  affectedCount: z.number().int().nonnegative(),
}).strict());

export const MoveEntityInputSchema: z.ZodType<MoveEntityInput> = z.object({
  ...commandContextShape,
  parentId: EntityIdSchema.nullable(),
  position: z.number().finite(),
  expectedVersion: z.number().finite(),
}).strict();

export const CreateEdgeInputSchema: z.ZodType<CreateEdgeInput> = z.object({
  ...commandContextShape,
  srcId: EntityIdSchema,
  dstId: EntityIdSchema,
  type: z.string().min(1),
  props: z.record(z.unknown()).optional(),
}).strict();

export const PatchEdgeInputSchema: z.ZodType<PatchEdgeInput> = z.object({
  ...commandContextShape,
  props: z.record(z.unknown()),
}).strict();

export const PlacementInputSchema: z.ZodType<PlacementInput> = z.object({
  ...commandContextShape,
  sourceId: EntityIdSchema,
  targetId: EntityIdSchema,
  intent: z.enum(['attach', 'assign', 'depend', 'subtask', 'embed', 'reparent']),
  embedMessage: z.string().optional(),
}).strict();

const PostMessageWireInputSchema: z.ZodType<PostMessageWireInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  anchorIds: uniqueArray(EntityIdSchema, 1, 16).optional(),
  anchorId: EntityIdSchema.optional(),
  conversationAnchorId: EntityIdSchema.nullable().optional(),
  replyToMessageId: EntityIdSchema.optional(),
  body: z.string().min(1).max(10_000),
  parentMessageId: EntityIdSchema.nullable().optional(),
  mentionIds: uniqueArray(EntityIdSchema, 0, 16).optional(),
  attachmentIds: uniqueArray(EntityIdSchema, 0, 16).optional(),
}).strict();

export const PostMessageInputSchema: z.ZodType<PostMessageInput, z.ZodTypeDef, PostMessageWireInput> =
  PostMessageWireInputSchema.superRefine((value, context) => {
    const hasReplyTarget = value.replyToMessageId !== undefined;
    const hasAnchorIds = value.anchorIds !== undefined;
    const hasLegacyAnchor = value.anchorId !== undefined;
    if (hasReplyTarget) {
      if (hasAnchorIds || hasLegacyAnchor) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'replyToMessageId cannot be combined with anchorIds or deprecated anchorId' });
      }
      if (value.parentMessageId != null || value.conversationAnchorId != null) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'a routed reply derives its conversation anchor and parent on the Server' });
      }
    } else if (hasAnchorIds === hasLegacyAnchor) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'provide exactly one of anchorIds or deprecated anchorId' });
    }
    const anchorCount = value.anchorIds?.length ?? (value.anchorId ? 1 : 0);
    const attachmentCount = value.attachmentIds?.length ?? 0;
    if (anchorCount * attachmentCount > 64) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'anchor × attachment pairs must not exceed 64' });
    }
    if (value.parentMessageId != null && anchorCount !== 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'a reply must resolve to exactly one anchor' });
    }
    if (
      value.conversationAnchorId != null &&
      ![...(value.anchorIds ?? []), ...(value.anchorId ? [value.anchorId] : [])]
        .includes(value.conversationAnchorId)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'conversationAnchorId must be one of the message anchors' });
    }
    const { anchorId, ...rest } = value;
    const canonical = { ...rest, anchorIds: value.anchorIds ?? (anchorId ? [anchorId] : []) };
    if (Buffer.byteLength(JSON.stringify(canonical), 'utf8') > 256 * 1024) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'canonical request JSON must not exceed 256 KiB' });
    }
  }).transform(({ anchorId, ...value }): PostMessageInput => ({
    ...value,
    anchorIds: value.anchorIds ?? (anchorId ? [anchorId] : []),
  }));

export const PatchMessageInputSchema: z.ZodType<PatchMessageInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  body: z.string().min(1).max(10_000),
  mentions: z.array(MentionSchema).optional(),
}).strict();

export const DeleteMessageInputSchema: z.ZodType<DeleteMessageInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
}).strict();

export const ReactionInputSchema: z.ZodType<ReactionInput> = z.object({
  ...commandContextShape,
  reaction: z.enum(['like', 'dislike', 'star']),
  enabled: z.boolean(),
}).strict();

export const GrantPointsInputSchema: z.ZodType<GrantPointsInput> = z.object({
  ...commandContextShape,
  amount: z.number().finite().refine((n) => n !== 0, 'amount must be non-zero'),
  reason: z.enum(['grant', 'award', 'seed']),
  referenceId: EntityIdSchema.optional(),
}).strict();

export const CompleteTaskInputSchema: z.ZodType<CompleteTaskInput> = z.object({
  ...commandContextShape,
  expectedVersion: z.number().finite(),
  completerIds: z.array(EntityIdSchema).min(1),
}).strict();

export const PullInputSchema: z.ZodType<PullInput> = z.object({
  ...commandContextShape,
  localId: z.string().nullable().optional(),
  pinnedVersion: z.number().finite(),
}).strict();

export const WorkInputSchema: z.ZodType<WorkInput> = z.object({
  ...commandContextShape,
  status: WorkStatusSchema,
  startedAt: IsoTimestamp.optional(),
  note: z.string().nullable().optional(),
}).strict();

export const TrackingRefreshInputSchema: z.ZodType<TrackingRefreshInput> = z.object({
  ...commandContextShape,
  entityIds: z.array(EntityIdSchema).optional(),
}).strict();

export const LinkPrInputSchema: z.ZodType<LinkPrInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  url: z.string().url(),
  projectId: z.string().min(1).optional(),
}).strict();

export const LinkCommitInputSchema: z.ZodType<LinkCommitInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  url: z.string().url(),
  projectId: z.string().min(1).optional(),
}).strict();

export const GateTaskInputSchema: z.ZodType<GateTaskInput> = z.object({
  ...commandContextShape,
  expectedVersion: z.number().finite(),
  gate: z.enum(['none', 'pr_merged']),
}).strict();

export const TaskAxisInputSchema: z.ZodType<TaskAxisInput> = z.object({
  ...commandContextShape,
  name: z.string().min(1),
  axisValues: z.array(z.string()),
  kind: z.enum(['default', 'manual']),
  position: z.number().finite(),
}).strict();

export const SavedViewInputSchema: z.ZodType<SavedViewInput> = z.object({
  ...commandContextShape,
  name: z.string().min(1),
  shareMode: z.enum(['private', 'space']),
  query: CollectionQuerySchema,
  graphLayout: z.record(z.object({ x: z.number(), y: z.number() }).strict()).optional(),
}).strict();

export const CreateSpaceInputSchema: z.ZodType<CreateSpaceInput> = z.object({
  ...commandContextShape,
  name: z.string().min(1),
  description: z.string().optional(),
  visibility: z.enum(['private', 'public']).optional(),
  githubRepo: z.string().nullable().optional(),
}).strict();

export const UpdateSpaceInputSchema: z.ZodType<UpdateSpaceInput> = z.object({
  ...commandContextShape,
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  githubRepo: z.string().nullable().optional(),
}).strict();

// ---------------------------------------------------------------------------
// Space menu and shared settings revision (W0 dossier A01-A03/A20)
// ---------------------------------------------------------------------------

export const MenuViewRefSchema = z.enum(['dashboard', 'feed', 'inbox', 'workspace', 'graph', 'channels', 'settings']);
// `worktree` un-excluded 2026-07-31 in lockstep with the MenuKindRef type:
// menu-visible, still not menu-creatable (creation stays with the saga).
// `channel` un-excluded 2026-08-01, same lockstep — it became a collection
// kind with a real `k/channels` list, so the rail can name it. See the type.
export const MenuKindRefSchema = z.union([
  CoreEntityKindSchema.exclude(['message']),
  CustomEntityKindSchema,
]);

export const MenuLeafSchema: z.ZodType<MenuLeaf> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('view'), ref: MenuViewRefSchema }).strict(),
  z.object({ type: z.literal('kind'), ref: MenuKindRefSchema }).strict(),
]);

export const MenuItemSchema: z.ZodType<MenuItem> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('view'),
    ref: MenuViewRefSchema,
    children: z.array(MenuLeafSchema).max(8).optional(),
  }).strict(),
  z.object({ type: z.literal('kind'), ref: MenuKindRefSchema }).strict(),
]);

export const MenuGroupSchema: z.ZodType<MenuGroup> = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  label: z.string().min(1).max(32),
  items: z.array(MenuItemSchema).max(12),
}).strict();

function validateMenu(groups: MenuGroup[], context: z.RefinementCtx): void {
  const groupIds = groups.map((group) => group.id);
  if (new Set(groupIds).size !== groupIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'menu group ids must be globally unique' });
  }
  const refs = groups.flatMap((group) => group.items.flatMap((item) => [
    item.ref,
    ...(item.type === 'view' ? (item.children ?? []).map((child) => child.ref) : []),
  ]));
  if (new Set(refs).size !== refs.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'menu refs must be globally unique' });
  }
  if (!refs.includes('settings')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'the required settings view must be present' });
  }
}

export const MenuConfigPayloadSchema: z.ZodType<MenuConfigPayload> = z.object({
  schemaVersion: z.literal(1),
  groups: z.array(MenuGroupSchema).max(8),
}).strict().superRefine((value, context) => validateMenu(value.groups, context));

export const MenuConfigSchema: z.ZodType<MenuConfig> = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().positive(),
  groups: z.array(MenuGroupSchema).max(8),
}).strict().superRefine((value, context) => validateMenu(value.groups, context));

export const UpdateMenuInputSchema: z.ZodType<UpdateMenuInput> = z.object({
  clientMutationId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  payload: MenuConfigPayloadSchema,
}).strict();

export const SetDefaultChannelInputSchema: z.ZodType<SetDefaultChannelInput> = z.object({
  clientMutationId: z.string().min(1),
  expectedSettingsRevision: z.number().int().positive(),
  channelId: EntityIdSchema.nullable(),
}).strict();

// ---------------------------------------------------------------------------
// Projects — linked resources (AM-2 §1, T-D17)
// ---------------------------------------------------------------------------

export const ProjectIdSchema = z.string().min(1);

export const ProjectTrustLevelSchema: z.ZodType<ProjectTrustLevel> =
  z.enum(['trusted', 'untrusted']);

export const ProjectDefaultsSchema: z.ZodType<ProjectDefaults> = z.object({
  model: z.string().nullable().optional(),
  agentTool: z.string().nullable().optional(),
  mode: z.enum(['worker', 'coordinator', 'coordinated-worker', 'coordinated-coordinator', 'dispatcher']).nullable().optional(),
}).strict();

export const ProjectResourceSchema: z.ZodType<ProjectResource> = z.object({
  id: ProjectIdSchema,
  name: z.string(),
  repoUrl: z.string().nullable().optional(),
  workingDir: z.string(),
  trust: ProjectTrustLevelSchema,
  defaults: ProjectDefaultsSchema,
  linkFrozen: z.boolean().optional(),
  activeLinkCount: z.number().int().nonnegative().optional(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
}).strict();

export const ProjectCreateInputSchema: z.ZodType<ProjectCreateInput> = z.object({
  ...commandContextShape,
  name: z.string().min(1),
  workingDir: z.string().min(1),
  repoUrl: z.string().nullable().optional(),
  trust: ProjectTrustLevelSchema.optional(),
  defaults: ProjectDefaultsSchema.optional(),
  ensureWorkingDir: z.boolean().optional(),
}).strict();

export const ProjectBranchSchema: z.ZodType<ProjectBranch> = z.object({
  name: z.string().min(1),
  head: z.string(),
  lastCommitAt: z.string().min(1),
  subject: z.string(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  isDefault: z.boolean(),
  isCurrent: z.boolean(),
  merged: z.boolean(),
  stale: z.boolean(),
}).strict();

export const ProjectBranchTopologySchema: z.ZodType<ProjectBranchTopology> = z.object({
  projectId: ProjectIdSchema,
  workingDir: z.string().min(1),
  defaultBranch: z.string().min(1),
  defaultBranchSource: z.enum(['origin_head', 'local_conventional', 'current_branch']),
  branches: z.array(ProjectBranchSchema),
  truncated: z.boolean(),
  staleAfterDays: z.number().int().positive(),
}).strict();

export const ProjectDirectoryEntrySchema: z.ZodType<ProjectDirectoryEntry> = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
}).strict();

export const ProjectDirectoryListingSchema: z.ZodType<ProjectDirectoryListing> = z.object({
  roots: z.array(z.string().min(1)).min(1),
  path: z.string().min(1),
  parentPath: z.string().min(1).nullable(),
  separator: z.enum(['/', '\\']),
  directories: z.array(ProjectDirectoryEntrySchema),
  truncated: z.boolean(),
}).strict();

export const ProjectFileEntrySchema: z.ZodType<ProjectFileEntry> = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: IsoTimestamp,
  mime: z.string().min(1),
  attachable: z.boolean(),
}).strict();

export const ProjectFileListingSchema: z.ZodType<ProjectFileListing> = z.object({
  projectId: z.string().min(1),
  workingDir: z.string().min(1),
  path: z.string().min(1),
  parentPath: z.string().min(1).nullable(),
  separator: z.enum(['/', '\\']),
  directories: z.array(ProjectDirectoryEntrySchema),
  files: z.array(ProjectFileEntrySchema),
  truncated: z.boolean(),
  maxSizeBytes: z.number().int().positive(),
}).strict();

export const ProjectFileReadResultSchema: z.ZodType<ProjectFileReadResult> = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1),
  mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  encoding: z.enum(['utf8', 'base64']),
  content: z.string(),
  truncated: z.boolean(),
}).strict();

export const ProjectFileAttachInputSchema: z.ZodType<ProjectFileAttachInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  spaceId: SpaceIdSchema,
  path: z.string().min(1),
  name: z.string().min(1).optional(),
  mime: z.string().min(1).optional(),
  targets: uniqueArray(EntityIdSchema, 0, 16).optional(),
}).strict();

export const ProjectUpdateInputSchema: z.ZodType<ProjectUpdateInput> = z.object({
  ...commandContextShape,
  name: z.string().min(1).optional(),
  workingDir: z.string().min(1).optional(),
  repoUrl: z.string().nullable().optional(),
  trust: ProjectTrustLevelSchema.optional(),
  defaults: ProjectDefaultsSchema.optional(),
}).strict();

export const ProjectLinkInputSchema: z.ZodType<ProjectLinkInput> = z.object({
  ...commandContextShape,
  projectId: ProjectIdSchema,
}).strict();

export const CorrectProjectAssociationInputSchema: z.ZodType<CorrectProjectAssociationInput> = z.object({
  clientMutationId: z.string().min(1),
  projectId: ProjectIdSchema,
  expectedArtifactVersion: z.number().int().positive(),
}).strict();

export const EdgeCorrectionResultSchema: z.ZodType<EdgeCorrectionResult> = z.lazy(() => z.object({
  artifactId: EntityIdSchema,
  projectId: ProjectIdSchema,
  outcome: z.enum(['removed', 'demoted', 'unchanged']),
  edge: EdgeViewSchema.nullable(),
}).strict());

// ---------------------------------------------------------------------------
// files.* blob lifecycle (AM-2 §2)
// ---------------------------------------------------------------------------

export const ChecksumSha256Schema = z.string().regex(SHA256_HEX_RE, 'must be a lowercase sha-256 hex digest');

export const FileUploadInitInputSchema: z.ZodType<FileUploadInitInput> = z.object({
  ...commandContextShape,
  spaceId: SpaceIdSchema,
  name: z.string().min(1),
  mime: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  checksumSha256: ChecksumSha256Schema,
  entityId: EntityIdSchema.nullable().optional(),
}).strict();

export const FileUploadGrantSchema: z.ZodType<FileUploadGrant> = z.object({
  uploadId: z.string(),
  uploadUrl: z.string().min(1),
  token: z.string().nullable().optional(),
  expiresAt: IsoTimestamp,
  maxSizeBytes: z.number().int().positive(),
}).strict();

/** Complete finalizes the file plus its explicitly requested attachment edges. */
export const FileUploadCompleteInputSchema: z.ZodType<FileUploadCompleteInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  targets: uniqueArray(EntityIdSchema, 0, 16).optional(),
}).strict();
export const FileUploadAbortInputSchema = CommandContextSchema;

// ---------------------------------------------------------------------------
// execution.* inputs (R16)
// ---------------------------------------------------------------------------

/**
 * `.strict()` on every member is the load-bearing part: it is what makes
 * `{ mode: 'worktree', path: '/etc' }` a parse failure rather than a field the
 * server quietly ignores. "Intent in, never paths" is structural here.
 *
 * The `baseRef` bound is politeness; the security control is that it reaches
 * Git as an element of an argv array, never a shell string, and is shape-checked
 * by `assertSafeRefName` on the way.
 */
export const SpawnWorkdirSchema: z.ZodType<SpawnWorkdir> = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('project') }).strict(),
  z.object({ mode: z.literal('scratch') }).strict(),
  z.object({ mode: z.literal('worktree'), baseRef: z.string().min(1).max(255).optional() }).strict(),
]);

const SpawnUuidSchema = z.string().uuid();

export const ExecutionSpawnInputSchema: z.ZodType<ExecutionSpawnInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  spaceId: SpawnUuidSchema,
  teamMemberId: SpawnUuidSchema,
  parentSessionId: SpawnUuidSchema.optional(),
  taskIds: z.array(SpawnUuidSchema).optional(),
  projectId: SpawnUuidSchema.nullable().optional(),
  workdir: SpawnWorkdirSchema.optional(),
  confirmUntrusted: z.literal(true).optional(),
  interactionProfileId: SpawnUuidSchema.optional(),
  mode: z.enum(['worker', 'coordinator', 'coordinated-worker', 'coordinated-coordinator', 'dispatcher']).optional(),
  model: z.string().nullable().optional(),
  agentTool: z.string().nullable().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  accessMode: z.enum(['safe', 'acceptEdits', 'auto', 'plan', 'fullAccess']).optional(),
  credentialSource: z.enum(['member', 'node']).optional(),
  title: z.string().optional(),
  promptExtra: z.string().nullable().optional(),
  memoryIds: z.array(SpawnUuidSchema).max(32).optional(),
}).strict();

/**
 * execution.dispatch — hand an entity to the space's dispatcher (§4.3).
 *
 * Three fields and no launch configuration is the whole design: choosing the
 * teammate, the model and the memories IS the dispatcher's job, so a caller
 * that could pass `teamMemberId` here would be doing the dispatching itself
 * and calling it a dispatch. `subjectId` is any launchable entity — it is
 * mapped through `derive_task_for_entity` (064) server-side, exactly as
 * `execution.spawn.taskIds` is.
 */
export const ExecutionDispatchInputSchema: z.ZodType<ExecutionDispatchInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
  spaceId: SpawnUuidSchema,
  subjectId: SpawnUuidSchema,
  note: z.string().max(4000).optional(),
}).strict();

/**
 * `delivery` is reported rather than thrown on. A dispatch whose envelope did
 * not reach the PTY still left a durable request message on the task, so the
 * work is recoverable; answering 5xx would tell the caller nothing happened.
 */
export const ExecutionDispatchResultSchema: z.ZodType<ExecutionDispatchResult> = z.object({
  taskId: EntityIdSchema,
  dispatcherSessionId: EntityIdSchema,
  dispatcherSpawned: z.boolean(),
  requestMessageId: EntityIdSchema.optional(),
  delivery: z.enum(['delivered', 'undelivered']),
}).strict();

export const ExecutionPromptInputSchema: z.ZodType<ExecutionPromptInput> = z.object({
  ...commandContextShape,
  message: z.string().min(1),
}).strict();

export const ExecutionTerminateInputSchema: z.ZodType<ExecutionTerminateInput> = z.object({
  ...commandContextShape,
  force: z.boolean().optional(),
}).strict();

export const ExecutionResumeInputSchema: z.ZodType<ExecutionResumeInput> = z.object({
  ...commandContextShape,
  clientMutationId: z.string().min(1),
}).strict();

export const ExecutionStreamsAttachInputSchema: z.ZodType<ExecutionStreamsAttachInput> = z.object({
  ...commandContextShape,
  mode: z.enum(['view', 'drive']),
}).strict();

export const StreamAttachGrantSchema: z.ZodType<StreamAttachGrant> = z.object({
  workSessionId: EntityIdSchema,
  url: z.string().min(1),
  protocol: z.literal('ws'),
  mode: z.enum(['view', 'drive']),
  token: z.string().min(1),
  expiresAt: IsoTimestamp,
}).strict();

export const CreateVoiceTokenInputSchema: z.ZodType<CreateVoiceTokenInput> = z.object({
  ...commandContextShape,
}).strict();

export const VoiceTokenGrantSchema: z.ZodType<VoiceTokenGrant> = z.object({
  voiceChannelId: EntityIdSchema,
  url: z.string().min(1),
  token: z.string().min(1),
  roomName: z.string().min(1),
  identity: z.string().min(1),
  expiresAt: IsoTimestamp,
}).strict();

/** A21 — execution.liveness (C-1). Point-in-time; see the contract type. */
export const ExecutionLivenessSchema: z.ZodType<ExecutionLiveness> = z.object({
  liveEntityIds: z.array(EntityIdSchema),
  nodeBootId: z.string().min(1),
  checkedAt: IsoTimestamp,
  capacity: z.object({
    used: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  }).strict(),
}).strict();

/**
 * execution.journal. NOT `.strict()` on the record: journal lines are written
 * by whatever CLI build the teammate happened to be running, and a newer CLI
 * adding a field must not make an older server refuse to show the session's
 * history. Unknown keys are dropped, the record still renders.
 */
export const SessionJournalCallSchema: z.ZodType<SessionJournalCall> = z.object({
  operation: z.string(),
  method: z.string(),
  path: z.string(),
  baseUrl: z.string(),
  status: z.number().int().nullable(),
  requestChars: z.number().int().nonnegative(),
  responseChars: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});

export const SessionJournalRecordSchema: z.ZodType<SessionJournalRecord> = z.object({
  v: z.literal(1),
  seq: z.number().int().nonnegative(),
  class: z.enum(['agent', 'harness', 'human']).optional(),
  sessionId: EntityIdSchema,
  spaceId: EntityIdSchema.nullable(),
  teamMemberId: EntityIdSchema.nullable(),
  pid: z.number().int(),
  startedAt: IsoTimestamp,
  durationMs: z.number().int().nonnegative(),
  command: z.object({
    path: z.array(z.string()),
    argv: z.array(z.string()),
    cwd: z.string(),
  }),
  input: z.object({ stdinChars: z.number().int().nonnegative() }),
  output: z.object({
    stdoutChars: z.number().int().nonnegative(),
    stderrChars: z.number().int().nonnegative(),
    stdoutSample: z.string(),
    stderrSample: z.string(),
    truncated: z.boolean(),
  }),
  calls: z.array(SessionJournalCallSchema),
  result: z.object({ exitCode: z.number().int(), error: z.string().nullable() }),
  tokens: z.object({
    estimator: z.literal('chars/4'),
    agentToCli: z.number().int().nonnegative(),
    cliToAgent: z.number().int().nonnegative(),
  }),
});

export const SessionJournalPageSchema: z.ZodType<SessionJournalPage> = z.object({
  sessionId: EntityIdSchema,
  available: z.boolean(),
  unavailableReason: z.enum(['no_journal_file', 'unreadable']).nullable(),
  totals: z.object({
    invocations: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    agentToCliEst: z.number().int().nonnegative(),
    cliToAgentEst: z.number().int().nonnegative(),
    estimator: z.literal('chars/4'),
    malformed: z.number().int().nonnegative(),
  }).strict(),
  records: z.array(SessionJournalRecordSchema),
  hasMore: z.boolean(),
}).strict();

/**
 * `manifest` is `z.record(z.unknown())` and NOT a modelled object: the stored
 * document was written by whatever build spawned the session, and validating
 * its interior would make this read fail closed on exactly the sessions a
 * debug surface most needs to explain. The envelope around it is strict.
 */
export const SessionLaunchRecordSchema: z.ZodType<SessionLaunchRecord> = z.object({
  sessionId: EntityIdSchema,
  available: z.boolean(),
  unavailableReason: z.enum(['no_manifest_row']).nullable(),
  manifest: z.record(z.unknown()).nullable(),
  envVarNames: z.array(z.string()),
  prompts: z.object({
    system: z.string().nullable(),
    task: z.string().nullable(),
    unavailableReason: z.enum(['not_recorded']).nullable(),
  }).strict(),
  recordedAt: z.string().nullable(),
}).strict();

/**
 * execution.transcript. Strict everywhere, unlike the journal above: nothing in
 * this page is a foreign record passed through — every field is computed by the
 * server from the native JSONL, so an unknown key here is a tm8 bug, not an
 * older CLI. The native records' own shape drift is absorbed in the reader,
 * which counts what it cannot parse as `malformed` and keeps going.
 */
export const SessionTranscriptEntrySchema: z.ZodType<SessionTranscriptEntry> = z.object({
  at: IsoTimestamp.nullable(),
  source: z.enum(['user', 'assistant']),
  text: z.string(),
  truncated: z.boolean(),
}).strict();

export const SessionTranscriptStatsSchema: z.ZodType<SessionTranscriptStats> = z.object({
  partial: z.boolean(),
  userMessages: z.number().int().nonnegative(),
  assistantMessages: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  // Nullable, not zero-defaulted: an agent that has not reported usage yet is
  // not an agent that used no tokens, and a debug surface must show the
  // difference.
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheCreationTokens: z.number().int().nonnegative().nullable(),
  tools: z.array(z.object({
    name: z.string(),
    count: z.number().int().positive(),
  }).strict()),
  models: z.array(z.string()),
}).strict();

export const SessionTranscriptStuckSchema: z.ZodType<SessionTranscriptStuck> = z.object({
  silentMs: z.number().int().nonnegative(),
  toolCallsSinceText: z.number().int().nonnegative(),
}).strict();

export const SessionTranscriptPageSchema: z.ZodType<SessionTranscriptPage> = z.object({
  sessionId: EntityIdSchema,
  available: z.boolean(),
  unavailableReason: z.enum([
    'no_native_session_id',
    'unsupported_agent_tool',
    'no_transcript_file',
    'unreadable',
  ]).nullable(),
  agentTool: z.enum(['claude-code', 'codex']).nullable(),
  entries: z.array(SessionTranscriptEntrySchema),
  // Nullable for the same reason `entries` is empty on an unavailable page:
  // there are no statistics about a transcript that was never found, and a
  // zeroed object would read as "this agent did nothing".
  stats: SessionTranscriptStatsSchema.nullable(),
  stuck: SessionTranscriptStuckSchema.nullable(),
  lastActivityAt: IsoTimestamp.nullable(),
  malformed: z.number().int().nonnegative(),
}).strict();

// ---------------------------------------------------------------------------
// W0 adopted amendment DTOs (A05-A20 and frozen-row shapes)
// ---------------------------------------------------------------------------

export const AddMessageAttachmentsInputSchema: z.ZodType<AddMessageAttachmentsInput> = z.object({
  clientMutationId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  fileEntityIds: uniqueArray(EntityIdSchema, 1, 16),
}).strict();
export const RemoveMessageAttachmentsInputSchema: z.ZodType<RemoveMessageAttachmentsInput> =
  AddMessageAttachmentsInputSchema;

export const MessageDeliveryStatusSchema = z.enum([
  'pending', 'dispatching', 'delivered', 'failed_retryable',
  'failed_permanent', 'unknown', 'expired', 'cancelled',
]);

export const MessageDeliveryQuerySchema: z.ZodType<MessageDeliveryQuery> = z.object({
  cursor: CursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export const MessageDeliveryRecordSchema: z.ZodType<MessageDeliveryRecord> = z.object({
  deliveryId: z.string().min(1),
  messageId: EntityIdSchema,
  sourceWorkSessionId: EntityIdSchema.nullable(),
  targetWorkSessionId: EntityIdSchema,
  status: MessageDeliveryStatusSchema,
  attemptNo: z.number().int().positive(),
  failureReason: z.string().nullable(),
  reservedAt: IsoTimestamp,
  claimedAt: IsoTimestamp.nullable(),
  settledAt: IsoTimestamp.nullable(),
  updatedAt: IsoTimestamp,
}).strict();

export const MessageDeliveryViewSchema: z.ZodType<MessageDeliveryView> = z.lazy(() => z.object({
  message: MessageViewSchema,
  deliveries: z.array(MessageDeliveryRecordSchema),
}).strict());

export const HandoffDeliveryStatusSchema = z.enum(['prepared', 'dispatching', 'delivered', 'refused', 'unknown']);
export const HandoffRecordStatusSchema = z.enum(['pending', 'recorded', 'failed', 'withdrawn']);

export const ShareProjectionEnvelopeSchema: z.ZodType<ShareProjectionEnvelope> = z.object({
  entityId: EntityIdSchema,
  kind: EntityKindSchema,
  title: z.string(),
  contentVersion: z.number().int().positive(),
  sourceSpaceId: SpaceIdSchema,
  body: z.string(),
  bodyBytes: z.number().int().min(0).max(32_768),
  truncated: z.boolean(),
  omittedFields: z.array(z.string()),
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(value.body, 'utf8') !== value.bodyBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['bodyBytes'], message: 'bodyBytes must equal the UTF-8 body length' });
  }
});

export const SendHandoffInputSchema: z.ZodType<SendHandoffInput> = z.object({
  clientMutationId: z.string().min(1),
  sourceEntityId: EntityIdSchema,
}).strict();

export const HandoffListQuerySchema: z.ZodType<HandoffListQuery> = z.object({
  deliveryStatus: uniqueArray(HandoffDeliveryStatusSchema).optional(),
  recordStatus: uniqueArray(HandoffRecordStatusSchema).optional(),
  cursor: CursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export const WithdrawHandoffInputSchema: z.ZodType<WithdrawHandoffInput> = z.object({
  clientMutationId: z.string().min(1),
  expectedRecordVersion: z.number().int().positive(),
  reason: z.string().min(1).max(256).optional(),
}).strict();

export const HandoffViewSchema: z.ZodType<HandoffView> = z.object({
  handoffId: z.string().min(1),
  sourceEntityId: EntityIdSchema,
  targetWorkSessionId: EntityIdSchema,
  deliveryStatus: HandoffDeliveryStatusSchema,
  recordStatus: HandoffRecordStatusSchema,
  sourceSnapshot: ShareProjectionEnvelopeSchema,
  envelopeHash: z.string().min(1),
  sourceMissing: z.boolean(),
  recordVersion: z.number().int().positive(),
  withdrawnBy: ActorSummarySchema.nullable(),
  withdrawnAt: IsoTimestamp.nullable(),
  withdrawReason: z.string().min(1).max(256).nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
}).strict().superRefine((value, context) => {
  const terminalDelivery = ['delivered', 'refused', 'unknown'].includes(value.deliveryStatus);
  if (!terminalDelivery && value.recordStatus !== 'pending') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['recordStatus'], message: 'prepared/dispatching handoffs must remain pending' });
  }
  const withdrawn = value.recordStatus === 'withdrawn';
  if (withdrawn !== (value.withdrawnAt !== null && value.withdrawnBy !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'withdrawn handoffs require withdrawnAt and withdrawnBy only together' });
  }
});

export const EntityFeedQuerySchema: z.ZodType<EntityFeedQuery> = z.object({
  scope: z.enum(['default', 'direct_v1', 'session_chat_v1']).optional(),
  order: z.enum(['newest', 'oldest']).optional(),
  around: z.string().regex(/^(message|activity):[^:]+$/).optional() as z.ZodType<`message:${string}` | `activity:${string}` | undefined>,
  cursor: CursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (value.around !== undefined && value.cursor !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'around and cursor are mutually exclusive' });
  }
});

export const DeliverySummarySchema: z.ZodType<DeliverySummary> = z.object({
  deliveryId: z.string().min(1),
  targetWorkSessionId: EntityIdSchema,
  targetWorkSession: EntitySummarySchema.nullable().optional(),
  status: MessageDeliveryStatusSchema,
  attemptNo: z.number().int().positive(),
  failureReason: z.string().nullable(),
  updatedAt: IsoTimestamp,
}).strict();

const feedItemBaseShape = {
  itemId: z.string().min(1),
  createdAt: IsoTimestamp,
  sortId: z.string().min(1),
  via: uniqueArray(z.enum(['subject', 'anchored', 'authored', 'replies', 'caused']), 1),
  actor: ActorSummarySchema.nullable(),
  sourceWorkSessionId: EntityIdSchema.nullable(),
  anchor: EntitySummarySchema.nullable(),
  logicalOperationId: z.string().nullable(),
};

export const FeedItemSchema: z.ZodType<FeedItem> = z.lazy(() => z.discriminatedUnion('itemKind', [
  z.object({
    ...feedItemBaseShape,
    itemKind: z.literal('message'),
    message: MessageViewSchema,
    delivery: z.array(DeliverySummarySchema),
    linkedWorkSessions: z.array(EntitySummarySchema).optional(),
  }).strict(),
  z.object({
    ...feedItemBaseShape,
    itemKind: z.literal('activity'),
    activity: ActivityItemSchema,
  }).strict(),
]));

export const EntityFeedPageSchema: z.ZodType<EntityFeedPage> = z.lazy(() => z.object({
  resolvedScope: z.enum(['direct_v1', 'session_chat_v1']),
  predicates: uniqueArray(z.enum(['subject', 'anchored', 'authored', 'replies', 'caused']), 1),
  items: z.array(FeedItemSchema),
  nextCursor: CursorSchema.nullable(),
  previousCursor: CursorSchema.nullable().optional(),
}).strict());

export const EntityContextQuerySchema: z.ZodType<EntityContextQuery> = z.object({
  sections: uniqueArray(z.enum(['summary', 'hierarchy', 'connections', 'messages', 'activity', 'actions'])).optional(),
  totalBytes: z.number().int().min(1024).max(32_768).optional(),
  sectionBytes: z.number().int().min(512).max(8192).optional(),
}).strict();

export const EntityContextViewSchema: z.ZodType<EntityContextView> = z.lazy(() => z.object({
  schemaVersion: z.literal('tm8.entity-context.v1'),
  root: EntitySummarySchema,
  content: z.object({
    excerpt: z.string(),
    source: z.enum(['entity', 'message', 'file']),
    truncated: z.boolean(),
  }).strict().optional(),
  parents: z.array(EntitySummarySchema),
  children: z.array(EntitySummarySchema),
  edges: z.array(EdgeViewSchema),
  messages: z.array(MessageViewSchema),
  actions: z.array(PaletteActionSchema),
  provenance: z.object({
    operation: z.custom<OperationName>(isOperationName),
    fetchedAt: IsoTimestamp,
    eventSeq: z.number().int().nonnegative(),
  }).strict(),
  cursors: z.record(CursorSchema.nullable()),
  byteSize: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict());

const OperationNameSchema = z.custom<OperationName>(isOperationName, 'must be a catalogued operation name');

export const ClosedPromptPolicySchema: z.ZodType<ClosedPromptPolicy> = z.object({
  kernelTemplate: z.string().min(1),
  manifestMaxBytes: z.number().int().min(1).max(4096),
  kernelMaxBytes: z.number().int().min(1).max(6144),
  initialContextMaxBytes: z.number().int().min(1).max(32_768),
  rollingControlMaxBytes: z.number().int().min(1).max(32_768),
  allowedInjectionKinds: uniqueArray(z.string().min(1)),
  untrustedEncoding: z.literal('escaped-xml'),
}).strict();

export const ToolDiscoveryPolicySchema: z.ZodType<ToolDiscoveryPolicy> = z.object({
  rootHelpRef: z.literal('tm8://help'),
  preloadNouns: uniqueArray(z.string().min(1)),
  semanticSearchEnabled: z.boolean(),
  semanticMaxMatches: z.number().int().min(0).max(5),
  nounShardMaxBytes: z.number().int().min(1).max(32_768),
  commandShardMaxBytes: z.number().int().min(1).max(32_768),
  entityContextDefaultBytes: z.number().int().min(1024).max(32_768),
  providerToolRegistrationAllowlist: uniqueArray(OperationNameSchema).optional(),
}).strict();

export const FeedPolicySchema: z.ZodType<FeedPolicy> = z.object({
  scope: z.enum(['direct_v1', 'session_chat_v1']),
  pageSize: z.number().int().min(1).max(100),
  bodyExcerptBytes: z.number().int().min(0).max(4096),
}).strict();

export const ComposerInteractionPolicySchema: z.ZodType<ComposerInteractionPolicy> = z.object({
  schemaRef: z.string().min(1),
  supportsReply: z.boolean(),
  supportsAttachments: z.boolean(),
  allowedAttachmentKinds: uniqueArray(z.string().min(1)),
  operationBindings: uniqueArray(OperationNameSchema),
}).strict();

export const WorkSessionInteractionProfileProjectionSchema: z.ZodType<
  import('./contract.js').WorkSessionInteractionProfileProjection
> = z.object({
  pinRevision: z.number().int().positive(),
  templateKey: z.string().min(1),
  templateVersion: z.number().int().positive(),
  compatibility: z.enum(['supported', 'unknown_template']),
  chatEnabled: z.boolean(),
  initialContentSurface: z.enum(['terminal', 'chat']),
  feedPolicy: FeedPolicySchema,
  composerPolicy: ComposerInteractionPolicySchema,
}).strict();

export const InteractionProfileDraftSchema: z.ZodType<InteractionProfileDraft> = z.object({
  name: z.string().min(1).max(80),
  templateKey: z.string().min(1),
  templateVersion: z.number().int().positive(),
  promptPolicy: ClosedPromptPolicySchema,
  toolDiscoveryPolicy: ToolDiscoveryPolicySchema,
  feedPolicy: FeedPolicySchema,
  providerCaptureMode: z.literal('explicit-only'),
  composerPolicy: ComposerInteractionPolicySchema,
  /* Which Content surface this profile opens on. OPTIONAL on purpose: every
     draft written before this field existed stays valid, and an absent value
     means "defer to the pinned static template" — exactly the behaviour those
     drafts already had. Authors who set it are choosing, not overriding. */
  initialContentSurface: z.enum(['terminal', 'chat']).optional(),
}).strict();

export const ProposeInteractionProfileInputSchema: z.ZodType<ProposeInteractionProfileInput> = z.object({
  clientMutationId: z.string().min(1),
  spaceId: SpaceIdSchema,
  draft: InteractionProfileDraftSchema,
}).strict();

export const UpdateInteractionProfileDraftInputSchema: z.ZodType<UpdateInteractionProfileDraftInput> = z.object({
  clientMutationId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  draft: InteractionProfileDraftSchema,
}).strict();

export const ValidateInteractionProfileInputSchema: z.ZodType<ValidateInteractionProfileInput> = z.object({
  clientMutationId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
}).strict();

export const PreviewInteractionProfileInputSchema: z.ZodType<PreviewInteractionProfileInput> = z.object({
  profileVersion: z.number().int().positive(),
}).strict();

export const ActivateInteractionProfileInputSchema: z.ZodType<ActivateInteractionProfileInput> = z.object({
  clientMutationId: z.string().min(1),
  validatedVersion: z.number().int().positive(),
  validatedHash: z.string().min(1),
  confirm: z.literal(true),
}).strict();

export const RetireInteractionProfileInputSchema: z.ZodType<RetireInteractionProfileInput> = z.object({
  clientMutationId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  confirm: z.literal(true),
}).strict();

export const SetTeammateProfileDefaultInputSchema: z.ZodType<SetTeammateProfileDefaultInput> = z.object({
  clientMutationId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  profileId: EntityIdSchema.nullable(),
}).strict();

export const SetSpaceProfileDefaultInputSchema: z.ZodType<SetSpaceProfileDefaultInput> = z.object({
  clientMutationId: z.string().min(1),
  expectedSettingsRevision: z.number().int().positive(),
  profileId: EntityIdSchema.nullable(),
  confirmAgentGenerated: z.literal(true).optional(),
}).strict();

export const InteractionProfileViewSchema: z.ZodType<InteractionProfileView> = z.object({
  profileId: EntityIdSchema,
  spaceId: SpaceIdSchema,
  status: z.enum(['draft', 'active', 'retired']),
  currentDraftVersion: z.number().int().positive(),
  validatedVersion: z.number().int().positive().nullable(),
  validatedHash: z.string().nullable(),
  activeVersion: z.number().int().positive().nullable(),
  activeHash: z.string().nullable(),
  generatedByTeamMemberId: EntityIdSchema.nullable(),
  retiredAt: IsoTimestamp.nullable(),
  version: z.number().int().positive(),
  draft: InteractionProfileDraftSchema,
}).strict();

export const ProfileValidationIssueSchema: z.ZodType<ProfileValidationIssue> = z.object({
  path: z.string(),
  code: z.string().min(1),
  message: z.string().min(1),
}).strict();

export const ProfileValidationViewSchema: z.ZodType<ProfileValidationView> = z.object({
  profileId: EntityIdSchema,
  profileVersion: z.number().int().positive(),
  status: z.enum(['valid', 'invalid']),
  validatedHash: z.string().nullable(),
  issues: z.array(ProfileValidationIssueSchema),
}).strict();

export const InteractionProfilePreviewSchema: z.ZodType<InteractionProfilePreview> = z.object({
  profileId: EntityIdSchema,
  profileVersion: z.number().int().positive(),
  name: z.string().min(1).max(80),
  templateKey: z.string().min(1),
  templateVersion: z.number().int().positive(),
  feedPolicy: FeedPolicySchema,
  composerPolicy: ComposerInteractionPolicySchema,
  validatedHash: z.string().nullable(),
  generatedByTeamMemberId: EntityIdSchema.nullable(),
}).strict();

export const TeammateProfileDefaultViewSchema: z.ZodType<TeammateProfileDefaultView> = z.object({
  teamMemberId: EntityIdSchema,
  defaultInteractionProfileId: EntityIdSchema.nullable(),
  version: z.number().int().positive(),
}).strict();

export const SpaceProfileDefaultViewSchema: z.ZodType<SpaceProfileDefaultView> = z.object({
  spaceId: SpaceIdSchema,
  defaultInteractionProfileId: EntityIdSchema.nullable(),
  settingsRevision: z.number().int().positive(),
}).strict();

export const InteractionProfilePinViewSchema: z.ZodType<InteractionProfilePinView> = z.object({
  workSessionId: EntityIdSchema,
  pinRevision: z.number().int().positive(),
  profileId: EntityIdSchema.nullable(),
  profileVersion: z.number().int().positive().nullable(),
  templateKey: z.string().min(1),
  templateVersion: z.number().int().positive(),
  resolvedHash: z.string().min(1),
  source: z.enum(['spawn_override', 'teammate_default', 'space_default', 'core_default']),
  createdAt: IsoTimestamp,
}).strict();

export const InboxRecipientSchema: z.ZodType<InboxRecipient> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('member'), memberId: EntityIdSchema }).strict(),
  z.object({ type: z.literal('team_member'), teamMemberId: EntityIdSchema }).strict(),
]);

export const InboxListQuerySchema: z.ZodType<InboxListQuery> = z.object({
  recipient: InboxRecipientSchema.optional(),
  spaceId: SpaceIdSchema.optional(),
  unread: z.boolean().optional(),
  cursor: CursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export const InboxMarkReadInputSchema: z.ZodType<InboxMarkReadInput> = z.object({
  clientMutationId: z.string().min(1),
  recipient: InboxRecipientSchema.optional(),
}).strict();

// ---------------------------------------------------------------------------
// Custom entity kinds (T-L4)
// ---------------------------------------------------------------------------

export const CustomFieldDefSchema: z.ZodType<CustomFieldDef> = z.object({
  name: z.string().min(1),
  type: z.enum(['text', 'number', 'bool', 'date', 'enum']),
  required: z.boolean().optional(),
  values: z.array(z.string()).optional(),
}).strict();

export const EntityKindDefSchema: z.ZodType<EntityKindDef> = z.object({
  id: z.string(),
  kind: EntityKindSchema,
  origin: z.enum(['core', 'custom']),
  spaceId: SpaceIdSchema.nullable(),
  icon: z.string().nullable().optional(),
  fieldSchema: z.array(CustomFieldDefSchema),
  capabilities: z.record(z.boolean()),
  createdBy: EntityIdSchema.nullable().optional(),
  createdAt: IsoTimestamp,
}).strict();

export const EntityKindCreateInputSchema: z.ZodType<EntityKindCreateInput> = z.object({
  ...commandContextShape,
  kind: CustomEntityKindSchema,
  icon: z.string().nullable().optional(),
  fieldSchema: z.array(CustomFieldDefSchema),
  capabilities: z.record(z.boolean()).optional(),
}).strict();

export const EntityKindUpdateInputSchema: z.ZodType<EntityKindUpdateInput> = z.object({
  ...commandContextShape,
  icon: z.string().nullable().optional(),
  fieldSchema: z.array(CustomFieldDefSchema).optional(),
  capabilities: z.record(z.boolean()).optional(),
  allowTightening: z.boolean().optional(),
}).strict();

// ---------------------------------------------------------------------------
// Facade-defined read shapes
// ---------------------------------------------------------------------------

export const SpaceSummarySchema: z.ZodType<SpaceSummary> = z.object({
  id: SpaceIdSchema,
  name: z.string(),
  description: z.string(),
  memberCount: z.number().int().nonnegative(),
  unreadTotal: z.number().int().nonnegative(),
  githubRepo: z.string().nullable().optional(),
  createdAt: IsoTimestamp,
}).strict();

export const NavChannelNodeSchema: z.ZodType<NavChannelNode> = z.lazy(() => z.object({
  entity: EntitySummarySchema,
  childCount: z.number().int().nonnegative(),
  children: z.array(NavChannelNodeSchema),
}).strict());

export const SpaceNavigationSchema: z.ZodType<SpaceNavigation> = z.lazy(() => z.object({
  spaceId: SpaceIdSchema,
  viewer: ActorSummarySchema,
  unreadTotal: z.number().int().nonnegative(),
  channels: z.array(NavChannelNodeSchema),
}).strict());

export const KindCountsSchema: z.ZodType<KindCounts> = z.object({
  total: z.number().int().nonnegative(),
  unseen: z.number().int().nonnegative(),
}).strict();

// Keyed by kind, and PARTIAL: kinds with no rows are absent, not zero. A
// record keyed by `EntityKindSchema` rather than an enum-keyed object is what
// lets a custom `c:*` kind carry counters without a schema change.
export const SpaceKindCountsSchema: z.ZodType<SpaceKindCounts> =
  z.record(EntityKindSchema, KindCountsSchema);

export const HomeSnapshotSchema: z.ZodType<HomeSnapshot> = z.lazy(() => z.object({
  readyToPull: CollectionResultSchema,
  inFlight: CollectionResultSchema,
  needsMe: CollectionResultSchema,
  activity: pageOf(ActivityItemSchema),
}).strict());

export const TaskAxisSchema: z.ZodType<TaskAxis> = z.object({
  id: z.string(),
  spaceId: SpaceIdSchema,
  name: z.string(),
  axisValues: z.array(z.string()),
  kind: z.enum(['default', 'manual']),
  position: z.number(),
}).strict();

export const LeaderboardRowSchema: z.ZodType<LeaderboardRow> = z.object({
  actor: ActorSummarySchema,
  score: z.number(),
  rank: z.number().int().positive(),
}).strict();

export const PointEventViewSchema: z.ZodType<PointEventView> = z.lazy(() => z.object({
  id: z.string(),
  recipient: ActorSummarySchema,
  actor: ActorSummarySchema,
  amount: z.number(),
  reason: z.enum(['grant', 'award', 'seed']),
  onEntity: EntitySummarySchema.nullable(),
  ref: EntitySummarySchema.nullable(),
  createdAt: IsoTimestamp,
}).strict());

export const SpaceSettingsSchema: z.ZodType<SpaceSettings> = z.lazy(() => z.object({
  space: SpaceSummarySchema,
  members: z.array(z.object({
    actor: ActorSummarySchema,
    role: z.enum(['owner', 'admin', 'member']),
    joinedAt: IsoTimestamp,
  }).strict()),
  invites: z.array(z.object({
    id: z.string(),
    code: z.string(),
    maxUses: z.number().int(),
    uses: z.number().int().nonnegative(),
    expiresAt: IsoTimestamp.nullable(),
    revoked: z.boolean(),
  }).strict()),
  taskAxes: z.array(TaskAxisSchema),
}).strict());

export const SpaceSettingsViewSchema: z.ZodType<SpaceSettingsView> = z.lazy(() => z.object({
  space: SpaceSummarySchema,
  members: z.array(z.object({
    actor: ActorSummarySchema,
    role: z.enum(['owner', 'admin', 'member']),
    joinedAt: IsoTimestamp,
  }).strict()),
  invites: z.array(z.object({
    id: z.string(),
    code: z.string(),
    maxUses: z.number().int(),
    uses: z.number().int().nonnegative(),
    expiresAt: IsoTimestamp.nullable(),
    revoked: z.boolean(),
  }).strict()),
  taskAxes: z.array(TaskAxisSchema),
  menu: MenuConfigSchema,
  defaultChannelId: EntityIdSchema.nullable(),
  defaultInteractionProfileId: EntityIdSchema.nullable(),
  settingsRevision: z.number().int().positive(),
}).strict());

export const SavedViewSchema: z.ZodType<SavedView> = z.lazy(() => z.object({
  id: z.string(),
  spaceId: SpaceIdSchema,
  name: z.string(),
  shareMode: z.enum(['private', 'space']),
  query: CollectionQuerySchema,
  graphLayout: z.record(z.object({ x: z.number(), y: z.number() }).strict()).optional(),
  createdBy: ActorSummarySchema,
  createdAt: IsoTimestamp,
}).strict());

export const PaletteActionSchema: z.ZodType<PaletteAction> = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  operation: OperationNameSchema,
  targetEntityId: EntityIdSchema.optional(),
  targetVersion: z.number().int().positive().optional(),
  capabilityEpoch: z.string().min(1),
  authzTarget: z.enum(['server', 'space', 'project', 'entity', 'session']),
  exposure: z.enum(['public', 'composite', 'internal', 'reserved']),
  helpRef: z.string().min(1),
}).strict();

export const ActionDiscoveryResultSchema: z.ZodType<ActionDiscoveryResult> = z.object({
  actorId: EntityIdSchema,
  targetEntityId: EntityIdSchema.optional(),
  targetVersion: z.number().int().positive().optional(),
  capabilityEpoch: z.string().min(1),
  actions: z.array(PaletteActionSchema),
}).strict();

// ---------------------------------------------------------------------------
// Wire envelope + error body (DEV-6 / DEV-8)
// ---------------------------------------------------------------------------

export const CommandErrorCodeSchema: z.ZodType<CommandErrorCode> = z.enum([
  'invalid_input', 'invalid_cursor',
  'unauthenticated', 'forbidden', 'not_found',
  'version_conflict', 'conflict', 'invariant_violation',
  'payload_too_large', 'rate_limited', 'limit_exceeded',
  'not_implemented', 'upstream_unavailable',
]);

export const ErrorCodeSchema: z.ZodType<ErrorCode> = z.enum([
  'invalid_input', 'forbidden', 'not_found', 'conflict',
  'invariant_violation', 'limit_exceeded', 'not_implemented',
]);

export const AmendmentErrorReasonSchema: z.ZodType<AmendmentErrorReason> = z.enum([
  'use_message_send', 'automated_wake_limit', 'session_contact_forbidden',
  'handoff_forbidden', 'message_batch_identity_mismatch',
  'feed_scope_not_applicable', 'feed_item_not_in_scope',
  'project_not_linked', 'project_association_cap', 'project_over_cap',
  'menu_revision_conflict', 'menu_upgrade_required',
  'profile_not_validated', 'profile_referenced_default', 'profile_retired',
  'profile_principal_required', 'profile_capture_mode_reserved',
  'attachment_edge_owned',
]);

export const ErrorDetailsSchema: z.ZodType<ErrorDetails> = z.object({
  reason: z.string().min(1),
  currentVersion: z.number().int().positive().optional(),
  currentRevision: z.number().int().positive().optional(),
  currentMenu: MenuConfigSchema.optional(),
  activeLinks: z.number().int().nonnegative().optional(),
  deliveryId: z.string().min(1).optional(),
}).strict();

export const WireErrorBodySchema: z.ZodType<WireErrorBody> = z.object({
  error: z.object({
    code: CommandErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string(),
    retryable: z.boolean(),
  }).strict(),
}).strict();

export function envelopeOf<T>(data: z.ZodType<T>) {
  return z.object({ data, requestId: z.string() }).strict();
}
