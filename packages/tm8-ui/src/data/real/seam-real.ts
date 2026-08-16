/**
 * `createRealSeam()` — the HTTP + WS implementation of the co-owned Facade seam
 * (LLD §5–§6, §9). Drop-in interchangeable with `createFixtureSeam()`: both are
 * type-indistinguishable because both return contract DTOs verbatim (C-3).
 *
 * NOT EXPORTED FROM `../index.ts`, on purpose. This lane is PREPARE, NOT WIRE
 * (master ruling): the module compiles, is tested against mock transports, and
 * waits for the integration task. Nothing imports it yet.
 *
 * ZERO NETWORK BY CONSTRUCTION. `fetch` and the WebSocket factory are REQUIRED
 * options with no defaults — this file cannot reach a socket unless a caller
 * hands it one, so "the tests do not touch the node" is a property of the type
 * signature rather than a promise in a comment. The integration caller passes
 * `globalThis.fetch` and `browserWebSocketFactory(WebSocket)` explicitly, at
 * one visible call site.
 *
 * Assembly:
 *
 *     http.ts ──> ops.ts ──┬──> connection.ts  (events.poll fallback)
 *                          └──> liveness.ts    (execution.liveness cadence)
 *     socket.ts ─────────────> connection.ts   (the WS transport)
 *
 * and three wires between them, each of which exists because one module holds
 * knowledge another one needs:
 *
 *   1. http `onTransport` → connection `noteTransport` — the ONLY input that
 *      distinguishes `polling` from `offline` (LLD §6).
 *   2. connection `onEvent` → liveness `noteEvent` — a `work_session` upsert is
 *      a liveness cadence trigger (LLD §9).
 *   3. connection `onReconnect` → liveness `noteReconnect` — same.
 */
import {
  type CreateInviteInput,
  type InvitePreview,
  type InviteRedemption,
  type RedeemInviteInput,
  type SpaceInviteView,
  type UpdateMemberRoleInput,
  CollabError,
  bindPath,
  type ActivityItem,
  type AttentionRequestListQuery,
  type AttentionRequestPage,
  type CollectionQuery,
  type CollectionResult,
  type CommandResult,
  type EdgeView,
  type EntityDetail,
  type EntityFeedPage,
  type EntityId,
  type EntityKindDef,
  type EntitySummary,
  type GraphQuery,
  type GraphResult,
  type HandoffView,
  type MenuConfig,
  type MessageDeliveryView,
  type MessageView,
  type NotificationItem,
  type Page,
  type ProjectBranchTopology,
  type ProjectResource,
  type ContentionReport,
  type ProjectFileBlame,
  type ProjectFileHistory,
  type SessionGitDiff,
  type SessionGitStatus,
  type SessionJournalPage,
  type SessionLaunchRecord,
  type SessionTranscriptPage,
  type SpaceId,
  type SpaceKindCounts,
  type SpaceSettingsView,
  type SpaceSummary,
} from '@tm8/contract';
import type { BranchTopologyOpts, ConnectionOpts, FeedOpts, FileBlameOpts, FileHistoryOpts, GitDiffOpts, IdentityView, JournalOpts, PageOpts, Seam, TranscriptOpts, Unsubscribe } from '../seam';
import { createHttpClient, type FetchLike } from './http';
import { chatTurnFrameFromWire, type WireChatTurnFrame } from '../../chat-home/wire';
import { createOps } from './ops';
import {
  createConnectionManager,
  type ConnectionConfig,
  type ConnectionManager,
  type Timers,
} from './connection';
import { createLivenessManager, type LivenessConfig } from './liveness';
import type { WebSocketFactory } from './socket';

