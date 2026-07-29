/**
 * THE FACADE SEAM — the typed interface the UI consumes for everything between
 * the server's HTTP/WS surface and the UI's stores.
 *
 * CO-OWNED (LLD C-2): bridge-coordinator + fe-coordinator, dual-consensus change
 * control. This file was stamped under the dual-consensus LLD review of
 * 2026-07-28 (see ./LLD.md, status header). Changes here require re-consensus
 * from BOTH owners — do not edit casually.
 *
 * Amendment 1 (2026-07-28, C-2 re-consensus [bridge->FE 1]/[fe->bridge 1]):
 * liveness.statusOf param widened WorkStatus → WorkStatus | WorkSessionStatus —
 * the task vocabulary cannot express the session 'running' literal the R-UI-5
 * predicate compares against. Additive, zero caller churn.
 * Recorded seam-scope ruling (same exchange): handoffs.send and
 * spaces.menu.update stay OUT of this seam until their phase; adding either is
 * a deferred amendment requiring dual re-consensus.
 *
 * Two implementations, drop-in interchangeable (LLD §10):
 *   - createFixtureSeam()  — backed by the shared fixture dataset (LLD C-5)
 *   - createRealSeam()     — HTTP + WS against the tm8 node (LLD §5–§6)
 *
 * Everything here is contract-shaped: reads return `@tm8/contract` DTOs
 * verbatim (LLD C-3) so the two implementations are type-indistinguishable.
 * Failures reject with the contract's own `CollabError` — there is no second
 * error vocabulary. The single soft-fallback exception is `menu()` (LLD C-4).
 *
 * NOT behind this seam (R9): the PTY terminal byte stream. The terminal
 * transport is transplanted verbatim by FE and shares `/v2/ws?sessionId=`
 * without being this client.
 */
import type {
  ActivityItem,
  CollectionQuery,
  CollectionResult,
  CommandContext,
  CommandResult,
  CompleteTaskInput,
  CreateEntityInput,
  CreateTaskInput,
  Cursor,
  DurableWorkspaceEvent,
  EdgeView,
  EntityDetail,
  EntityFeedPage,
  EntityId,
  EntityKindDef,
  EntitySummary,
  ExecutionPromptInput,
  ExecutionSpawnInput,
  ExecutionTerminateInput,
  FeedScope,
  GraphQuery,
  GraphResult,
  HandoffView,
  MenuConfig,
  MessageBatchResult,
  MessageDeliveryView,
  MessageView,
  MoveEntityInput,
  NotificationItem,
  Page,
  PatchEntityInput,
  PatchMessageInput,
  PatchTaskInput,
  PostMessageInput,
  ProjectResource,
  ReactionInput,
  SpaceId,
  SpaceSettingsView,
  SpaceSummary,
  WorkInput,
  WorkSessionStatus,
  WorkStatus,
} from '@tm8/contract';

export type Unsubscribe = () => void;

/**
 * Connection honesty states (T4). The UI renders these truthfully and never
 * fakes liveness:
 *   'live'    — WS open, subscribed, events flowing.
 *   'polling' — WS down but HTTP catch-up succeeding (render as reconnecting/
 *               degraded; data advances on the same seq spine, slower).
 *   'offline' — nothing is reaching the node.
 */
export type ConnectionState =
  | { phase: 'connecting' }
  | { phase: 'live' }
  | { phase: 'polling'; disconnectedSince: string }
  | { phase: 'offline'; disconnectedSince: string };

/**
 * R-UI-5: the ONLY liveness vocabulary. 'unknown' (no fresh snapshot) renders
 * neutral — NEVER as live. recordedStatus=running + not in the live set ⇒
 * 'stale', never live.
 */
export type SessionLiveness = 'live' | 'stale' | 'not-running' | 'unknown';

