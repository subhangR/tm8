/**
 * @tm8/contract — DTO + command types. THE LAW.
 *
 * §1 of this file is a near-verbatim transcription of the Collab V2 UI's
 * `types/contract.ts` (vendored at docs/history/collab-v2/ui-snapshot/ui-types-contract.ts.txt),
 * itself transcribed from docs/history/collab-v2/UI-DATA-CONTRACT.md. Keep the diff
 * against that snapshot ~zero so the W3 UI transplant is mechanical.
 *
 * §2 is the tm8 extension block (docs/architecture/03-ENTITY-GRAPH-DELTAS):
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
  | 'work_session' | 'collection' | 'project' | 'interaction_profile'
  | 'voice_channel'
  | 'memory'
  | 'artifact'
  | 'worktree'
  | 'loop';

/** tm8: runtime-registered custom kinds are namespaced (T-L4). */
export type CustomEntityKind = `c:${string}`;

export type EntityKind = CoreEntityKind | CustomEntityKind;

export type WorkStatus = 'open' | 'pulled' | 'working' | 'in_review'
  | 'done' | 'blocked' | 'cancelled';

export type Visibility = 'space' | 'restricted';

export interface ActorSummary {
  id: EntityId;
  /**
   * `work_session` joined 2026-08-05: most `working_on` edges are sourced from
   * a RUN, not a person, and the two-value union forced the resolver to mint
   * them as `{kind:'member', displayName:'Member'}` — a false human. A
   * session-sourced actor now resolves to its PERSONA (kind `team_member`,
   * plus `via`) when `participates_in` names one, and is otherwise typed as
   * what it is. The ONE deliberate non-additive change in the board/people
   * wave; adjudicated twice independently.
   */
  kind: 'member' | 'team_member' | 'work_session';
  displayName: string;
  avatar?: string | null;
  role?: string | null;
  ownerMemberId?: EntityId;       // present for a team_member
  isAgent: boolean;
  /**
   * Present when this actor was RESOLVED THROUGH a work_session: the summary
   * is the persona, and `via.sessionId` is the run it acted through. Additive;
   * a consumer that ignores it renders the persona and is still truthful.
   */
  via?: { sessionId: EntityId };
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
  | { kind: 'channel'; topic: string; members: ActorSummary[]; unreadCount: number;
      workingAgentCount: number }
  | { kind: 'doc'; format: 'markdown'|'mermaid'|'excalidraw'; childCount: number }
  | { kind: 'message'; anchorId: EntityId; rootMessageId: EntityId | null; author: ActorSummary;
      messageBatchId: string | null; editedAt?: string | null; redactedAt?: string | null }
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
      startedAt: string | null; exitedAt: string | null;
      /**
       * WHAT KIND OF SESSION THIS IS — the discriminator that lets a client
       * tell a private credential login terminal from ordinary work (083).
       *
       * OPTIONAL, AND ITS ABSENCE IS LOAD-BEARING. A node that predates 083,
       * or a row hydrated from a payload cached before the column shipped,
       * carries no value here. Absence therefore means `agent` — the pre-083
       * behaviour — so a frozen server degrades to showing everything rather
       * than to showing nothing.
       *
       * WRITE EVERY CLIENT FILTER AS `sessionKind !== 'credential'`, NEVER AS
       * `=== 'agent'`. SQL surfaces test the positive (`session_kind =
       * 'agent'`, credential-catalog.ts:506) because the database column is
       * NOT NULL; TypeScript surfaces must test the INVERSE, because here the
       * field can be missing. `=== 'agent'` passes every test written against
       * fresh data and silently blanks the session list for anyone holding an
       * older payload.
       */
      sessionKind?: WorkSessionKind }
  | { kind: 'collection'; collectionType: string; itemCount: number }
  | { kind: 'project'; projectId: ProjectId; materializedVersion: number }
  | { kind: 'interaction_profile'; status: InteractionProfileStatus;
      currentDraftVersion: number; activeVersion: number | null;
      activeHash: string | null; retiredAt: string | null;
      /** The draft's surface choice, absent when the draft has no opinion. */
      initialContentSurface?: 'terminal' | 'chat' }
  /** Roster count is a live read from the ephemeral voice-participants store, never stored. */
  | { kind: 'voice_channel'; participantCount: number }
  /**
   * The scope fields ride in `state` so they arrive on EVERY summary read, in
   * the same payload as the title — a value cannot travel away from the
   * conditions that produced it. The statement itself is content; summaries
   * carry it through the excerpt.
   */
  | { kind: 'memory'; mechanism: string; subjectScope: string;
      doesNotEstablish: string; measuredAt: string | null }
  /** Publish drives version advancement; `revisionNumber` is the current bundle revision. */
  | { kind: 'artifact'; revisionNumber: number }
  /**
   * Semantic lifecycle only (forward-only: active → merged|abandoned → deleted).
   * Operational disk health (preparing/ready/missing/…) deliberately does NOT
   * appear here — it lives in `worktree_allocations`, which is not entity-backed
   * and never bumps the entity version (WORKTREE-DESIGN.md §3).
   */
  | { kind: 'worktree'; status: WorktreeStatus; branch: string; baseRef: string;
      baseCommitOid: string; projectId: ProjectId }
  /**
   * Scheduling state rides in `state` so a list can show "enabled, next at X"
   * without a second read. `teamMemberId: null` is MEANINGFUL — it means the
   * firing routes through the dispatcher rather than naming a runner.
   */
  | { kind: 'loop'; schedule: string; enabled: boolean; teamMemberId: EntityId | null;
      subjectId: EntityId | null; nextRunAt: string | null; lastRunAt: string | null;
      lastError: string | null };

/** tm8 (T-L4): custom-kind Z1/Z2 fields are the schema-validated scalars. */
export interface CustomEntityState { kind: CustomEntityKind; fields: Record<string, CustomFieldValue> }

export type EntityState = CoreEntityState | CustomEntityState;

export interface EntityBadges {
  /** Derived from unresolved rows in `attention_requests`; never stored on the entity. */
  attention?: EntityAttentionSummary;
  blocked?: { unresolvedHardDependencyCount: number; waitingOn: EntitySummary[] };
  pulls?: PullState[];
  workingActors?: LiveWork[];
  /**
   * Additive: the latest `completed_by` edge, readable at last — the house
   * pattern (written by the completion command, and it IS an ending). Detail
   * header line "Completed by {actor} {date}" and the Z2 card field.
   */
  completedBy?: { actor: ActorSummary; at: string };
  restricted?: boolean;
  /**
   * Derived at read time from mark edges and versions; never stored.
   * ABSENT MEANS UNFLAGGED — it does NOT mean verified or current.
   */
  staleness?: EntityStaleness;
}

/**
 * Derived at read time from mark edges (`supersedes`, `disputes`, `verifies`,
 * `based_on`, `copy_of`) and pinned versions; never stored. ABSENT MEANS
 * UNFLAGGED — it does NOT mean verified or current. `verified` is present only
 * when a verifying edge exists, and `verified.current` is false once the
 * target's content has moved past the version that was verified. Every value
 * is viewer-independent.
 */