export interface RealSeamOptions {
  /** Relative ('') by default — the vite dev server proxies /v2 to the node. */
  baseUrl?: string;
  /** REQUIRED. See the header: no default, so nothing here can reach the network alone. */
  fetch: FetchLike;
  /** REQUIRED, same reason. `browserWebSocketFactory(WebSocket)` in the browser. */
  webSocketFactory: WebSocketFactory;
  /**
   * Absolute `ws://`/`wss://` URL for `events.subscribe`. Derived from
   * `baseUrl`/`origin` when omitted — and it THROWS rather than guessing when
   * neither is absolute, because a silently-wrong socket URL fails as a
   * permanently-reconnecting `polling` state that looks like a flaky network.
   */
  wsUrl?: string;
  /** Page origin, used only to derive `wsUrl` when `baseUrl` is relative. */
  origin?: string;
  /**
   * The viewer's `tm8s_…` pass for THIS server, read per request. Absent ⇒ no
   * Authorization header; a loopback node may then resolve the auto-owner
   * (T-L7). Browser WebSockets authenticate independently with the Secure,
   * HttpOnly cookie and never receive this pass in their URL. Supplied by the
   * host from the per-server pass store for authenticated HTTP requests.
   */
  getAuthToken?: () => string | null;
  timers?: Timers;
  now?: () => number;
  random?: () => number;
  connection?: Partial<ConnectionConfig>;
  liveness?: Partial<LivenessConfig>;
  newClientMutationId?: (prefix: string) => string;
  /** Non-fatal transport noise (malformed frames, failed polls, liveness reads). */
  onError?: (error: unknown, context: string) => void;
}

/**
 * Controls that exist only on the REAL implementation, mirroring the precedent
 * `FixtureSeam.fixtureControls` set. None of them widens the seam.
 */
export interface RealControls {
  /**
   * A `control.refused` naming a space. THE SEAM HAS NO ERROR CHANNEL for an
   * asynchronous refusal — `openSpace()` resolves once the frames are sent,
   * because the protocol has no positive ack to wait for (LLD §6 fact 1) — so a
   * refusal that arrives later lands here. Subscribe BEFORE calling
   * `openSpace()`. LLD §6: "a refused space must not look like a quiet one".
   *
   * FLAGGED to bridge-coordinator as a seam gap; seam.ts is locked (C-2) and
   * this lane does not edit it.
   */
  onSpaceRefused(cb: (spaceId: SpaceId, error: CollabError) => void): Unsubscribe;
  /** The node process restarted; every previously-live PTY is gone (LLD §9). */
  onNodeRestart(cb: (nodeBootId: string) => void): Unsubscribe;
  /** Drives the 30s slow liveness interval (LLD §9: "while any session surface is visible"). */
  setSessionSurfaceVisible(visible: boolean): void;
  /** High-water seq for a space. For assertions and diagnostics. */
  cursorOf(spaceId: SpaceId): number;
}

export interface RealSeam extends Seam {
  realControls: RealControls;
}

/** `http(s)://host` + the catalog's own WS path → `ws(s)://host/v2/ws`. */
export function deriveWsUrl(baseUrl: string, origin?: string): string {
  const path = bindPath('events.subscribe');
  const abs = /^https?:\/\//i.test(baseUrl) ? baseUrl : origin;
  if (abs === undefined || abs === '') {
    throw new CollabError(
      'invalid_input',
      'createRealSeam: wsUrl is required when baseUrl is relative and no origin was supplied',
    );
  }
  // 'https' → 'wss' falls out of this because the trailing 's' survives.
  return `${abs.replace(/\/$/, '')}${path}`.replace(/^http/i, 'ws');
}

