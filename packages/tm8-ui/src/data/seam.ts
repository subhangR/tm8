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
 * Amendment 8 (2026-08-09, Tier 1 file reads): reads gain `projectFileHistory`
 * and `projectFileBlame` — the contract's `projects.file.history` and
 * `projects.file.blame` (GET /v2/projects/:projectId/file-history|blame,
 * catalog v1). READS over one path in a linked project's working directory:
 * revisions (rename-following, optional selected-revision patch via
 * `diffOid`) and working-tree blame hunks, each joined to the `created_in`
 * session provenance — `session: null` means NO tm8 session recorded, and the
 * UI must say so rather than guess. Contract-shaped and additive, zero caller
 * churn. Filed by the tier1-file-history-blame lane for dual re-consensus
 * recording alongside the catalog rows it consumes.
 *
 * Amendment 9 (2026-08-09, Tier 2 completion): commands gain
 * `gitCherryPick` / `gitBranch` / `gitStash` — the contract's
 * `execution.gitCherryPick|gitBranch|gitStash` (POST, catalog v1), and
 * `SessionGitStatus` gains the additive optional `stashes` list the server
 * now returns. Same conflict law as `gitMerge`: a conflict RESOLVES with
 * `status:'conflict'` + the conflicted paths, worktree restored clean
 * (verified server-side); the destructive gates (unmerged branch delete,
 * stash drop) refuse without `force`. Additive, zero caller churn. Filed by
 * the tier2-completion lane for dual re-consensus recording alongside the
 * three catalog rows it consumes.
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
  CreateInviteInput,
  InvitePreview,
  InviteRedemption,
  RedeemInviteInput,
  SpaceInviteView,
  UpdateMemberRoleInput,
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
  ExecutionTerminalStartInput,
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
  ProjectFileBlame,
  ProjectFileHistory,
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
  ContentionReport,
  ExecutionGitCheckpointInput,
  ExecutionGitCommitInput,
  ExecutionGitMergeInput,
  ExecutionGitCherryPickInput,
  ExecutionGitBranchInput,
  ExecutionGitStashInput,
  ExecutionGitRollbackInput,
  SessionGitCheckpointResult,
  SessionGitCommitResult,
  SessionGitDiff,
  SessionGitMergeResult,
  SessionGitCherryPickResult,
  SessionGitBranchResult,
  SessionGitStashResult,
  SessionGitRollbackResult,
  SessionGitStatus,
  SessionJournalPage,
  SessionLaunchRecord,
  SessionTranscriptPage,
  HomeSnapshot,
  StartChatThreadInput,
  StartChatThreadResult,
  SpaceId,
  SpaceKindCounts,
  SpaceSettingsView,
  SpaceSummary,
  TaskAxis,
  TaskAxisInput,
  TaskWorkflow,
  Workflow,
  TaskWorkflowInput,
  UpdateAttentionRequestInput,
  TrackingPrMergeInput,
  TrackingPrMergeResult,
  WorkInput,
  WorkSessionStatus,
  WorkStatus,
} from '@tm8/contract';
import type { ChatTurnFrame } from '../chat-home/types';

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

/**
 * One published bundle revision, as `artifacts.revisions.list` answers it.
 * MIRRORS THE SERVER WIRE SHAPE (`revisionDto`) rather than importing a
 * contract DTO, because the contract declares NONE for this response — the
 * catalog row exists (`artifacts.revisions.list`, v1) but its output type was
 * never written down. Recorded as a contract gap under Amendment 12; when the
 * DTO lands in `@tm8/contract`, this declaration must move there and this
 * one must die, not diverge.
 */
export interface ArtifactRevisionSummary {
  revisionNumber: number;
  manifestSha256: string;
  entrypoint: string;
  fileCount: number;
  totalSizeBytes: number;
  sourceProvenance: Record<string, unknown> | null;
  createdAt: string;
  /** Identity id of the publisher, or null when unrecorded. */
  publishedBy: string | null;
}

