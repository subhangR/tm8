/**
 * Typed wrappers for EXACTLY the operations the seam exposes (LLD §5:
 * "one typed function per seam-exposed op. No generic op-name dispatcher, no
 * speculative coverage of all 98 ops"). If a function here has no caller in
 * `seam-real.ts`, it should not exist.
 *
 * This file is also where the seam's shape and the server's shape are
 * reconciled, out loud. Four places they differ today — each adapted here and
 * NOWHERE else, so the divergence has exactly one address:
 *
 *   1. `createTask` — there is no task route. `CreateTaskInput`'s kind-specific
 *      fields travel inside `content` on `POST /v2/entities` (contract.ts:603,
 *      server dispatch entities-commands-tracking.ts:882). Same for `patchTask`
 *      via `update_task_content` (…:963) — `status` included.
 *   2. `editMessage` — the server answers a bare `MessageView`, not a
 *      `CommandResult`. `MessageView extends EntitySummary`, so it is lifted to
 *      `{patches: [view]}`: the authoritative patch list the optimistic journal
 *      reconciles against, with nothing invented.
 *   3. `markRead` / `upsertReadMark` — both server routes REQUIRE a
 *      `clientMutationId` the seam signature has no slot for. One is synthesized
 *      here. Safe precisely because neither is an optimistic-echo path (LLD §8:
 *      markRead is local-optimistic with rollback), so no caller needs to
 *      recognise the id later. `upsertReadMark`'s `lastReadAt` is NOT sent:
 *      `RequiredCommandContextSchema` is `.strict()` and the server stamps the
 *      time itself (`mark_read`, inbox-read-marks.ts:427). Sending it would be a
 *      400, and pretending the client's clock won would be worse.
 *   4. `liveness` — the response is space-scoped but does not echo `spaceId`,
 *      so this adapter stamps the request id onto the snapshot.
 */
import {
  type CreateInviteInput,
  type InvitePreview,
  type InviteRedemption,
  type RedeemInviteInput,
  type SpaceInviteView,
  type UpdateMemberRoleInput,
  bindPath,
  type ActivityItem,
  type ArtifactPreviewSession,
  type ArtifactsPreviewStartInput,
  type AttentionRequestListQuery,
  type AttentionRequestMutationResult,
  type AttentionRequestPage,
  type CollectionAddItemInput,
  type CollectionQuery,
  type CollectionResult,
  type CommandContext,
  type CommandResult,
  type ContainersCreateInput,
  type ContainersDestroyInput,
  type ContainersLifecycleInput,
  type ContainersProvidersListResult,
  type ContainersTerminalStartInput,
  type ContainersTerminalStartResult,
  type CompleteTaskInput,
  type CreateEdgeInput,
  type CreateEntityInput,
  type CreateSpaceInput,
  type CreateSpaceResult,
  type CreateTaskInput,
  type CredentialProviderName,
  type CredentialsDeleteResult,
  type CredentialsLoginSessionFinishResult,
  type CredentialsLoginSessionStartResult,
  type CredentialsStatusView,
  type DurableWorkspaceEvent,
  type EdgeView,
  type EntityDetail,
  type EntityFeedPage,
  type EntityId,
  type EntityKindDef,
  type EntitySummary,
  type ExecutionPromptInput,
  type ExecutionDispatchInput,
  type ExecutionDispatchResult,
  type ExecutionSpawnInput,
  type ExecutionTerminalStartInput,
  type ExecutionResumeInput,
  type ExecutionTerminateInput,
  type FileUploadAbortInput,
  type FileUploadCompleteInput,
  type FileUploadGrant,
  type FileUploadInitInput,
  type GraphQuery,
  type GraphResult,
  type HandoffView,
  type IdentityProfileUpdateInput,
  type IdentityProfileView,
  type MenuConfig,
  type MessageBatchResult,
  type MessageDeliveryView,
  type MessageView,
  type MoveEntityInput,
  type NotificationItem,
  type Page,
  type PatchEntityInput,
  type PatchMessageInput,
  type PatchTaskInput,
  type PostMessageInput,
  type ProjectBranchTopology,
  type ProjectFileBlame,
  type ProjectFileHistory,
  type ProjectCreateInput,
  type ProjectDirectoryListing,
  type ProjectFileAttachInput,
  type ProjectFileReadResult,
  type ProjectFolderUploadAbortInput,
  type ProjectFolderUploadCompleteInput,
  type ProjectFolderUploadGrant,
  type ProjectFolderUploadInitInput,
  type ProjectFolderUploadResult,
  type ProjectFileListing,
  type ProjectId,
  type ProjectLinkInput,
  type ProjectResource,
  type ReactionInput,
  type ResolveEntityAttentionInput,
  type ContentionReport,
  type ExecutionGitCheckpointInput,
  type ExecutionGitCommitInput,
  type ExecutionGitMergeInput,
  type ExecutionGitCherryPickInput,
  type ExecutionGitBranchInput,
  type ExecutionGitStashInput,
  type ExecutionGitRollbackInput,
  type SessionGitCheckpointResult,
  type SessionGitCommitResult,
  type SessionGitDiff,
  type SessionGitMergeResult,
  type SessionGitCherryPickResult,
  type SessionGitBranchResult,
  type SessionGitStashResult,
  type SessionGitRollbackResult,
  type SessionGitStatus,
  type SessionJournalPage,
  type SessionLaunchRecord,
  type SessionTranscriptPage,
  type SpaceId,
  type HomeSnapshot,
  type StartChatThreadInput,
  type StartChatThreadResult,
  type SpaceKindCounts,
  type SpaceSettingsView,
  type SpaceSummary,
  type TaskAxis,
  type TaskAxisInput,
  type TaskWorkflow,
  type Workflow,
  type TaskWorkflowInput,
  type TrackingPrMergeInput,
  type TrackingPrMergeResult,
  type UpdateAttentionRequestInput,
  type WorkInput,
} from '@tm8/contract';
import { measureSpawnTerminalSize } from '../../terminal/pty/terminalSize.js';