export function createRealSeam(options: RealSeamOptions): RealSeam {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const onError = options.onError ?? (() => {});
  // Browser sockets authenticate with the Secure/HttpOnly session cookie.
  // Never copy the long-lived browser pass into a URL: URLs leak into proxy
  // access logs, browser history and diagnostics. HTTP still reads the pass
  // below while old sessions transition to the cookie-backed path.
  const wsUrl = options.wsUrl ?? deriveWsUrl(baseUrl, options.origin);

  // Late-bound so http can signal transport reachability into a manager that
  // does not exist yet — the alternative is an extra setter on http, which
  // would let the wire be forgotten silently.
  let conn: ConnectionManager | null = null;

  const http = createHttpClient({
    baseUrl,
    fetch: options.fetch,
    onTransport: (reachable) => conn?.noteTransport(reachable),
    ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}),
  });

  const ops = createOps(http, { newClientMutationId: options.newClientMutationId });

  const connection = createConnectionManager({
    wsUrl,
    webSocketFactory: options.webSocketFactory,
    poll: (spaceId, since, limit) => ops.pollEvents(spaceId, since, limit),
    timers: options.timers,
    now: options.now,
    random: options.random,
    config: options.connection,
    onError,
  });
  conn = connection;

  const liveness = createLivenessManager({
    read: (spaceId) => ops.liveness(spaceId),
    timers: options.timers,
    now: options.now,
    config: options.liveness,
    onError,
  });

  // Wires 2 and 3 (see header).
  connection.onEvent((event) => liveness.noteEvent(event));
  connection.onReconnect(() => liveness.noteReconnect());

  const seam: RealSeam = {
    // -- lifecycle -----------------------------------------------------------

    /**
     * Resolves once the space is subscribed and the liveness cadence has
     * STARTED — deliberately not once either has succeeded:
     *
     *  - the socket protocol has no positive ack, so there is nothing to await
     *    (a refusal arrives later, via `realControls.onSpaceRefused`);
     *  - `execution.liveness` has no catalog row and no server route yet (LLD
     *    §13 open item), so awaiting the first snapshot would make EVERY
     *    `openSpace()` reject against today's node. The read failing is
     *    reported through `onError` and leaves `statusOf` answering 'unknown',
     *    which is the honest state and exactly what R-UI-5 reserves it for.
     *
     * A space with a RECORDED refusal rejects immediately rather than
     * optimistically re-opening into silence.
     */
    async openSpace(spaceId: SpaceId): Promise<void> {
      const refusal = connection.refusalOf(spaceId);
      if (refusal !== undefined) throw refusal;
      connection.openSpace(spaceId);
      liveness.noteSpaceOpened(spaceId);
    },

    closeSpace(spaceId: SpaceId): void {
      connection.closeSpace(spaceId);
      liveness.noteSpaceClosed(spaceId);
    },

    dispose(): void {
      connection.dispose();
      liveness.dispose();
    },

    // -- event stream & connection honesty -----------------------------------

    onEvent: (cb) => connection.onEvent(cb),
    // PR188 review F1: the node publishes payload-wrapped contract
    // MessageParts in its C3 frames; the chat-home render types are
    // flattened. Normalize at the seam boundary so every consumer sees ONE
    // shape — reading the wire shape through the render type yields
    // undefined in every field, silently.
    onChatTurn: (cb) =>
      connection.onChatTurn((frame) =>
        cb(chatTurnFrameFromWire(frame as unknown as WireChatTurnFrame))),
    onConnection: (cb) => connection.onConnection(cb),
    getConnection: () => connection.getConnection(),
    onResync: (cb) => connection.onResync(cb),

    // -- reads ---------------------------------------------------------------

    identity: (): Promise<IdentityView> => ops.identity(),
    spaces: (): Promise<SpaceSummary[]> => ops.spaces(),
    spaceSettings: (spaceId: SpaceId): Promise<SpaceSettingsView> => ops.spaceSettings(spaceId),
    previewInvite: (code: string): Promise<InvitePreview> => ops.previewInvite(code),
    counts: (spaceId: SpaceId): Promise<SpaceKindCounts> => ops.counts(spaceId),

    /**
     * LLD C-4, the ONE soft-fallback in the whole seam: `not_implemented` (501)
     * and `not_found` (404) both resolve `null` and are DELIBERATELY
     * indistinguishable — the UI substitutes its shipped versioned default menu
     * and neither case is a failure the user should see. Every other code
     * rejects like any other read.
     */
    async menu(spaceId: SpaceId): Promise<MenuConfig | null> {
      try {
        return await ops.menu(spaceId);
      } catch (err) {
        if (err instanceof CollabError && (err.code === 'not_implemented' || err.code === 'not_found')) {
          return null;
        }
        throw err;
      }
    },

    query: (input: CollectionQuery): Promise<CollectionResult> => ops.query(input),
    graph: (input: GraphQuery): Promise<GraphResult> => ops.graph(input),
    entityKinds: (spaceId: SpaceId): Promise<EntityKindDef[]> => ops.entityKinds(spaceId),
    projects: (spaceId: SpaceId): Promise<ProjectResource[]> => ops.projects(spaceId),
    projectBranches: (projectId: string, opts?: BranchTopologyOpts): Promise<ProjectBranchTopology> =>
      ops.projectBranches(projectId, opts),
    projectSetup: {
      directories: (path) => ops.projectDirectories(path),
      createSpace: (input) => ops.createSpace(input),
      createProject: (input) => ops.createProject(input),
      linkProject: (spaceId, input) => ops.linkProject(spaceId, input),
      listProjects: () => ops.projects(),
    },
    projectFiles: {
      list: (projectId, path) => ops.projectFiles(projectId, path),
      read: (projectId, path) => ops.readProjectFile(projectId, path),
      attach: (projectId, input) => ops.attachProjectFile(projectId, input),
      archiveHref: (projectId, path) => ops.projectArchiveHref(projectId, path),
    },
    // Seam Amendment 8: browser-originated folder import (R7 materialization).
    projectFolderUploads: {
      init: (spaceId, input) => ops.folderUploadInit(spaceId, input),
      complete: (folderUploadId, input) => ops.folderUploadComplete(folderUploadId, input),
      abort: (folderUploadId, input) => ops.folderUploadAbort(folderUploadId, input),
    },
    entity: (id: EntityId): Promise<EntityDetail> => ops.entity(id),
    children: (id: EntityId, opts?: PageOpts): Promise<Page<EntitySummary>> => ops.children(id, opts),
    connections: (id: EntityId, opts?: ConnectionOpts): Promise<Page<EdgeView>> => ops.connections(id, opts),
    activity: (id: EntityId, opts?: PageOpts): Promise<Page<ActivityItem>> => ops.activity(id, opts),
    messages: (anchorId: EntityId, opts?: PageOpts): Promise<Page<MessageView>> => ops.messages(anchorId, opts),
    home: (spaceId) => ops.home(spaceId),
    handoffs: (workSessionId: EntityId, opts?: PageOpts): Promise<Page<HandoffView>> =>
      ops.handoffs(workSessionId, opts),
    journal: (workSessionId: EntityId, opts?: JournalOpts): Promise<SessionJournalPage> =>
      ops.journal(workSessionId, opts),
    launch: (workSessionId: EntityId): Promise<SessionLaunchRecord> => ops.launch(workSessionId),
    transcript: (workSessionId: EntityId, opts?: TranscriptOpts): Promise<SessionTranscriptPage> =>
      ops.transcript(workSessionId, opts),
    projectContention: (projectId: string): Promise<ContentionReport> => ops.projectContention(projectId),
    projectFileHistory: (projectId: string, path: string, opts?: FileHistoryOpts): Promise<ProjectFileHistory> =>
      ops.projectFileHistory(projectId, path, opts),
    projectFileBlame: (projectId: string, path: string, opts?: FileBlameOpts): Promise<ProjectFileBlame> =>
      ops.projectFileBlame(projectId, path, opts),
    gitStatus: (workSessionId: EntityId): Promise<SessionGitStatus> => ops.gitStatus(workSessionId),
    gitDiff: (workSessionId: EntityId, opts?: GitDiffOpts): Promise<SessionGitDiff> =>
      ops.gitDiff(workSessionId, opts),
    inbox: (opts?: PageOpts): Promise<Page<NotificationItem>> => ops.inbox(opts),
    attentionRequests: (input: AttentionRequestListQuery): Promise<AttentionRequestPage> =>
      ops.attentionRequests(input),
    feed: (id: EntityId, opts?: FeedOpts): Promise<EntityFeedPage> => ops.feed(id, opts),
    delivery: (messageId: EntityId): Promise<MessageDeliveryView> => ops.delivery(messageId),

    files: {
      uploadInit: (input) => ops.fileUploadInit(input),
      putBytes: (grant, bytes) => ops.fileUploadBytes(grant, bytes),
      complete: (uploadId, input) => ops.fileUploadComplete(uploadId, input),
      abort: (uploadId, input) => ops.fileUploadAbort(uploadId, input),
      downloadHref: (fileEntityId) => ops.fileDownloadHref(fileEntityId),
    },

    // -- commands ------------------------------------------------------------

    commands: {
      createEntity: (input) => ops.createEntity(input),
      createTask: (input) => ops.createTask(input),
      patchEntity: (id, input) => ops.patchEntity(id, input),
      patchTask: (id, input) => ops.patchTask(id, input),
      moveEntity: (id, input) => ops.moveEntity(id, input),
      deleteEntity: (id, ctx) => ops.deleteEntity(id, ctx),
      restoreEntity: (id, ctx) => ops.restoreEntity(id, ctx),
      complete: (id, input) => ops.complete(id, input),
      work: (id, input) => ops.work(id, input),
      createEdge: (input) => ops.createEdge(input),
      deleteEdge: (edgeId, ctx) => ops.deleteEdge(edgeId, ctx),
      addToCollection: (collectionId, input) => ops.addToCollection(collectionId, input),
      removeFromCollection: (collectionId, entityId, ctx) =>
        ops.removeFromCollection(collectionId, entityId, ctx),
      postMessage: (input) => ops.postMessage(input),
      startChatThread: (input) => ops.startChatThread(input),
      editMessage: (id, input): Promise<CommandResult> => ops.editMessage(id, input),
      react: (id, input) => ops.react(id, input),
      resolveAttention: (id, input) => ops.resolveAttention(id, input),
      updateProfile: (input) => ops.updateProfile(input),
      setMemberRole: (spaceId, memberId, input) => ops.setMemberRole(spaceId, memberId, input),
      createInvite: (spaceId, input) => ops.createInvite(spaceId, input),
      // `ctx` defaults to `{}` rather than being forwarded as `undefined`: the
      // revoke body binds `RequiredCommandContextSchema`, so a missing body is
      // a 400 and an absent object is not the same as an empty one on the wire.
      revokeInvite: (spaceId, inviteId, ctx) => ops.revokeInvite(spaceId, inviteId, ctx ?? {}),
      createTaskAxis: (spaceId, input) => ops.createTaskAxis(spaceId, input),
      updateTaskAxis: (spaceId, axisId, input) => ops.updateTaskAxis(spaceId, axisId, input),
      deleteTaskAxis: (spaceId, axisId, ctx) => ops.deleteTaskAxis(spaceId, axisId, ctx),
      upsertTaskWorkflow: (spaceId, input) => ops.upsertTaskWorkflow(spaceId, input),
      deleteTaskWorkflow: (spaceId, workflowId, ctx) => ops.deleteTaskWorkflow(spaceId, workflowId, ctx),
      redeemInvite: (input) => ops.redeemInvite(input),
      markRead: (notificationId) => ops.markRead(notificationId),
      /**
       * `lastReadAt` is intentionally NOT sent. `readMarks.upsert` binds
       * `RequiredCommandContextSchema` (`.strict()`) and the server stamps the
       * time itself inside `mark_read` — sending the client's clock would be a
       * 400, and honouring it would let a skewed client mark the future read.
       */
      upsertReadMark: (anchorId, lastReadAt) => {
        void lastReadAt;
        return ops.upsertReadMark(anchorId);
      },
      previewArtifact: (id, input) => ops.previewArtifact(id, input),
      spawn: (input) => ops.spawn(input),
      startTerminal: (input) => ops.startTerminal(input),
      dispatch: (input) => ops.dispatch(input),
      prompt: (id, input) => ops.prompt(id, input),
      terminate: (id, input) => ops.terminate(id, input),
      resume: (id, input) => ops.resume(id, input),
      gitCheckpoint: (id, input) => ops.gitCheckpoint(id, input),
      gitRollback: (id, input) => ops.gitRollback(id, input),
      gitCommit: (id, input) => ops.gitCommit(id, input),
      gitMerge: (id, input) => ops.gitMerge(id, input),
      gitCherryPick: (id, input) => ops.gitCherryPick(id, input),
      gitBranch: (id, input) => ops.gitBranch(id, input),
      gitStash: (id, input) => ops.gitStash(id, input),
      mergePullRequest: (id, input) => ops.mergePullRequest(id, input),
    },

    // -- credentials ---------------------------------------------------------

    credentials: {
      status: () => ops.credentialsStatus(),
      disconnect: (provider) => ops.credentialsDisconnect(provider),
      startLogin: (spaceId, provider) => ops.credentialsStartLogin(spaceId, provider),
      finishLogin: (workSessionId) => ops.credentialsFinishLogin(workSessionId),
    },

    // -- liveness ------------------------------------------------------------

    liveness: {
      refresh: (spaceId) => liveness.refresh(spaceId),
      onChange: (cb) => liveness.onChange(cb),
      statusOf: (session) => liveness.statusOf(session),
    },

    realControls: {
      onSpaceRefused: (cb) => connection.onSpaceRefused(cb),
      onNodeRestart: (cb) => liveness.onNodeRestart(cb),
      setSessionSurfaceVisible: (visible) => liveness.setVisible(visible),
      cursorOf: (spaceId) => connection.cursorOf(spaceId),
    },
  };

  return seam;
}
