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

import type { OperationName } from './catalog.js';

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
  | 'work_session' | 'collection' | 'project' | 'interaction_profile';

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
      messageBatchId: string | null; editedAt?: string | null }
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
  | { kind: 'collection'; collectionType: string; itemCount: number }
  | { kind: 'project'; projectId: ProjectId; materializedVersion: number }
  | { kind: 'interaction_profile'; status: InteractionProfileStatus;
      currentDraftVersion: number; activeVersion: number | null;
      activeHash: string | null; retiredAt: string | null };

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
  | { kind: 'work_session'; nodeId: string | null;
      /** Immutable launch-root provenance; associations are `in_project` edges. */
      launchProjectId: ProjectId | null;
      workingOn: EntitySummary[]; transcriptDoc: EntitySummary | null }
  | { kind: 'collection'; description: string; items: EntitySummary[] }
  | { kind: 'project'; projectId: ProjectId; repoUrl?: string | null;
      materializedVersion: number }
  | { kind: 'interaction_profile'; status: InteractionProfileStatus;
      templateKey: string; templateVersion: number; resolvedHash: string | null;
      generatedByTeamMemberId: EntityId | null };

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
  createdBy: ActorSummary; createdAt: string; updatedAt: string; resolved?: boolean; hard?: boolean }

/** Flat `entities.connections` query; cursors bind this complete fingerprint. */
export interface EntityConnectionsQuery {
  types?: string[];
  direction?: 'incoming' | 'outgoing' | 'both';
  peerIds?: EntityId[];
  peerKinds?: EntityKind[];
  createdByIds?: EntityId[];
  createdAfter?: string;
  createdBefore?: string;
  sort?: 'createdAt' | 'updatedAt' | 'type';
  order?: 'asc' | 'desc';
  cursor?: Cursor;
  limit?: number;
}

export type EntityConnectionsPage = Page<EdgeView>;

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
    /**
     * A22 (additive): only `work_session` rows in these statuses. While
     * present the query returns work_sessions exclusively — the same
     * kind-narrowing semantics `workStatus` has for tasks (a NULL state axis
     * never matches). Combining it with `workStatus` is REFUSED as
     * `invalid_input` (schema refinement): the filters are kind-disjoint, so
     * the pair could only ever produce the always-empty set, and a confident
     * zero is worse than a refusal that names the mechanism.
     */
    sessionStatus?: WorkSessionStatus[];
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
  verb: string; summary: Record<string, unknown>; createdAt: string; refId?: string | null;
  workSessionId?: EntityId | null }

export interface PresenceSnapshot { viewers: ActorSummary[]; typingActorIds: EntityId[]; updatedAt: string }

// ---------------------------------------------------------------------------
// Realtime event contract (§5)
//
// ⚠ AM-2 §3 AMENDMENT INSIDE §1 (flagged for the UI team): the event shape
// here deliberately DIVERGES from the UI snapshot. The bare `eventId` field is
// replaced by a mandatory envelope `{spaceId, seq, occurredAt, schemaVersion}`
// on every event, and `clientMutationId?` widens to ALL mutation-derived
// variants (not just entity/edge). Dedupe/ordering key = (spaceId, seq).
// This is the only intentional §1 divergence besides the `limit_exceeded`
// taxonomy code below.
// ---------------------------------------------------------------------------

/** Bump when the event envelope or a payload shape changes incompatibly. */
export const WORKSPACE_EVENT_SCHEMA_VERSION = 1;

/**
 * AM-2 §3: the envelope every WorkspaceEvent carries on the multiplexed
 * socket and the poll fallback. `seq` is a per-space monotonic sequence
 * assigned by the durable event log — it is the client's dedupe key, ordering
 * key, and the basis of the `events.poll` `since` cursor. For the ephemeral
 * presence/typing events (DEV-4, never on the durable stream) `seq` is
 * channel-local and MUST NOT be used as a durable cursor.
 */
export interface WorkspaceEventEnvelope {
  spaceId: SpaceId;
  /** Per-space monotonic; gaps allowed, order is authoritative. */
  seq: number;
  occurredAt: string;
  schemaVersion: number;
}

/**
 * Every event carries its full typed payload — there are NO bare-entity-id
 * variants that force a refetch (AM-2 §3). `clientMutationId` is present on
 * every event derived from a ledgered mutation and echoes the originating
 * command's id for optimistic reconciliation (DEV-9); presence/typing are
 * client-synthesized and never carry one.
 */
