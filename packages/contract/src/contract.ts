/**
 * @tm8/contract — DTO + command types. THE LAW.
 *
 * §1 of this file is a near-verbatim transcription of the Collab V2 UI's
 * `types/contract.ts` (vendored at docs/ui-snapshot/ui-types-contract.ts.txt),
 * itself transcribed from docs/COLLAB_V2_UI_DATA_CONTRACT.md. Keep the diff
 * against that snapshot ~zero so the W3 UI transplant is mechanical.
 *
 * §2 is the tm8 extension block (docs/tm8-architecture/03-ENTITY-GRAPH-DELTAS):
 * `work_session` + `collection` core kinds, custom (`c:*`) kinds, and the
 * `execution.*` operation family (R16). Extensions are additive — they widen
 * unions, never reshape inherited members.
 *
 * Zod schemas for every shape live in ./schemas.ts, compile-bound to these
 * types. Recursive DTOs (EntitySummary, MessageView, NavChannelNode) make full
 * z.infer impossible, so the types here are the declaration and the schemas
 * are constrained to them — drift fails the build.
 */

// ===========================================================================
// §1 — Inherited contract (UI snapshot, near-verbatim)
// ===========================================================================

export type EntityId = string;
export type SpaceId = string;
export type Cursor = string;

/** tm8: the inherited 11 kinds + the two promoted core kinds (03 §1). */
export type CoreEntityKind =
  | 'channel' | 'task' | 'message' | 'member' | 'team_member'
  | 'doc' | 'file' | 'spell' | 'skill' | 'pull_request' | 'commit'
  | 'work_session' | 'collection';

/** tm8: runtime-registered custom kinds are namespaced (T-L4). */
export type CustomEntityKind = `c:${string}`;

export type EntityKind = CoreEntityKind | CustomEntityKind;

export type WorkStatus = 'open' | 'pulled' | 'working' | 'in_review'
  | 'done' | 'blocked' | 'cancelled';

export type Visibility = 'space' | 'restricted';

export interface ActorSummary {
  id: EntityId;
  kind: 'member' | 'team_member';
  displayName: string;
  avatar?: string | null;
  role?: string | null;
  ownerMemberId?: EntityId;       // present for a team_member
  isAgent: boolean;
}

export interface EntityCounters {
  likes: number;
  dislikes: number;
  stars: number;
  points: number;
  messages: number;
  /** Server-computed from the caller's reaction edge — always present (DEV-10). */
  viewerReaction: 'like' | 'dislike' | 'star' | null;
}

export interface EntitySummary {
  id: EntityId;
  spaceId: SpaceId;
  kind: EntityKind;
  title: string;                  // kind-specific display title, never an ID
  excerpt?: string;
  parentId: EntityId | null;
  position: number;
  visibility: Visibility;
  version: number;
  activityAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  createdBy: ActorSummary;
  counters: EntityCounters;
  state: EntityState;             // discriminator-specific Z1/Z2 fields
  badges: EntityBadges;
}

export type CoreEntityState =
  | { kind: 'task'; workStatus: WorkStatus; priority: 'low'|'medium'|'high'|'urgent';
      axes: Record<string, string>; dueDate?: string | null; assignees: ActorSummary[];
      acceptance: { total: number; completed: number } }
  | { kind: 'channel'; topic: string; unreadCount: number; workingAgentCount: number }
  | { kind: 'doc'; format: 'markdown'|'mermaid'|'excalidraw'; childCount: number }
  | { kind: 'message'; anchorId: EntityId; rootMessageId: EntityId | null; author: ActorSummary;
      editedAt?: string | null }
  | { kind: 'member'; role: 'owner'|'admin'|'member'; score: number; taskDoneCount: number }
  | { kind: 'team_member'; owner: ActorSummary; model?: string | null; agentTool?: string | null;
      liveWork?: LiveWork | null }
  | { kind: 'pull_request'; repository: string; number: number; state: string;
      url?: string; fetchedAt?: string | null; stale: boolean }
  | { kind: 'commit'; repository: string; sha: string; message: string; committedAt?: string | null }
  | { kind: 'file'; name: string; mimeType: string; sizeBytes: number }
  | { kind: 'spell' | 'skill'; description?: string; equipped: boolean }
  // tm8 additions (03 §1) — see §2 for the enums.
  | { kind: 'work_session'; status: WorkSessionStatus; agentTool: string | null;
      model: string | null; shareMode: WorkSessionShareMode;
      startedAt: string | null; exitedAt: string | null }
  | { kind: 'collection'; collectionType: string; itemCount: number };