export interface EntityStaleness {
  /** Every reason that applies, in display-precedence order (superseded > disputed > basisDeleted > basisMoved). Never empty — the badge is absent instead. */
  reasons: ('superseded' | 'disputed' | 'basisDeleted' | 'basisMoved')[];
  superseded?: { byId: EntityId; headId: EntityId | null; depthTruncated: boolean };
  disputed?: { openCount: number; latestAt: string };
  basisDeleted?: { count: number };
  basisMoved?: { count: number };
  verified?: { at: string; atVersion: number; current: boolean;
               independenceBasis: 'session' | 'actor' };
}

export type AttentionRequestStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed';

/** Compact aggregate carried by every entity summary and used to prioritize lists. */
export interface EntityAttentionSummary {
  pendingCount: number;
  totalPoints: number;
  maxPoints: number;
  latestReason: string;
  oldestRequestedAt: string;
}

/** A generic attention item can target any present or future entity kind. */
export interface AttentionRequest {
  id: string;
  spaceId: SpaceId;
  entityId: EntityId;
  reason: string;
  points: number;
  status: AttentionRequestStatus;
  version: number;
  requestedBy: ActorSummary;
  acknowledgedBy: ActorSummary | null;
  resolvedBy: ActorSummary | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface AttentionRequestListQuery {
  spaceId: SpaceId;
  entityId?: EntityId;
  status?: AttentionRequestStatus;
  minPoints?: number;
  limit?: number;
  cursor?: string;
}

export type AttentionRequestPage = Page<AttentionRequest>;

export interface AttentionRequestMutationResult {
  request: AttentionRequest | null;
  entity: EntitySummary;
  affectedCount: number;
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

/**
 * Safe viewer-side projection of the immutable work-session Interaction
 * Profile pin. Agent prompt/tool policy and credentials are intentionally not
 * representable in this shape.
 */
export interface WorkSessionInteractionProfileProjection {
  pinRevision: number;
  templateKey: string;
  templateVersion: number;
  compatibility: 'supported' | 'unknown_template';
  chatEnabled: boolean;
  initialContentSurface: 'terminal' | 'chat';
  feedPolicy: FeedPolicy;
  composerPolicy: ComposerInteractionPolicy;
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
      workingOn: EntitySummary[]; transcriptDoc: EntitySummary | null;
      /** Null means no readable immutable pin, so Terminal is the only surface. */
      interactionProfile?: WorkSessionInteractionProfileProjection | null }
  | { kind: 'collection'; description: string; items: EntitySummary[] }
  | { kind: 'project'; projectId: ProjectId; repoUrl?: string | null;
      materializedVersion: number }
  | { kind: 'interaction_profile'; status: InteractionProfileStatus;
      templateKey: string; templateVersion: number; resolvedHash: string | null;
      generatedByTeamMemberId: EntityId | null }
  | { kind: 'voice_channel' }
  | { kind: 'memory'; statement: string; mechanism: string; subjectScope: string;
      doesNotEstablish: string; measuredAt: string | null }
  /** The current bundle revision, projected; the bytes are served via preview/export, not here. */
  | { kind: 'artifact'; description: string | null; currentRevisionNumber: number;
      entrypoint: string; manifestSha256: string; fileCount: number; totalSizeBytes: number }
  | { kind: 'worktree'; projectId: ProjectId; path: string; branch: string;
      baseRef: string; baseCommitOid: string; status: WorktreeStatus;
      statusChangedAt: string | null }
  | { kind: 'loop'; schedule: string; enabled: boolean; teamMemberId: EntityId | null;
      subjectId: EntityId | null; prompt: string; config: Record<string, unknown>;
      nextRunAt: string | null; lastRunAt: string | null; lastError: string | null };

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
  canPull: boolean; canReact: boolean; canGrantPoints: boolean; canComplete: boolean;
  /**
   * Additive: the state ids the viewer may move this entity to, when a
   * transition matrix EXISTS for its type. ABSENT means "no matrix — fall
   * back to the registry vocabulary"; PRESENT is authoritative narrowing
   * (doc 06 §1.5). Today no server matrix exists, so no server populates it;
   * the field lands with the contract so both old and new servers are legal.
   */
  allowedTransitions?: string[] }

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
     * Additive (board/people wave): entities this actor WORKED, resolved
     * through the second hop — a `working_on` edge whose source is the actor
     * itself OR a work_session the actor `participates_in`. A plain
     * `filters.edge` on `working_on` matches only person-sourced edges (15%
     * of the live data) and silently misses the rest; this is the honest
     * form, so the "Worked by" filter may ship (doc 06 §3.2's gate).
     */
    workedByActorId?: EntityId;
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
  sort?: 'activityAt_desc'|'updatedAt_desc'|'createdAt_desc'|'position'|'dueDate'|'priority';
  cursor?: Cursor; limit?: number;
}

export interface CollectionResult { query: CollectionQuery; page: Page<EntitySummary>; groups?: CollectionGroup[] }
export interface CollectionGroup {
  key: string; label: string; items: EntitySummary[]; nextCursor?: Cursor;
  /**
   * Additive: the group's TRUE size under the query's filters, independent of
   * the page window. Fills the board's column headers with real counts and
   * retires the "{n} shown" hedge; groups themselves stay page-scoped until
   * per-group cursors exist.
   */
  total?: number;
}
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

/** tm8 voice channels (LiveKit): one roster row per connected participant. */
export interface VoiceParticipant { memberId: EntityId; name: string; muted?: boolean }

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
 | { type: 'message.created'|'message.updated'|'message.deleted'; anchorId: EntityId;
     // ENVELOPE provenance, sitting next to `anchorId` (the target): the SENDER
     // work session the message was authored FROM, so a consumer can animate a
     // message travelling from session A to session B. It is the recorder-owned
     // `authored_from` edge's `dst_id`, hydrated live at map time — it is NOT on
     // `CoreEntityState kind:'message'` and NOT on MessageView, because it is a
     // fact about the delivery envelope, not about the message entity. Optional
     // and nullable: human-authored messages have no `authored_from` edge, and
     // rows captured before this field must stay valid under `assertWorkspaceEvent`.
     sourceWorkSessionId?: EntityId | null;
     message: MessageView; clientMutationId?: string }
 | { type: 'counter.changed'; entityId: EntityId; counters: EntityCounters; clientMutationId?: string }
 | { type: 'activity.created'; activity: ActivityItem; clientMutationId?: string }
 | { type: 'notification.created'|'notification.read'; notification: NotificationItem; clientMutationId?: string }
 | { type: 'menu.updated'; menu: MenuConfig; clientMutationId?: string }
 | { type: 'space.default_channel.updated'; channelId: EntityId | null;
     settingsRevision: number; clientMutationId?: string }
 // Git facts on the durable stream (Tier 4 git×graph). RPC-authored
 // passthrough rows: the SQL authors (db/migrations/083) build these payloads
 // contract-shaped, discriminant included — see mapper.ts
 // RPC_AUTHORED_PASSTHROUGH for the membership rules they satisfy.
 | { type: 'git.commit_recorded'; commitEntityId: EntityId; repo: string; sha: string;
     provider: string; clientMutationId?: string }
 | { type: 'git.pr_state_changed'; prEntityId: EntityId; repo: string; number: number;
     previousState: 'open'|'merged'|'closed'|'draft'; state: 'open'|'merged'|'closed'|'draft';
     headSha?: string | null; clientMutationId?: string }
 | { type: 'git.worktree_status_changed'; worktreeEntityId: EntityId; projectId: string;
     branch: string; previousStatus: 'active'|'merged'|'abandoned'|'deleted';
     status: 'active'|'merged'|'abandoned'|'deleted'; clientMutationId?: string }
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
 | { type: 'typing.changed'; anchorId: EntityId; typingActorIds: EntityId[] }
 | { type: 'voice.participants.changed'; voiceChannelId: EntityId; spaceId: SpaceId;
     participants: VoiceParticipant[] });

