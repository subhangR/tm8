/**
 * CollabFacade — THE seam between the Collab V2 UI and any backend.
 *
 * One interface = the full route matrix of docs/history/collab-v2/UI-DATA-CONTRACT.md
 * (§3 reads, §4 commands, §5 realtime). The MockFacade implements it against a
 * seeded in-memory world; the real backend later is a new class implementing
 * the same interface — zero component changes.
 *
 * Conventions:
 * - Reads reject with CollabError('not_found') for missing/tombstoned ids.
 * - Commands reject with typed CollabError (the closed code set of 04 §4;
 *   a `version_conflict` carries `current: EntityDetail`).
 * - Envelopes are HTTP-level only (DEV-6): the wire wraps every response as
 *   `{ data, requestId }`, but facade methods return the unwrapped typed
 *   values — no `{ data }`/`requestId` shapes ever leak through this seam.
 * - Auth is a maestro-server session concern outside this seam (DEV-12): no
 *   token/credential parameter appears on any method, and no backend-vendor
 *   auth concept exists anywhere in collab-v2 (enforced by the seam-purity test).
 * - All list reads take OPAQUE keyset cursors (DEV-5) — never offsets; a
 *   stale/foreign cursor rejects with CollabError('invalid_cursor') — and
 *   exclude soft-deleted entities by default (tombstone summaries appear only
 *   inside retained history).
 * - Every mutation accepts `clientMutationId` and honors it (DEV-9): a retry
 *   with the same id replays the stored result as a no-op; the same id on a
 *   DIFFERENT operation rejects with 'invariant_violation'.
 * - Edge-predicate direction in CollectionQuery.filters.edge is from the
 *   CANDIDATE entity's viewpoint: `{type:'attached_to', direction:'outgoing',
 *   entityId: channelId}` = "entities with an outgoing attached_to edge to the
 *   channel".
 */
import type {
  ActivityItem, ChannelTab, CollectionQuery, CollectionResult, CommandResult,
  CompleteTaskInput, CreateEdgeInput, CreateEntityInput, CreateTaskInput,
  Cursor, EntityDetail, EntityId, EntityKind, GraphQuery, GraphResult,
  Hierarchy, HomeSnapshot, LeaderboardRow, LinkPrInput, MessageView,
  MoveEntityInput, NotificationItem, Page, PaletteAction, PatchEdgeInput,
  PatchEntityInput, PatchMessageInput, PatchTaskInput, PlacementInput,
  PointEventView, PostMessageInput, PresenceSnapshot, PresenceWorkspaceEvent,
  ProjectFromRepo, PullInput, GrantPointsInput, ReactionInput, SavedView, SavedViewInput,
  SpaceId, SpaceNavigation, SpaceSettings, SpaceSummary, TaskAxis,
  TaskAxisInput, TrackingRefreshInput, UndoToken, Unsubscribe, WorkInput,
  WorkspaceEvent, EntitySummary, Connections, CommandContext,
} from '../types/contract';

export interface CollabFacade {
  // -------------------------------------------------------------------------
  // Reads — spaces & navigation
  // -------------------------------------------------------------------------
  listSpaces(): Promise<SpaceSummary[]>;
  getNavigation(spaceId: SpaceId): Promise<SpaceNavigation>;

  // -------------------------------------------------------------------------
  // Reads — entity detail + lazy sections
  // -------------------------------------------------------------------------
  getEntity(id: EntityId): Promise<EntityDetail>;
  getHierarchy(id: EntityId, cursor?: Cursor): Promise<Hierarchy>;
  getConnections(id: EntityId): Promise<Connections>;
  getActivity(id: EntityId, cursor?: Cursor): Promise<Page<ActivityItem>>;
  getVersions(id: EntityId, cursor?: Cursor): Promise<Page<{ version: number; changedBy: EntityId; changedAt: string }>>;
  getPresence(id: EntityId): Promise<PresenceSnapshot>;

  // -------------------------------------------------------------------------
  // Reads — collections, graph, home
  // -------------------------------------------------------------------------
  queryCollection(query: CollectionQuery): Promise<CollectionResult>;
  queryGraph(query: GraphQuery): Promise<GraphResult>;
  getHome(spaceId: SpaceId): Promise<HomeSnapshot>;
  getChannelTabs(channelId: EntityId): Promise<ChannelTab[]>;

