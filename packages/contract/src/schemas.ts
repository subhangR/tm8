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
import { SHA256_HEX_RE } from './contract.js';
import type {
  AcceptanceCriterion, ActivityItem, ActorSummary, ChannelTab, CollectionGroup,
  CollectionQuery, CollectionResult, CommandContext, CommandErrorCode,
  CommandResult, CompleteTaskInput, Connections, CreateEdgeInput,
  CreateEntityInput, CreateSpaceInput, CreateTaskInput, CustomEntityKind, CustomFieldDef,
  CustomFieldValue, EdgeGroup, EdgeView, EntityBadges, EntityCapabilities,
  EntityContent, EntityCounters, EntityDetail, EntityKind, EntityKindCreateInput,
  EntityKindDef, EntityKindUpdateInput, EntityState, EntitySummary,
  ExecutionPromptInput, ExecutionSpawnInput, ExecutionStreamsAttachInput,
  ExecutionTerminateInput, FileAttachment, FileUploadGrant, FileUploadInitInput,
  GraphQuery, GraphResult,
  GrantPointsInput, Hierarchy, HomeSnapshot, LeaderboardRow, LinkCommitInput,
  LinkPrInput, LiveWork, Mention, MessageView, MoveEntityInput,
  NavChannelNode, NotificationItem, Page, PaletteAction, PatchEdgeInput,
  PatchEntityInput, PatchMessageInput, PatchTaskInput, PlacementInput,
  PointEventView, PostMessageInput, PresenceSnapshot, ProjectCreateInput,
  ProjectDefaults, ProjectLinkInput, ProjectResource, ProjectTrustLevel,
  ProjectUpdateInput, PullInput, PullState,
  ReactionInput, SavedView, SavedViewInput, SpaceNavigation, SpaceSettings,
  SpaceSummary, SpawnWorkdir, StreamAttachGrant, TaskAxis, TaskAxisInput,
  TrackingRefreshInput, UndoToken, UpdateSpaceInput, WorkInput, WorkSessionShareMode,
  WorkSessionStatus, WorkspaceEvent,
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

export const CoreEntityKindSchema = z.enum([
  'channel', 'task', 'message', 'member', 'team_member',
  'doc', 'file', 'spell', 'skill', 'pull_request', 'commit',
  'work_session', 'collection',
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

// ---------------------------------------------------------------------------
// Actors, counters
// ---------------------------------------------------------------------------

export const ActorSummarySchema: z.ZodType<ActorSummary> = z.object({
  id: EntityIdSchema,
  kind: z.enum(['member', 'team_member']),
  displayName: z.string(),
  avatar: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  ownerMemberId: EntityIdSchema.optional(),
  isAgent: z.boolean(),
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
    editedAt: z.string().nullable().optional(),
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
  }).strict(),
  z.object({
    kind: z.literal('collection'),
    collectionType: z.string(),
    itemCount: z.number().int().nonnegative(),
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
  blocked: z.object({
    unresolvedHardDependencyCount: z.number().int().nonnegative(),
    waitingOn: z.array(EntitySummarySchema),
  }).strict().optional(),
  pulls: z.array(PullStateSchema).optional(),
  workingActors: z.array(LiveWorkSchema).optional(),
  restricted: z.boolean().optional(),
}).strict());

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
  resolved: z.boolean().optional(),
  hard: z.boolean().optional(),
}).strict());

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
    projectId: z.string().nullable(),
    workingOn: z.array(EntitySummarySchema),
    transcriptDoc: EntitySummarySchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal('collection'),
    description: z.string(),
    items: z.array(EntitySummarySchema),
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
  inFlightForActorId: EntityIdSchema.optional(),
  needsActorId: EntityIdSchema.optional(),
  deleted: z.enum(['exclude', 'only', 'include']).optional(),
}).strict();