/** `artifacts.revisions.list` — newest first, exactly as the server orders it. */
export interface ArtifactRevisionsList {
  revisions: ArtifactRevisionSummary[];
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
  /**
   * Also scan the whole transcript for Edit/Write tool calls and attach
   * `fileChanges` — "what did this session change", without a worktree,
   * labelled source:'transcript' (observed tool calls, not git).
   */
  files?: boolean;
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

/** `projectFileHistory` options — bounded server-side (default 100 revisions). */
export interface FileHistoryOpts {
  /** Max revisions returned; the DTO's `truncated` says when this cut the walk. */
  maxRevisions?: number;
  /** Full 40-hex oid: also answer that revision's patch (`diff`), byte-capped. */
  diffOid?: string;
}

/** `projectFileBlame` options — bounded server-side (default 2000 lines). */
export interface FileBlameOpts {
  /** Max lines blamed; `totalLines - blamedLines` is what a cut holds back. */
  maxLines?: number;
}

/** `gitDiff` options — bounded server-side (`maxBytes` caps at 1 MiB). */
export interface GitDiffOpts {
  /** Unified-diff byte cap; server default 256 KiB, max 1 MiB. */
  maxBytes?: number;
}

export interface Seam {
  // -- lifecycle -------------------------------------------------------------
  /** Subscribe the space's event stream and start the liveness cadence. Idempotent. */
  openSpace(spaceId: SpaceId): Promise<void>;
  closeSpace(spaceId: SpaceId): void;
  /** Force the next open to establish a fresh off-React baseline after resync. */
  invalidateSpaceBaseline?(spaceId: SpaceId): void;
  dispose(): void;