  // -------------------------------------------------------------------------
  // Reads — messages, activity feed, presence, inbox, leaderboard, axes, misc
  // -------------------------------------------------------------------------
  getMessages(anchorId: EntityId, opts?: { cursor?: Cursor; order?: 'asc'|'desc'; rootId?: EntityId }): Promise<Page<MessageView>>;
  getSpaceActivity(spaceId: SpaceId, cursor?: Cursor): Promise<Page<ActivityItem>>;
  getInbox(cursor?: Cursor): Promise<Page<NotificationItem>>;
  getLeaderboard(spaceId: SpaceId, cursor?: Cursor): Promise<Page<LeaderboardRow>>;
  getAwards(spaceId: SpaceId, cursor?: Cursor): Promise<Page<PointEventView>>;
  getTaskAxes(spaceId: SpaceId): Promise<TaskAxis[]>;
  getSettings(spaceId: SpaceId): Promise<SpaceSettings>;
  listSavedViews(spaceId: SpaceId): Promise<SavedView[]>;
  /**
   * DEV-13: search is DEFERRED for v1 — every implementation rejects with
   * CollabError('not_implemented'). The method stays on the seam for v2; the
   * palette runs on recent/known entities + `getActions` instead.
   */
  search(q: string, opts?: { spaceId?: SpaceId; kinds?: EntityKind[]; cursor?: Cursor }): Promise<Page<EntitySummary>>;
  getActions(contextEntityId?: EntityId): Promise<PaletteAction[]>;

  // -------------------------------------------------------------------------
  // Commands — create/patch entities (generic, DEV-1), move
  // -------------------------------------------------------------------------
  /** @deprecated Thin wrapper over `createEntity({ kind: 'task', … })` (DEV-1) — kept for existing consumers. */
  createTask(input: CreateTaskInput): Promise<CommandResult>;
  /** @deprecated Thin wrapper over `patchEntity` with task fields in `content` (DEV-1) — kept for existing consumers. */
  patchTask(id: EntityId, input: PatchTaskInput): Promise<CommandResult>;
  createEntity(input: CreateEntityInput): Promise<CommandResult>;
  patchEntity(id: EntityId, input: PatchEntityInput): Promise<CommandResult>;
  moveEntity(id: EntityId, input: MoveEntityInput): Promise<CommandResult>;
  deleteEntity(id: EntityId, ctx?: CommandContext): Promise<CommandResult>;

  // -------------------------------------------------------------------------
  // Commands — edges & placements (drag/drop grammar)
  // -------------------------------------------------------------------------
  createEdge(input: CreateEdgeInput): Promise<CommandResult>;
  patchEdge(edgeId: string, input: PatchEdgeInput): Promise<CommandResult>;
  deleteEdge(edgeId: string, ctx?: CommandContext): Promise<CommandResult>;
  placements(input: PlacementInput): Promise<CommandResult>;
  /**
   * POST /v2/undo (DEV-11): redeems an UndoToken from CommandResult.undo by
   * executing the inverse command. Tokens are single-use with a 5-minute TTL —
   * unknown/used → 'not_found', expired → 'invariant_violation'.
   */
  undo(token: UndoToken | string, ctx?: CommandContext): Promise<CommandResult>;

  // -------------------------------------------------------------------------
  // Commands — messages, reactions, points, completion
  // -------------------------------------------------------------------------
  postMessage(input: PostMessageInput): Promise<CommandResult>;
  patchMessage(id: EntityId, input: PatchMessageInput): Promise<CommandResult>;
  deleteMessage(id: EntityId, ctx?: CommandContext): Promise<CommandResult>;
  setReaction(id: EntityId, input: ReactionInput): Promise<CommandResult>;
  grantPoints(id: EntityId, input: GrantPointsInput): Promise<CommandResult>;
  completeTask(id: EntityId, input: CompleteTaskInput): Promise<CommandResult>;