/** tm8 (T-L4): custom-kind Z1/Z2 fields are the schema-validated scalars. */
export interface CustomEntityState { kind: CustomEntityKind; fields: Record<string, CustomFieldValue> }

export type EntityState = CoreEntityState | CustomEntityState;

export interface EntityBadges {
  blocked?: { unresolvedHardDependencyCount: number; waitingOn: EntitySummary[] };
  pulls?: PullState[];
  workingActors?: LiveWork[];
  restricted?: boolean;
}

export interface PullState {
  actor: ActorSummary;
  localId?: string | null;
  pinnedVersion: number;
  contentStale: boolean;          // pinnedVersion < entity.version
  discussionMoved: boolean;       // activity changed after the pull
  workStatus?: string | null;
  pulledAt: string;
}

export interface LiveWork { actor: ActorSummary; task: EntitySummary; startedAt: string; note?: string | null }

export interface EntityDetail extends EntitySummary {
  content: EntityContent;
  hierarchy: Hierarchy;
  connections: Connections;
  capabilities: EntityCapabilities;
}

export type CoreEntityContent =
  | { kind: 'task'; description: string; acceptanceCriteria: AcceptanceCriterion[];
      pointsEstimate?: number | null }
  | { kind: 'channel'; topic: string; pinned: EntitySummary[]; autoTabs: ChannelTab[] }
  | { kind: 'doc'; body: string; format: 'markdown'|'mermaid'|'excalidraw' }
  | { kind: 'message'; body: string; mentions: Mention[]; attachments: FileAttachment[] }
  | { kind: 'member'; teamMembers: EntitySummary[]; work: EntitySummary[] }
  | { kind: 'team_member'; identity: string; memories: unknown[]; capabilities: Record<string, unknown>;
      commandPermissions: Record<string, unknown>; equipped: EntitySummary[]; work: EntitySummary[] }
  | { kind: 'pull_request' | 'commit' | 'file' | 'spell' | 'skill'; [key: string]: unknown }
  // tm8 additions (03 §1, §4).
  | { kind: 'work_session'; nodeId: string | null; projectRef: string | null;
      workingOn: EntitySummary[]; transcriptDoc: EntitySummary | null }
  | { kind: 'collection'; description: string; items: EntitySummary[] };

export interface CustomEntityContent { kind: CustomEntityKind; fields: Record<string, CustomFieldValue> }

export type EntityContent = CoreEntityContent | CustomEntityContent;

export interface AcceptanceCriterion { id: string; text: string; done: boolean; doneBy?: EntityId; doneAt?: string }
export interface Mention { entityId: EntityId; kind: 'member'|'team_member'; display: string }
export interface FileAttachment { fileEntityId: EntityId; name: string; mime: string }

export interface Hierarchy { parent: EntitySummary | null; children: Page<EntitySummary>; path: EntitySummary[] }

export interface Connections {
  outgoing: EdgeGroup[];
  incoming: EdgeGroup[];
  unresolvedHardDependencyCount: number;
}

export interface EdgeGroup { type: string; direction: 'outgoing'|'incoming'; label: string; edges: EdgeView[]; nextCursor?: Cursor }

export interface EdgeView { id: string; type: string; source: EntitySummary; target: EntitySummary; props: Record<string, unknown>;
  createdBy: ActorSummary; createdAt: string; resolved?: boolean; hard?: boolean }