export type WorkspaceEvent = WorkspaceEventEnvelope & (
 | { type: 'entity.upsert'|'entity.deleted'; entity: EntitySummary; clientMutationId?: string }
 | { type: 'edge.upsert'|'edge.deleted'; edge: EdgeView; clientMutationId?: string }
 | { type: 'message.created'|'message.updated'|'message.deleted'; anchorId: EntityId; message: MessageView; clientMutationId?: string }
 | { type: 'counter.changed'; entityId: EntityId; counters: EntityCounters; clientMutationId?: string }
 | { type: 'activity.created'; activity: ActivityItem; clientMutationId?: string }
 | { type: 'notification.created'|'notification.read'; notification: NotificationItem; clientMutationId?: string }
 | { type: 'menu.updated'; menu: MenuConfig; clientMutationId?: string }
 | { type: 'space.default_channel.updated'; channelId: EntityId | null;
     settingsRevision: number; clientMutationId?: string }
 | { type: 'project.association.corrected'; result: EdgeCorrectionResult; clientMutationId?: string }
 | { type: 'handoff.prepared'|'handoff.delivery_settled'|'handoff.recorded'|'handoff.withdrawn';
     handoff: HandoffView; clientMutationId?: string }
 | { type: 'message.delivery_reserved'|'message.delivery_settled';
     delivery: MessageDeliveryRecord; clientMutationId?: string }
 | { type: 'message.attachments.updated'; message: MessageView; clientMutationId?: string }
 | { type: 'interaction_profile.proposed'|'interaction_profile.updated'|'interaction_profile.activated'|'interaction_profile.retired';
     profile: InteractionProfileView; clientMutationId?: string }
 | { type: 'interaction_profile.validated'; validation: ProfileValidationView; clientMutationId?: string }
 | { type: 'interaction_profile.default_updated';
     target: { type: 'team_member'; value: TeammateProfileDefaultView }
       | { type: 'space'; value: SpaceProfileDefaultView };
     clientMutationId?: string }
 | { type: 'work_session.profile_pinned'|'work_session.profile_repinned';
     pin: InteractionProfilePinView; clientMutationId?: string }
 | { type: 'presence.changed'; entityId: EntityId; presence: PresenceSnapshot }
 | { type: 'typing.changed'; anchorId: EntityId; typingActorIds: EntityId[] });

/**
 * DEV-4: presence/typing are CLIENT-SYNTHESIZED, ephemeral events. They stay in
 * the WorkspaceEvent union but NEVER ride the durable `subscribe` stream — they
 * arrive only on the separate `subscribePresence` channel.
 */
export type PresenceWorkspaceEvent =
  Extract<WorkspaceEvent, { type: 'presence.changed' | 'typing.changed' }>;

/** The durable event stream (`subscribe`) emits exactly these. */
export type DurableWorkspaceEvent = Exclude<WorkspaceEvent, PresenceWorkspaceEvent>;

// ---------------------------------------------------------------------------
// The CLIENT→SERVER control channel on the same socket (§5)
//
// Everything above this line travels server→client. This block is the only
// traffic that travels the other way, and it is being ADDED to complete three
// requirements the contract had already adopted but could not express:
//
//   1. Semantic delivery of AUTHORIZED durable events. `events.subscribe` is
//      ONE multiplexed socket for the whole workspace (T-L10), so the server
//      cannot know which Spaces a connection wants until the connection says
//      so. Without `subscribe`/`unsubscribe` the fan-out has no recipients and
//      every durable event is delivered to nobody.
//   2. Reconnect/replay reconciliation. A client that dropped and returned must
//      be able to name the last seq it durably applied, or it silently loses
//      the gap — `resume`.
//   3. Presence. `presence` toggles the ephemeral channel. Note this is not a
//      new idea: the DEV-4 note above ALREADY says presence events "arrive only
//      on the separate `subscribePresence` channel", naming a client-driven
//      toggle that had no wire shape to be driven by.
//
// A query string on the upgrade cannot serve these: it is evaluated ONCE, so it
// can express an initial subscribe and a resume cursor but can NEVER express
// subscribing to an additional Space, unsubscribing, or toggling presence on a
// live socket without tearing the socket down and rebuilding it.
//
// DELIBERATELY NOT HERE, and flagged rather than decided: (a) a server→client
// acknowledgement telling a client its subscribe was refused — without it an
// unauthorized subscribe is indistinguishable from an authorized-but-quiet
// Space; (b) a `schemaVersion` on control frames. Both are real questions and
// both would widen this beyond the three adopted requirements, so they are
// raised for arbitration instead of being settled here.
// ---------------------------------------------------------------------------

/**
 * How many Spaces one `subscribe`/`unsubscribe` frame may name.
 *
 * The wire is untrusted input: without a bound, one frame can ask the server to
 * allocate and authorize an unbounded set. Bounded for the same reason
 * `events.poll` clamps `limit` rather than trusting it.
 */
export const MAX_CONTROL_FRAME_SPACES = 100;