  // -------------------------------------------------------------------------
  // Commands — pull/work, tracking, read-marks, axes, saved views
  // -------------------------------------------------------------------------
  pullEntity(id: EntityId, input: PullInput): Promise<CommandResult>;
  setWork(id: EntityId, input: WorkInput): Promise<CommandResult>;
  /**
   * POST /v2/entities/:id/commands/link-pr (DEV-3): creates or upserts (by URL)
   * the pull_request entity and the `tracks` edge from `id` atomically. The PR
   * summary rides in `patches` (and `entity`).
   */
  linkPr(id: EntityId, input: LinkPrInput): Promise<CommandResult>;
  trackingRefresh(input: TrackingRefreshInput): Promise<CommandResult>;
  markRead(anchorId: EntityId, ctx?: CommandContext): Promise<CommandResult>;
  markNotificationRead(notificationId: string, ctx?: CommandContext): Promise<CommandResult>;
  /**
   * POST /v2/spaces/:spaceId/projects/from-repo — clone a GitHub repository
   * into this Space as a project and link it, in one step.
   *
   * `repoUrl` is the only input BY DESIGN, not for brevity: the server derives
   * the working directory under a managed root, which is precisely why this
   * needs no node-admin where `projects.create` does. The result is always an
   * untrusted project. Requires the caller's own GitHub credential, and
   * refuses with `forbidden` + `reason: 'no_github_credential'` when there is
   * none. See migration 173.
   */
  createProjectFromRepo(
    spaceId: SpaceId,
    input: { repoUrl: string; name?: string },
  ): Promise<ProjectFromRepo>;
  createTaskAxis(spaceId: SpaceId, input: TaskAxisInput): Promise<TaskAxis>;
  updateTaskAxis(spaceId: SpaceId, axisId: string, input: Partial<TaskAxisInput>): Promise<TaskAxis>;
  deleteTaskAxis(spaceId: SpaceId, axisId: string): Promise<void>;
  createSavedView(spaceId: SpaceId, input: SavedViewInput): Promise<SavedView>;
  updateSavedView(viewId: string, input: Partial<SavedViewInput>): Promise<SavedView>;
  deleteSavedView(viewId: string): Promise<void>;

  // -------------------------------------------------------------------------
  // Realtime (§5)
  // -------------------------------------------------------------------------
  /**
   * THE durable event stream (DEV-4): emits only durable-graph events
   * (entity/edge/message/counter/activity/notification). It NEVER emits
   * `presence.changed` / `typing.changed` — those are client-synthesized and
   * arrive on `subscribePresence`.
   */
  subscribe(spaceId: SpaceId, cb: (event: WorkspaceEvent) => void): Unsubscribe;
  /**
   * CLIENT-SYNTHESIZED presence/typing channel (DEV-4) — ephemeral, never
   * durable, fully separate from `subscribe`. Feeds `usePresenceStore`.
   */
  subscribePresence(spaceId: SpaceId, cb: (event: PresenceWorkspaceEvent) => void): Unsubscribe;
}

/**
 * OPTIONAL connection-status capability (DEF-17) — NOT a contract route.
 * A facade that knows its transport state (MockFacade via `setConnected`; a
 * real binding via its socket) exposes it so `connectStores` can feed the
 * connection store behind W7's offline banner + queued composer. Facades
 * without it are treated as always connected.
 */
export interface ConnectionControl {
  isConnected(): boolean;
  subscribeConnection(cb: (connected: boolean) => void): Unsubscribe;
}

export function hasConnectionControl(facade: CollabFacade): facade is CollabFacade & ConnectionControl {
  const c = facade as Partial<ConnectionControl>;
  return typeof c.isConnected === 'function' && typeof c.subscribeConnection === 'function';
}

/**
 * Browser file shape used by the optional upload capability. Keeping this
 * structural makes the facade testable without constructing a DOM `File`.
 */
export interface UploadableFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface UploadFileInput extends CommandContext {
  spaceId: SpaceId;
  file: UploadableFile;
  /** Entities the completed file should be attached to atomically. */
  targetIds?: EntityId[];
}

/**
 * OPTIONAL raw-file capability. File bytes use a server-minted upload grant,
 * so this cannot be expressed as one of the JSON-only CollabFacade commands.
 */
export interface FileAttachmentControl {
  uploadFile(input: UploadFileInput): Promise<EntityDetail>;
  fileDownloadUrl(fileEntityId: EntityId): string;
}

export function hasFileAttachmentControl(
  facade: CollabFacade,
): facade is CollabFacade & FileAttachmentControl {
  const files = facade as Partial<FileAttachmentControl>;
  return typeof files.uploadFile === 'function' && typeof files.fileDownloadUrl === 'function';
}