import type { HttpClient, QueryParams } from './http';
import type { ArtifactRevisionsList, BranchTopologyOpts, ConnectionOpts, FeedOpts, FileBlameOpts, FileHistoryOpts, GitDiffOpts, IdentityView, JournalOpts, LivenessSnapshot, MessageListOpts, PageOpts, TranscriptOpts } from '../seam';

/**
 * Fill in terminal geometry the caller did not state, so a server-hosted PTY
 * boots at the real pane width instead of 80x24.
 *
 * Resolved PER FIELD with `??` rather than by spread order. `{...measured,
 * ...input}` reads the same for the common case but is quietly fragile: it
 * relies on the caller OMITTING the key, so any construction that sets
 * `cols: undefined` explicitly would blow the measurement away — and because
 * JSON.stringify drops undefined, the server would then see no geometry at all
 * and fall back to 80x24. This form cannot be broken that way.
 */
function withMeasuredGeometry<T extends object>(
  input: T,
): T & { cols?: number; rows?: number } {
  // Read through a widened view rather than constraining T to carry the two
  // optional fields: a caller whose literal omits them gives TypeScript nothing
  // to infer T from, and it collapses to the constraint and rejects every other
  // property on the object.
  const stated = input as { cols?: number; rows?: number };
  const measured = measureSpawnTerminalSize();
  const cols = stated.cols ?? measured.cols;
  const rows = stated.rows ?? measured.rows;
  return {
    ...input,
    // Still omitted entirely when neither side has an opinion — the contract
    // bounds these at >= 1, so sending a 0 would be a validation error where
    // saying nothing is a clean fall back to the PTY host's default.
    ...(cols ? { cols } : {}),
    ...(rows ? { rows } : {}),
  };
}

/**
 * `GET /v2/spaces/:spaceId/events` response (server `DurableEventPage`,
 * events/poll.ts:51). Declared locally because the contract does not export it.
 *
 * `nextCursor` is a seq rendered DECIMAL AS A STRING, reusable verbatim as the
 * next `?since=`. The server type says `string | null`; the implementation
 * always emits a string and echoes your own `since` on an empty page, because
 * this feed has no end (poll.ts:126-135). Typed permissively; `connection.ts`
 * coerces defensively either way.
 */
export interface DurableEventPage {
  items: DurableWorkspaceEvent[];
  nextCursor: string | number | null;
}

/**
 * `execution.liveness` — catalog row A21 as of Delta 2 (commit dd41e89; signal
 * [SO->BRIDGE 32], ACKed [BRIDGE->SO 33]). The literal-path branch that carried
 * this op while the row was absent died its scheduled death per the disposition
 * written in liveness-absent.itest.ts the day the suite was born: the catalog
 * is now the only source of this path.
 */
export const LIVENESS_OP = 'execution.liveness';

export function livenessPath(spaceId: SpaceId): string {
  return bindPath(LIVENESS_OP, { spaceId });
}

/** Cursor-paged reads share one query builder; `undefined` keys are dropped by http.ts. */
function pageQuery(opts: PageOpts | undefined): QueryParams {
  return { cursor: opts?.cursor, limit: opts?.limit };
}

/** Drop `undefined` values so a strict server schema never sees a phantom key. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

export interface OpsOptions {
  /**
   * Mints the `clientMutationId` for the two commands whose seam signature has
   * no slot for one (see header note 3). Injectable so tests are deterministic.
   */
  newClientMutationId?: (prefix: string) => string;
}

let mutationSeq = 0;

/**
 * Sequence + timestamp + real entropy. The entropy is not optional: ids
 * carrying only a counter and a clock collide ACROSS PRINCIPALS (two humans'
 * first mutations in the same millisecond), and `require_replay_principal`
 * refuses the later one as a replay. Proven the hard way by the bare `au-<n>`
 * counter in `authoring/commands.ts` — see its docblock.
 */