/**
 * A control frame sent BY A CLIENT to the server over `events.subscribe`.
 *
 * `subscribe` and `resume` are deliberately separate frames rather than one
 * `subscribe {since?}`. They are different requests: `subscribe` is idempotent
 * membership in the fan-out, `resume` is a replay of stored events from a
 * cursor. Merging them would make every re-subscribe implicitly re-replay, and
 * would leave a client that is ALREADY subscribed and has merely detected a gap
 * with no way to ask for the gap without a redundant subscribe.
 *
 * Subscribing is NOT a way around read authorization: the server authorizes
 * every named Space against the same membership predicate that guards
 * `spaces.get`, and a Space the caller may not read is never added to the
 * connection's fan-out set.
 */
export type WorkspaceControlFrame =
  /** Add these Spaces to this connection's durable fan-out set. */
  | { type: 'subscribe'; spaceIds: SpaceId[] }
  /** Remove these Spaces from it. */
  | { type: 'unsubscribe'; spaceIds: SpaceId[] }
  /** Toggle the ephemeral presence channel for the Spaces already subscribed (DEV-4). */
  | { type: 'presence'; on: boolean }
  /**
   * Replay stored events for `spaceId` after `since`.
   *
   * `since` is the per-Space `seq` from the AM-2 §3 envelope — the last seq the
   * client durably applied — not a timestamp and not an opaque cursor.
   */
  | { type: 'resume'; spaceId: SpaceId; since: number }
  /**
   * Announce this caller's ephemeral presence at `entityId` (requirement 3).
   *
   * WHY THIS EXISTS, since it is the frame that is easiest to mistake for scope
   * growth: a presence-channel TOGGLE with no presence WRITER satisfies the
   * channel and not the requirement — `presence.get` would have no source and
   * would return empty viewers for every entity forever, which is the same
   * "green badge over an absence" construct `poll.ts` refuses for `events.poll`.
   * The toggle says "send me presence"; this says "here is some".
   *
   * `spaceId` is what gets AUTHORIZED. It is not trusted as a fact about where
   * `entityId` lives: the store is keyed by `(spaceId, entityId)` and
   * `presence.get` resolves an entity's REAL Space before reading, so a caller
   * that names the wrong Space writes into a bucket nobody ever reads. The lie
   * is self-neutralizing and costs no extra read on the write path.
   *
   * Ephemeral by construction (DEV-4): this never produces a durable row, never
   * advances the durable cursor, and is not replayable.
   */
  | { type: 'presence.set'; spaceId: SpaceId; entityId: EntityId; viewing: boolean; typing: boolean };

/**
 * The ONLY server→client message on this socket that is not a `WorkspaceEvent`.
 *
 * Without it a refused `subscribe` is indistinguishable from a Space that is
 * simply quiet, and a client would wait forever on events it will never be sent
 * — the same "cannot tell 'not allowed' from 'nothing here'" defect that makes
 * an always-empty read dishonest. The authorizer is the thing that must ship
 * with the control protocol, and this is the only side of it a client can see.
 *
 * `type` is namespaced `control.*`, which cannot collide with any
 * `WorkspaceEvent` variant, so a client discriminates on `type` as it already
 * does and never has to parse two competing shapes.
 */
export interface WorkspaceControlAck {
  type: 'control.refused';
  /** Which frame was refused. */
  frame: WorkspaceControlFrame['type'];
  /** Present when the refusal was about a specific Space. */
  spaceId?: SpaceId;
  /** `forbidden` = the authorizer said no. `malformed` = it was not a valid frame. */
  reason: 'forbidden' | 'malformed';
}

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
  recipient: ActorSummary;
  readAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Commands / mutation contract (§4)
// ---------------------------------------------------------------------------

/**
 * Closed error set (04-COMMUNICATION-MODEL §4, adopted via DEV-8).
 *
 * ⚠ AM-2 §4 AMENDMENT INSIDE §1 (flagged for the UI team): `limit_exceeded`
 * is added for governance caps — a refusal because a countable resource limit
 * is at capacity (e.g. the execution.spawn per-node/per-space session
 * concurrency cap). Distinct from `rate_limited` (request-frequency
 * throttling): same 429 status, retryable once capacity frees.
 */
/** Closed W0-dossier error subset used by the adopted amendment family. */
export type ErrorCode =
  | 'invalid_input' | 'forbidden' | 'not_found' | 'conflict'
  | 'invariant_violation' | 'limit_exceeded' | 'not_implemented';

export type AmendmentErrorReason =
  | 'use_message_send' | 'automated_wake_limit' | 'session_contact_forbidden'
  | 'handoff_forbidden' | 'message_batch_identity_mismatch'
  | 'feed_scope_not_applicable' | 'feed_item_not_in_scope'
  | 'project_not_linked' | 'project_association_cap' | 'project_over_cap'
  | 'menu_revision_conflict' | 'menu_upgrade_required'
  | 'profile_not_validated' | 'profile_referenced_default' | 'profile_retired'
  | 'profile_principal_required' | 'profile_capture_mode_reserved'
  | 'attachment_edge_owned';