export interface EntityCapabilities { canEdit: boolean; canDelete: boolean; canAddChild: boolean; canLink: boolean;
  canPull: boolean; canReact: boolean; canGrantPoints: boolean; canComplete: boolean }

export interface Page<T> { items: T[]; nextCursor: Cursor | null; total?: number }

export interface ChannelTab { key: 'feed'|'tasks'|'docs'|'team'|'prs'|string; label: string; count: number;
  query: CollectionQuery }

// ---------------------------------------------------------------------------
// Collection and graph DTOs (§2.1)
// ---------------------------------------------------------------------------

export interface CollectionQuery {
  spaceId: SpaceId;
  kinds?: EntityKind[];
  subtreeOf?: EntityId;
  parentId?: EntityId | null;
  filters?: {
    workStatus?: WorkStatus[]; axes?: Record<string, string[]>; assigneeIds?: EntityId[];
    edge?: { type: string; direction: 'incoming'|'outgoing'; entityId: EntityId };
    readyToPull?: boolean; inReviewForActorId?: EntityId; mentionedActorId?: EntityId;
    /**
     * Facade-defined server-preset expansions BEYOND the doc'd filter list
     * (flagged upstream): they make the `getHome` preset queries reproducible
     * on re-execution. Actor scope = the actor's member + owned team_members.
     * `inFlightForActorId` = tasks that stable pulled / is working on (not
     * done/cancelled); `needsActorId` = union of `inReviewForActorId` and
     * `mentionedActorId` semantics.
     */
    inFlightForActorId?: EntityId; needsActorId?: EntityId;
    deleted?: 'exclude'|'only'|'include';
  };
  layout?: 'list'|'board'|'tree'|'feed'|'gallery'|'graph';
  groupBy?: 'workStatus'|'assignee'|`axis:${string}`;
  sort?: 'activityAt_desc'|'createdAt_desc'|'position'|'dueDate'|'priority';
  cursor?: Cursor; limit?: number;
}

export interface CollectionResult { query: CollectionQuery; page: Page<EntitySummary>; groups?: CollectionGroup[] }
export interface CollectionGroup { key: string; label: string; items: EntitySummary[]; nextCursor?: Cursor }
export interface GraphQuery extends CollectionQuery { focusId?: EntityId; hops?: number; edgeTypes?: string[]; mode?: 'free'|'dependency' }
export interface GraphResult { nodes: EntitySummary[]; edges: EdgeView[]; clusters: { parentId: EntityId; childIds: EntityId[] }[];
  layout?: Record<EntityId, { x: number; y: number }> }

// ---------------------------------------------------------------------------
// Thread, activity, and presence reads (§3)
// ---------------------------------------------------------------------------

export interface MessageView extends EntitySummary {
  state: Extract<CoreEntityState, { kind: 'message' }>;
  content: Extract<CoreEntityContent, { kind: 'message' }>;
  replyCount: number; replies?: Page<MessageView>; pending?: boolean;
}

export interface ActivityItem { id: string; entityId?: EntityId | null; actor?: ActorSummary | null;
  verb: string; summary: Record<string, unknown>; createdAt: string; refId?: string | null }

export interface PresenceSnapshot { viewers: ActorSummary[]; typingActorIds: EntityId[]; updatedAt: string }

// ---------------------------------------------------------------------------
// Realtime event contract (§5)
// ---------------------------------------------------------------------------

export type WorkspaceEvent =
 | { type: 'entity.upsert'|'entity.deleted'; eventId: string; entity: EntitySummary; clientMutationId?: string }
 | { type: 'edge.upsert'|'edge.deleted'; eventId: string; edge: EdgeView; clientMutationId?: string }
 | { type: 'message.created'|'message.updated'|'message.deleted'; eventId: string; anchorId: EntityId; message: MessageView }
 | { type: 'counter.changed'; eventId: string; entityId: EntityId; counters: EntityCounters }
 | { type: 'activity.created'; eventId: string; activity: ActivityItem }
 | { type: 'notification.created'|'notification.read'; eventId: string; notification: NotificationItem }
 | { type: 'presence.changed'; eventId: string; entityId: EntityId; presence: PresenceSnapshot }
 | { type: 'typing.changed'; eventId: string; anchorId: EntityId; typingActorIds: EntityId[] };