/** Result of the Delta 2 read: `GET /v2/spaces/:spaceId/execution/liveness` (LLD C-1). */
export interface LivenessSnapshot {
  spaceId: SpaceId;
  liveEntityIds: string[];
  /** Stable per node process. A change between snapshots ⇒ node restarted ⇒ every previously live PTY is gone. */
  nodeBootId: string;
  checkedAt: string;
  capacity?: { used: number; total: number };
}

/**
 * `identity.get` typed AS THE SERVER RETURNS IT TODAY (LLD §13 / FE consensus
 * attachment 3). The contract exports no identity view type; capability flags
 * do not exist here yet — if the UI needs them, FE + bridge escalate JOINTLY
 * to master before inventing a shape (R4). Do not add fields speculatively.
 */
export interface IdentityView {
  identityId: string;
  accountId: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  email: string | null;
  isNodeAdmin: boolean;
  isOwner: boolean;
  status: string;
  actingAs: string | null;
  memberships: Array<{ spaceId: string; memberId: string; role: string }>;
}

/** Cursor-paged read options. */
export interface PageOpts {
  cursor?: Cursor;
  limit?: number;
}

export interface FeedOpts extends PageOpts {
  scope?: FeedScope;
}

export interface Seam {
  // -- lifecycle -------------------------------------------------------------
  /** Subscribe the space's event stream and start the liveness cadence. Idempotent. */
  openSpace(spaceId: SpaceId): Promise<void>;
  closeSpace(spaceId: SpaceId): void;
  dispose(): void;

  // -- event stream & connection honesty (LLD §6) ----------------------------
  /**
   * Durable events for open spaces. GUARANTEE: strictly increasing seq per
   * space, no duplicates — consumers need no seenEventIds set. Presence/typing
   * frames never appear here (R8 dormant; W5: no publisher exists).
   */
  onEvent(cb: (e: DurableWorkspaceEvent) => void): Unsubscribe;
  onConnection(cb: (s: ConnectionState) => void): Unsubscribe;
  getConnection(): ConnectionState;
  /**
   * Catch-up integrity lost for a space (refused resume, or a disconnect gap
   * past the resync threshold): consumers re-run their hydration reads.
   * Events keep flowing from the re-seeded cursor either way — no gap window.
   */
  onResync(cb: (spaceId: SpaceId) => void): Unsubscribe;

  // -- reads (contract DTOs verbatim; reject with CollabError) ---------------
  identity(): Promise<IdentityView>;
  spaces(): Promise<SpaceSummary[]>;
  /**
   * LLD C-4: resolves `null` for BOTH `not_implemented` (501) and `not_found`
   * (404) — deliberately indistinguishable; the UI substitutes its shipped
   * versioned default menu (TM8-UI-SPEC-FINAL §4.10). Other codes reject.
   */
  menu(spaceId: SpaceId): Promise<MenuConfig | null>;
  /** Launch-default provenance and other member-authorized space settings. */
  spaceSettings(spaceId: SpaceId): Promise<SpaceSettingsView>;
  /** Both list panels + palette consume this one read (FE gate list item 4). */
  query(input: CollectionQuery): Promise<CollectionResult>;
  /** Full graph hydration; durable entity/edge events keep this lens current. */
  graph(input: GraphQuery): Promise<GraphResult>;
  /**
   * FE CONSENSUS RULING (LLD §14, recorded 2026-07-28): this is the
   * CUSTOM-KIND (`c:*`) extension source ONLY — existence + naming metadata.
   * The FE domain registry (TM8-UI-SPEC-FINAL §4.5) is the sole behavior
   * authority for ALL kinds; server kind metadata never carries behavior config.
   */
  entityKinds(spaceId: SpaceId): Promise<EntityKindDef[]>;
  /** Linked project resources, including trust and graph-owned cwd. */
  projects(spaceId: SpaceId): Promise<ProjectResource[]>;
  entity(id: EntityId): Promise<EntityDetail>;
  children(id: EntityId, opts?: PageOpts): Promise<Page<EntitySummary>>;
  /** Connections tab. */
  connections(id: EntityId, opts?: PageOpts): Promise<Page<EdgeView>>;
  /** Activity tab. */
  activity(id: EntityId, opts?: PageOpts): Promise<Page<ActivityItem>>;
  /** Discussion tab. */
  messages(anchorId: EntityId, opts?: PageOpts): Promise<Page<MessageView>>;
  handoffs(workSessionId: EntityId, opts?: PageOpts): Promise<Page<HandoffView>>;
  // kept in seam, not gate-critical (LLD §4):
  inbox(opts?: PageOpts): Promise<Page<NotificationItem>>;
  /** Chat feed (Phase 2 surface). */
  feed(id: EntityId, opts?: FeedOpts): Promise<EntityFeedPage>;
  /**
   * Delivery facets, ON DEMAND — the correctness path in v1 (the settled-event
   * passthrough is Delta-1-dormant, LLD §7/§8). Facets pass through
   * UNCOLLAPSED; 'unknown' is never styled as success.
   */
  delivery(messageId: EntityId): Promise<MessageDeliveryView>;