/** Typed fields admitted by the W0 amendment family on `error.details`. */
export interface ErrorDetails {
  reason: string;
  currentVersion?: number;
  currentRevision?: number;
  currentMenu?: MenuConfig;
  activeLinks?: number;
  deliveryId?: string;
}

export type CommandErrorCode =
  | 'invalid_input' | 'invalid_cursor'
  | 'unauthenticated' | 'forbidden' | 'not_found'
  | 'version_conflict' | 'conflict' | 'invariant_violation'
  | 'payload_too_large' | 'rate_limited' | 'limit_exceeded'
  | 'not_implemented' | 'upstream_unavailable';

export const ERROR_STATUS: Record<CommandErrorCode, number> = {
  invalid_input: 400, invalid_cursor: 400,
  unauthenticated: 401, forbidden: 403, not_found: 404,
  version_conflict: 409, conflict: 409, invariant_violation: 409,
  payload_too_large: 413, rate_limited: 429, limit_exceeded: 429,
  not_implemented: 501, upstream_unavailable: 503,
};

export const RETRYABLE_BY_DEFAULT = new Set<CommandErrorCode>(['rate_limited', 'limit_exceeded', 'upstream_unavailable']);

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
  clientMutationId: string;
  spaceId: SpaceId;
  kind: Exclude<EntityKind, 'message' | 'member' | 'work_session' | 'project' | 'interaction_profile'>;
  title: string;
  parentId?: EntityId | null;
  position?: number;
  content?: Record<string, unknown>;
  attachTo?: { entityId: EntityId; edgeType: 'attached_to' | 'relates_to' };
  connections?: InitialConnectionInput[];
}