function collectionQueryShape() {
  return {
    spaceId: SpaceIdSchema,
    kinds: z.array(EntityKindSchema).optional(),
    subtreeOf: EntityIdSchema.optional(),
    parentId: EntityIdSchema.nullable().optional(),
    filters: CollectionFiltersSchema.optional(),
    layout: z.enum(['list', 'board', 'tree', 'feed', 'gallery', 'graph']).optional(),
    groupBy: GroupBySchema.optional(),
    sort: z.enum(['activityAt_desc', 'createdAt_desc', 'position', 'dueDate', 'priority']).optional(),
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
  editedAt: z.string().nullable().optional(),
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

export const ActivityItemSchema: z.ZodType<ActivityItem> = z.lazy(() => z.object({
  id: z.string(),
  entityId: EntityIdSchema.nullable().optional(),
  actor: ActorSummarySchema.nullable().optional(),
  verb: z.string(),
  summary: z.record(z.unknown()),
  createdAt: IsoTimestamp,
  refId: z.string().nullable().optional(),
}).strict());

export const PresenceSnapshotSchema: z.ZodType<PresenceSnapshot> = z.object({
  viewers: z.array(ActorSummarySchema),
  typingActorIds: z.array(EntityIdSchema),
  updatedAt: IsoTimestamp,
}).strict();

export const NotificationItemSchema: z.ZodType<NotificationItem> = z.lazy(() => z.object({
  id: z.string(),
  spaceId: SpaceIdSchema,
  kind: z.string(),
  actor: ActorSummarySchema.nullable().optional(),
  target: EntitySummarySchema.nullable().optional(),
  message: z.string().optional(),
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
]));

// ---------------------------------------------------------------------------
// Commands: shared envelope, results, undo
// ---------------------------------------------------------------------------

const commandContextShape = {
  actorId: EntityIdSchema.optional(),
  clientMutationId: z.string().optional(),
};

export const CommandContextSchema: z.ZodType<CommandContext> =
  z.object(commandContextShape).strict();

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

export const CreateEntityInputSchema: z.ZodType<CreateEntityInput> = z.object({
  ...commandContextShape,
  spaceId: SpaceIdSchema,
  kind: z.union([
    CoreEntityKindSchema.exclude(['message', 'member', 'work_session']),
    CustomEntityKindSchema,
  ]),
  title: z.string().min(1),
  parentId: EntityIdSchema.nullable().optional(),
  position: z.number().optional(),
  content: z.record(z.unknown()).optional(),
  attachTo: attachToSchema.optional(),
}).strict() as z.ZodType<CreateEntityInput>;

export const PatchEntityInputSchema: z.ZodType<PatchEntityInput> = z.object({
  ...commandContextShape,
  expectedVersion: z.number().finite(),
  title: z.string().optional(),
  content: z.record(z.unknown()).optional(),
}).strict();

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

export const PostMessageInputSchema: z.ZodType<PostMessageInput> = z.object({
  ...commandContextShape,
  anchorId: EntityIdSchema,
  body: z.string().min(1).max(10_000),
  parentMessageId: EntityIdSchema.nullable().optional(),
  mentions: z.array(MentionSchema).optional(),
  attachments: z.array(FileAttachmentSchema).optional(),
}).strict();

export const PatchMessageInputSchema: z.ZodType<PatchMessageInput> = z.object({
  ...commandContextShape,
  body: z.string().min(1).max(10_000),
  mentions: z.array(MentionSchema).optional(),
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
  url: z.string().url(),
}).strict();

export const LinkCommitInputSchema: z.ZodType<LinkCommitInput> = z.object({
  ...commandContextShape,
  url: z.string().url(),
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
// Projects — linked resources (AM-2 §1, T-D17)
// ---------------------------------------------------------------------------

export const ProjectIdSchema = z.string().min(1);

export const ProjectTrustLevelSchema: z.ZodType<ProjectTrustLevel> =
  z.enum(['trusted', 'untrusted']);

export const ProjectDefaultsSchema: z.ZodType<ProjectDefaults> = z.object({
  model: z.string().nullable().optional(),
  agentTool: z.string().nullable().optional(),
  mode: z.enum(['worker', 'coordinator', 'coordinated-worker', 'coordinated-coordinator']).nullable().optional(),
}).strict();

export const ProjectResourceSchema: z.ZodType<ProjectResource> = z.object({
  id: ProjectIdSchema,
  name: z.string(),
  repoUrl: z.string().nullable().optional(),
  workingDir: z.string(),
  trust: ProjectTrustLevelSchema,
  defaults: ProjectDefaultsSchema,
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

/** Complete/abort carry only the command context; ids travel in the path. */
export const FileUploadCompleteInputSchema = CommandContextSchema;
export const FileUploadAbortInputSchema = CommandContextSchema;

// ---------------------------------------------------------------------------
// execution.* inputs (R16)
// ---------------------------------------------------------------------------

export const SpawnWorkdirSchema: z.ZodType<SpawnWorkdir> = z.object({
  mode: z.enum(['project', 'worktree']),
  baseRef: z.string().nullable().optional(),
}).strict();

export const ExecutionSpawnInputSchema: z.ZodType<ExecutionSpawnInput> = z.object({
  ...commandContextShape,
  spaceId: SpaceIdSchema,
  teamMemberId: EntityIdSchema,
  taskIds: z.array(EntityIdSchema).optional(),
  projectId: ProjectIdSchema.nullable().optional(),
  workdir: SpawnWorkdirSchema.optional(),
  mode: z.enum(['worker', 'coordinator', 'coordinated-worker', 'coordinated-coordinator']).optional(),
  model: z.string().nullable().optional(),
  agentTool: z.string().nullable().optional(),
  title: z.string().optional(),
  promptExtra: z.string().nullable().optional(),
}).strict();

export const ExecutionPromptInputSchema: z.ZodType<ExecutionPromptInput> = z.object({
  ...commandContextShape,
  message: z.string().min(1),
}).strict();

export const ExecutionTerminateInputSchema: z.ZodType<ExecutionTerminateInput> = z.object({
  ...commandContextShape,
  force: z.boolean().optional(),
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
  token: z.string().nullable().optional(),
  expiresAt: IsoTimestamp,
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
  targetEntityId: EntityIdSchema.optional(),
}).strict();

// ---------------------------------------------------------------------------
// Wire envelope + error body (DEV-6 / DEV-8)
// ---------------------------------------------------------------------------

export const CommandErrorCodeSchema: z.ZodType<CommandErrorCode> = z.enum([
  'invalid_input', 'invalid_cursor',
  'unauthenticated', 'forbidden', 'not_found',
  'version_conflict', 'invariant_violation',
  'payload_too_large', 'rate_limited', 'limit_exceeded',
  'not_implemented', 'upstream_unavailable',
]);

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