/**
 * DEV-4: presence/typing are CLIENT-SYNTHESIZED, ephemeral events. They stay in
 * the WorkspaceEvent union but NEVER ride the durable `subscribe` stream — they
 * arrive only on the separate `subscribePresence` channel.
 */
export type PresenceWorkspaceEvent =
  Extract<WorkspaceEvent, { type: 'presence.changed' | 'typing.changed' }>;

/** The durable event stream (`subscribe`) emits exactly these. */
export type DurableWorkspaceEvent = Exclude<WorkspaceEvent, PresenceWorkspaceEvent>;

// Facade-defined: notification row backing the Inbox screen (route matrix:
// "notification rows with target EntitySummary, actor, kind, read state and
// timestamp").
export interface NotificationItem {
  id: string;
  spaceId: SpaceId;
  kind: 'mention' | 'assignment' | 'award' | 'unblock' | 'review_request' | 'stale' | string;
  actor?: ActorSummary | null;
  target?: EntitySummary | null;
  message?: string;
  readAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Commands / mutation contract (§4)
// ---------------------------------------------------------------------------

/** Closed error set (04-COMMUNICATION-MODEL §4, adopted via DEV-8). */
export type CommandErrorCode =
  | 'invalid_input' | 'invalid_cursor'
  | 'unauthenticated' | 'forbidden' | 'not_found'
  | 'version_conflict' | 'invariant_violation'
  | 'payload_too_large' | 'rate_limited'
  | 'not_implemented' | 'upstream_unavailable';

export const ERROR_STATUS: Record<CommandErrorCode, number> = {
  invalid_input: 400, invalid_cursor: 400,
  unauthenticated: 401, forbidden: 403, not_found: 404,
  version_conflict: 409, invariant_violation: 409,
  payload_too_large: 413, rate_limited: 429,
  not_implemented: 501, upstream_unavailable: 503,
};

export const RETRYABLE_BY_DEFAULT = new Set<CommandErrorCode>(['rate_limited', 'upstream_unavailable']);

let requestSeq = 0;

/**
 * Typed command failure mirroring the wire error body
 * `{ error: { code, message, details?, requestId, retryable } }` (04 §4).
 * `status` is the HTTP mapping; a `version_conflict` carries
 * `current: EntityDetail`.
 */
export class CollabError extends Error {
  readonly code: CommandErrorCode;
  readonly status: number;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly current?: EntityDetail;
  readonly details?: Record<string, unknown>;