  // -- event stream & connection honesty (LLD §6) ----------------------------
  /**
   * Durable events for open spaces. GUARANTEE: strictly increasing seq per
   * space, no duplicates — consumers need no seenEventIds set. Presence/typing
   * frames never appear here (R8 dormant; W5: no publisher exists).
   */
  onEvent(cb: (e: DurableWorkspaceEvent) => void): Unsubscribe;
  /** C3 transient turn frames. Durable parts are re-read after a reconnect. */
  onChatTurn(cb: (frame: ChatTurnFrame) => void): Unsubscribe;
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
  /**
   * The category-model workflows (`spaces.workflows.list`, migration 149):
   * the ONE global default (spaceId null) plus this space's own. Distinct
   * from `spaceSettings().taskWorkflows` — those are the LEGACY status-subset
   * rules that phase 6 retires; these are the named state/transition sets the
   * universal board's columns are built from.
   */
  workflows(spaceId: SpaceId): Promise<Workflow[]>;
  /**
   * Amendment 11 — the one read on this seam that answers BEFORE the caller is
   * anybody (migration 118, `spaces.invites.preview`).
   *
   * A join link is opened by someone with no account, or with one and no
   * membership in the space the code names — so every other read here correctly
   * returns nothing for them. It sits beside the reads rather than under
   * `commands` because it writes nothing; it is listed apart in the doc because
   * "unauthenticated read" is a property no other member of this interface has,
   * and a caller who does not notice would place it behind the auth gate where
   * it is useless.
   */
  previewInvite(code: string): Promise<InvitePreview>;
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
   * The file-contention map over one project's ACTIVE worktrees (Git UI
   * wave): which lanes exist, what each touched beyond its base, and which
   * PAIRS overlap — the read that sees a silent-revert collision while both
   * lanes are still alive, not after the second merge. Lanes the node cannot
   * read are SKIPPED with a reason, never silently omitted.
   */
  projectContention(projectId: string): Promise<ContentionReport>;
  /**
   * The revisions of one path in a linked project's working directory
   * (Amendment 8) — argv-only git server-side, rename-following, each
   * revision carrying its `created_in` session attribution or null. The same
   * `invalid_input`-is-a-project-fact rule as `projectBranches` applies.
   */
  projectFileHistory(projectId: string, path: string, opts?: FileHistoryOpts): Promise<ProjectFileHistory>;
  /**
   * Working-tree blame of one path (Amendment 8): hunks with commit oid and
   * the session provenance join. `session: null` means no tm8 session
   * recorded — consumers must render that as a named absence, never guess.
   */
  projectFileBlame(projectId: string, path: string, opts?: FileBlameOpts): Promise<ProjectFileBlame>;
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
    /**
     * Every project on the node, unscoped — `projects.list` without a
     * `spaceId`. `working_dir` is node-globally unique, so when
     * `createProject` refuses because the folder already HAS a project, this
     * is how onboarding finds that project to link instead of dead-ending.
     */
    listProjects(): Promise<ProjectResource[]>;
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
    /**
     * Amendment 9 (2026-08-12, folder download): the URL of
     * `projects.files.archive` — a whole subtree as one zip.
     *
     * An HREF here and a DTO for `read` is not an inconsistency, it is §4.4.
     * A single file off a project's disk must never get a document context on
     * the app origin, so it travels as JSON and the UI decides how to render
     * it. An archive cannot BE a document: it is `application/zip` served
     * `attachment` with `nosniff`, so the browser's own download path is both
     * safe and the only sensible transport — streaming a 200 MB tree through
     * JSON to rebuild it as a Blob would buy nothing and cost the heap.
     *
     * `path` is ABSOLUTE, the same vocabulary the rest of this group speaks;
     * omitted means the project root.
     */
    archiveHref(projectId: ProjectId, path?: string): string;
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
  /**
   * Amendment 10 (2026-08-13, TM8 Chat composition — PR188 review F1): the
   * contract's `spaces.home` read. The chat home's thread list rides its
   * additive `chatThreads` field, so this is the read half of the bridge the
   * shipped chat home was missing — the surface rendered a disabled composer
   * blaming the server for operations the node in fact serves.
   */
  home(spaceId: SpaceId | string): Promise<HomeSnapshot>;
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
   * The session GIT RAIL's two reads (Git UI wave).
   *
   * `gitStatus` answers "where is this lane": branch, dirty counts,
   * ahead/behind its recorded base — read LIVE from the worktree by the node
   * that holds it. `gitDiff` answers "what did this session change": working
   * tree vs the merge-base of the base ref, so upstream drift never pollutes
   * the answer. Both carry `available:false` with a NAMED reason as a real,
   * common state (a scratch/project-dir session simply has no worktree) and
   * consumers render the reason, never an empty or broken panel.
   *
   * The diff is digest+partial (the transcript precedent): `stat`/`files`
   * are always complete; the unified text is byte-capped with
   * `diffTruncated` saying when the cap cut it.
   */
  gitStatus(workSessionId: EntityId): Promise<SessionGitStatus>;
  gitDiff(workSessionId: EntityId, opts?: GitDiffOpts): Promise<SessionGitDiff>;
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
    /**
     * Amendment 10 (with `home` above): the contract's `chat.threads.start`
     * — the write half of the chat-home bridge. Input is an ALREADY-POSTED
     * root message id; the op never creates messages and triggers turn 1.
     */
    startChatThread(input: StartChatThreadInput): Promise<StartChatThreadResult>;
    editMessage(id: EntityId, input: PatchMessageInput): Promise<CommandResult>;
    react(id: EntityId, input: ReactionInput): Promise<CommandResult>;
    resolveAttention(id: EntityId, input: ResolveEntityAttentionInput): Promise<AttentionRequestMutationResult>;
    /**
     * Write ONE attention request, addressed by its own id.
     *
     * The sibling above is the BULK verb: `resolveEntity` flips every open row
     * on an entity at once, has no per-request granularity and no way to say
     * `dismissed`. That was the only write this seam carried, which is why
     * `dismissed` — a full quarter of the status enum (migration 050:16-17) —
     * had no UI path at all: nothing could reach it, and a queue item could
     * only ever be *satisfied*, never *declined*.
     *
     * OPTIMISTICALLY LOCKED, and the version is the caller's problem: the RPC
     * raises 40001 when `expectedVersion` is stale (050:128-132), and a stale
     * version is the EXPECTED case here rather than a rare race — the bulk
     * resolve that fires when you open an entity bumps `version` on every row
     * it touches. A caller holding rows fetched before that must refetch, not
     * retry.
     */
    updateAttentionRequest(
      requestId: string,
      input: UpdateAttentionRequestInput,
    ): Promise<AttentionRequestMutationResult>;
    /**
     * Amendment 4: write the VIEWER'S OWN profile row — the DTO names no
     * subject by design (`identity.profile.update`, contract.ts). All fields
     * optional; only provided fields are written. The server enforces the
     * `issuer:subject` shape on `globalId` with a check constraint; callers
     * should validate first so users see a message, not a constraint error.
     */
    updateProfile(input: IdentityProfileUpdateInput): Promise<IdentityProfileView>;
    /**
     * Amendment 11 — MEMBERSHIP GETS ITS VERBS (migration 118).
     *
     * `settings-space/reasons.ts` has said since 2026-07-29 that "the seam has
     * no membership verb at all", and every role and invite control on the
     * settings surface has rendered disabled-with-reason because of it. These
     * four close exactly that gap and nothing wider.
     *
     * `setMemberRole` addresses the member by the (space, member) PAIR because
     * the operation does: a member id alone would authorize against a space the
     * row is not in. Every rule — admin to change anything, owner to touch the
     * owner role, never leave a space without one — lives in SQL, so this seam
     * carries no client-side authorization and cannot drift from the server's.
     */
    setMemberRole(
      spaceId: SpaceId,
      memberId: EntityId,
      input: UpdateMemberRoleInput,
    ): Promise<CommandResult>;
    /**
     * Mint a join code. `role` is what redemption confers and may be `admin` or
     * `member` — never `owner`: a code travels out of band, and a bearer
     * capability that could confer ownership is a different and much larger
     * thing than an invitation.
     */
    createInvite(spaceId: SpaceId, input: CreateInviteInput): Promise<SpaceInviteView>;
    /** Kill a live code. The row survives, revoked, so the list stays truthful. */
    revokeInvite(spaceId: SpaceId, inviteId: string, ctx?: CommandContext): Promise<SpaceInviteView>;
    /**
     * The task-axis registry's writes (W2, 2026-08-16) — over catalog ops
     * that existed all along (`spaces.taskAxes.create|update|delete`): new
     * SEAM verbs only, zero catalog change.
     *
     * The READ deliberately has no verb here: axes ride `spaceSettings()`,
     * the same round trip the settings shell already makes for invites.
     *
     * Every rule lives in SQL and is surfaced, never copied: space-admin
     * authorization, name/value validation, and the three in-use refusals
     * (delete / rename / value-removal while any task carries the axis) come
     * back as the server's own words. `update` takes the WHOLE row shape —
     * `w2_update_task_axis` has no sparse form.
     */
    createTaskAxis(spaceId: SpaceId, input: TaskAxisInput): Promise<TaskAxis>;
    updateTaskAxis(spaceId: SpaceId, axisId: string, input: TaskAxisInput): Promise<TaskAxis>;
    deleteTaskAxis(spaceId: SpaceId, axisId: string, ctx: CommandContext): Promise<{ axisId: string }>;
    /**
     * The task-workflow registry's writes (W4, migration 132) — the same
     * posture as the axis three above: new seam verbs over catalog ops
     * (`spaces.taskWorkflows.upsert|delete`), the READ rides `spaceSettings()`
     * (`SpaceSettings.taskWorkflows`), and every rule lives in SQL and is
     * surfaced, never copied — space-admin authorization, the duplicate-status
     * refusal (22023), the structural {open,working,done} check (23514), and
     * the per-status trigger refusal on the tasks themselves.
     *
     * `upsert` rather than create+update because the natural key is
     * (space, typeValue) and the UI edits one row per value. Deleting a rule
     * is never data loss: it widens the vocabulary back to the seven and no
     * task row changes.
     */
    upsertTaskWorkflow(spaceId: SpaceId, input: TaskWorkflowInput): Promise<TaskWorkflow>;
    deleteTaskWorkflow(spaceId: SpaceId, workflowId: string, ctx: CommandContext): Promise<{ workflowId: string }>;
    /**
     * Redeem a code as the CURRENT viewer. Distinct from `previewInvite` below
     * in the way that matters: this one requires you to be somebody.
     */
    redeemInvite(input: RedeemInviteInput): Promise<InviteRedemption>;
    markRead(notificationId: string): Promise<void>;
    upsertReadMark(anchorId: EntityId, lastReadAt: string): Promise<void>;
    /**
     * Mint a short-lived, viewer-bound preview capability (Amendment 2).
     * `previewUrl` is present only when the node runs the second-origin
     * preview listener; callers must treat its absence as "this node cannot
     * render previews", never fabricate a URL.
     */
    previewArtifact(id: EntityId, input: ArtifactsPreviewStartInput): Promise<ArtifactPreviewSession>;
    /**
     * Amendment 12 (2026-08-17, artifact viewer): the artifact detail block
     * grew from metadata-plus-Run into a real viewer, and the two remaining
     * artifact catalog ops gain their first UI callers — the revision
     * switcher (`artifacts.revisions.list`) and download-as-zip
     * (`artifacts.export`).
     *
     * Both sit in THIS group despite being catalog reads, for the zero-churn
     * reason Amendment 2 put `previewArtifact` here: every detail-panel host
     * threads exactly `seam.commands` into `EntityDetailPanel`, and the
     * artifact block's port is a structural subset of this group — a second
     * prop through every host is precisely the adapter D57.1 warns about.
     *
     * CONTRACT GAP (recorded, not papered over): the contract has no DTO for
     * the revisions-list response; `ArtifactRevisionsList` above mirrors the
     * server's wire shape and must move into `@tm8/contract` when its DTO
     * lands.
     */
    listArtifactRevisions(id: EntityId): Promise<ArtifactRevisionsList>;
    /**
     * `artifacts.export` answers RAW ZIP BYTES — no JSON envelope — so this
     * is the one member here that resolves a `Blob`; the caller turns it into
     * an object-URL download. A seam METHOD rather than an href builder (the
     * `files.downloadHref` idiom) because the export route must carry the
     * viewer's Authorization header, which an `<a href>` cannot send.
     */
    exportArtifactRevision(id: EntityId, revisionNumber: number): Promise<Blob>;
    spawn(input: ExecutionSpawnInput): Promise<CommandResult>;
    /**
     * `execution.terminal.start` — a VANILLA TERMINAL (101): a shell session
     * with no agent attached.
     *
     * NOT A VARIANT OF `spawn` WITH THE AGENT FIELDS LEFT NULL, and the input
     * type is what enforces that: it has no `teamMemberId`, no `model`, no
     * `agentTool` and no `mode` to leave null. A seam method taking
     * `ExecutionSpawnInput` with those omitted would be one optional-field edit
     * away from a terminal that quietly spawns an agent.
     *
     * Returns a `CommandResult` like `spawn` does, because it creates exactly
     * the same thing — a `work_session` entity — and every store that
     * reconciles a spawn's patches must reconcile this one's identically.
     */
    startTerminal(input: ExecutionTerminalStartInput): Promise<CommandResult>;
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
    /**
     * The session git rail's four verbs (Git UI wave) — checkpoint, rollback,
     * commit, and merge-the-base-FORWARD. The other merge direction (session
     * branch → base) is deliberately absent at every layer: base is checked
     * out in the user's primary tree or nowhere, and landing on base goes
     * through a PR. A merge CONFLICT resolves (not rejects) with
     * `status:'conflict'` and the conflicted paths — the worktree is restored
     * clean server-side, and the UI's job is to surface the paths loudly.
     */
    gitCheckpoint(id: EntityId, input: ExecutionGitCheckpointInput): Promise<SessionGitCheckpointResult>;
    gitRollback(id: EntityId, input: ExecutionGitRollbackInput): Promise<SessionGitRollbackResult>;
    gitCommit(id: EntityId, input: ExecutionGitCommitInput): Promise<SessionGitCommitResult>;
    gitMerge(id: EntityId, input: ExecutionGitMergeInput): Promise<SessionGitMergeResult>;
    /**
     * Tier 2 completion (Amendment 8). Cherry-pick's direction is fixed by
     * construction — FROM the named commits ONTO the session branch; branch
     * delete/rename refuse checked-out and protected branches server-side;
     * stash drop and an unmerged branch delete gate on `force`.
     */
    gitCherryPick(id: EntityId, input: ExecutionGitCherryPickInput): Promise<SessionGitCherryPickResult>;
    gitBranch(id: EntityId, input: ExecutionGitBranchInput): Promise<SessionGitBranchResult>;
    gitStash(id: EntityId, input: ExecutionGitStashInput): Promise<SessionGitStashResult>;
    /**
     * Amendment 11 (2026-08-13, B10 forge write): `tracking.pr.merge` — land a
     * tracked PR ON THE FORGE, as the acting member's own GitHub credential.
     *
     * THE COUNTERPART TO `gitMerge`'S DELIBERATE EXCLUSION, and the reason that
     * exclusion was safe: the rail refuses session-branch → base because
     * "landing on base goes through a PR", and until #184 there was no door for
     * the PR half either. `merge-pr` has therefore sat in the action registry
     * DEFERRED, carrying the authored reason "this node only has the read-only
     * tracker". That precondition is now false; this is what retires it.
     *
     * IT REFUSES FROM OBSERVED FACTS, BEFORE ANY NETWORK — state `open`,
     * mergeable not `dirty`, CI not `failing`, and a stored member credential.
     * The server guards on the STORED row rather than a fresh read on purpose:
     * the stored row is what the human REVIEWED. That makes the refusal
     * vocabulary (`details.reason`: not_open | conflicted | ci_red |
     * no_github_credential | forge_blocked | head_moved) part of THIS seam's
     * contract, not an implementation detail — callers render it verbatim.
     *
     * `headSha` is NOT a version guard: it is the observed head to merge, and
     * omitting it lets the server pin the head it stored. Either way a branch
     * that moved after review answers `head_moved` instead of merging commits
     * nobody looked at — so callers should pin what the user was SHOWN.
     *
     * Success returns the forge's own `mergeSha`. It does NOT flip the PR's
     * lifecycle here: `merged` arrives through the observer loop as a
     * `git.pr_state_changed` fact. A caller that repaints the chip optimistically
     * is asserting an outcome the forge has not confirmed.
     */
    mergePullRequest(id: EntityId, input: TrackingPrMergeInput): Promise<TrackingPrMergeResult>;
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
    statusOf(session: { id: EntityId; status: WorkStatus | WorkSessionStatus | null }): SessionLiveness;
  };
}