  // -- commands (contract input types VERBATIM; the caller supplies
  //    clientMutationId so stores can journal before the promise settles;
  //    reconcile on echo — event or CommandResult — rollback on rejection) ----
  commands: {
    createEntity(input: CreateEntityInput): Promise<CommandResult>;
    createTask(input: CreateTaskInput): Promise<CommandResult>;
    patchEntity(id: EntityId, input: PatchEntityInput): Promise<CommandResult>;
    patchTask(id: EntityId, input: PatchTaskInput): Promise<CommandResult>;
    moveEntity(id: EntityId, input: MoveEntityInput): Promise<CommandResult>;
    deleteEntity(id: EntityId, ctx?: CommandContext): Promise<CommandResult>;
    restoreEntity(id: EntityId, ctx?: CommandContext): Promise<CommandResult>;
    complete(id: EntityId, input: CompleteTaskInput): Promise<CommandResult>;
    work(id: EntityId, input: WorkInput): Promise<CommandResult>;
    postMessage(input: PostMessageInput): Promise<CommandResult | MessageBatchResult>;
    editMessage(id: EntityId, input: PatchMessageInput): Promise<CommandResult>;
    react(id: EntityId, input: ReactionInput): Promise<CommandResult>;
    markRead(notificationId: string): Promise<void>;
    upsertReadMark(anchorId: EntityId, lastReadAt: string): Promise<void>;
    spawn(input: ExecutionSpawnInput): Promise<CommandResult>;
    prompt(id: EntityId, input: ExecutionPromptInput): Promise<CommandResult>;
    terminate(id: EntityId, input: ExecutionTerminateInput): Promise<CommandResult>;
  };

  // -- liveness (Delta 2, LLD C-1 / §9) --------------------------------------
  liveness: {
    /** Force a fresh read now (also runs on the LLD §9 cadence). */
    refresh(spaceId: SpaceId): Promise<LivenessSnapshot>;
    onChange(cb: (snap: LivenessSnapshot) => void): Unsubscribe;
    /** THE predicate — the only place liveness truth is computed (R-UI-5).
     *  Accepts both vocabularies (Amendment 1): tasks carry WorkStatus, work
     *  sessions carry WorkSessionStatus — 'running' lives in the latter. */
    statusOf(session: { id: EntityId; workStatus: WorkStatus | WorkSessionStatus | null }): SessionLiveness;
  };
}

/**
 * Extra controls on the FIXTURE implementation only (LLD §10 + FE consensus
 * attachment: setConnection / setLiveness / triggerResync). Lets the gate
 * screen demo the honesty states and the hydration-replay path on demand.
 */
export interface FixtureControls {
  setConnection(state: ConnectionState): void;
  setLiveness(spaceId: SpaceId, liveEntityIds: string[], nodeBootId?: string): void;
  triggerResync(spaceId: SpaceId): void;
}

export interface FixtureSeam extends Seam {
  fixtureControls: FixtureControls;
}