function defaultMutationId(prefix: string): string {
  mutationSeq += 1;
  const c = globalThis.crypto;
  const entropy =
    c && typeof c.randomUUID === 'function'
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${mutationSeq.toString(36)}_${entropy}`;
}

export type Ops = ReturnType<typeof createOps>;

export function createOps(http: HttpClient, options: OpsOptions = {}) {
  const newId = options.newClientMutationId ?? defaultMutationId;

  return {
    // -- reads ---------------------------------------------------------------

    identity(): Promise<IdentityView> {
      return http.call<IdentityView>('identity.get');
    },

    /**
     * Writes the caller's OWN profile row (`identity.profile.update`). No
     * params: the route names no subject — the server derives the row from
     * the bound identity claim. The answer is the written profile, not a
     * `CommandResult`, exactly as the contract types it.
     */
    updateProfile(input: IdentityProfileUpdateInput): Promise<IdentityProfileView> {
      return http.call<IdentityProfileView>('identity.profile.update', { body: input });
    },

    /**
     * Membership writes (118). All three name their subject in the PATH, never
     * the body — `set_member_role` and `w2_revoke_invite` both authorize
     * against the (space, row) pair, and a body-carried id would authorize
     * against a space the row is not in.
     */
    setMemberRole(
      spaceId: SpaceId,
      memberId: EntityId,
      input: UpdateMemberRoleInput,
    ): Promise<CommandResult> {
      return http.call<CommandResult>('spaces.members.updateRole', {
        params: { spaceId, memberId },
        body: input,
      });
    },

    createInvite(spaceId: SpaceId, input: CreateInviteInput): Promise<SpaceInviteView> {
      return http.call<SpaceInviteView>('spaces.invites.create', { params: { spaceId }, body: input });
    },

    revokeInvite(spaceId: SpaceId, inviteId: string, body: CommandContext): Promise<SpaceInviteView> {
      return http.call<SpaceInviteView>('spaces.invites.revoke', {
        params: { spaceId, inviteId },
        body,
      });
    },

    /**
     * Task-axis writes (W2) — the same path rule as the membership writes
     * above: the subject rides the PATH, the w2_* RPCs authorize against the
     * (space, axis) pair. Create answers 201 with the row; update answers the
     * row; delete answers `{ axisId }` (the handler discards the RPC body).
     */
    createTaskAxis(spaceId: SpaceId, input: TaskAxisInput): Promise<TaskAxis> {
      return http.call<TaskAxis>('spaces.taskAxes.create', { params: { spaceId }, body: input });
    },

    updateTaskAxis(spaceId: SpaceId, axisId: string, input: TaskAxisInput): Promise<TaskAxis> {
      return http.call<TaskAxis>('spaces.taskAxes.update', {
        params: { spaceId, axisId },
        body: input,
      });
    },

    deleteTaskAxis(spaceId: SpaceId, axisId: string, body: CommandContext): Promise<{ axisId: string }> {
      return http.call<{ axisId: string }>('spaces.taskAxes.delete', {
        params: { spaceId, axisId },
        body,
      });
    },

    /**
     * Task-workflow writes (W4, 132) — same path rule as the axis writes
     * above. Upsert answers the row (the natural key is (space, typeValue));
     * delete answers `{ workflowId }` (the handler discards the RPC body).
     */
    upsertTaskWorkflow(spaceId: SpaceId, input: TaskWorkflowInput): Promise<TaskWorkflow> {
      return http.call<TaskWorkflow>('spaces.taskWorkflows.upsert', {
        params: { spaceId },
        body: input,
      });
    },

    deleteTaskWorkflow(spaceId: SpaceId, workflowId: string, body: CommandContext): Promise<{ workflowId: string }> {
      return http.call<{ workflowId: string }>('spaces.taskWorkflows.delete', {
        params: { spaceId, workflowId },
        body,
      });
    },

    /** Joins as the CURRENT viewer; the space is whatever the code resolves to. */
    redeemInvite(input: RedeemInviteInput): Promise<InviteRedemption> {
      return http.call<InviteRedemption>('spaces.invites.redeem', { body: input });
    },

    /**
     * `auth.invite.resolve` — the read that answers before the caller is anybody
     * here. A join page has no identity to bind, and every other read on this
     * client would correctly answer with nothing.
     *
     * POST with the code in the BODY, and it must stay that way: a join code is
     * a bearer capability, and a URL carrying one is copied into access logs,
     * browser history and `Referer` on the first outbound link the page renders.
     */
    previewInvite(code: string): Promise<InvitePreview> {
      return http.call<InvitePreview>('auth.invite.resolve', { body: { code } });
    },

    /**
     * `credentials.status` — the viewer's own agent credentials.
     *
     * No params: like `identity.get`, the route names no subject and the
     * server derives the account from the bound identity claim. It is a READ
     * that is nonetheless HUMAN-ONLY (R2) — the server refuses any caller
     * whose `authKind` is not `browser`/`cli`, so an agent asking this gets a
     * refusal, which is the intended answer and not something to work around.
     */
    credentialsStatus(): Promise<CredentialsStatusView> {
      return http.call<CredentialsStatusView>('credentials.status');
    },

    /**
     * `credentials.delete` — Disconnect. The provider is the RESOURCE and
     * travels in the path; the body carries only the mutation id, because the
     * subject is always the caller's own account.
     */
    credentialsDisconnect(provider: CredentialProviderName): Promise<CredentialsDeleteResult> {
      return http.call<CredentialsDeleteResult>('credentials.delete', {
        params: { provider },
        body: { clientMutationId: newId('creddisc') },
      });
    },

    /**
     * `credentials.loginSessions.start` — opens the login terminal.
     *
     * Geometry IS sent, and the note that used to sit here saying it was
     * deliberately withheld was wrong on its own terms. It argued that "the
     * terminal we host fits itself on mount, so sending a guess here would just
     * be a second, wrong answer to a question the PTY resize already settles" —
     * but the PTY resize does NOT settle it. A full-screen TUI lays out its
     * frame for the width it is handed at startup, and the socket suppresses
     * the corrective resize whenever the fitted size already matches. And the
     * program on the other end is not a bare device-code prompt:
     * CREDENTIAL_LOGIN_COMMANDS.anthropic is `claude auth login`, a full-screen
     * Ink TUI — the exact case that breaks. `cols`/`rows` are the only client
     * input this op accepts, and they cannot influence which program runs.
     */
    credentialsStartLogin(
      spaceId: SpaceId,
      provider: CredentialProviderName,
    ): Promise<CredentialsLoginSessionStartResult> {
      return http.call<CredentialsLoginSessionStartResult>('credentials.loginSessions.start', {
        body: withMeasuredGeometry({
          spaceId,
          provider,
          clientMutationId: newId('credlogin'),
        }),
      });
    },

    /** `credentials.loginSessions.finish` — the session id is the path resource. */
    credentialsFinishLogin(workSessionId: EntityId): Promise<CredentialsLoginSessionFinishResult> {
      return http.call<CredentialsLoginSessionFinishResult>('credentials.loginSessions.finish', {
        params: { id: workSessionId },
        body: { clientMutationId: newId('credfin') },
      });
    },

    /** Bare array, not a Page — `spaces.list` accepts no pagination at all. */
    spaces(): Promise<SpaceSummary[]> {
      return http.call<SpaceSummary[]>('spaces.list');
    },

    menu(spaceId: SpaceId): Promise<MenuConfig> {
      return http.call<MenuConfig>('spaces.menu.get', { params: { spaceId } });
    },

    spaceSettings(spaceId: SpaceId): Promise<SpaceSettingsView> {
      return http.call<SpaceSettingsView>('spaces.settings', { params: { spaceId } });
    },

    /** The category-model workflows (149): the global default + this space's. */
    workflows(spaceId: SpaceId): Promise<Workflow[]> {
      return http.call<Workflow[]>('spaces.workflows.list', { params: { spaceId } });
    },

    /**
     * Per-kind rail counters. Kinds with no rows are ABSENT from the payload
     * rather than present with zeroes, so callers read a missing key as "none".
     */
    counts(spaceId: SpaceId): Promise<SpaceKindCounts> {
      return http.call<SpaceKindCounts>('spaces.counts', { params: { spaceId } });
    },

    /** `cursor`/`limit` are BODY fields on this op, carried inside the query object. */
    query(input: CollectionQuery): Promise<CollectionResult> {
      return http.call<CollectionResult>('collections.query', { body: input });
    },

    graph(input: GraphQuery): Promise<GraphResult> {
      return http.call<GraphResult>('graph.query', { body: input });
    },

    /** Bare array (core kinds first, then custom `c:*`). */
    entityKinds(spaceId: SpaceId): Promise<EntityKindDef[]> {
      return http.call<EntityKindDef[]>('entityKinds.list', { params: { spaceId } });
    },

    /** Space-scoped with `spaceId`; the whole node's projects without. */
    projects(spaceId?: SpaceId): Promise<ProjectResource[]> {
      return http.call<ProjectResource[]>('projects.list', { query: { spaceId } });
    },

    projectDirectories(path?: string): Promise<ProjectDirectoryListing> {
      return http.call<ProjectDirectoryListing>('projects.directories.list', { query: { path } });
    },

    projectFiles(projectId: ProjectId, path?: string): Promise<ProjectFileListing> {
      return http.call<ProjectFileListing>('projects.files.list', { params: { projectId }, query: { path } });
    },

    /**
     * One file's CONTENT out of a connected project folder — the viewer half of
     * `projectFiles`. Answers a DTO, deliberately NOT an href like
     * `fileDownloadHref`: a project's disk must never reach the browser as a
     * document on the app origin. A withheld file arrives as a NAMED `refusal`
     * inside a 200, so a caller can tell it from a transport failure.
     */
    readProjectFile(projectId: ProjectId, path: string): Promise<ProjectFileReadResult> {
      return http.call<ProjectFileReadResult>('projects.files.read', {
        params: { projectId }, query: { path },
      });
    },

    /**
     * The URL of `projects.files.archive` — a whole subtree as one zip.
     *
     * An HREF, unlike `readProjectFile` right above it, and for the reason
     * §4.4 gives: a single project file must not become a document on the app
     * origin, so it travels as a DTO. An archive cannot be a document —
     * `application/zip`, `attachment`, `nosniff` — so the browser's own
     * download path is both safe and the only sane transport for a tree that
     * may be hundreds of megabytes. Built from the CATALOG binding for the
     * same reason `fileDownloadHref` is: if the route moves, this moves with
     * it rather than silently 404ing.
     */
    projectArchiveHref(projectId: ProjectId, path?: string): string {
      const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`;
      return `${http.baseUrl}${bindPath('projects.files.archive', { projectId })}${query}`;
    },

    attachProjectFile(projectId: ProjectId, input: ProjectFileAttachInput): Promise<CommandResult> {
      return http.call<CommandResult>('projects.files.attach', { params: { projectId }, body: input });
    },

    /** Folder import lifecycle (seam Amendment 8, owner ruling R7). */
    folderUploadInit(spaceId: SpaceId, input: ProjectFolderUploadInitInput): Promise<ProjectFolderUploadGrant> {
      return http.call<ProjectFolderUploadGrant>('projects.folderUploads.init', { params: { spaceId }, body: input });
    },

    folderUploadComplete(
      folderUploadId: string,
      input: ProjectFolderUploadCompleteInput,
    ): Promise<ProjectFolderUploadResult> {
      return http.call<ProjectFolderUploadResult>('projects.folderUploads.complete', {
        params: { folderUploadId },
        body: input,
      });
    },

    async folderUploadAbort(folderUploadId: string, input: ProjectFolderUploadAbortInput): Promise<void> {
      await http.call('projects.folderUploads.abort', { params: { folderUploadId }, body: input });
    },

    /** Branch topology for a project's working directory — seam Amendment 5. */
    projectBranches(projectId: string, opts?: BranchTopologyOpts): Promise<ProjectBranchTopology> {
      return http.call<ProjectBranchTopology>('projects.branches.list', {
        params: { projectId },
        query: { staleAfterDays: opts?.staleAfterDays, limit: opts?.limit },
      });
    },

    createSpace(input: CreateSpaceInput): Promise<CreateSpaceResult> {
      return http.call<CreateSpaceResult>('spaces.create', { body: input });
    },

    createProject(input: ProjectCreateInput): Promise<ProjectResource> {
      return http.call<ProjectResource>('projects.create', { body: input });
    },

    async linkProject(spaceId: SpaceId, input: ProjectLinkInput): Promise<void> {
      await http.call('projects.link', { params: { spaceId }, body: input });
    },

    entity(id: EntityId): Promise<EntityDetail> {
      return http.call<EntityDetail>('entities.get', { params: { id } });
    },

    children(id: EntityId, opts?: PageOpts): Promise<Page<EntitySummary>> {
      return http.call<Page<EntitySummary>>('entities.children', { params: { id }, query: pageQuery(opts) });
    },

    /**
     * `types` travels as the PLURAL `?types=a,b` param: the server reads
     * `type` via `getAll` (repeated keys) and `types` by splitting on commas
     * (`entities-commands-tracking.ts:448`), and `QueryParams` is one value
     * per key — so the comma form is the one this builder can express.
     * Omitted keys are dropped by `http.ts`, leaving the unfiltered call
     * byte-identical to what it sent before.
     */
    connections(id: EntityId, opts?: ConnectionOpts): Promise<Page<EdgeView>> {
      return http.call<Page<EdgeView>>('entities.connections', {
        params: { id },
        query: {
          ...pageQuery(opts),
          types: opts?.types && opts.types.length > 0 ? opts.types.join(',') : undefined,
          direction: opts?.direction,
        },
      });
    },

    activity(id: EntityId, opts?: PageOpts): Promise<Page<ActivityItem>> {
      return http.call<Page<ActivityItem>>('entities.activity', { params: { id }, query: pageQuery(opts) });
    },

    messages(anchorId: EntityId, opts?: MessageListOpts): Promise<Page<MessageView>> {
      return http.call<Page<MessageView>>('messages.list', {
        params: { anchorId },
        query: { ...pageQuery(opts), rootMessageId: opts?.rootMessageId },
      });
    },

    /** Amendment 10: `spaces.home` — carries the chat-home `chatThreads` list. */
    home(spaceId: SpaceId | string): Promise<HomeSnapshot> {
      return http.call<HomeSnapshot>('spaces.home', { params: { spaceId } });
    },

    handoffs(workSessionId: EntityId, opts?: PageOpts): Promise<Page<HandoffView>> {
      return http.call<Page<HandoffView>>('handoffs.list', { params: { workSessionId }, query: pageQuery(opts) });
    },
    journal(workSessionId: EntityId, opts?: JournalOpts): Promise<SessionJournalPage> {
      // `http.call` binds the path from the catalog row (`execution.journal`);
      // no URL literal. `undefined` query keys are dropped by http.ts, so a
      // paging-less first read sends neither `limit` nor `before`.
      return http.call<SessionJournalPage>('execution.journal', {
        params: { workSessionId },
        query: { limit: opts?.limit, before: opts?.before },
      });
    },
    launch(workSessionId: EntityId): Promise<SessionLaunchRecord> {
      // No query at all: the launch record is a whole document, not a window.
      return http.call<SessionLaunchRecord>('execution.launch', { params: { workSessionId } });
    },
    transcript(workSessionId: EntityId, opts?: TranscriptOpts): Promise<SessionTranscriptPage> {
      // Optional keys only; http.ts drops `undefined`, so the default read
      // sends a bare path and lets the server own the window size. `before` is
      // the page-back cursor — a byte offset taken from a previous page's
      // `windowStart`, sent only when that page said `hasOlder`.
      return http.call<SessionTranscriptPage>('execution.transcript', {
        params: { workSessionId },
        query: { last: opts?.last, before: opts?.before, files: opts?.files ? '1' : undefined },
      });
    },
    projectContention(projectId: string): Promise<ContentionReport> {
      return http.call<ContentionReport>('projects.contention', { params: { projectId } });
    },
    /** Tier 1 file reads — seam Amendment 8. */
    projectFileHistory(projectId: string, path: string, opts?: FileHistoryOpts): Promise<ProjectFileHistory> {
      return http.call<ProjectFileHistory>('projects.file.history', {
        params: { projectId },
        query: { path, maxRevisions: opts?.maxRevisions, diffOid: opts?.diffOid },
      });
    },
    projectFileBlame(projectId: string, path: string, opts?: FileBlameOpts): Promise<ProjectFileBlame> {
      return http.call<ProjectFileBlame>('projects.file.blame', {
        params: { projectId },
        query: { path, maxLines: opts?.maxLines },
      });
    },
    gitStatus(workSessionId: EntityId): Promise<SessionGitStatus> {
      return http.call<SessionGitStatus>('execution.gitStatus', { params: { workSessionId } });
    },
    gitDiff(workSessionId: EntityId, opts?: GitDiffOpts): Promise<SessionGitDiff> {
      return http.call<SessionGitDiff>('execution.gitDiff', {
        params: { workSessionId },
        query: { maxBytes: opts?.maxBytes },
      });
    },
    gitCheckpoint(workSessionId: EntityId, input: ExecutionGitCheckpointInput): Promise<SessionGitCheckpointResult> {
      return http.call<SessionGitCheckpointResult>('execution.gitCheckpoint', {
        params: { workSessionId },
        body: input,
      });
    },
    gitRollback(workSessionId: EntityId, input: ExecutionGitRollbackInput): Promise<SessionGitRollbackResult> {
      return http.call<SessionGitRollbackResult>('execution.gitRollback', {
        params: { workSessionId },
        body: input,
      });
    },
    gitCommit(workSessionId: EntityId, input: ExecutionGitCommitInput): Promise<SessionGitCommitResult> {
      return http.call<SessionGitCommitResult>('execution.gitCommit', {
        params: { workSessionId },
        body: input,
      });
    },
    gitMerge(workSessionId: EntityId, input: ExecutionGitMergeInput): Promise<SessionGitMergeResult> {
      return http.call<SessionGitMergeResult>('execution.gitMerge', {
        params: { workSessionId },
        body: input,
      });
    },
    gitCherryPick(workSessionId: EntityId, input: ExecutionGitCherryPickInput): Promise<SessionGitCherryPickResult> {
      return http.call<SessionGitCherryPickResult>('execution.gitCherryPick', {
        params: { workSessionId },
        body: input,
      });
    },
    gitBranch(workSessionId: EntityId, input: ExecutionGitBranchInput): Promise<SessionGitBranchResult> {
      return http.call<SessionGitBranchResult>('execution.gitBranch', {
        params: { workSessionId },
        body: input,
      });
    },
    gitStash(workSessionId: EntityId, input: ExecutionGitStashInput): Promise<SessionGitStashResult> {
      return http.call<SessionGitStashResult>('execution.gitStash', {
        params: { workSessionId },
        body: input,
      });
    },

    /**
     * The forge write door. `POST /v2/tracking/pr/:id/merge` — note the param is
     * `id`, the PULL REQUEST entity, not a work session: this verb never touches
     * a checkout. Every refusal arrives as a normal error code with
     * `details.reason`; `toCollabError` already carries both to the caller, so
     * nothing is interpreted here.
     */
    mergePullRequest(id: EntityId, input: TrackingPrMergeInput): Promise<TrackingPrMergeResult> {
      return http.call<TrackingPrMergeResult>('tracking.pr.merge', {
        params: { id },
        body: input,
      });
    },

    inbox(opts?: PageOpts): Promise<Page<NotificationItem>> {
      return http.call<Page<NotificationItem>>('inbox.list', { query: pageQuery(opts) });
    },

    /** Every field rides the query string; `compact` keeps optional filters off
     *  the wire so the server's strict schema never sees a phantom key. */
    attentionRequests(input: AttentionRequestListQuery): Promise<AttentionRequestPage> {
      return http.call<AttentionRequestPage>('attentionRequests.list', {
        query: compact({
          spaceId: input.spaceId,
          entityId: input.entityId,
          status: input.status,
          minPoints: input.minPoints,
          limit: input.limit,
          cursor: input.cursor,
        }) as QueryParams,
      });
    },

    feed(id: EntityId, opts?: FeedOpts): Promise<EntityFeedPage> {
      return http.call<EntityFeedPage>('entities.feed', {
        params: { id },
        query: {
          ...pageQuery(opts),
          scope: opts?.scope,
          order: opts?.order,
          around: opts?.around,
        },
      });
    },

    /**
     * Accepts `cursor`/`limit` server-side but returns NO `nextCursor`
     * (messages-handoffs.ts:453) — so this read is not pageable and the seam
     * does not pretend it is. Flagged, not worked around.
     */
    delivery(messageId: EntityId): Promise<MessageDeliveryView> {
      return http.call<MessageDeliveryView>('messages.delivery.get', { params: { messageId } });
    },

    /**
     * `since` is a SEQ AS A DECIMAL INTEGER, not a keyset cursor and not a
     * timestamp — a non-numeric value is a hard 400 `invalid_cursor`
     * (events/handlers.ts:53-66).
     */
    pollEvents(spaceId: SpaceId, since: number, limit?: number): Promise<DurableEventPage> {
      return http.call<DurableEventPage>('events.poll', {
        params: { spaceId },
        query: { since, limit },
      });
    },

    /** Delta 2 (LLD C-1 / §9). Uncataloged today — see `livenessPath`. */
    async liveness(spaceId: SpaceId): Promise<LivenessSnapshot> {
      const raw = await http.callPath<Omit<LivenessSnapshot, 'spaceId'> & { spaceId?: SpaceId }>(
        'GET',
        livenessPath(spaceId),
      );
      // The read is per-space and the response shape C-1 fixed does not echo
      // the id, so it is stamped from the request rather than trusted absent.
      //
      // `eventHwm` is normalized HERE, at the wire boundary, because it is the
      // one field whose absence has a wrong-but-plausible reading: an older
      // node omits it, and a consumer that let `undefined` become 0 would seed
      // the event cursor at the start of the retained log. Anything that is
      // not a non-negative safe integer becomes null — "cannot establish".
      const hwm = raw.eventHwm;
      const eventHwm = typeof hwm === 'number' && Number.isSafeInteger(hwm) && hwm >= 0 ? hwm : null;
      return { ...raw, spaceId, eventHwm };
    },

    // -- commands ------------------------------------------------------------

    createEntity(input: CreateEntityInput): Promise<CommandResult> {
      return http.call<CommandResult>('entities.create', { body: input });
    },

    /** Note 1: no task route exists; kind-specific fields travel in `content`. */
    createTask(input: CreateTaskInput): Promise<CommandResult> {
      const body: CreateEntityInput = {
        ...compact({ actorId: input.actorId, parentId: input.parentId, position: input.position, attachTo: input.attachTo }),
        clientMutationId: input.clientMutationId ?? newId('task'),
        spaceId: input.spaceId,
        kind: 'task',
        title: input.title,
        content: compact({
          description: input.description,
          axes: input.axes,
          priority: input.priority,
          acceptanceCriteria: input.acceptanceCriteria,
          pointsEstimate: input.pointsEstimate,
          startDate: input.startDate,
          dueDate: input.dueDate,
        }),
      } as CreateEntityInput;
      return http.call<CommandResult>('entities.create', { body });
    },

    patchEntity(id: EntityId, input: PatchEntityInput): Promise<CommandResult> {
      return http.call<CommandResult>('entities.patch', { params: { id }, body: input });
    },

    resolveAttention(
      id: EntityId,
      input: ResolveEntityAttentionInput,
    ): Promise<AttentionRequestMutationResult> {
      return http.call<AttentionRequestMutationResult>('attentionRequests.resolveEntity', {
        params: { entityId: id }, body: input,
      });
    },

    /** PATCH /v2/attention-requests/:requestId — the request id is NOT an
     *  entity id, so it rides `params.requestId` exactly as the catalog row
     *  spells it (catalog.ts `attentionRequests.update`). */
    updateAttentionRequest(
      requestId: string,
      input: UpdateAttentionRequestInput,
    ): Promise<AttentionRequestMutationResult> {
      return http.call<AttentionRequestMutationResult>('attentionRequests.update', {
        params: { requestId }, body: input,
      });
    },

    /** Note 1 again: `update_task_content` reads every task field off `content`. */
    patchTask(id: EntityId, input: PatchTaskInput): Promise<CommandResult> {
      const body: PatchEntityInput = {
        ...compact({ actorId: input.actorId, clientMutationId: input.clientMutationId, title: input.title }),
        expectedVersion: input.expectedVersion,
        content: compact({
          description: input.description,
          axes: input.axes,
          status: input.status,
          priority: input.priority,
          acceptanceCriteria: input.acceptanceCriteria,
          pointsEstimate: input.pointsEstimate,
          startDate: input.startDate,
          dueDate: input.dueDate,
        }),
      } as PatchEntityInput;
      return http.call<CommandResult>('entities.patch', { params: { id }, body });
    },

    moveEntity(id: EntityId, input: MoveEntityInput): Promise<CommandResult> {
      return http.call<CommandResult>('entities.move', { params: { id }, body: input });
    },

    /**
     * DELETE carries a body here, deliberately: the server binds
     * `RequiredCommandContextSchema` and refuses without `clientMutationId`
     * (input-schemas.ts:68). The seam types `ctx` optional, so an omitted
     * context reaches the server as `{}` and earns an honest `invalid_input`
     * rather than being papered over with a synthesized id — an id the caller
     * never saw could not reconcile the caller's journal entry.
     */
    deleteEntity(id: EntityId, ctx?: CommandContext): Promise<CommandResult> {
      return http.call<CommandResult>('entities.delete', { params: { id }, body: ctx ?? {} });
    },

    restoreEntity(id: EntityId, ctx?: CommandContext): Promise<CommandResult> {
      return http.call<CommandResult>('entities.restore', { params: { id }, body: ctx ?? {} });
    },

    complete(id: EntityId, input: CompleteTaskInput): Promise<CommandResult> {
      return http.call<CommandResult>('entities.commands.complete', { params: { id }, body: input });
    },

    work(id: EntityId, input: WorkInput): Promise<CommandResult> {
      return http.call<CommandResult>('entities.commands.work', { params: { id }, body: input });
    },

    createEdge(input: CreateEdgeInput): Promise<CommandResult> {
      return http.call<CommandResult>('edges.create', { body: input });
    },

    /**
     * Same DELETE-carries-a-body rule as `deleteEntity`: the server binds
     * `RequiredCommandContextSchema` to `edges.delete` (input-schemas.ts:165)
     * and refuses without a `clientMutationId`. An omitted context reaches the
     * node as `{}` and earns an honest `invalid_input` rather than a
     * synthesized id the caller could never reconcile.
     */
    deleteEdge(edgeId: string, ctx?: CommandContext): Promise<CommandResult> {
      return http.call<CommandResult>('edges.delete', { params: { edgeId }, body: ctx ?? {} });
    },

    addToCollection(collectionId: EntityId, input: CollectionAddItemInput): Promise<CommandResult> {
      return http.call<CommandResult>('collections.addItem', {
        params: { id: collectionId },
        body: input,
      });
    },

    /**
     * Same DELETE-carries-a-body rule as `deleteEdge`: the server binds
     * `RequiredCommandContextSchema` to `collections.removeItem` and refuses
     * without a `clientMutationId`.
     */
    removeFromCollection(
      collectionId: EntityId,
      entityId: EntityId,
      ctx?: CommandContext,
    ): Promise<CommandResult> {
      return http.call<CommandResult>('collections.removeItem', {
        params: { id: collectionId, entityId },
        body: ctx ?? {},
      });
    },

    fileUploadInit(input: FileUploadInitInput): Promise<FileUploadGrant> {
      return http.call<FileUploadGrant>('files.uploadInit', { body: input });
    },

    fileUploadBytes(grant: FileUploadGrant, bytes: BodyInit): Promise<void> {
      return http.putGrantedBytes(grant.uploadUrl, grant.token, bytes);
    },

    fileUploadComplete(uploadId: string, input: FileUploadCompleteInput): Promise<CommandResult> {
      return http.call<CommandResult>('files.uploadComplete', { params: { uploadId }, body: input });
    },

    fileUploadAbort(uploadId: string, input: FileUploadAbortInput): Promise<CommandResult> {
      return http.call<CommandResult>('files.uploadAbort', { params: { uploadId }, body: input });
    },

    /**
     * The download URL, built from the CATALOG binding rather than a typed
     * path — so if `files.download` ever moves, this moves with it and cannot
     * silently 404. No request is made here: the browser makes it, as an
     * `<img src>` or an `<a href>`, which is the only way to reach a route
     * that answers bytes instead of the JSON envelope.
     */
    fileDownloadHref(fileEntityId: EntityId): string {
      return `${http.baseUrl}${bindPath('files.download', { fileEntityId })}`;
    },

    /** Answers `MessageBatchResult` — the seam's union member, passed through. */
    postMessage(input: PostMessageInput): Promise<MessageBatchResult> {
      return http.call<MessageBatchResult>('messages.post', { body: input });
    },

    /** Amendment 10: `chat.threads.start` — the chat-home bridge's write half. */
    startChatThread(input: StartChatThreadInput): Promise<StartChatThreadResult> {
      return http.call<StartChatThreadResult>('chat.threads.start', { body: input });
    },

    /** Note 2: bare `MessageView` lifted into the seam's `CommandResult`. */
    async editMessage(id: EntityId, input: PatchMessageInput): Promise<CommandResult> {
      const view = await http.call<MessageView>('messages.edit', { params: { id }, body: input });
      return { patches: [view] };
    },

    react(id: EntityId, input: ReactionInput): Promise<CommandResult> {
      return http.call<CommandResult>('entities.react', { params: { id }, body: input });
    },

    /** Note 3: server requires a mutation id the seam has no slot for. */
    async markRead(notificationId: string): Promise<void> {
      await http.call<NotificationItem>('inbox.markRead', {
        params: { notificationId },
        body: { clientMutationId: newId('read') },
      });
    },

    /** Note 3: `lastReadAt` is the SERVER's stamp; sending it is a 400. */
    async upsertReadMark(anchorId: EntityId): Promise<void> {
      await http.call<unknown>('readMarks.upsert', {
        params: { anchorId },
        body: { clientMutationId: newId('mark') },
      });
    },

    previewArtifact(id: EntityId, input: ArtifactsPreviewStartInput): Promise<ArtifactPreviewSession> {
      return http.call<ArtifactPreviewSession>('artifacts.preview.start', {
        params: { artifactId: id },
        body: input,
      });
    },

    listArtifactRevisions(id: EntityId): Promise<ArtifactRevisionsList> {
      return http.call<ArtifactRevisionsList>('artifacts.revisions.list', {
        params: { artifactId: id },
      });
    },

    /** RAW ZIP BYTES — `callBytes`, never `call`: there is no envelope to unwrap. */
    exportArtifactRevision(id: EntityId, revisionNumber: number): Promise<Blob> {
      return http.callBytes('artifacts.export', {
        params: { artifactId: id, revisionNumber: String(revisionNumber) },
      });
    },

    /**
     * Attach the browser's measured terminal geometry so the server-hosted PTY
     * BOOTS at the real pane width instead of 80x24.
     *
     * A full-screen agent TUI lays out its entire frame for the width it is
     * handed at STARTUP, and a later resize only repairs that if the agent
     * actually repaints — which the PTY socket's echo-loop guard prevents
     * whenever the fitted size already matches what the PTY has, leaving an
     * 80-column frame frozen on screen until a human resizes the window.
     * Measuring here makes that unreachable. Every op on this seam that boots a
     * PTY now does the same thing; there is no principled exception.
     *
     * This lives at the ops choke point every spawn passes through rather than
     * in `buildSpawnInput`, because the domain builder is pure and must stay
     * callable without a DOM. A caller that already knows its geometry wins —
     * see `withMeasuredGeometry`, which resolves that per FIELD rather than by
     * spread order.
     */
    spawn(input: ExecutionSpawnInput): Promise<CommandResult> {
      return http.call<CommandResult>('execution.spawn', {
        body: withMeasuredGeometry(input),
      });
    },

    /**
     * A vanilla terminal (101). Its own op, not `spawn` with nulls.
     *
     * Geometry matters here for the same reason it does on `spawn`: its input
     * has accepted `cols`/`rows` all along and no caller ever sent them, so a
     * plain terminal booted 80x24 — and a plain terminal is exactly where
     * someone types `claude` or `htop` by hand and gets a full-screen TUI laid
     * out for the wrong width.
     */
    startTerminal(input: ExecutionTerminalStartInput): Promise<CommandResult> {
      return http.call<CommandResult>('execution.terminal.start', {
        body: withMeasuredGeometry(input),
      });
    },

    /**
     * Note the RESULT TYPE: `ExecutionDispatchResult`, not `CommandResult`.
     * Dispatch does not create the session it is asking for — it derives the
     * task, finds or spawns the dispatcher, and delivers a request — so there
     * are no patches to reconcile and nothing for a store to journal
     * optimistically. Typing it as a command result would invite exactly that.
     */
    dispatch(input: ExecutionDispatchInput): Promise<ExecutionDispatchResult> {
      return http.call<ExecutionDispatchResult>('execution.dispatch', { body: input });
    },

    /**
     * A permanent 403 on this node by design (`use_message_send`,
     * execution-handlers.ts). The refusal passes through as a `CollabError` —
     * the UI renders disabled-with-reason and nothing here pretends otherwise.
     */
    prompt(id: EntityId, input: ExecutionPromptInput): Promise<CommandResult> {
      return http.call<CommandResult>('execution.prompt', { params: { id }, body: input });
    },

    terminate(id: EntityId, input: ExecutionTerminateInput): Promise<CommandResult> {
      return http.call<CommandResult>('execution.terminate', { params: { id }, body: input });
    },

    /** A resume re-spawns the PTY, so it carries the same geometry as `spawn`. */
    resume(id: EntityId, input: ExecutionResumeInput): Promise<CommandResult> {
      return http.call<CommandResult>('execution.resume', {
        params: { id },
        body: withMeasuredGeometry(input),
      });
    },

    // -- containers (migration 177) ----------------------------------------
    //
    // NO ADAPTATION HAPPENS HERE, and that is worth stating in a file whose
    // header lists the four places the seam and the server disagree. The
    // container routes take the contract DTOs unchanged and answer the
    // contract results unchanged, so these are the plainest possible wrappers.
    // If one of them ever grows a body transform, it belongs in that header's
    // list.

    createContainer(input: ContainersCreateInput): Promise<CommandResult> {
      return http.call<CommandResult>('containers.create', { body: input });
    },

    /*
     * The four lifecycle verbs share one DTO and one route shape, so the verb
     * selects the operation name and nothing else varies. Written as a lookup
     * off a frozen map rather than string concatenation: `containers.${verb}`
     * would happily build an operation name that does not exist if the union
     * ever widened, and the failure would be a 404 at runtime instead of a
     * type error here.
     */
    containerLifecycle(
      id: EntityId,
      verb: 'start' | 'stop' | 'pause' | 'resume',
      input: ContainersLifecycleInput,
    ): Promise<CommandResult> {
      /* `as const` so the lookup yields the catalog's own literal union and
         not `string` — `http.call` takes an `OperationName`, which is what
         turns a mistyped operation into a compile error instead of a 404. */
      const op = ({
        start: 'containers.start',
        stop: 'containers.stop',
        pause: 'containers.pause',
        resume: 'containers.resume',
      } as const)[verb];
      return http.call<CommandResult>(op, { params: { containerId: id }, body: input });
    },

    destroyContainer(id: EntityId, input: ContainersDestroyInput): Promise<CommandResult> {
      return http.call<CommandResult>('containers.destroy', {
        params: { containerId: id },
        body: input,
      });
    },

    /*
     * `withMeasuredGeometry` — the SAME treatment `spawn` and `startTerminal`
     * get, and for the identical reason recorded there: the input has accepted
     * `cols`/`rows` all along and a caller that sends none boots 80x24, which
     * is exactly where someone runs a full-screen TUI laid out for the wrong
     * width. A container's exec PTY is a PTY.
     */
    startContainerTerminal(
      id: EntityId,
      input: ContainersTerminalStartInput,
    ): Promise<ContainersTerminalStartResult> {
      return http.call<ContainersTerminalStartResult>('containers.terminal.start', {
        params: { containerId: id },
        body: withMeasuredGeometry(input),
      });
    },

    containerProviders(): Promise<ContainersProvidersListResult> {
      return http.call<ContainersProvidersListResult>('containers.providers.list', {});
    },
  };
}