/**
 * Extra controls on the FIXTURE implementation only (LLD §10 + FE consensus
 * attachment: setConnection / setLiveness / triggerResync). Lets the gate
 * screen demo the honesty states and the hydration-replay path on demand.
 */
/**
 * Every outcome `commands.mergePullRequest` can produce, as one word a test
 * can name. The first group is the op's OBSERVED-FACT vocabulary
 * (`details.reason`); the second is its tail — codes that carry no `reason`,
 * so a caller that keys off `reason` alone renders an empty refusal for them;
 * and `not_implemented` is the 501 an older node answers, which is a state to
 * render, not an error to log.
 */
export type FixturePrMergeGuard =
  | 'available'
  | 'not_open' | 'conflicted' | 'ci_red' | 'no_github_credential'
  | 'forge_blocked' | 'head_moved'
  | 'not_found' | 'unauthorized' | 'rate_limited' | 'upstream_unavailable'
  | 'not_implemented';

export interface FixtureControls {
  setConnection(state: ConnectionState): void;
  setLiveness(spaceId: SpaceId, liveEntityIds: string[], nodeBootId?: string): void;
  triggerResync(spaceId: SpaceId): void;
  setPrMergeGuard(guard: FixturePrMergeGuard): void;
}

export interface FixtureSeam extends Seam {
  fixtureControls: FixtureControls;
}