/**
 * DEV-4: presence/typing are CLIENT-SYNTHESIZED, ephemeral events. They stay in
 * the WorkspaceEvent union but NEVER ride the durable `subscribe` stream — they
 * arrive only on the separate `subscribePresence` channel.
 *
 * tm8 voice channels: `voice.participants.changed` is SERVER-synthesized (from
 * LiveKit webhooks) but shares the same ephemeral contract — it is never
 * ledgered and must never ride the durable stream either (S12/voice plan §2).
 */
export type PresenceWorkspaceEvent =
  Extract<WorkspaceEvent, { type: 'presence.changed' | 'typing.changed' | 'voice.participants.changed' }>;

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
export interface CommandContext {
  actorId?: EntityId;
  clientMutationId?: string;
  /**
   * Work session that originated this command. The database authorizes the
   * claimed session against the resolved actor before recording provenance.
   */
  workSessionId?: EntityId;
}

/** A node-local, named route to another tm8 Server. Credentials are a later transport concern. */
export interface ServerConnection {
  id: string;
  name: string;
  baseUrl: string;
  username?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServerConnectionCreateInput extends CommandContext {
  clientMutationId: string;
  name: string;
  baseUrl: string;
  username?: string | null;
}

export interface ServerConnectionDeleteInput extends CommandContext {
  clientMutationId: string;
}

/**
 * `identity.profile.update` — the caller writes their OWN `user_profiles` row.
 *
 * Deliberately NO `actorId`: a profile belongs to an identity, not to a
 * per-space actor, so acting-as is meaningless here and `--as` must be
 * refused rather than ignored. There is likewise no field naming whose
 * profile to write — the subject is always the bound identity.
 *
 * All fields optional; only provided fields are written. `globalId` carries
 * the cross-server display binding in `issuer:subject` shape. It is a display
 * claim, never an authorization input (Identity v2 invariant I6).
 */
export interface IdentityProfileUpdateInput {
  clientMutationId: string;
  displayName?: string;
  avatar?: string;
  email?: string;
  globalId?: string;
}

/** The written profile, as `identity.profile.update` returns it. */
export interface IdentityProfileView {
  identityId: string;
  displayName: string | null;
  avatar: string | null;
  email: string | null;
  globalId: string | null;
}

// ---------------------------------------------------------------------------
// auth.* — local accounts (Identity v2 Stage 1, doc 4 §6).
//
// None of these extend CommandContext: an actor is a per-space authoring
// persona and has no meaning on the authentication surface, and auth commands
// are deliberately outside the idempotency ledger (a session row is not a
// graph mutation; a retried login mints a second session, which is correct).
// Strict schemas therefore refuse `actorId`/`clientMutationId` on the wire.
// ---------------------------------------------------------------------------

/**
 * Whether a command operation's DTO accepts `clientMutationId` at all.
 *
 * The paragraph above is the rule; this is the rule stated once so a caller can
 * ask instead of assuming. It exists because a transport that supplies an id
 * for the DTOs that require one must not supply it to the DTOs that forbid it —
 * doing so made every `auth.signup`/`auth.login`/`auth.logout` fail contract
 * validation with `Unrecognized key(s): 'clientMutationId'` whenever the
 * command ledger was disabled, which is the default.
 */
export function commandAcceptsClientMutationId(opName: string): boolean {
  return !opName.startsWith('auth.');
}

/** How a session authenticates thereafter. `agent` sessions are minted at spawn, never by `auth.login`. */
export type AuthSessionKindView = 'browser' | 'cli' | 'agent';

/** The session half of every auth response. The token itself appears exactly once, at issuance. */
export interface AuthSessionView {
  sessionId: string;
  kind: AuthSessionKindView;
  /** Persona-scoped agent sessions only; null for human sessions. */
  actingAsTeamMemberId: string | null;
  label: string | null;
  /** Present at issuance; `auth.session.get` verifies live rather than re-reading the row. */
  createdAt?: string;
  expiresAt: string;
}

/** The account half of every auth response. Never carries credential material. */
export interface AuthAccountView {
  accountId: string;
  identityId: string;
  username: string;
  displayName: string | null;
  isNodeAdmin: boolean;
  isOwner: boolean;
}

/**
 * `auth.signup` — node-admin creates a local account. NEVER open
 * self-registration: provisioning is the server owner's decision (doc 4 §6).
 * The password is hashed server-side (scrypt); it is transported in the
 * request body, which is why TLS is a hard prerequisite for real deployments
 * (review finding F8).
 */
export interface AuthSignupInput {
  username: string;
  password: string;
  displayName?: string;
  email?: string;
  /** Node-level role — accounts, invites, limits. Never widens `can_act_as`. */
  isNodeAdmin?: boolean;
}

export interface AuthSignupResult {
  account: AuthAccountView;
}

/** `auth.login` — exchange a local credential for a `tm8s_…` bearer token. */
export interface AuthLoginInput {
  username: string;
  password: string;
  /** Defaults to `browser`. `agent` is refused — agent tokens are minted at spawn. */
  kind?: 'browser' | 'cli';
  /** Free-form label shown in session listings (e.g. a device name). */
  label?: string;
}

export interface AuthLoginResult {
  /** `tm8s_<sessionId>.<secret>` — returned exactly once, never recoverable. */
  token: string;
  account: AuthAccountView;
  session: AuthSessionView;
}

/**
 * `auth.logout` — revoke the presented bearer session, or (node admin / same
 * account) an explicitly named one. A loopback auto-owner request carries no
 * session; naming none is then an `invalid_input`.
 */
export interface AuthLogoutInput {
  /** Defaults to the session presented in the Authorization header. */
  sessionId?: string;
}

export interface AuthLogoutResult {
  sessionId: string;
  revoked: boolean;
}

/** `auth.session.get` — who am I, on this server, and how am I authenticated. */
export interface AuthSessionGetResult {
  /** `bearer` for token callers; `auto-owner` for the loopback degenerate case. */
  authKind: 'bearer' | 'auto-owner';
  account: AuthAccountView;
  /** null for the loopback auto-owner, which authenticates without a session row. */
  session: AuthSessionView | null;
}

// ---------------------------------------------------------------------------
// credentials.* — Tier B per-member vendor credentials (sub-doc 11 §D).
//
// NONE of these extend `CommandContext`, and the omission is the point rather
// than an oversight. `CommandContext` carries `actorId`, which exists so a
// caller can act AS a teammate — and a credential operation is the one thing
// that must never be performed on someone else's behalf (finding D2). The
// defence is now stated three times, in three layers that fail independently:
// `start_credential_session` builds its envelope from
// `internal.current_member_id` and never `internal.resolve_actor` (083);
// `W2CredentialSessionsService.start` throws if the claims envelope carries an
// `actorId` at all; and the strict schemas over these DTOs REFUSE `actorId` on
// the wire rather than ignoring it, so the field cannot even arrive.
//
// They DO accept `clientMutationId`, because `commandAcceptsClientMutationId`
// admits everything outside `auth.*` and a transport that supplies one to a
// schema that forbids it fails validation — the exact bug that paragraph
// documents.
// ---------------------------------------------------------------------------

/**
 * The three providers a login terminal can run.
 *
 * Wider than what `account_agent_credentials` will store, and DELIBERATELY so
 * (R6): that table's CHECK admits only the two FILE-shaped providers, while a
 * GitHub token is string-shaped and belongs in 079's `account_git_credentials`.
 * `credential_sessions.provider` carries all three because the terminal can run
 * `gh auth login` regardless of where its output lands. A provider is admitted
 * by measuring its login flow, never by widening a constraint.
 */
export type CredentialProviderName = 'anthropic' | 'openai' | 'github';

/** One provider's card on the Connections screen. */
export interface CredentialConnectionView {
  provider: CredentialProviderName;
  /** The only field the UI may branch a "Connected" badge on. */
  connected: boolean;
  /**
   * The vendor-side account name, when the login verb can learn one.
   *
   * For anthropic this is populated post-R4-amendment: tm8 now runs `claude
   * auth login` (whose grant includes `user:profile`), because the previously
   * ruled `claude setup-token` PRINTS a token without persisting a login, so
   * the finish probe could never see a completed flow. Rows minted under the
   * old verb remain NULL here — the UI must still branch on presence and
   * render "Connected — inference access" for them, never "Connected as null".
   */
  login: string | null;
  authMethod: string | null;
  status: 'active' | 'stale' | 'revoked' | null;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
}

/**
 * `credentials.status` — the merged view, and an honest account of its own
 * completeness.
 *
 * The two credential stores are split by SHAPE, so this reads two tables and
 * one of them MAY NOT EXIST: `account_git_credentials` ships in migration 079
 * on the deployed staging line and is reachable from no local git object.
 * `gitCredentialStore` therefore reports what actually happened rather than
 * letting an absent table read as "not connected" — a missing table and a
 * member who has not connected GitHub are different facts, and collapsing them
 * would put a confident "Not connected" in front of someone who IS connected on
 * a node where the table exists.
 */
export interface CredentialsStatusView {
  /** One entry per provider in `CredentialProviderName`, always all three. */
  providers: CredentialConnectionView[];
  /**
   * `present` — the table exists and was read.
   * `absent`  — the table does not exist on this node; the github entry's
   *             `connected` is false because it is UNKNOWN, not because it was
   *             measured false.
   */
  gitCredentialStore: 'present' | 'absent';
}

/**
 * `credentials.delete` — Disconnect, which TERMINATES (R3).
 *
 * The provider travels in the PATH, not the body: it is the resource being
 * addressed. There is no field naming whose credential to delete — the subject
 * is always the bound identity's own account, which the RPC derives itself.
 */
export interface CredentialsDeleteInput {
  clientMutationId?: string;
}

/**
 * What Disconnect actually managed to do, stated per step.
 *
 * Best-effort by ruling: a kill that fails is REPORTED and never undoes the
 * revoke. Callers must render both truths R3 requires — "this stops N running
 * sessions" AND "to fully revoke, rotate the credential at the vendor" —
 * because a process that already read the secret still holds it in memory.
 * `revoked` being true while `failures` is non-empty is the normal, correct
 * outcome of a partial disconnect, not a contradiction.
 */
export interface CredentialsDeleteResult {
  provider: CredentialProviderName;
  /** Step 1. True when the index row was removed (or was already absent). */
  revoked: boolean;
  /** Step 2 — the login terminal for this (account, provider), if one was live. */
  terminatedCredentialSessionIds: string[];
  /** Step 3 — the account's live agent sessions that carried this provider. */
  terminatedAgentSessionIds: string[];
  /** Non-fatal failures, in the order they happened. Never empties the above. */
  failures: Array<{ step: 'revoke' | 'credentialSession' | 'agentSession'; sessionId?: string; reason: string }>;
}

/**
 * `credentials.loginSessions.start` — open the login terminal.
 *
 * NO COMMAND FIELD, NO ARGS FIELD, NO FLAGS FIELD, and that absence is the
 * security control. This starts a PTY running as the tm8 OS user from a
 * settings form in a browser; a client-supplied command there is remote code
 * execution with a pleasant user interface. argv comes from
 * `CREDENTIAL_LOGIN_COMMANDS`, a fixed server-side table keyed by provider. A
 * field that does not exist cannot be forwarded by a later refactor, which is a
 * stronger guarantee than any assertion about a value.
 */
export interface CredentialsLoginSessionStartInput {
  spaceId: SpaceId;
  provider: CredentialProviderName;
  /** Terminal geometry only — the one client input, and it cannot reach argv. */
  cols?: number;
  rows?: number;
  clientMutationId?: string;
}

export interface CredentialsLoginSessionStartResult {
  workSessionId: EntityId;
  spaceId: SpaceId;
  provider: CredentialProviderName;
  /** Shorter than the vendor's device-code lifetime, so the terminal dies first. */
  expiresAt: string;
  /** The exact table entry that WAS launched. Recorded so a caller can assert it. */
  command: string;
}

/**
 * `credentials.loginSessions.finish` — close the terminal and record what the
 * PROBE established. The work session id travels in the path.
 */
export interface CredentialsLoginSessionFinishInput {
  clientMutationId?: string;
}

/**
 * NOTHING HERE IS DERIVED FROM AN EXIT CODE. A member who opens the terminal,
 * reads the device code and closes the tab exits 0 with nothing captured —
 * indistinguishable at the process level from one who completed the flow. So
 * `connected` is the probe's answer, and `stored` is a SEPARATE fact.
 *
 * `stored: false` with `connected: true` is a real and expected state on this
 * line: a verified GitHub login has nowhere to go, because its string-shaped
 * store (079) is not present here. Reporting it plainly is the whole reason the
 * two fields are not collapsed into one.
 */
export interface CredentialsLoginSessionFinishResult {
  workSessionId: EntityId;
  provider: CredentialProviderName;
  connected: boolean;
  login: string | null;
  authMethod: string | null;
  status: 'active' | 'stale' | 'revoked';
  /** True only when a metadata row was actually written. */
  stored: boolean;
  /** Whether this node's PTY was killed, as the PTY itself reported it. */
  terminated: boolean;
}

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
/** The kinds `entities.create` accepts — named so a caller can narrow to it. */
export type CreatableEntityKind = Exclude<
  EntityKind,
  'message' | 'member' | 'work_session' | 'project' | 'interaction_profile' | 'artifact' | 'worktree'
>;

export interface CreateEntityInput extends CommandContext {
  clientMutationId: string;
  spaceId: SpaceId;
  kind: CreatableEntityKind;
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

/** POST /v2/entities/:entityId/attention-requests. */
export interface CreateAttentionRequestInput extends CommandContext {
  clientMutationId: string;
  reason: string;
  points: number;
}

/** PATCH /v2/attention-requests/:requestId. */
export interface UpdateAttentionRequestInput extends CommandContext {
  clientMutationId: string;
  expectedVersion: number;
  reason?: string;
  points?: number;
  status?: AttentionRequestStatus;
  resolutionNote?: string;
}

/** POST /v2/entities/:entityId/attention-requests/resolve. */
export interface ResolveEntityAttentionInput extends CommandContext {
  clientMutationId: string;
  resolutionNote?: string;
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
  /**
   * Canonical conversation origin for a multi-anchor post.  A session-target
   * copy uses this anchor's sibling message as its durable reply destination;
   * it must never infer the origin from array order.
   */
  conversationAnchorId?: EntityId | null;
  /**
   * CLI/session reply projection.  When present `anchorIds` is the canonical
   * empty array and the Server derives both the destination anchor and parent
   * from the immutable route recorded for this delivered message copy.
   */
  replyToMessageId?: EntityId;
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

/** POST /v2/entities/:id/commands/gate — 083's opt-in completion gate. 'pr_merged' makes complete refuse while a tracked PR is unmerged or CI-red. */
export interface GateTaskInput extends CommandContext { expectedVersion: number; gate: 'none' | 'pr_merged' }

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

/** `graph` added 2026-07-29 (additive union widening, R4) for the ◉ Graph view. */
export type MenuViewRef = 'dashboard' | 'feed' | 'inbox' | 'workspace' | 'graph' | 'channels' | 'settings';
/**
 * tm8: `worktree` became menu-VISIBLE 2026-07-31 (additive union widening,
 * same R4 posture as `graph`). Menu presence is list navigation only — a
 * worktree is still born exclusively from the provisioning saga (worktree
 * design §2.7): generic create is refused server-side and the UI registry row
 * carries `quickCreate: false`, which is the same visible-but-not-creatable
 * posture `project` and `artifact` already hold. The former exclusion here
 * enforced the CREATE rule with a VISIBILITY lever, and the cost was a whole
 * kind unreachable from the rail.
 */
/**
 * `channel` un-excluded 2026-08-01, in lockstep with `MenuKindRefSchema` and
 * for the same reason `worktree` was un-excluded on 2026-07-31: the exclusion
 * described a kind that no longer exists in that form.
 *
 * It was here because `channel` was `strategy: 'special'` with no `k/` route —
 * a reserved word the rail could not address as a collection. The user ruling
 * of 2026-08-01 made it a real collection kind with the slug `channels`, so it
 * now has exactly the same list view every other menu-eligible kind has, and
 * the rail must be able to name it. `message` stays excluded: it is anchored,
 * has no slug, and still has no collection view.
 */
export type MenuKindRef = Exclude<EntityKind, 'message'>;

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

/**
 * The default menu's group spine — ONE shared truth for its two twins.
 *
 * The server seeder (`internal.w1_default_menu_payload()`, last redefined in
 * db/migrations/061) and the client shipped default (tm8-ui
 * `SHIPPED_DEFAULT_MENU`) each carry a hand-written copy of the default
 * menu's groups, and the ids DIFFER in one place for historical reasons
 * (`work` server-side, `workspace` client-side). Until 2026-07-31 nothing
 * joined the copies: migration 059 rewrote the seeder from a stale base and
 * silently dropped the voice group, every suite stayed green, and the stable
 * DEPLOYMENT was what caught it. The two parity tests
 * (packages/server/test/db/menu-seeder-parity.pg.test.ts and tm8-ui's
 * menu.test.ts) now each pin their own side against THIS constant, so adding
 * or removing a group is one edit here that both tests immediately enforce —
 * pinned to one truth instead of to each other.
 *
 * Additive export only: no schema, operation, or DTO changes ride on it.
 */
export const DEFAULT_MENU_GROUP_SPINE = [
  // 2026-08-01 (user ruling): the Channels GROUP is gone. Channels are
  // ENTITIES, so they live in the Entity List Panel with every other
  // collection — tm8-ui's `channel` registry row is `strategy: 'collection'`
  // now, which is what puts them in that panel's kind switcher. A rail section
  // AND a collection list would be two divergent homes for one kind.
  // Feed and Inbox left the rail in the same ruling, so `home` is Dashboard
  // alone. All three view refs keep their routes and their chords: this
  // removes rail rows, not features.
  { serverId: 'home', clientId: 'home' },
  { serverId: 'work', clientId: 'workspace' },
  { serverId: 'tracking', clientId: 'tracking' },
  { serverId: 'collab', clientId: 'collab' },
  // items-empty on both sides BY NECESSITY: MenuViewRef is a closed enum with
  // no 'voice'; GateApp hangs live voice_channel rows beneath the group id.
  { serverId: 'voice', clientId: 'voice' },
  { serverId: 'settings', clientId: 'settings' },
] as const;

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

/**
 * One kind's pair of rail counters.
 *
 * `total` is every live entity of the kind the caller may read; `unseen` is the
 * subset they have never opened, or have not opened since it last changed.
 * They are separate numbers rather than one filtered number because the rail
 * draws them in different slots — a plain trailing total and a distinct unseen
 * mark — and collapsing them would lose the distinction it renders.
 *
 * `unseen` is derived from the caller's own read marks, so it is the one
 * genuinely PER-VIEWER field here, in the same sense as
 * `EntityCounters.viewerReaction` (DEV-10). It is deliberately NOT sourced from
 * `attention`, which is space-wide and therefore cannot express "new to me".
 */
export interface KindCounts { total: number; unseen: number }

/**
 * GET /v2/spaces/:spaceId/counts — the menu rail's per-kind numbers.
 *
 * PARTIAL BY CONSTRUCTION: the underlying read groups by kind, so a kind with
 * no rows in this space is ABSENT rather than present with zeroes. Consumers
 * must treat a missing key as "no entities", which is also what lets a custom
 * `c:*` kind appear here without a schema change.
 */
export type SpaceKindCounts = Partial<Record<EntityKind, KindCounts>>;

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

/**
 * Worktree SEMANTIC lifecycle, forward-only: active → merged|abandoned → deleted.
 * `merged`/`abandoned` are recorded human/agent claims (the server can refuse a
 * false merge claim but cannot observe one); `deleted` means the working
 * directory has been removed from disk — the graph node itself is soft-deleted
 * separately, after the transition.
 */
export type WorktreeStatus = 'active' | 'merged' | 'abandoned' | 'deleted';

/** Graph-side announce/authorize state for live terminal sharing (T-L10). */
export type WorkSessionShareMode = 'none' | 'space' | 'explicit';

/**
 * What a work_session IS, mirroring 083's `work_sessions.session_kind`.
 *
 * `agent` is ordinary work. `credential` is a private login terminal minted by
 * `credentials.loginSessions.start` so a member can authenticate an agent tool
 * against their own account — it is not work, and it must not sit in session
 * lists pretending to be. See the note on `EntityState`'s work_session arm for
 * why every client filter must be written as the INVERSE of the SQL one.
 */
export type WorkSessionKind = 'agent' | 'credential';

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
  mode?: 'worker' | 'coordinator' | 'coordinated-worker' | 'coordinated-coordinator' | 'dispatcher' | null;
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
  /**
   * Create `workingDir` when it is one missing child beneath an allowed,
   * existing project-browse directory. False/absent never mutates the
   * filesystem; it only records the supplied path, preserving the original
   * projects.create contract for CLI and migration callers.
   */
  ensureWorkingDir?: boolean;
}

/** One local branch in a project's working directory. */
export interface ProjectBranch {
  name: string;
  /** Tip commit oid. */
  head: string;
  /** Tip commit date, ISO-8601. */
  lastCommitAt: string;
  subject: string;
  /** Configured upstream (`origin/feat/x`), or null when there is none. */
  upstream: string | null;
  /** Commits on this branch that the default branch does not have. */
  ahead: number;
  /** Commits on the default branch that this branch does not have. */
  behind: number;
  isDefault: boolean;
  /** Checked out in the project's working directory right now. */
  isCurrent: boolean;
  /** `ahead === 0` — the default branch already contains all of it. */
  merged: boolean;
  /** No commit newer than `staleAfterDays`. */
  stale: boolean;
}

/**
 * GET /v2/projects/:projectId/branches — branch topology for a project's
 * working directory, read with argv-only git. A READ: nothing here checks
 * anything out or writes a ref.
 *
 * `defaultBranchSource` ships WITH `defaultBranch` because `main` is a
 * convention, not a rule. A consumer rendering "12 behind main" needs to know
 * whether the trunk came from the remote's own HEAD or was guessed from
 * whatever happened to be checked out.
 */
export interface ProjectBranchTopology {
  projectId: ProjectId;
  workingDir: string;
  defaultBranch: string;
  defaultBranchSource: 'origin_head' | 'local_conventional' | 'current_branch';
  branches: ProjectBranch[];
  /** True when the branch cap cut the list short — the read is bounded. */
  truncated: boolean;
  staleAfterDays: number;
}

/** One selectable child in the node-local project directory browser. */
export interface ProjectDirectoryEntry {
  name: string;
  path: string;
}

/**
 * GET /v2/project-directories — a bounded, root-confined view of directories
 * on the tm8 node. Files are deliberately absent: this is a project-root
 * picker, not a general filesystem API.
 */
export interface ProjectDirectoryListing {
  roots: string[];
  path: string;
  parentPath: string | null;
  separator: '/' | '\\';
  directories: ProjectDirectoryEntry[];
  truncated: boolean;
}

/** One readable regular file inside a connected project's working directory. */
export interface ProjectFileEntry {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Extension-derived; `application/octet-stream` when nothing is recognised. */
  mime: string;
  /** False when the file exceeds the deployment's per-blob ceiling. */
  attachable: boolean;
}

/**
 * GET /v2/projects/:projectId/files — a bounded view of ONE directory inside a
 * connected project's working directory. Unlike `projects.directories.list`
 * this is confined to a single project rather than to `TM8_PROJECT_ROOTS` at
 * large, and it does list files, because attaching one is the point.
 */
export interface ProjectFileListing {
  projectId: string;
  workingDir: string;
  path: string;
  /** Null at the working directory itself — the browser cannot walk above it. */
  parentPath: string | null;
  separator: '/' | '\\';
  directories: ProjectDirectoryEntry[];
  files: ProjectFileEntry[];
  truncated: boolean;
  /** The effective per-blob ceiling, so a picker can explain a refusal. */
  maxSizeBytes: number;
}

/**
 * POST /v2/projects/:projectId/files/attach — read one node-local file out of
 * a connected project folder and record it as a `file` entity, optionally
 * attached to targets. The bytes never travel through the browser: a browser
 * file input cannot name an absolute path, so a connected folder can only be
 * read by the node that holds it. The result is the same `CommandResult` as
 * `files.uploadComplete`, because this drives that same upload ledger.
 */
export interface ProjectFileAttachInput extends CommandContext {
  clientMutationId: string;
  spaceId: SpaceId;
  /** Absolute path of a regular file inside the project's working directory. */
  path: string;
  /** Overrides the on-disk basename as the file entity's name. */
  name?: string;
  /** Overrides the extension-derived MIME type. */
  mime?: string;
  /** Finalized `file -> attached_to -> target` edges, as in files.uploadComplete. */
  targets?: EntityId[];
}

/** The wrapper returned by spaces.create after its default member/channel saga. */
export interface CreateSpaceResult {
  space: SpaceSummary;
  memberId: EntityId;
  defaultChannelId: EntityId;
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
 * Publicly supported spawn targets.
 *
 * Intent in, never paths (worktree design §7.1): no variant carries a `path`,
 * and `baseRef` is a SYMBOLIC ref the server resolves and validates. A client
 * cannot supply a commit OID either — that would let it pin a commit the server
 * never checked against the repository.
 *
 * `worktree` was absent from this union for as long as the node could not
 * create one, and this type was the only thing holding that line (§7.4's third
 * prohibition: the database would have accepted it). It is present now because
 * the manager, the provisioning saga and the reconciler landed together, which
 * is the condition §7.4 names.
 */
export type SpawnWorkdir =
  | { mode: 'project' }
  | { mode: 'scratch' }
  | { mode: 'worktree'; baseRef?: string };

/** Provider-neutral launch controls. The execution layer maps these to each
 * agent CLI's native flags; keeping them typed here prevents a UI choice from
 * being displayed but silently discarded at the facade boundary. */
export type LaunchReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/**
 * `auto` is the posture a session gets when the request names none — the agent
 * runs what it judges safe and escalates the rest. It is listed here so a caller
 * can PIN it (the omitted-field default is resolved by the execution layer, and
 * a client that wants the posture on the record rather than inherited says so).
 */
export type LaunchAccessMode = 'safe' | 'acceptEdits' | 'auto' | 'plan' | 'fullAccess';

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
  /**
   * The work_session issuing this spawn. The server persists it as the new
   * session entity's homogeneous `parentId`, which is the spawn tree's source
   * of truth. Human-launched sessions omit it and remain roots.
   */
  parentSessionId?: EntityId;
  /** Tasks the session works on — become `working_on` edges. */
  taskIds?: EntityId[];
  /**
   * AM-2 §1: typed project reference (replaces the untyped `projectRef`).
   * The project must be linked to `spaceId` and pass its trust gate.
   * Omitted/null = a projectless scratch session in a server-managed temp dir.
   */
  projectId?: ProjectId | null;
  /** Working-directory semantics; default `{ mode: 'project' }`. */
  workdir?: SpawnWorkdir;
  /** Explicit consent carrier for untrusted Projects and scratch roots. */
  confirmUntrusted?: true;
  /** Optional active profile override; human-principal authorization is server-owned. */
  interactionProfileId?: EntityId;
  mode?: 'worker' | 'coordinator' | 'coordinated-worker' | 'coordinated-coordinator' | 'dispatcher';
  model?: string | null;
  agentTool?: string | null;
  reasoningEffort?: LaunchReasoningEffort;
  accessMode?: LaunchAccessMode;
  /**
   * Which credential the session authenticates with. `'member'` requires the
   * spawner's own connected credential (the launch is refused when there is
   * none — never a silent fallback to the node's identity); `'node'` skips
   * member-credential injection. Absent = auto: the member's credential when
   * connected, the node's otherwise. This can only ever name the CALLER'S OWN
   * credential — the server resolves it RLS-scoped to the spawner, so no value
   * here reaches another member's store.
   */
  credentialSource?: 'member' | 'node';
  title?: string;
  /** Extra prompt context appended to the composed manifest. */
  promptExtra?: string | null;
  /**
   * Memory entities (kind `memory`, same space) appended to the persona's
   * working set for THIS session only — a spawn-time memory hand-off. They are
   * rendered into the manifest's `agent.memory` alongside the teammate's own
   * `remembers` set; nothing is written to the graph.
   */
  memoryIds?: EntityId[];
}

/**
 * execution.dispatch — POST /v2/execution/dispatch (DESIGN §4.3, D2/D4).
 *
 * Route `subjectId` to the space's resident dispatcher, which picks the
 * teammate and the memories and then spawns. Deliberately carries NO launch
 * configuration: the moment a caller can name the teammate, it is spawning,
 * not dispatching.
 */
export interface ExecutionDispatchInput extends CommandContext {
  clientMutationId: string;
  spaceId: EntityId;
  /** Any launchable entity; derived to a task server-side via 064. */
  subjectId: EntityId;
  /** Free-text steer for the dispatcher, carried in the trusted envelope. */
  note?: string;
}

/** What `execution.dispatch` answers with — see the handler for the states. */
export interface ExecutionDispatchResult {
  /** The task the subject derived to; the dispatcher's anchor for this request. */
  taskId: EntityId;
  /** The dispatcher session the request was delivered to. */
  dispatcherSessionId: EntityId;
  /** True when this call had to spawn the dispatcher rather than reuse one. */
  dispatcherSpawned: boolean;
  /** The stored request message. Absent only if delivery was not attempted. */
  requestMessageId?: EntityId;
  /** Honest delivery outcome; `undelivered` still leaves a durable message. */
  delivery: 'delivered' | 'undelivered';
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
 * execution.resume — POST /v2/entities/:id/commands/resume. Bring a terminal
 * (`exited`/`failed`) work_session back to life by relaunching its agent
 * against the provider's OWN conversation id (`claude --resume <uuid>` /
 * `codex resume <id>`), so the agent returns with its full prior conversation.
 *
 * Everything else about the session — persona, project, tasks, model, workdir —
 * is re-read from the graph, never re-supplied by the caller: a resume is the
 * same session continuing, not a new launch with overrides. Sessions whose
 * agent tool has no resume-by-id contract (or that predate native-id capture)
 * are refused, never silently restarted fresh.
 */
export interface ExecutionResumeInput extends CommandContext {
  clientMutationId: string;
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
  /** One-shot PTY capability, returned once and never embedded in `url`. */
  token: string;
  expiresAt: string;
}

/**
 * voice.token.create — POST /v2/entities/:id/commands/voice-token. Mints a
 * LiveKit access token scoped to one voice_channel entity (room = entity id).
 * Audio never touches tm8-server; this grant is the sole authorization the
 * browser needs to connect directly to the LiveKit SFU (voice plan §2).
 */
export type CreateVoiceTokenInput = CommandContext;

export interface VoiceTokenGrant {
  voiceChannelId: EntityId;
  /** LiveKit ws URL the client connects to directly. */
  url: string;
  /** HS256 LiveKit access token (room join grant). */
  token: string;
  roomName: string;
  identity: string;
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
  /** Node-wide admission truth used by execution.spawn's concurrency gate. */
  capacity: { used: number; total: number };
}

// --- execution.journal — the session CLI command journal --------------------

/**
 * ONE `tm8` INVOCATION, as the CLI recorded it on its way out.
 *
 * Every `tm8` command a teammate runs is its own short-lived process that
 * already knows its session (`TM8_SESSION_ID` is injected at spawn), so it
 * appends one of these to `<dataDir>/journals/<sessionId>.jsonl` and exits.
 * No daemon, no database, no IPC.
 *
 * WHAT THE TOKEN FIELDS ARE, AND ARE NOT. They are BYTE-DERIVED ESTIMATES of
 * text crossing the CLI boundary, never the provider's reported usage. They
 * exclude the system prompt and the conversation, so they can NEVER be
 * presented as the session's token spend. `chars` counts are exact and are the
 * ground truth; the estimate is derived from them by `estimator`.
 */
export interface SessionJournalRecord {
  /** Record schema version — readers must ignore fields they do not know. */
  v: 1;
  /** Per-process counter. Pair with `startedAt` to order across processes. */
  seq: number;
  /**
   * Who this invocation was, decided AT WRITE TIME: a spawned agent, a test
   * harness, or a human. OPTIONAL because records predating the field exist
   * and must stay valid — readers fall back to heuristics for those. Without
   * this split the corpus is unreadable: 2,737 of 3,018 measured records were
   * the CLI integration suite inheriting `TM8_JOURNAL_PATH` from a parent
   * agent, inverting the headline failure rate.
   */
  class?: 'agent' | 'harness' | 'human';
  sessionId: EntityId;
  spaceId: EntityId | null;
  teamMemberId: EntityId | null;
  pid: number;
  startedAt: string;
  durationMs: number;
  command: {
    /** Resolved command path, e.g. `['message','send']`. Empty if unparsed. */
    path: string[];
    argv: string[];
    cwd: string;
  };
  input: { stdinChars: number };
  output: {
    stdoutChars: number;
    stderrChars: number;
    /** Bounded head of stdout. `truncated` says whether bytes were dropped. */
    stdoutSample: string;
    stderrSample: string;
    truncated: boolean;
  };
  /** One entry per HTTP call this invocation made. Often 1, sometimes 0 or N. */
  calls: SessionJournalCall[];
  result: { exitCode: number; error: string | null };
  tokens: {
    /** Names how the estimate was derived. Never omit it. */
    estimator: 'chars/4';
    /** Command line + stdin — tokens the agent EMITTED. */
    agentToCli: number;
    /** stdout + stderr — tokens the agent will CONSUME next turn. */
    cliToAgent: number;
  };
}

export interface SessionJournalCall {
  operation: string;
  method: string;
  path: string;
  /** The node actually addressed — `--server` can retarget mid-session. */
  baseUrl: string;
  /** null when the transport failed and no response was ever produced. */
  status: number | null;
  requestChars: number;
  responseChars: number;
  durationMs: number;
}

/**
 * A bounded window over one session's journal, plus totals over the WHOLE file.
 *
 * Totals are computed across every record, records are only a window — so the
 * headline number stays honest even when the table is truncated.
 */
export interface SessionJournalPage {
  sessionId: EntityId;
  /**
   * false when there is no journal file: a session spawned before this feature,
   * or one launched with journaling off. A real, common state that must render
   * as an explained empty rather than as a zero.
   */
  available: boolean;
  /** Present only when `available` is false. Machine-readable reason. */
  unavailableReason: 'no_journal_file' | 'unreadable' | null;
  totals: {
    invocations: number;
    failed: number;
    agentToCliEst: number;
    cliToAgentEst: number;
    estimator: 'chars/4';
    /** Records the reader could not parse — surfaced, never silently dropped. */
    malformed: number;
  };
  /** Oldest-first within the window. */
  records: SessionJournalRecord[];
  hasMore: boolean;
}

/**
 * How ONE session was configured at the instant it was launched — the other
 * half of the debug surface, alongside `SessionJournalPage`.
 *
 * The journal answers "what did this agent DO"; this answers "what was this
 * agent TOLD". Both are needed to explain a session's behaviour, and until
 * this existed the second question had no answer anywhere outside the node's
 * own filesystem.
 *
 * EVERY FIELD IS A STORED FACT, never a re-derivation. In particular the two
 * prompts are the bytes that went onto the child's argv, read back out of
 * `session_manifests`, and NOT the output of running the composer again — a
 * recomposed prompt describes the build doing the reading, not the launch
 * being inspected, and the two diverge silently.
 */
export interface SessionLaunchRecord {
  sessionId: EntityId;
  /**
   * false when the session has no manifest row at all: a spawn that failed
   * before recording one, or a session whose row was never written. Renders as
   * an explained empty, never as a blank configuration.
   */
  available: boolean;
  /** Present only when `available` is false. Machine-readable reason. */
  unavailableReason: 'no_manifest_row' | null;
  /**
   * The composed spawn manifest EXACTLY as stored: persona, resolved launch
   * posture, command-network policy, workdir/project + trust, the pinned
   * interaction profile, and the task list.
   *
   * DELIBERATELY UNTYPED. This is a JSON document written by whatever build
   * spawned the session, and a strict schema here would refuse to show a
   * manifest an older or newer build wrote — on the one surface whose entire
   * job is to show what is actually there. Readers pick out the keys they know
   * and render the rest verbatim.
   */
  manifest: Record<string, unknown> | null;
  /**
   * Environment variable NAMES handed to the agent process. Values are
   * structurally absent (S15) — they are injected from the node's OS
   * environment at spawn and never travel back into Postgres — so a reader
   * must present these as names, never as configuration that can be inspected.
   */
  envVarNames: string[];
  /**
   * The two prompts, on the two channels they actually travel on: `system`
   * configures the agent (`--append-system-prompt` / `developer_instructions`)
   * and `task` is its first user turn (the CLI positional).
   */
  prompts: {
    system: string | null;
    task: string | null;
    /**
     * Why both are null. `not_recorded` means this session was launched before
     * prompts were persisted, and the text is unrecoverable — it existed only
     * in the spawn process's memory and on the child's argv.
     */
    unavailableReason: 'not_recorded' | null;
  };
  /** When the manifest row was written — i.e. when the session was launched. */
  recordedAt: string | null;
}

/**
 * ONE turn of an agent's conversation, read back out of the agent CLI's OWN
 * transcript and normalised across tools.
 *
 * WHY THIS IS NOT THE PTY. The terminal ring (`OutputBuffer`) holds ANSI frames
 * — repaints, cursor moves, spinners — capped at 1 MiB and discarded when the
 * process exits or the node restarts. It answers "what does the screen look
 * like". This answers "what did the agent SAY", survives exit, and is written
 * by the agent itself at no cost to us. A coordinator needs the second one.
 *
 * `source` is deliberately only user/assistant. Tool CALLS are counted (see
 * `SessionTranscriptStats.toolCalls`) but their arguments and output are NOT
 * carried: they are the bulk of a transcript by volume, they are the most
 * likely place for a secret to sit, and a coordinator reads this to decide
 * whether a worker is on track — a job the prose answers and the tool spam
 * does not.
 */
export interface SessionTranscriptEntry {
  /** ISO 8601. Null when the underlying record carried no timestamp. */
  at: string | null;
  source: 'user' | 'assistant';
  text: string;
  /** True when `text` was cut to the caller's `maxChars` budget. */
  truncated: boolean;
}

/**
 * Aggregates over the WINDOW THAT WAS READ, never over the whole conversation.
 *
 * The reader deliberately tails a bounded slice of a file that can reach tens
 * of megabytes, so these are honest counts of what was parsed and NOT the
 * session's lifetime totals. `partial` says which of the two you are holding.
 * Presenting a tail's token count as a session's spend is the exact dishonesty
 * this field exists to prevent.
 */
export interface SessionTranscriptStats {
  /** False only when the whole file fit inside the read budget. */
  partial: boolean;
  /**
   * SPEECH turns in the parsed window, counted on the same rule in both
   * dialects: exactly the `entries` this window produced, before the caller's
   * `last` slice. So `userMessages + assistantMessages` is the number of turns
   * the window held, and never disagrees with the list rendered beside it.
   *
   * NOT a count of native records. A claude tool result is a `type:'user'`
   * record and a claude tool call is a `type:'assistant'` record with no text
   * block; counting records reported 32/52 for a window holding 2 human turns
   * and 12 prose replies, and meant something different again on the codex
   * side, where tool traffic is `function_call` rather than a message.
   */
  userMessages: number;
  assistantMessages: number;
  /** Tool invocations in the window. These are NOT turns — see above. */
  toolCalls: number;
  /**
   * Provider-reported usage summed over the parsed window, when the transcript
   * carries it. Claude records it per assistant turn; Codex reports it as a
   * running total, so these can be null for a tool that does not say.
   */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** Descending by count. Names as the agent wrote them. */
  tools: { name: string; count: number }[];
  /** Distinct model ids seen, in first-seen order. */
  models: string[];
}

/**
 * The "is this worker stuck" signal, ported from maestro's LogDigestService
 * because it is the single thing that made an unattended fleet supervisable.
 *
 * A working agent alternates prose and tool calls. An agent that has made many
 * tool calls and said NOTHING for a long time is usually looping — retrying a
 * failing command, or grinding a search that will not converge. Neither the PTY
 * (still emitting bytes) nor the process table (still alive) can see it.
 *
 * This is a HEURISTIC and is reported as evidence, not as a verdict: the two
 * raw numbers travel with it so a reader can disagree.
 */
export interface SessionTranscriptStuck {
  /** Since the last assistant prose, not since the last byte of any kind. */
  silentMs: number;
  toolCallsSinceText: number;
}

/**
 * A bounded window over one session's agent transcript.
 *
 * Same honesty contract as `SessionJournalPage`: a session with no readable
 * transcript is a REAL and common state (it predates this feature, it ran a
 * tool with no transcript format, or it died before its first turn) and must
 * render as an explained empty rather than as a zero.
 */
export interface SessionTranscriptPage {
  sessionId: EntityId;
  available: boolean;
  /**
   * Present only when `available` is false.
   * - `no_native_session_id` — the session predates native-id capture, so its
   *   transcript cannot be identified. Unrecoverable, not an error.
   * - `unsupported_agent_tool` — the tool has no transcript format tm8 reads
   *   (an operator `TM8_AGENT_CMD` wrapper, echo-agent).
   * - `no_transcript_file` — the id is known but no file exists: the agent
   *   never wrote a turn, or its transcript has been cleaned up.
   * - `unreadable` — the file exists and could not be read (permissions, I/O).
   */
  unavailableReason:
    | 'no_native_session_id'
    | 'unsupported_agent_tool'
    | 'no_transcript_file'
    | 'unreadable'
    | null;
  /** Which transcript dialect was parsed. Null when unavailable. */
  agentTool: 'claude-code' | 'codex' | null;
  /** Oldest-first. The NEWEST `last` entries, so a tail reads in order. */
  entries: SessionTranscriptEntry[];
  stats: SessionTranscriptStats | null;
  /** Null when the heuristic does not fire — never a zeroed object. */
  stuck: SessionTranscriptStuck | null;
  /** Newest turn of any kind, including ones not carried in `entries`. */
  lastActivityAt: string | null;
  /** Lines the reader could not parse — surfaced, never silently dropped. */
  malformed: number;
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
  /** Readable canonical session summary for direct navigation from a feed. */
  targetWorkSession?: EntitySummary | null;
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
  | (FeedItemBase & { itemKind: 'message'; message: MessageView; delivery: DeliverySummary[];
      /** Work-session siblings in this message batch (channel tag/spawn targets). */
      linkedWorkSessions?: EntitySummary[] })
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
  /** Which Content surface a session pinned to this profile opens on. Absent
      means "defer to the pinned static template", which is what every draft
      written before this field existed meant implicitly. */
  initialContentSurface?: 'terminal' | 'chat';
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
