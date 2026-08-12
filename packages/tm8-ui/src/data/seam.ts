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
 * Amendment 2 (2026-07-31, artifacts preview): commands gains
 * `previewArtifact` — the user RATIFIED the two decisions that gated artifact
 * preview execution (second origin + accepted iframe residual,
 * TM8-ARTIFACTS-DESIGN §9/§12.1), so the Run button stops being inert and
 * needs its one command. Additive, zero caller churn; contract types
 * verbatim like every other command.
 *
 * Amendment 3 (2026-08-01, attachments): `files` gains `downloadHref` — a
 * synchronous URL builder for the contract-v1 `files.download` route. It is the
 * one seam member that answers a URL rather than a DTO, because that route
 * answers RAW BYTES and a browser reaches bytes through `href`/`src`, not
 * through a DTO. Additive, zero caller churn; it closes the SEAM GAP recorded
 * at `files/reasons.ts:DOWNLOAD_UNAVAILABLE`.
 *
 * Amendment 4 (2026-08-01, identity display): `IdentityView` gains `globalId`
 * — migration 067 landed the column and `identity.get` returns it — and
 * `commands` gains `updateProfile`, the contract's `identity.profile.update`
 * (`POST /v2/identity/profile`, catalog v1). Both contract-shaped and
 * additive, zero caller churn. `globalId` is DISPLAY ONLY (Identity v2
 * invariant I6): it is a claim the hosting server makes, never an
 * authorization input — nothing in the UI may gate on it. Filed by the
 * identity-display lane for dual re-consensus recording.
 *
 * Amendment 5 (2026-08-04, connected project folders): a new optional
 * `projectFiles` group — `list` and `attach`, the contract's
 * `projects.files.list` / `projects.files.attach`. Optional for the same reason
 * `projectSetup` is: a fixture seam has no filesystem. It does NOT replace
 * `files`; the two describe different byte sources, a browser upload and a
 * node-local read, and only the node can perform the second because a browser
 * file input never learns an absolute path. Additive, zero caller churn.
 *
 * Amendment 6 (2026-08-09, edges): commands gain `createEdge`/`deleteEdge` —
 * the generic `edges.create`/`edges.delete` catalog rows. Reached by the
 * assignment and attachment features at once; one amendment, not two (see the
 * op's own note below).
 *
 * Amendment 7 (2026-08-09, branch topology): reads gain `projectBranches` —
 * the contract's `projects.branches.list` (`GET /v2/projects/:projectId/branches`,
 * catalog v1). A READ over a linked project's working directory: local
 * branches with ahead/behind vs the default branch, stale and merged flags.
 * Contract-shaped (`ProjectBranchTopology` verbatim) and additive, zero
 * caller churn. Filed by the branch-topology-ui lane for dual re-consensus
 * recording alongside the catalog row it consumes (PR #74).
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
  ArtifactPreviewSession,
  ArtifactsPreviewStartInput,
  AttentionRequestListQuery,
  AttentionRequestMutationResult,
  AttentionRequestPage,
  CollectionAddItemInput,
  CollectionQuery,
  CollectionResult,
  CommandContext,
  CommandResult,
  CompleteTaskInput,
  CreateEdgeInput,
  CreateEntityInput,
  CreateSpaceInput,
  CreateSpaceResult,
  CreateTaskInput,
  CredentialProviderName,
  CredentialsDeleteResult,
  CredentialsLoginSessionFinishResult,
  CredentialsLoginSessionStartResult,
  CredentialsStatusView,
  Cursor,
  DurableWorkspaceEvent,
  EdgeView,
  EntityDetail,
  EntityFeedPage,
  EntityId,
  EntityKindDef,
  EntitySummary,
  ExecutionPromptInput,
  ExecutionDispatchInput,
  ExecutionDispatchResult,
  ExecutionSpawnInput,
  ExecutionResumeInput,
  ExecutionTerminateInput,
  FileUploadAbortInput,
  FileUploadCompleteInput,
  FileUploadGrant,
  FileUploadInitInput,
  FeedScope,
  GraphQuery,
  GraphResult,
  HandoffView,
  IdentityProfileUpdateInput,
  IdentityProfileView,
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
  ProjectBranchTopology,
  ProjectCreateInput,
  ProjectDirectoryListing,
  ProjectFileAttachInput,
  ProjectFileReadResult,
  ProjectFileListing,
  ProjectFolderUploadAbortInput,
  ProjectFolderUploadCompleteInput,
  ProjectFolderUploadGrant,
  ProjectFolderUploadInitInput,
  ProjectFolderUploadResult,
  ProjectId,
  ProjectLinkInput,
  ProjectResource,
  ReactionInput,
  ResolveEntityAttentionInput,
  SessionJournalPage,
  SessionLaunchRecord,
  SessionTranscriptPage,
  SpaceId,
  SpaceKindCounts,
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
  /**
   * Cross-server display binding, `issuer:subject` (e.g. `google:12345`) —
   * migration 067. NULL on every row until the viewer sets it. Display only
   * (Identity v2 I6): a claim by the hosting server, never an authorization
   * input — no route, permission, or feature may gate on it.
   */
  globalId: string | null;
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

/** `messages.list` paging plus the one filter that read has always accepted. */
export interface MessageListOpts extends PageOpts {
  /** Read the branch under this root instead of the anchor's thread roots. */
  rootMessageId?: EntityId;
}

/**
 * `entities.connections` paging PLUS the two filters that route has always
 * accepted (`?type=`/`?types=`, `?direction=`).
 *
 * THE FILTERS ARE NOT A CONVENIENCE. The server pages this read at
 * `DEFAULT_LIMIT = 50` across EVERY edge type on the node. A caller hunting
 * one `assigned_to` edge on an entity with more edges than that gets a page
 * that does not contain it and cannot tell "not present" from "not on this
 * page" — so it reports the edge as gone, which is a false statement to a
 * user. Naming the type is what makes the page mean what the caller reads it
 * to mean.
 */
export interface ConnectionOpts extends PageOpts {
  /** Edge types to include. Empty/absent ⇒ every type, which is the trap above. */
  types?: readonly string[];
  /** Relative to the anchor entity. Server default is `both`. */
  direction?: 'incoming' | 'outgoing' | 'both';
}

export interface FeedOpts extends PageOpts {
  scope?: FeedScope;
  order?: 'newest' | 'oldest';
  around?: `message:${string}` | `activity:${string}`;
}

/** The DEBUG journal read's paging window. `before` is a seq cursor, not a Cursor. */
export interface JournalOpts {
  /** Max records in the window; server default is 100. */
  limit?: number;
  /** Return records with `seq` below this — the cursor for paging older records. */
  before?: number;
}

/**
 * The DEBUG transcript read's window. There is NO cursor: the server reads a
 * tail, so "older" is not a page you can walk — asking for more turns widens
 * the same window rather than stepping back through history.
 */
export interface TranscriptOpts {
  /** Newest turns to return; server default is 20, max 200. */
  last?: number;
}

/**
 * `projectBranches` options — both bounded SERVER-side (limit caps at 200;
 * each branch costs a rev-list, so the cap is a process budget, not taste).
 */
export interface BranchTopologyOpts {
  /** Days without a commit before a branch is flagged stale. Server default: 30. */
  staleAfterDays?: number;
  /** Max branches returned; the DTO's `truncated` says when this cut the list. */
  limit?: number;
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
  /**
   * The menu rail's per-kind counters — total, and how many the viewer has not
   * seen. Its own read rather than a derivation over `query` results, because
   * the rail must show every kind's number BEFORE any of those lists has been
   * fetched (the gate hydrates only a handful of kinds at boot), and because a
   * page length is not a total.
   */
  counts(spaceId: SpaceId): Promise<SpaceKindCounts>;
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
  /**
   * Branch topology for one linked project's working directory (Amendment 6):
   * local branches with ahead/behind vs the default branch, stale and merged
   * flags. A READ — the server runs git argv-only and checks nothing out.
   * `invalid_input` is a real, expected rejection (the project's workingDir is
   * not a git repository) and consumers must render it as a fact about the
   * project, not as a seam fault.
   */
  projectBranches(projectId: string, opts?: BranchTopologyOpts): Promise<ProjectBranchTopology>;
  /**
   * Node-local onboarding is optional because fixture seams have no filesystem.
   * The real seam exposes the complete contract-backed saga surface; its
   * absence keeps the Add Space control disabled-with-reason.
   */
  projectSetup?: {
    directories(path?: string): Promise<ProjectDirectoryListing>;
    createSpace(input: CreateSpaceInput): Promise<CreateSpaceResult>;
    createProject(input: ProjectCreateInput): Promise<ProjectResource>;
    linkProject(spaceId: SpaceId, input: ProjectLinkInput): Promise<void>;
  };
  /**
   * Reading an ALREADY-CONNECTED project folder, for the same reason
   * `projectSetup` is optional: a fixture seam has no filesystem to read. The
   * attach here is node-side by necessity — a browser file input never learns
   * an absolute path, so bytes inside a connected folder can only be read by
   * the node holding it. `seam.files` remains the browser-upload path and the
   * two are not alternatives to each other.
   */
  projectFiles?: {
    list(projectId: ProjectId, path?: string): Promise<ProjectFileListing>;
    /**
     * Amendment 8 (2026-08-09, Files browser): `read` — one file's CONTENT,
     * `projects.files.read`. The group could LIST a directory and ATTACH a file
     * but never SHOW one, so a viewer had nothing to render.
     *
     * `path` is ABSOLUTE, the same vocabulary `list` answers in
     * `ProjectFileEntry.path` and `attach` consumes — a second, relative
     * vocabulary over one filesystem would invite passing one for the other.
     */
    read(projectId: ProjectId, path: string): Promise<ProjectFileReadResult>;
    attach(projectId: ProjectId, input: ProjectFileAttachInput): Promise<CommandResult>;
  };
  /**
   * Amendment 8 (2026-08-10, folder import — owner ruling R7): the
   * `projects.folderUploads.init|complete|abort` lifecycle. A picked local
   * folder MATERIALIZES on the node's disk and is linked as a Project; the
   * bytes ride the EXISTING raw-PUT transport (`files.putBytes` accepts each
   * per-file grant — zero-byte files receive NO grant by design). Optional
   * for the same reason `projectSetup` is: a fixture seam has no filesystem
   * to materialize onto, and its absence keeps the Import-folder control
   * disabled-with-reason. `mode: 'merge'` is R8 — in-place replacement with
   * an explicit `replacedCount`, never a refusal and never a delete.
   */
  projectFolderUploads?: {
    init(spaceId: SpaceId, input: ProjectFolderUploadInitInput): Promise<ProjectFolderUploadGrant>;
    complete(
      folderUploadId: string,
      input: ProjectFolderUploadCompleteInput,
    ): Promise<ProjectFolderUploadResult>;
    abort(folderUploadId: string, input: ProjectFolderUploadAbortInput): Promise<void>;
  };
  entity(id: EntityId): Promise<EntityDetail>;
  children(id: EntityId, opts?: PageOpts): Promise<Page<EntitySummary>>;
  /** Connections tab, and the edge-id lookup behind any edge REMOVAL. */
  connections(id: EntityId, opts?: ConnectionOpts): Promise<Page<EdgeView>>;
  /** Activity tab. */
  activity(id: EntityId, opts?: PageOpts): Promise<Page<ActivityItem>>;
  /**
   * Discussion tab, and — with `rootMessageId` — a thread's branch.
   * `?rootMessageId=` switches the server read from "thread roots" to
   * "replies under a root", keyset-paginated OLDEST-FIRST (a conversation is
   * read in the order it happened, unlike a feed). The cursor is opaque and
   * fingerprinted over (anchorId, rootMessageId); never mix cursors across
   * the two shapes of this read.
   */
  messages(anchorId: EntityId, opts?: MessageListOpts): Promise<Page<MessageView>>;
  handoffs(workSessionId: EntityId, opts?: PageOpts): Promise<Page<HandoffView>>;
  /**
   * The session's `tm8` CLI command journal — the DEBUG surface's only read.
   * A window (`records`) plus whole-file `totals`, so the headline stays honest
   * when the window is truncated. `available:false` is a real, common state (a
   * session spawned before journaling, or one launched with it off) and renders
   * as an explained empty, never a zero. `before` is a seq cursor for paging
   * older records; `limit` defaults to 100 server-side.
   */
  journal(workSessionId: EntityId, opts?: JournalOpts): Promise<SessionJournalPage>;
  /**
   * What the session was TOLD at spawn — the other half of the DEBUG surface.
   *
   * The journal answers "what did this agent DO"; this answers "what was this
   * agent GIVEN": the composed manifest (teammate, model, provider, workdir,
   * tasks, profile pin), the environment variable NAMES, and the two prompt
   * channels as the bytes actually sent. One-shot, not polled: unlike the
   * journal it cannot grow, so re-reading it every few seconds would ship a
   * whole manifest to learn nothing.
   *
   * `available:false` and `prompts.unavailableReason:'not_recorded'` are two
   * DIFFERENT explained empties — no manifest row at all versus a manifest
   * recorded before the prompts were captured — and the surface must keep them
   * apart. Environment VALUES are structurally absent, never merely hidden.
   */
  launch(workSessionId: EntityId): Promise<SessionLaunchRecord>;
  /**
   * What the session's agent SAID — the third face of the DEBUG surface, after
   * TOLD (`launch`) and DID (`journal`).
   *
   * Read from the agent's OWN transcript file, so it carries model prose the
   * journal structurally cannot hold. Polled like the journal, because unlike
   * the launch record it grows.
   *
   * `stats` describes the RETURNED WINDOW, not the session's lifetime — the
   * server reads a tail — and `stats.partial` says which. `stuck` is a
   * HEURISTIC over tool calls without prose and must never be rendered as a
   * liveness claim; `execution.liveness` is the authority on that.
   */
  transcript(workSessionId: EntityId, opts?: TranscriptOpts): Promise<SessionTranscriptPage>;
  /**
   * The space-wide attention queue — the ONLY way to discover *which* entities
   * are waiting on a human. `collections.query` has neither an attention filter
   * nor an attention sort (contract.ts CollectionQuery), so the alternative
   * would be scanning every entity to find a handful.
   *
   * Rows are per-REQUEST and carry no title or kind; the server orders them
   * `points desc, createdAt asc, id asc`. Callers that want one row per entity
   * group them and hydrate names separately.
   */
  attentionRequests(input: AttentionRequestListQuery): Promise<AttentionRequestPage>;
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

  /** Canonical file grant lifecycle; raw bytes remain outside JSON commands. */
  files: {
    uploadInit(input: FileUploadInitInput): Promise<FileUploadGrant>;
    putBytes(grant: FileUploadGrant, bytes: BodyInit): Promise<void>;
    complete(uploadId: string, input: FileUploadCompleteInput): Promise<CommandResult>;
    abort(uploadId: string, input: FileUploadAbortInput): Promise<CommandResult>;
    /**
     * Amendment 3 (2026-08-01, attachments). The ONE read in this seam that
     * answers a URL rather than a DTO, because `files.download`
     * (GET /v2/files/:fileEntityId/download, catalog.ts:118) answers RAW BYTES
     * and a browser reaches bytes through `<a href>` / `<img src>`, not through
     * a fetch the UI would then have to re-blob.
     *
     * It is HERE and not in a component because building a transport URL is
     * `src/data/**` work: only this layer knows the node's base URL, and
     * `files/reasons.ts:DOWNLOAD_UNAVAILABLE` recorded the alternative
     * (same-origin luck in a component) as the thing not to do. Synchronous by
     * design — a src attribute cannot await.
     *
     * Not a capability grant: the route authorizes the caller itself, so the
     * href is only as good as the viewer's session.
     */
    downloadHref(fileEntityId: EntityId): string;
  };

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
    /**
     * The write side of the relationship graph (`edges.create` / `edges.delete`).
     *
     * THE READS ALWAYS HAD A WRITE PATH ON THE NODE AND THIS SEAM DID NOT
     * EXPOSE IT. `EntitySummary.state.assignees` is projected from `assigned_to`
     * edges (server `entity-read.ts:551`) and `connections()` has rendered
     * edges since the beginning, so every surface could SHOW an assignment and
     * none could make one. That is why the task tile's "Assigned" chip was
     * static: not a forgotten onClick, a missing seam operation.
     *
     * GENERIC ON PURPOSE — this is `edges.create`, not `assign`. The catalog
     * row is generic, the database validates the endpoint kinds per edge type
     * (`internal.validate_edge`), and naming one edge type here would put a
     * kind-specific verb in the layer whose whole job is to be kind-blind.
     * `useRowLifecycle` is where "assign" means `assigned_to`.
     *
     * `write_edge` UPSERTS on (src, dst, type), so create is idempotent on the
     * edge identity; delete is addressed by the edge's own id, which callers
     * read from `connections()`.
     *
     * DETACH IS THE SAME OPERATION. Attaching a file writes ONE `attached_to`
     * edge and nothing else, so un-attaching is the deletion of that edge —
     * not of the file, which may be attached elsewhere and whose bytes are not
     * this surface's to destroy. The catalog has carried `edges.delete`
     * (DELETE /v2/edges/:edgeId) since v1; the seam simply never named it,
     * which is why the attachment strip shipped as a one-way door. Assignment
     * and attachment reached this op from two different features at once; it
     * is ONE Amendment 5, not two.
     *
     * `ctx` is optional in the type and REQUIRED by the server
     * (`RequiredCommandContextSchema`), exactly as `deleteEntity` is: an
     * omitted context earns an honest `invalid_input` rather than a
     * synthesized id the caller could not reconcile.
     */
    createEdge(input: CreateEdgeInput): Promise<CommandResult>;
    deleteEdge(edgeId: string, ctx?: CommandContext): Promise<CommandResult>;
    /**
     * Collection membership (2026-08-12) — sugar over the `contains` edge,
     * NOT a parallel store. These exist beside `createEdge`/`deleteEdge`
     * because the generic doors cannot say two things this pair must say:
     * `addToCollection` auto-appends `props.position` after the current
     * maximum when the caller names none (write_edge would sort every member
     * identically), and `removeFromCollection` is addressed by the
     * (collection, entity) PAIR — a caller that never read the edge row can
     * still take an item out of a list. Re-adding an existing member
     * re-positions it rather than duplicating (the store upserts on
     * src/dst/type).
     */
    addToCollection(collectionId: EntityId, input: CollectionAddItemInput): Promise<CommandResult>;
    removeFromCollection(
      collectionId: EntityId,
      entityId: EntityId,
      ctx?: CommandContext,
    ): Promise<CommandResult>;
    postMessage(input: PostMessageInput): Promise<CommandResult | MessageBatchResult>;
    editMessage(id: EntityId, input: PatchMessageInput): Promise<CommandResult>;
    react(id: EntityId, input: ReactionInput): Promise<CommandResult>;
    resolveAttention(id: EntityId, input: ResolveEntityAttentionInput): Promise<AttentionRequestMutationResult>;
    /**
     * Amendment 4: write the VIEWER'S OWN profile row — the DTO names no
     * subject by design (`identity.profile.update`, contract.ts). All fields
     * optional; only provided fields are written. The server enforces the
     * `issuer:subject` shape on `globalId` with a check constraint; callers
     * should validate first so users see a message, not a constraint error.
     */
    updateProfile(input: IdentityProfileUpdateInput): Promise<IdentityProfileView>;
    markRead(notificationId: string): Promise<void>;
    upsertReadMark(anchorId: EntityId, lastReadAt: string): Promise<void>;
    /**
     * Mint a short-lived, viewer-bound preview capability (Amendment 2).
     * `previewUrl` is present only when the node runs the second-origin
     * preview listener; callers must treat its absence as "this node cannot
     * render previews", never fabricate a URL.
     */
    previewArtifact(id: EntityId, input: ArtifactsPreviewStartInput): Promise<ArtifactPreviewSession>;
    spawn(input: ExecutionSpawnInput): Promise<CommandResult>;
    /**
     * `execution.dispatch` — hand a subject to the space's resident dispatcher
     * and let IT choose the teammate and the memories (DESIGN §4.3, D2/D4).
     *
     * IT CARRIES NO LAUNCH CONFIGURATION, and that absence is the feature: the
     * contract's own comment is that "the moment a caller can name the
     * teammate, it is spawning, not dispatching". So this is not a variant of
     * `spawn` with defaults filled in and must never grow toward one.
     *
     * IT RETURNS A DELIVERY VERDICT, not a session. Dispatch is asynchronous by
     * construction — it posts a request to another agent, which decides later —
     * so there is no session id to hand back and `delivery: 'undelivered'` is a
     * real, non-exceptional outcome that still leaves a durable message. A
     * caller that treats this like `spawn` and waits for a terminal will wait
     * forever.
     */
    dispatch(input: ExecutionDispatchInput): Promise<ExecutionDispatchResult>;
    prompt(id: EntityId, input: ExecutionPromptInput): Promise<CommandResult>;
    terminate(id: EntityId, input: ExecutionTerminateInput): Promise<CommandResult>;
    /**
     * Bring an `exited`/`failed` session back with its agent's conversation
     * restored. `clientMutationId` is REQUIRED by the contract DTO (unlike
     * terminate's optional `force`), and the server's `.strict()` schema
     * refuses any field the contract does not name.
     */
    resume(id: EntityId, input: ExecutionResumeInput): Promise<CommandResult>;
  };

  /**
   * -- per-member agent credentials (the four `credentials.*` catalog ops) ---
   *
   * HUMAN-ONLY BY RULING R2, enforced server-side on `ctx.identity.authKind`
   * (allowlist `browser` | `cli`). A browser session is on the allowed side,
   * which is why this block exists on the seam at all; nothing here weakens or
   * routes around that guard, and `status` is human-only too, deliberately.
   *
   * It is a TOP-LEVEL block rather than a member of `commands` because it is
   * mixed read/write about the VIEWER's own account — it names no subject and
   * no space except when opening a terminal, so filing the read under
   * `commands` would have been the only alternative and a worse lie.
   */
  credentials: {
    /** The merged view + `gitCredentialStore`, its own completeness report. */
    status(): Promise<CredentialsStatusView>;
    /**
     * Disconnect, which TERMINATES (R3). `revoked: true` with a non-empty
     * `failures` is the NORMAL partial outcome, not a contradiction — a
     * credential can be revoked while a session it opened refuses to die.
     */
    disconnect(provider: CredentialProviderName): Promise<CredentialsDeleteResult>;
    /** Opens the login PTY. The answer names a work_session to host. */
    startLogin(
      spaceId: SpaceId,
      provider: CredentialProviderName,
    ): Promise<CredentialsLoginSessionStartResult>;
    /** Harvests what the terminal achieved. `connected` and `stored` differ. */
    finishLogin(workSessionId: EntityId): Promise<CredentialsLoginSessionFinishResult>;
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