  constructor(code: CommandErrorCode, message: string,
              opts: { current?: EntityDetail; details?: Record<string, unknown>; retryable?: boolean } = {}) {
    super(message);
    this.name = 'CollabError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    requestSeq += 1;
    this.requestId = `req_${requestSeq.toString(36).padStart(6, '0')}`;
    this.retryable = opts.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    this.current = opts.current;
    this.details = opts.details;
  }
}

export function isCollabError(e: unknown): e is CollabError {
  return e instanceof CollabError;
}

/**
 * Facade-defined: opaque undo handle returned by cheaply-invertible commands,
 * redeemable at `undo()` within a 5-minute TTL (DEV-11, 04 §5).
 */
export interface UndoToken { token: string; label: string; expiresAt?: string }

export interface CommandResult {
  entity?: EntityDetail;
  edge?: EdgeView;
  activity?: ActivityItem;
  patches: EntitySummary[];
  undo?: UndoToken;
}

/** Common envelope on every command (§4 preamble). */
export interface CommandContext { actorId?: EntityId; clientMutationId?: string }

export interface CreateTaskInput extends CommandContext {
  spaceId: SpaceId;
  title: string;
  description?: string;
  axes?: Record<string, string>;
  parentId?: EntityId | null;
  position?: number;
  priority?: 'low'|'medium'|'high'|'urgent';
  acceptanceCriteria?: Array<Pick<AcceptanceCriterion, 'text'> & Partial<AcceptanceCriterion>>;
  pointsEstimate?: number | null;
  dueDate?: string | null;
  /** Creates the task and the edge atomically (channel-create / promote-message). */
  attachTo?: { entityId: EntityId; edgeType: 'attached_to' | 'relates_to' };
}

export interface PatchTaskInput extends CommandContext {
  expectedVersion: number;
  title?: string;
  description?: string;
  axes?: Record<string, string>;
  workStatus?: WorkStatus;
  priority?: 'low'|'medium'|'high'|'urgent';
  acceptanceCriteria?: AcceptanceCriterion[];
  pointsEstimate?: number | null;
  dueDate?: string | null;
}

/**
 * POST /v2/entities — the ONLY create form (DEV-1): discriminated `kind` plus
 * kind-typed fields inside `content`. Tasks route through here too (their
 * payload fields — description, axes, priority, acceptanceCriteria,
 * pointsEstimate, dueDate — travel inside `content`); messages keep
 * `postMessage` and members are not client-creatable.
 * tm8: `work_session` is not client-creatable either — it is born only from
 * `execution.spawn` (03 §1.1); custom `c:*` kinds create through here.
 */
export interface CreateEntityInput extends CommandContext {
  spaceId: SpaceId;
  kind: Exclude<EntityKind, 'message' | 'member' | 'work_session'>;
  title: string;
  parentId?: EntityId | null;
  position?: number;
  content?: Record<string, unknown>;
  attachTo?: { entityId: EntityId; edgeType: 'attached_to' | 'relates_to' };
}

export interface PatchEntityInput extends CommandContext {
  expectedVersion: number;
  title?: string;
  content?: Record<string, unknown>;
}

export interface MoveEntityInput extends CommandContext {
  parentId: EntityId | null;      // same kind or null
  position: number;
  expectedVersion: number;
}

export interface CreateEdgeInput extends CommandContext {
  srcId: EntityId; dstId: EntityId; type: string; props?: Record<string, unknown>;
}
export interface PatchEdgeInput extends CommandContext { props: Record<string, unknown> }

export type PlacementIntent = 'attach'|'assign'|'depend'|'subtask'|'embed'|'reparent';
export interface PlacementInput extends CommandContext {
  sourceId: EntityId;
  targetId: EntityId;
  intent: PlacementIntent;
  embedMessage?: string;
}

export interface PostMessageInput extends CommandContext {
  anchorId: EntityId;
  body: string;
  parentMessageId?: EntityId | null;
  mentions?: Mention[];
  attachments?: FileAttachment[];
}
export interface PatchMessageInput extends CommandContext { body: string; mentions?: Mention[] }

export interface ReactionInput extends CommandContext {
  reaction: 'like'|'dislike'|'star';
  enabled: boolean;
}

export interface GrantPointsInput extends CommandContext {
  amount: number;
  reason: 'grant'|'award'|'seed';
  referenceId?: EntityId;
}

export interface CompleteTaskInput extends CommandContext {
  expectedVersion: number;
  completerIds: EntityId[];
}

export interface PullInput extends CommandContext { localId?: string | null; pinnedVersion: number }
export interface WorkInput extends CommandContext { status: WorkStatus; startedAt?: string; note?: string | null }

export interface TrackingRefreshInput extends CommandContext { entityIds?: EntityId[] }

/**
 * POST /v2/entities/:id/commands/link-pr (DEV-3): creates/upserts the
 * pull_request entity for `url` and the `tracks` edge atomically.
 */
export interface LinkPrInput extends CommandContext { url: string }

/** POST /v2/entities/:id/commands/link-commit — analogous to link-pr (01 §6). */
export interface LinkCommitInput extends CommandContext { url: string }

export interface TaskAxisInput extends CommandContext {
  name: string;
  axisValues: string[];
  kind: 'default'|'manual';
  position: number;
}

export interface SavedViewInput extends CommandContext {
  name: string;
  shareMode: 'private'|'space';
  query: CollectionQuery;
  graphLayout?: Record<EntityId, { x: number; y: number }>;
}

/** POST /v2/spaces — default visibility is 'private' (01 §2, D-fix). */
export interface CreateSpaceInput extends CommandContext {
  name: string;
  description?: string;
  visibility?: 'private' | 'public';
  githubRepo?: string | null;
}

/** PATCH /v2/spaces/:spaceId */
export interface UpdateSpaceInput extends CommandContext {
  name?: string;
  description?: string;
  githubRepo?: string | null;
}

// ---------------------------------------------------------------------------
// Facade-defined read shapes for route-matrix rows without inline DTOs (§3)
// ---------------------------------------------------------------------------

/** GET /v2/spaces */
export interface SpaceSummary {
  id: SpaceId;
  name: string;
  description: string;
  memberCount: number;
  unreadTotal: number;
  githubRepo?: string | null;
  createdAt: string;
}

/** GET /v2/spaces/:spaceId/navigation */
export interface SpaceNavigation {
  spaceId: SpaceId;
  viewer: ActorSummary;
  unreadTotal: number;
  channels: NavChannelNode[];
}
export interface NavChannelNode { entity: EntitySummary; childCount: number; children: NavChannelNode[] }

/** Home — My Work: the three server-defined presets plus compact activity. */
export interface HomeSnapshot {
  readyToPull: CollectionResult;
  inFlight: CollectionResult;
  needsMe: CollectionResult;
  activity: Page<ActivityItem>;
}

/** GET /v2/spaces/:spaceId/task-axes */
export interface TaskAxis {
  id: string;
  spaceId: SpaceId;
  name: string;
  axisValues: string[];
  kind: 'default'|'manual';
  position: number;
}

/** GET /v2/spaces/:spaceId/leaderboard */
export interface LeaderboardRow { actor: ActorSummary; score: number; rank: number }

/** GET /v2/spaces/:spaceId/awards — point events with task/completer. */
export interface PointEventView {
  id: string;
  recipient: ActorSummary;
  actor: ActorSummary;
  amount: number;
  reason: 'grant'|'award'|'seed';
  onEntity: EntitySummary | null;   // what the points were granted on
  ref: EntitySummary | null;        // e.g. the task that generated an award
  createdAt: string;
}

/** GET /v2/spaces/:spaceId/settings */
export interface SpaceSettings {
  space: SpaceSummary;
  members: Array<{ actor: ActorSummary; role: 'owner'|'admin'|'member'; joinedAt: string }>;
  invites: Array<{ id: string; code: string; maxUses: number; uses: number; expiresAt: string | null; revoked: boolean }>;
  taskAxes: TaskAxis[];
}

/** POST /v2/saved-views */
export interface SavedView {
  id: string;
  spaceId: SpaceId;
  name: string;
  shareMode: 'private'|'space';
  query: CollectionQuery;
  graphLayout?: Record<EntityId, { x: number; y: number }>;
  createdBy: ActorSummary;
  createdAt: string;
}

/** GET /v2/actions?contextEntityId= — palette action descriptors. */
export interface PaletteAction {
  id: string;
  label: string;
  kind: 'navigate' | 'create' | 'link' | 'pull' | 'status' | string;
  targetEntityId?: EntityId;
}

export type Unsubscribe = () => void;

// ===========================================================================
// §2 — tm8 extensions (03-ENTITY-GRAPH-DELTAS, R7–R10, R16–R17, R29)
// ===========================================================================

// --- work_session (03 §1.1) -------------------------------------------------

/** Single writer: the execution block's transition function (R29). */
export type WorkSessionStatus = 'spawning' | 'running' | 'idle' | 'exited' | 'failed';

/** Graph-side announce/authorize state for live terminal sharing (T-L10). */
export type WorkSessionShareMode = 'none' | 'space' | 'explicit';

// --- execution.* operation family (R16) ------------------------------------

/**
 * execution.spawn — the only way a `work_session` is born. The server-side
 * SpawnService (R27) reads the graph through this contract, creates the
 * work_session entity + `working_on` edges + manifest in one transaction, and
 * emits the spawn request to the server-hosted PTY (AM-1: server PTY is the
 * ONLY spawn path — there is no desktop shell). Result: `CommandResult` whose
 * `entity` is the new work_session detail.
 */
export interface ExecutionSpawnInput extends CommandContext {
  spaceId: SpaceId;
  /** The persona to run; authorization resolves through its owner (T-L7). */
  teamMemberId: EntityId;
  /** Tasks the session works on — become `working_on` edges. */
  taskIds?: EntityId[];
  /** Repo/workingDir reference (space↔project link, T-D17). */
  projectRef?: string | null;
  mode?: 'worker' | 'coordinator' | 'coordinated-worker' | 'coordinated-coordinator';
  model?: string | null;
  agentTool?: string | null;
  title?: string;
  /** Extra prompt context appended to the composed manifest. */
  promptExtra?: string | null;
}

/**
 * execution.prompt (R17): PTY delivery, not graph state — the message is
 * injected into the live session's PTY and marked delivered. Targets a
 * work_session entity: POST /v2/entities/:id/commands/prompt.
 */
export interface ExecutionPromptInput extends CommandContext {
  message: string;
}

/** execution.terminate — POST /v2/entities/:id/commands/terminate. */
export interface ExecutionTerminateInput extends CommandContext {
  force?: boolean;
}

/**
 * execution.streams.attach (T-L10): the graph announces and authorizes; bytes
 * flow client↔home-server over the WS bridge. Returns a grant, never bytes.
 */
export interface ExecutionStreamsAttachInput extends CommandContext {
  mode: 'view' | 'drive';
}

export interface StreamAttachGrant {
  workSessionId: EntityId;
  /** WebSocket URL to attach to (server-relative or absolute). */
  url: string;
  protocol: 'ws';
  mode: 'view' | 'drive';
  token?: string | null;
  expiresAt: string;
}

// --- custom entity kinds (T-L4, R7–R9) --------------------------------------

/** Scalars ONLY (R8) — relations are edges, full stop. */
export type CustomFieldType = 'text' | 'number' | 'bool' | 'date' | 'enum';
export type CustomFieldValue = string | number | boolean | null;

export interface CustomFieldDef {
  name: string;
  type: CustomFieldType;
  required?: boolean;
  /** For `enum` fields. */
  values?: string[];
}

/** A row of the `entity_kinds` registry, as read by the KindRegistry. */
export interface EntityKindDef {
  id: string;
  kind: EntityKind;
  origin: 'core' | 'custom';
  /** Custom kinds are space-scoped; core kinds are global (null) [R7]. */
  spaceId: SpaceId | null;
  icon?: string | null;
  fieldSchema: CustomFieldDef[];
  /** Which universal capabilities are surfaced (all default on). */
  capabilities: Record<string, boolean>;
  createdBy?: EntityId | null;
  createdAt: string;
}

/** POST /v2/spaces/:spaceId/entity-kinds — custom kinds only (`c:*`). */
export interface EntityKindCreateInput extends CommandContext {
  kind: CustomEntityKind;
  icon?: string | null;
  fieldSchema: CustomFieldDef[];
  capabilities?: Record<string, boolean>;
}

/**
 * PATCH /v2/spaces/:spaceId/entity-kinds/:kind — additive-or-relaxing by
 * default (R9); a tightening edit is refused unless run as an explicit
 * admin backfill (`allowTightening`).
 */
export interface EntityKindUpdateInput extends CommandContext {
  icon?: string | null;
  fieldSchema?: CustomFieldDef[];
  capabilities?: Record<string, boolean>;
  allowTightening?: boolean;
}