/** Atomic initial edge created in the same transaction as its source entity. */
export interface InitialConnectionInput {
  type: string;
  targetId: EntityId;
  props?: Record<string, unknown>;
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

/** Canonical post-batch DTO after deprecated singular-anchor normalization. */
export interface PostMessageInput extends CommandContext {
  clientMutationId: string;
  anchorIds: EntityId[];
  body: string;
  parentMessageId?: EntityId | null;
  mentionIds?: EntityId[];
  attachmentIds?: EntityId[];
}

/** Accepted only at the versioned input migration boundary. */
export type PostMessageWireInput = Omit<PostMessageInput, 'anchorIds'> & {
  anchorIds?: EntityId[];
  /** @deprecated Normalize to a one-element `anchorIds` array. */
  anchorId?: EntityId;
};

export interface MessageBatchResult {
  messageBatchId: string;
  messages: MessageView[];
}

export interface PatchMessageInput extends CommandContext {
  clientMutationId: string;
  expectedVersion: number;
  body: string;
  mentions?: Mention[];
}

export interface DeleteMessageInput extends CommandContext {
  clientMutationId: string;
  expectedVersion: number;
}

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
export interface LinkPrInput extends CommandContext { clientMutationId: string; url: string; projectId?: ProjectId }

/** POST /v2/entities/:id/commands/link-commit — analogous to link-pr (01 §6). */
export interface LinkCommitInput extends CommandContext { clientMutationId: string; url: string; projectId?: ProjectId }

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
// W0 dossier: Space menu and shared settings revision
// ---------------------------------------------------------------------------

export type MenuViewRef = 'dashboard' | 'feed' | 'inbox' | 'workspace' | 'channels' | 'settings';
export type MenuKindRef = Exclude<EntityKind, 'channel' | 'message'>;

export type MenuLeaf =
  | { type: 'view'; ref: MenuViewRef }
  | { type: 'kind'; ref: MenuKindRef };

export type MenuItem =
  | { type: 'view'; ref: MenuViewRef; children?: MenuLeaf[] }
  | { type: 'kind'; ref: MenuKindRef };

export interface MenuGroup {
  id: string;
  label: string;
  items: MenuItem[];
}

export interface MenuConfigPayload {
  schemaVersion: 1;
  groups: MenuGroup[];
}

export interface MenuConfig extends MenuConfigPayload {
  revision: number;
}

export interface UpdateMenuInput {
  clientMutationId: string;
  expectedRevision: number;
  payload: MenuConfigPayload;
}

export interface SetDefaultChannelInput {
  clientMutationId: string;
  expectedSettingsRevision: number;
  channelId: EntityId | null;
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

/** Member-authorized settings projection returned by A03 and settings reads. */
export interface SpaceSettingsView extends SpaceSettings {
  menu: MenuConfig;
  defaultChannelId: EntityId | null;
  defaultInteractionProfileId: EntityId | null;
  settingsRevision: number;
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
  operation: OperationName;
  targetEntityId?: EntityId;
  targetVersion?: number;
  capabilityEpoch: string;
  authzTarget: 'server' | 'space' | 'project' | 'entity' | 'session';
  exposure: 'public' | 'composite' | 'internal' | 'reserved';
  helpRef: string;
}

export interface ActionDiscoveryResult {
  actorId: EntityId;
  targetEntityId?: EntityId;
  targetVersion?: number;
  capabilityEpoch: string;
  actions: PaletteAction[];
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

// --- projects — linked resources, NOT an entity kind (AM-2 §1, T-D17) -------

/**
 * A project is a repo/workingDir reference linked to spaces many-to-many
 * (T-D17: workspace = root container of one server instance; space = sharing
 * boundary; projects = linked resources). It deliberately is NOT an entity —
 * no hierarchy, edges, messages, or reactions — so it lives as a resource DTO
 * + the `projects.*` op family, and rides `space_projects` in the schema.
 */
export type ProjectId = string;

/**
 * Governance: `untrusted` projects are spawn-restricted — the execution block
 * refuses (or sandboxes, later) sessions whose cwd resolves into them;
 * `trusted` is the explicit opt-in for full agent execution.
 */
export type ProjectTrustLevel = 'trusted' | 'untrusted';

/** Per-project spawn defaults, overridable per `execution.spawn` call. */
export interface ProjectDefaults {
  model?: string | null;
  agentTool?: string | null;
  mode?: 'worker' | 'coordinator' | 'coordinated-worker' | 'coordinated-coordinator' | null;
}

export interface ProjectResource {
  id: ProjectId;
  name: string;
  repoUrl?: string | null;
  /** Absolute path on the owning node; path-traversal/symlink-guarded (10-SECURITY-MODEL). */
  workingDir: string;
  trust: ProjectTrustLevel;
  defaults: ProjectDefaults;
  /** Migration/remediation state for the 16-active-link cap. */
  linkFrozen?: boolean;
  activeLinkCount?: number;
  createdAt: string;
  updatedAt: string;
}

/** POST /v2/projects — workspace-scoped (node-level), then linked to spaces. */
export interface ProjectCreateInput extends CommandContext {
  name: string;
  workingDir: string;
  repoUrl?: string | null;
  /** Defaults to 'untrusted' — trust is an explicit grant. */
  trust?: ProjectTrustLevel;
  defaults?: ProjectDefaults;
}

/** PATCH /v2/projects/:projectId */
export interface ProjectUpdateInput extends CommandContext {
  name?: string;
  workingDir?: string;
  repoUrl?: string | null;
  trust?: ProjectTrustLevel;
  defaults?: ProjectDefaults;
}

/** POST /v2/spaces/:spaceId/projects — link (M2M); unlink is the DELETE binding. */
export interface ProjectLinkInput extends CommandContext {
  projectId: ProjectId;
}

export interface CorrectProjectAssociationInput {
  clientMutationId: string;
  projectId: ProjectId;
  expectedArtifactVersion: number;
}

export interface EdgeCorrectionResult {
  artifactId: EntityId;
  projectId: ProjectId;
  outcome: 'removed' | 'demoted' | 'unchanged';
  edge: EdgeView | null;
}

/**
 * Worktree semantics for a spawn (AM-2 §1): `project` runs the session
 * directly in `project.workingDir`; `worktree` gives it an isolated git
 * worktree (server-managed path under the node data dir, guarded per
 * 10-SECURITY-MODEL) off `baseRef` (default: the repo's default branch).
 */
export type SpawnWorkdir =
  | { mode: 'project' }
  | { mode: 'worktree'; baseRef?: string | null }
  | { mode: 'scratch' };

// --- execution.* operation family (R16) ------------------------------------

/**
 * execution.spawn — the only way a `work_session` is born. The server-side
 * SpawnService (R27) reads the graph through this contract, creates the
 * work_session entity + `working_on` edges + manifest in one transaction, and
 * emits the spawn request to the server-hosted PTY (AM-1: server PTY is the
 * ONLY spawn path — there is no desktop shell). Result: `CommandResult` whose
 * `entity` is the new work_session detail.
 *
 * Governance minimums (AM-2 §4):
 * - The server enforces a session concurrency cap (per node and per space);
 *   a spawn over the cap is refused with `429 limit_exceeded` (retryable
 *   once a session exits) — never queued silently.
 * - `execution.terminate` is THE cancellation path — there is no separate
 *   cancel operation.
 * - Every `execution.*` command is recorded in the command_ledger like any
 *   other mutation — the ledger is the execution audit trail.
 */
export interface ExecutionSpawnInput extends CommandContext {
  clientMutationId: string;
  spaceId: SpaceId;
  /** The persona to run; authorization resolves through its owner (T-L7). */
  teamMemberId: EntityId;
  /** Tasks the session works on — become `working_on` edges. */
  taskIds?: EntityId[];
  /**
   * AM-2 §1: typed project reference (replaces the untyped `projectRef`).
   * The project must be linked to `spaceId` and pass its trust gate.
   * Required when `workdir.mode` is 'worktree'; omitted/null = a projectless
   * scratch session in a server-managed temp dir.
   */
  projectId?: ProjectId | null;
  /** Working-directory semantics; default `{ mode: 'project' }`. */
  workdir?: SpawnWorkdir;
  /** Explicit consent carrier for untrusted Projects and scratch roots. */
  confirmUntrusted?: true;
  /** Optional active profile override; human-principal authorization is server-owned. */
  interactionProfileId?: EntityId;
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

/**
 * execution.terminate — POST /v2/entities/:id/commands/terminate. This IS the
 * cancellation path (AM-2 §4): graceful stop by default, `force` kills the
 * PTY. Terminations are ledgered like every execution.* command.
 */
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

/**
 * A21 — `execution.liveness` (shape C-1): "is there actually a live PTY?"
 *
 * Recorded `work_sessions.status` and in-process PTY truth can disagree
 * between boots (ghost reconciliation runs only at startup), so a
 * status=running row is not evidence of a live terminal. This read answers
 * from the ONE authority — the node's in-process PTY map — scoped to the
 * sessions of one space the caller can read.
 *
 * `nodeBootId` is stable for the life of the server process and rotates on
 * restart: a client comparing it across reads can tell "same node, session
 * genuinely gone" from "node restarted — recorded statuses are stale until
 * reconciliation" (the R-UI-5 honesty states). `checkedAt` is stamped at
 * read time; liveness is a point-in-time observation, never a promise.
 */
export interface ExecutionLiveness {
  /** work_session entity ids of THIS space with a live PTY right now. */
  liveEntityIds: EntityId[];
  nodeBootId: string;
  checkedAt: string;
}

// --- files.* blob lifecycle (AM-2 §2, 03 §6) --------------------------------

/**
 * Blob storage model (03 §6): bytes live on local disk under the node's data
 * dir (object storage on hubs) at `spaces/<spaceId>/…`, brokered exclusively
 * by tm8-server routes carrying the SAME membership checks as the graph —
 * graph RLS and blob authz must never disagree. Blobs are part of a space's
 * backup/export.
 *
 * Lifecycle: `uploadInit` reserves an upload slot and returns a grant;
 * the client PUTs the raw bytes to `uploadUrl`; `uploadComplete` verifies
 * size + checksum and creates the `file` entity (the graph-side record) in
 * one transaction; `uploadAbort` (or grant expiry) releases the slot.
 *
 * GC/retention: orphaned upload slots (never completed) are GC'd after grant
 * expiry; blob bytes are GC'd when their `file` entity is hard-purged after
 * the soft-delete retention window — a soft-deleted file's bytes remain
 * restorable until then.
 */

/** Deployment-configurable ceiling; grants carry the effective value. */
export const FILE_MAX_SIZE_BYTES_DEFAULT = 512 * 1024 * 1024;

/** Blob checksums are SHA-256, lowercase hex. */
export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/** POST /v2/files/uploads */
export interface FileUploadInitInput extends CommandContext {
  spaceId: SpaceId;
  name: string;
  mime: string;
  /** Declared size; uploadComplete refuses a mismatch (payload_too_large above the limit). */
  sizeBytes: number;
  /** SHA-256 of the blob, lowercase hex; verified at uploadComplete. */
  checksumSha256: string;
  /** Optional anchor: on complete, the file entity is `attached_to` this entity. */
  entityId?: EntityId | null;
}

export interface FileUploadGrant {
  uploadId: string;
  /** PUT target for the raw bytes (server-relative or absolute). */
  uploadUrl: string;
  token?: string | null;
  expiresAt: string;
  /** The deployment's effective per-blob size limit. */
  maxSizeBytes: number;
}

/**
 * POST /v2/files/uploads/:uploadId/complete — verifies size + checksum,
 * creates the `file` entity; result is a CommandResult whose `entity` is the
 * new file detail. POST /v2/files/uploads/:uploadId/abort releases the slot.
 * Both take only the command context (ids travel in the path).
 */
export interface FileUploadCompleteInput extends CommandContext {
  clientMutationId: string;
  /** Finalized `file -> attached_to -> target` edges created atomically. */
  targets?: EntityId[];
}
export type FileUploadAbortInput = CommandContext;

/**
 * GET /v2/files/:fileEntityId/download — the authorized, entity-scoped byte
 * stream. NOTE: this is the one read that returns raw bytes, NOT the DEV-6
 * JSON envelope (content-type/content-length from file state; errors still
 * use the wire error body). `bridge.fetchBlob` — cross-node blob fetch over
 * the asymmetric bridge — is RESERVED for Phase 2 and must answer an honest
 * 501 until built (DEV-13).
 */

// --- W0 amendment DTOs -------------------------------------------------------

export interface AddMessageAttachmentsInput {
  clientMutationId: string;
  expectedVersion: number;
  fileEntityIds: EntityId[];
}
export type RemoveMessageAttachmentsInput = AddMessageAttachmentsInput;

export interface MessageDeliveryQuery {
  cursor?: Cursor;
  limit?: number;
}

export type MessageDeliveryStatus =
  | 'pending' | 'dispatching' | 'delivered' | 'failed_retryable'
  | 'failed_permanent' | 'unknown' | 'expired' | 'cancelled';

export interface MessageDeliveryRecord {
  deliveryId: string;
  messageId: EntityId;
  sourceWorkSessionId: EntityId | null;
  targetWorkSessionId: EntityId;
  status: MessageDeliveryStatus;
  attemptNo: number;
  failureReason: string | null;
  reservedAt: string;
  claimedAt: string | null;
  settledAt: string | null;
  updatedAt: string;
}

export interface MessageDeliveryView {
  message: MessageView;
  deliveries: MessageDeliveryRecord[];
}

export type HandoffDeliveryStatus = 'prepared' | 'dispatching' | 'delivered' | 'refused' | 'unknown';
export type HandoffRecordStatus = 'pending' | 'recorded' | 'failed' | 'withdrawn';

export interface ShareProjectionEnvelope {
  entityId: EntityId;
  kind: EntityKind;
  title: string;
  contentVersion: number;
  sourceSpaceId: SpaceId;
  body: string;
  bodyBytes: number;
  truncated: boolean;
  omittedFields: string[];
}

export interface SendHandoffInput {
  clientMutationId: string;
  sourceEntityId: EntityId;
}

export interface HandoffListQuery {
  deliveryStatus?: HandoffDeliveryStatus[];
  recordStatus?: HandoffRecordStatus[];
  cursor?: Cursor;
  limit?: number;
}

export interface WithdrawHandoffInput {
  clientMutationId: string;
  expectedRecordVersion: number;
  reason?: string;
}

export interface HandoffView {
  handoffId: string;
  sourceEntityId: EntityId;
  targetWorkSessionId: EntityId;
  deliveryStatus: HandoffDeliveryStatus;
  recordStatus: HandoffRecordStatus;
  sourceSnapshot: ShareProjectionEnvelope;
  envelopeHash: string;
  sourceMissing: boolean;
  recordVersion: number;
  withdrawnBy: ActorSummary | null;
  withdrawnAt: string | null;
  withdrawReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FeedScope = 'direct_v1' | 'session_chat_v1';
export type FeedVia = 'subject' | 'anchored' | 'authored' | 'replies' | 'caused';

export interface EntityFeedQuery {
  scope?: 'default' | FeedScope;
  order?: 'newest' | 'oldest';
  around?: `message:${string}` | `activity:${string}`;
  cursor?: Cursor;
  limit?: number;
}

export interface DeliverySummary {
  deliveryId: string;
  targetWorkSessionId: EntityId;
  status: MessageDeliveryStatus;
  attemptNo: number;
  failureReason: string | null;
  updatedAt: string;
}

export interface FeedItemBase {
  itemId: string;
  createdAt: string;
  sortId: string;
  via: FeedVia[];
  actor: ActorSummary | null;
  sourceWorkSessionId: EntityId | null;
  anchor: EntitySummary | null;
  logicalOperationId: string | null;
}

export type FeedItem =
  | (FeedItemBase & { itemKind: 'message'; message: MessageView; delivery: DeliverySummary[] })
  | (FeedItemBase & { itemKind: 'activity'; activity: ActivityItem });

export interface EntityFeedPage {
  resolvedScope: FeedScope;
  predicates: FeedVia[];
  items: FeedItem[];
  nextCursor: Cursor | null;
  previousCursor?: Cursor | null;
}

export type EntityContextSection = 'summary' | 'hierarchy' | 'connections' | 'messages' | 'activity' | 'actions';

export interface EntityContextQuery {
  sections?: EntityContextSection[];
  totalBytes?: number;
  sectionBytes?: number;
}

export interface EntityContextView {
  schemaVersion: 'tm8.entity-context.v1';
  root: EntitySummary;
  content?: { excerpt: string; source: 'entity' | 'message' | 'file'; truncated: boolean };
  parents: EntitySummary[];
  children: EntitySummary[];
  edges: EdgeView[];
  messages: MessageView[];
  actions: PaletteAction[];
  provenance: { operation: OperationName; fetchedAt: string; eventSeq: number };
  cursors: Record<string, Cursor | null>;
  byteSize: number;
  truncated: boolean;
}

export interface ClosedPromptPolicy {
  kernelTemplate: string;
  manifestMaxBytes: number;
  kernelMaxBytes: number;
  initialContextMaxBytes: number;
  rollingControlMaxBytes: number;
  allowedInjectionKinds: string[];
  untrustedEncoding: 'escaped-xml';
}

export interface ToolDiscoveryPolicy {
  rootHelpRef: 'tm8://help';
  preloadNouns: string[];
  semanticSearchEnabled: boolean;
  semanticMaxMatches: number;
  nounShardMaxBytes: number;
  commandShardMaxBytes: number;
  entityContextDefaultBytes: number;
  providerToolRegistrationAllowlist?: OperationName[];
}

export interface FeedPolicy {
  scope: FeedScope;
  pageSize: number;
  bodyExcerptBytes: number;
}

export interface ComposerInteractionPolicy {
  schemaRef: string;
  supportsReply: boolean;
  supportsAttachments: boolean;
  allowedAttachmentKinds: string[];
  operationBindings: OperationName[];
}

export interface InteractionProfileDraft {
  name: string;
  templateKey: string;
  templateVersion: number;
  promptPolicy: ClosedPromptPolicy;
  toolDiscoveryPolicy: ToolDiscoveryPolicy;
  feedPolicy: FeedPolicy;
  providerCaptureMode: 'explicit-only';
  composerPolicy: ComposerInteractionPolicy;
}

export type InteractionProfileStatus = 'draft' | 'active' | 'retired';

export interface ProposeInteractionProfileInput {
  clientMutationId: string;
  spaceId: SpaceId;
  draft: InteractionProfileDraft;
}
export interface UpdateInteractionProfileDraftInput {
  clientMutationId: string;
  expectedVersion: number;
  draft: InteractionProfileDraft;
}
export interface ValidateInteractionProfileInput { clientMutationId: string; expectedVersion: number }
export interface PreviewInteractionProfileInput { profileVersion: number }
export interface ActivateInteractionProfileInput {
  clientMutationId: string;
  validatedVersion: number;
  validatedHash: string;
  confirm: true;
}
export interface RetireInteractionProfileInput {
  clientMutationId: string;
  expectedVersion: number;
  confirm: true;
}
export interface SetTeammateProfileDefaultInput {
  clientMutationId: string;
  expectedVersion: number;
  profileId: EntityId | null;
}
export interface SetSpaceProfileDefaultInput {
  clientMutationId: string;
  expectedSettingsRevision: number;
  profileId: EntityId | null;
  confirmAgentGenerated?: true;
}

export interface InteractionProfileView {
  profileId: EntityId;
  spaceId: SpaceId;
  status: InteractionProfileStatus;
  currentDraftVersion: number;
  validatedVersion: number | null;
  validatedHash: string | null;
  activeVersion: number | null;
  activeHash: string | null;
  generatedByTeamMemberId: EntityId | null;
  retiredAt: string | null;
  version: number;
  draft: InteractionProfileDraft;
}

export interface ProfileValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface ProfileValidationView {
  profileId: EntityId;
  profileVersion: number;
  status: 'valid' | 'invalid';
  validatedHash: string | null;
  issues: ProfileValidationIssue[];
}

/** Sanitized, non-interactive projection: no prompt/tool/capture policy. */
export interface InteractionProfilePreview {
  profileId: EntityId;
  profileVersion: number;
  name: string;
  templateKey: string;
  templateVersion: number;
  feedPolicy: FeedPolicy;
  composerPolicy: ComposerInteractionPolicy;
  validatedHash: string | null;
  generatedByTeamMemberId: EntityId | null;
}

export interface TeammateProfileDefaultView {
  teamMemberId: EntityId;
  defaultInteractionProfileId: EntityId | null;
  version: number;
}

export interface SpaceProfileDefaultView {
  spaceId: SpaceId;
  defaultInteractionProfileId: EntityId | null;
  settingsRevision: number;
}

export interface InteractionProfilePinView {
  workSessionId: EntityId;
  pinRevision: number;
  profileId: EntityId | null;
  profileVersion: number | null;
  templateKey: string;
  templateVersion: number;
  resolvedHash: string;
  source: 'spawn_override' | 'teammate_default' | 'space_default' | 'core_default';
  createdAt: string;
}

export type InboxRecipient =
  | { type: 'member'; memberId: EntityId }
  | { type: 'team_member'; teamMemberId: EntityId };

export interface InboxListQuery {
  recipient?: InboxRecipient;
  spaceId?: SpaceId;
  unread?: boolean;
  cursor?: Cursor;
  limit?: number;
}

export interface InboxMarkReadInput {
  clientMutationId: string;
  recipient?: InboxRecipient;
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
