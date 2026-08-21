/**
 * RealFacade — CollabFacade over the live tm8 server.
 *
 * The same interface MockFacade implements, so every component above the seam
 * is unchanged. What differs is only what is *behind* each method, and this
 * file's whole job is to be honest about that difference.
 *
 * THREE STANDING RULES, in priority order:
 *
 * 1. NEVER FABRICATE. Where tm8 has not built an operation, this facade returns
 *    a typed empty (reads) or throws not_implemented (writes). It never invents
 *    a plausible row. A fake task is worse than a missing panel: a user cannot
 *    tell it is fake, and neither can the next engineer. See ./capabilities.ts
 *    for the register and the reasoning behind the read/write asymmetry.
 *
 * 2. ADAPT HERE, NEVER IN THE SNAPSHOT. The tm8 contract's §1 is a near-verbatim
 *    transcription of this UI's own types, so most of this file is a pass-through
 *    — and it is kept as an explicit seam anyway, because two divergences already
 *    exist (the WorkspaceEvent envelope, in ./events.ts, and `limit_exceeded`, in
 *    ./TmClient.ts) and a visible pass-through is far cheaper to change later
 *    than one that has to be reintroduced.
 *
 * 3. RESPECT THE ENVELOPE ASYMMETRY. It is real and intentional, confirmed by
 *    live call rather than by reading handlers:
 *      reads              → the DTO BARE at `data`   (lists are bare ARRAYS)
 *      entity commands    → CommandResult at `data`  ({entity, patches, …})
 *      spaces.create      → `data.space` (+ memberId, defaultChannelId)
 *      projects.create    → the ProjectResource BARE
 *    `unwrapCommand` below is the single place that knows the command shape.
 */
import {
  CollabError,
  type ActivityItem, type ChannelTab, type CollectionQuery, type CollectionResult,
  type CommandContext, type CommandResult, type CompleteTaskInput, type Connections,
  type CreateEdgeInput, type CreateEntityInput, type CreateTaskInput, type Cursor,
  type EntityDetail, type EntityId, type EntitySummary,
  type GraphQuery, type GraphResult, type Hierarchy, type HomeSnapshot,
  type LeaderboardRow, type LinkPrInput, type MessageView, type MoveEntityInput,
  type NotificationItem, type Page, type PaletteAction, type PatchEdgeInput,
  type PatchEntityInput, type PatchMessageInput, type PatchTaskInput,
  type PlacementInput, type PointEventView, type PostMessageInput,
  type PresenceSnapshot, type PresenceWorkspaceEvent, type PullInput,
  type GrantPointsInput, type ReactionInput, type SavedView, type SavedViewInput,
  type SpaceId, type SpaceNavigation, type SpaceSettings, type SpaceSummary,
  type TaskAxis, type TaskAxisInput, type TrackingRefreshInput, type UndoToken,
  type Unsubscribe, type WorkInput, type WorkspaceEvent,
} from '../collab-v2/types/contract';
import type {
  CollabFacade, ConnectionControl, FileAttachmentControl, UploadFileInput,
} from '../collab-v2/facade/CollabFacade';
import { EventPoller } from './events';
import { TmClient } from './TmClient';

/** An empty page — the honest read-degradation shape. */
function emptyPage<T>(): Page<T> {
  return { items: [], nextCursor: null };
}

/**
 * The refusal every unbuilt WRITE gets. Loud on purpose: a write that quietly
 * does nothing while the UI reports success is the exact failure this lane
 * exists to prevent.
 *
 * Returns a REJECTED PROMISE rather than throwing synchronously. That
 * distinction is not pedantry: these methods are declared `Promise<…>`, so a
 * caller writing `facade.moveEntity(…).catch(showToast)` — which is the normal
 * shape — would never catch a synchronous throw. The error would escape as an
 * unhandled exception at the call site instead of flowing through the caller's
 * own error handling. Caught by the mapping tests, not by reading the code.
 */
function notImplemented<T>(method: string): Promise<T> {
  return Promise.reject(new CollabError(
    'not_implemented',
    `${method} is not implemented on this tm8 node — the affordance should be disabled, not invoked`,
  ));
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * tm8 entity commands answer with the contract's CommandResult. `patches` is
 * defaulted rather than assumed: some handlers legitimately return none (the
 * project-link command returns `patches: []`), and the stores iterate it
 * unconditionally.
 */
function unwrapCommand(raw: unknown): CommandResult {
  const r = (raw ?? {}) as Partial<CommandResult>;
  return { ...r, patches: r.patches ?? [] } as CommandResult;
}

interface FileUploadGrant {
  uploadId: string;
  uploadUrl: string;
  token?: string | null;
  expiresAt: string;
  maxSizeBytes: number;
}

export interface MessageDeliveryDisposition {
  targetMessageId: string;
  targetWorkSessionId: string;
  status: 'accepted' | 'skipped' | 'undelivered';
  reason?: string;
  deliveryId?: string;
}

export interface MessageBatchResult {
  messageBatchId: string;
  messages: MessageView[];
  /** Per-target live-copy outcome; absent when the batch named no session. */
  delivery?: MessageDeliveryDisposition[];
}

/** Canonical tm8 multi-anchor message command used by Channel @Tags. */
export interface PostMessageBatchInput extends CommandContext {
  anchorIds: EntityId[];
  body: string;
  parentMessageId?: EntityId | null;
  mentionIds?: EntityId[];
  attachmentIds?: EntityId[];
}

let generatedMutationSeq = 0;

function mutationRoot(prefix: string): string {
  generatedMutationSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${generatedMutationSeq}`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new CollabError('upstream_unavailable', 'this browser cannot compute the file checksum');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * The execution family has no home on CollabFacade — that interface was frozen
 * against the Collab V2 contract, which predates tm8's `execution.*` operations
 * (contract §2, R16). Rather than widen a seam Atlas's team owns, sessions ride
 * this OPTIONAL capability, mirroring how ConnectionControl is already bolted
 * on beside the facade. The work-session panel feature-detects it.
 */
export interface ExecutionControl {
  spawnSession(input: {
    spaceId: SpaceId;
    projectId: string;
    teamMemberId: EntityId;
    taskIds: EntityId[];
    mode?: string;
    clientMutationId?: string;
  }): Promise<CommandResult>;
  promptSession(sessionId: EntityId, message: string, ctx?: CommandContext): Promise<CommandResult>;
  terminateSession(sessionId: EntityId, ctx?: CommandContext): Promise<CommandResult>;
  listProjects(spaceId?: SpaceId): Promise<Tm8Project[]>;
  createProject(input: { name: string; workingDir: string; trust?: 'trusted' | 'untrusted' }): Promise<Tm8Project>;
  linkProject(spaceId: SpaceId, projectId: string): Promise<void>;
  createSpace(name: string): Promise<{ space: SpaceSummary; memberId?: EntityId }>;
}

/** tm8 projects are linked RESOURCES, not entities (AM-2 §1 / T-D17). */
export interface Tm8Project {
  id: string;
  name: string;
  repoUrl: string | null;
  workingDir: string;
  trust: 'trusted' | 'untrusted';
  defaults: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function hasExecutionControl(f: CollabFacade): f is CollabFacade & ExecutionControl {
  return typeof (f as Partial<ExecutionControl>).spawnSession === 'function';
}

export class RealFacade implements CollabFacade, ConnectionControl, ExecutionControl, FileAttachmentControl {
  private readonly client: TmClient;
  private readonly pollers = new Map<SpaceId, EventPoller>();

  constructor(client: TmClient = new TmClient()) {
    this.client = client;
  }

  // =========================================================================
  // Reads — spaces & navigation                       [IMPLEMENTED server-side]
  // =========================================================================

  /** `spaces.list` returns a bare ARRAY, not a {items} page. */
  listSpaces(): Promise<SpaceSummary[]> {
    return this.client.get<SpaceSummary[]>('/v2/spaces');
  }

  getNavigation(spaceId: SpaceId): Promise<SpaceNavigation> {
    return this.client.get<SpaceNavigation>(`/v2/spaces/${spaceId}/navigation`);
  }

  // =========================================================================
  // Reads — entity detail + lazy sections
  // =========================================================================

  getEntity(id: EntityId): Promise<EntityDetail> {
    return this.client.get<EntityDetail>(`/v2/entities/${id}`);
  }

  async getHierarchy(id: EntityId, cursor?: Cursor): Promise<Hierarchy> {
    // `entities.children` returns only the child page; parent and path come
    // from the detail read, so one extra call buys a complete Hierarchy.
    const [detail, children] = await Promise.all([
      this.getEntity(id),
      this.client.get<Page<EntitySummary>>(`/v2/entities/${id}/children${qs({ cursor })}`),
    ]);
    return { parent: detail.hierarchy?.parent ?? null, children, path: detail.hierarchy?.path ?? [] };
  }

  /**
   * `edges.list` is a 404 on this node, but `entities.get` carries a fully
   * populated `connections` block — real edges, both directions. Serving it
   * from there is a different route to the same real data, not a stand-in for
   * absent data, so this counts as implemented.
   */
  async getConnections(id: EntityId): Promise<Connections> {
    const detail = await this.getEntity(id);
    return detail.connections ?? { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 };
  }

  getActivity(id: EntityId, cursor?: Cursor): Promise<Page<ActivityItem>> {
    return this.client.get<Page<ActivityItem>>(`/v2/entities/${id}/activity${qs({ cursor })}`);
  }

  // --- degraded reads ------------------------------------------------------

  /** `entities.versions` — unbuilt. Empty page, so version UI renders blank, not wrong. */
  async getVersions(): Promise<Page<{ version: number; changedBy: EntityId; changedAt: string }>> {
    return emptyPage();
  }

  /** `presence.get` — 501. No viewers is TRUE here: nothing tracks presence. */
  async getPresence(): Promise<PresenceSnapshot> {
    return { viewers: [], typingActorIds: [], updatedAt: new Date().toISOString() };
  }

  // =========================================================================
  // Reads — collections, graph, home
  // =========================================================================

  /**
   * `collections.query` is `.strict()` server-side: an unknown key is a 400
   * rather than an ignored field. The UI's CollectionQuery carries presentation
   * concerns (`layout`, `groupBy`) that the server has no column for, so they
   * are stripped here and the server's echoed query is merged back with the
   * caller's — the screens read `result.query.layout` to pick their renderer.
   */
  async queryCollection(query: CollectionQuery): Promise<CollectionResult> {
    const { layout, groupBy, ...serverQuery } = query;
    const result = await this.client.post<CollectionResult>('/v2/collections/query', serverQuery);
    return {
      ...result,
      query: { ...result.query, ...(layout ? { layout } : {}), ...(groupBy ? { groupBy } : {}) },
    };
  }

  /**
   * No graph traversal binding exists. Returning the collection's nodes with
   * NO edges would draw a disconnected graph that looks like a real answer —
   * so this degrades to fully empty and the screen reports it unavailable.
   */
  async queryGraph(_query: GraphQuery): Promise<GraphResult> {
    void _query;
    return { nodes: [], edges: [], clusters: [] };
  }

  getHome(spaceId: SpaceId): Promise<HomeSnapshot> {
    return this.client.get<HomeSnapshot>(`/v2/spaces/${spaceId}/home`);
  }

  /** `channel.autoTabs` is an honest `[]` server-side; mirror it rather than invent tabs. */
  async getChannelTabs(): Promise<ChannelTab[]> {
    return [];
  }

  // =========================================================================
  // Reads — messages, activity, inbox, leaderboard, axes, misc
  // =========================================================================

  getMessages(
    anchorId: EntityId,
    opts?: { cursor?: Cursor; order?: 'asc' | 'desc'; rootId?: EntityId },
  ): Promise<Page<MessageView>> {
    return this.client.get<Page<MessageView>>(
      `/v2/entities/${anchorId}/messages${qs({
        cursor: opts?.cursor, order: opts?.order, rootMessageId: opts?.rootId,
      })}`,
    );
  }

  /**
   * There is no space-wide activity route, but `spaces.home` computes exactly
   * that feed and returns it as `activity`. Real data, one hop across.
   */
  async getSpaceActivity(spaceId: SpaceId): Promise<Page<ActivityItem>> {
    const home = await this.getHome(spaceId);
    return home.activity ?? emptyPage<ActivityItem>();
  }

  async getInbox(): Promise<Page<NotificationItem>> { return emptyPage(); }
  async getLeaderboard(): Promise<Page<LeaderboardRow>> { return emptyPage(); }
  async getAwards(): Promise<Page<PointEventView>> { return emptyPage(); }
  async getTaskAxes(): Promise<TaskAxis[]> { return []; }
  async listSavedViews(): Promise<SavedView[]> { return []; }

  /**
   * No settings route. Echo the space's own identity from `spaces.get` and
   * leave everything else at its neutral default — every field here is either
   * server-sourced or an explicit blank, never a guess at what a user configured.
   *
   * This used to return `{spaceId, name, description, githubRepo, axes, members}`
   * cast `as unknown as SpaceSettings` — a DIFFERENT SHAPE: no `space`, no
   * `invites`, and `axes` where `taskAxes` belongs. The double cast is precisely
   * what let it compile; the screen then read `settings.space.name` off
   * `undefined` and threw, white-screening the entire app because nothing in the
   * package caught it. Returning the real shape with NO cast makes the compiler
   * enforce this from here on — that is the actual fix, the screen's guards are
   * only the second line of defence.
   *
   * `unavailable` marks what this node cannot serve, so the screen can say
   * "not available on this node" rather than the indistinguishable "none yet".
   */
  async getSettings(spaceId: SpaceId): Promise<SpaceSettings> {
    const space = await this.client.get<SpaceSummary>(`/v2/spaces/${spaceId}`);
    return {
      space,
      members: [],
      invites: [],
      taskAxes: [],
      unavailable: { members: true, invites: true, taskAxes: true },
    };
  }

  /** DEV-13 defers search even in the contract; tm8 has no route either. */
  async search(): Promise<Page<EntitySummary>> {
    throw new CollabError('not_implemented', 'search is deferred for v1 (DEV-13) and unbuilt on tm8');
  }

  /** `actions.list` — 501. No actions is honest; the palette falls back to recents. */
  async getActions(): Promise<PaletteAction[]> { return []; }

  // =========================================================================
  // Commands — entities                               [IMPLEMENTED server-side]
  // =========================================================================

  /** Deprecated sugar; DEV-1 routes every create through `createEntity`. */
  createTask(input: CreateTaskInput): Promise<CommandResult> {
    const { spaceId, title, parentId, position, attachTo, clientMutationId, ...rest } = input;
    return this.createEntity({
      spaceId, kind: 'task', title, parentId, position, attachTo, clientMutationId,
      content: rest as Record<string, unknown>,
    });
  }

  patchTask(id: EntityId, input: PatchTaskInput): Promise<CommandResult> {
    const { expectedVersion, title, clientMutationId, actorId, ...rest } = input;
    return this.patchEntity(id, {
      expectedVersion, title, clientMutationId, actorId,
      content: rest as Record<string, unknown>,
    });
  }

  async createEntity(input: CreateEntityInput): Promise<CommandResult> {
    return unwrapCommand(await this.client.post('/v2/entities', input));
  }

  async patchEntity(id: EntityId, input: PatchEntityInput): Promise<CommandResult> {
    return unwrapCommand(await this.client.patch(`/v2/entities/${id}`, input));
  }

  async createEdge(input: CreateEdgeInput): Promise<CommandResult> {
    return unwrapCommand(await this.client.post('/v2/edges', input));
  }

  async postMessageBatch(input: PostMessageBatchInput): Promise<MessageBatchResult> {
    return this.client.post<MessageBatchResult>('/v2/messages', {
      actorId: input.actorId,
      clientMutationId: input.clientMutationId ?? mutationRoot('message-batch'),
      anchorIds: input.anchorIds,
      body: input.body,
      parentMessageId: input.parentMessageId,
      mentionIds: input.mentionIds,
      attachmentIds: input.attachmentIds,
    });
  }

  async postMessage(input: PostMessageInput): Promise<CommandResult> {
    const batch = await this.postMessageBatch({
      actorId: input.actorId,
      clientMutationId: input.clientMutationId,
      anchorIds: [input.anchorId],
      body: input.body,
      parentMessageId: input.parentMessageId,
      mentionIds: input.mentions?.map((mention) => mention.entityId),
      attachmentIds: input.attachments?.map((attachment) => attachment.fileEntityId),
    });
    return {
      patches: [...batch.messages],
    };
  }

  /** The complete grant → bytes → finalize lifecycle behind Channel attachments. */
  async uploadFile(input: UploadFileInput): Promise<EntityDetail> {
    if (input.file.size <= 0) {
      throw new CollabError('invalid_input', 'empty files cannot be uploaded');
    }

    const root = input.clientMutationId ?? mutationRoot('upload');
    const bytes = await input.file.arrayBuffer();
    const checksumSha256 = await sha256Hex(bytes);
    let grant: FileUploadGrant | null = null;

    try {
      grant = await this.client.post<FileUploadGrant>('/v2/files/uploads', {
        actorId: input.actorId,
        clientMutationId: `${root}:init`,
        spaceId: input.spaceId,
        name: input.file.name,
        mime: input.file.type || 'application/octet-stream',
        sizeBytes: input.file.size,
        checksumSha256,
      });
      if (input.file.size > grant.maxSizeBytes) {
        throw new CollabError('payload_too_large', `file exceeds the ${grant.maxSizeBytes}-byte upload limit`);
      }
      await this.client.putGrantedBytes(grant.uploadUrl, grant.token, bytes);
      const result = unwrapCommand(await this.client.post(
        `/v2/files/uploads/${grant.uploadId}/complete`,
        {
          actorId: input.actorId,
          clientMutationId: `${root}:complete`,
          targets: [...new Set(input.targetIds ?? [])],
        },
      ));
      if (!result.entity || result.entity.kind !== 'file') {
        throw new CollabError('upstream_unavailable', 'upload completed without a file entity');
      }
      return result.entity;
    } catch (error) {
      if (grant) {
        await this.client.post(`/v2/files/uploads/${grant.uploadId}/abort`, {
          actorId: input.actorId,
          clientMutationId: `${root}:abort`,
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  fileDownloadUrl(fileEntityId: EntityId): string {
    return this.client.resolveUrl(`/v2/files/${encodeURIComponent(fileEntityId)}/download`);
  }

  /**
   * Both fields are REQUIRED by the server and neither can be defaulted here.
   * `expectedVersion` makes completion optimistic-concurrency controlled, and
   * `completerIds` must name at least one member because a task is completed BY
   * somebody — that is what earns the points. Failing early with the server's
   * own vocabulary beats a 400 from a call we knew was malformed.
   */
  async completeTask(id: EntityId, input: CompleteTaskInput): Promise<CommandResult> {
    const completerIds = (input as { completerIds?: EntityId[] }).completerIds ?? [];
    if (completerIds.length === 0) {
      throw new CollabError('invalid_input', 'completeTask requires at least one completerId');
    }
    return unwrapCommand(await this.client.post(`/v2/entities/${id}/commands/complete`, input));
  }

  async setWork(id: EntityId, input: WorkInput): Promise<CommandResult> {
    return unwrapCommand(await this.client.post(`/v2/entities/${id}/commands/work`, input));
  }

  /**
   * The award ledger's manual entry point, and the one place this facade was
   * more pessimistic than the node it talks to: `entities.points.add` IS built
   * (POST /v2/entities/:id/points), so refusing it disabled two real
   * affordances — the per-entity points control and the panel's points action —
   * against a server that would have honoured them.
   *
   * `input` goes over whole, as every other command here does: GrantPointsInput
   * is exactly the server's body (`amount`, `reason`, `referenceId`) plus the
   * CommandContext envelope (`actorId`, `clientMutationId`) the handler reads
   * off the same object. The grant is idempotent on `clientMutationId`
   * server-side, so a double-press pays once — verified by live call, not by
   * reading the handler.
   */
  async grantPoints(id: EntityId, input: GrantPointsInput): Promise<CommandResult> {
    return unwrapCommand(await this.client.post(`/v2/entities/${id}/points`, input));
  }

  // --- unbuilt writes: loud refusals, never silent no-ops ------------------

  moveEntity(_id: EntityId, _i: MoveEntityInput): Promise<CommandResult> { return notImplemented('moveEntity'); }
  deleteEntity(_id: EntityId, _c?: CommandContext): Promise<CommandResult> { return notImplemented('deleteEntity'); }
  patchEdge(_e: string, _i: PatchEdgeInput): Promise<CommandResult> { return notImplemented('patchEdge'); }
  deleteEdge(_e: string, _c?: CommandContext): Promise<CommandResult> { return notImplemented('deleteEdge'); }
  placements(_i: PlacementInput): Promise<CommandResult> { return notImplemented('placements'); }
  undo(_t: UndoToken | string, _c?: CommandContext): Promise<CommandResult> { return notImplemented('undo'); }
  patchMessage(_id: EntityId, _i: PatchMessageInput): Promise<CommandResult> { return notImplemented('patchMessage'); }
  deleteMessage(_id: EntityId, _c?: CommandContext): Promise<CommandResult> { return notImplemented('deleteMessage'); }
  setReaction(_id: EntityId, _i: ReactionInput): Promise<CommandResult> { return notImplemented('setReaction'); }
  pullEntity(_id: EntityId, _i: PullInput): Promise<CommandResult> { return notImplemented('pullEntity'); }
  linkPr(_id: EntityId, _i: LinkPrInput): Promise<CommandResult> { return notImplemented('linkPr'); }
  trackingRefresh(_i: TrackingRefreshInput): Promise<CommandResult> { return notImplemented('trackingRefresh'); }
  /**
   * The one unbuilt write that must NOT throw, and the reasoning matters.
   *
   * Every other refusal here is attached to an affordance a user presses. This
   * one is not: the thread marks itself read on view, so throwing produced an
   * unhandled rejection on EVERY thread open —
   *   "PAGEERROR: markRead is not implemented on this tm8 node"
   * — caught in the browser during the acceptance run. A loud refusal aimed at a
   * button is honest; the same refusal fired by an automatic background call is
   * just noise, and noise in the console is how the next real error gets missed.
   *
   * Resolving is also the TRUTHFUL answer rather than a convenient one: unread
   * state on this node is a hollow field — `channel.state.unreadCount`,
   * `space.unreadTotal` and `navigation.unreadTotal` are all hard-wired to 0
   * (see ./capabilities.ts). Mark-read exists to clear a count that is already
   * and permanently zero, so there is genuinely nothing to do and nothing is
   * being faked by saying so. It returns no patches, so no UI state moves.
   */
  async markRead(_a: EntityId, _c?: CommandContext): Promise<CommandResult> {
    return { patches: [] };
  }
  markNotificationRead(_n: string, _c?: CommandContext): Promise<CommandResult> { return notImplemented('markNotificationRead'); }
  createTaskAxis(_s: SpaceId, _i: TaskAxisInput): Promise<TaskAxis> { return notImplemented('createTaskAxis'); }
  updateTaskAxis(_s: SpaceId, _a: string, _i: Partial<TaskAxisInput>): Promise<TaskAxis> { return notImplemented('updateTaskAxis'); }
  deleteTaskAxis(_s: SpaceId, _a: string): Promise<void> { return notImplemented('deleteTaskAxis'); }
  createSavedView(_s: SpaceId, _i: SavedViewInput): Promise<SavedView> { return notImplemented('createSavedView'); }
  updateSavedView(_v: string, _i: Partial<SavedViewInput>): Promise<SavedView> { return notImplemented('updateSavedView'); }
  deleteSavedView(_v: string): Promise<void> { return notImplemented('deleteSavedView'); }

  // =========================================================================
  // Execution (tm8 §2 / R16) — beside the seam, not through it
  // =========================================================================

  async spawnSession(input: {
    spaceId: SpaceId; projectId: string; teamMemberId: EntityId;
    taskIds: EntityId[]; mode?: string; clientMutationId?: string;
  }): Promise<CommandResult> {
    // `workdir: {mode:'worktree'}` is REFUSED by the server rather than silently
    // falling back to the project directory — silently using the wrong directory
    // is how an agent writes into the wrong tree. So 'project' is the only mode
    // sent, and it is sent explicitly.
    return unwrapCommand(await this.client.post('/v2/execution/spawn', {
      ...input, mode: input.mode ?? 'worker', workdir: { mode: 'project' },
    }));
  }

  async promptSession(sessionId: EntityId, message: string, ctx?: CommandContext): Promise<CommandResult> {
    return unwrapCommand(
      await this.client.post(`/v2/entities/${sessionId}/commands/prompt`, { message, ...ctx }),
    );
  }

  async terminateSession(sessionId: EntityId, ctx?: CommandContext): Promise<CommandResult> {
    return unwrapCommand(
      await this.client.post(`/v2/entities/${sessionId}/commands/terminate`, { ...ctx }),
    );
  }

  /**
   * `projects.list`, optionally scoped to ONE SPACE's linked projects.
   *
   * The `spaceId` filter is not decoration — it is the difference between a
   * spawn that works and one the server refuses. `execution.spawn` requires the
   * project to be LINKED to the task's space (`space_projects`), and the
   * unfiltered list is every project on the NODE. Resolving a run target from
   * the unfiltered list picks a project that is very often linked to some OTHER
   * space, and the spawn dies with "project … is not linked to this space" —
   * which is exactly how it shipped and blocked the user.
   *
   * There is no `projects.listForSpace` in the catalog, so this looked
   * unavailable; the filter was found by calling the endpoint rather than by
   * reading the catalog, and it works today.
   */
  listProjects(spaceId?: SpaceId): Promise<Tm8Project[]> {
    return this.client.get<Tm8Project[]>(`/v2/projects${qs({ spaceId })}`);
  }

  /**
   * `trust` defaults to 'trusted' here because a project created FROM this UI
   * is one the operator just asked for by name and working directory — that is
   * the explicit yes `execution.spawn` demands. Projects arriving by any other
   * path keep the server's 'untrusted' default.
   *
   * ⚠ KNOWN GAP — DELIBERATELY DEFERRED TO WAVE 3 (projects + trust).
   * The contract's default is `untrusted`, and this INVERTS it. The argument
   * above is real but it is not the same thing as informed consent:
   * `10-SECURITY-MODEL.md` S12 requires an explicit `confirmUntrusted` step,
   * and that field does not exist in the frozen contract at all — so there is
   * currently no conformant way to express the consent this default assumes.
   *
   * It is NOT flipped here on purpose. There is no projects-management UI yet
   * (Wave 3), so this call is the only way a project enters the system from the
   * app; defaulting it to `untrusted` today would make every newly created
   * project un-spawnable with no surface to change it — trading a modelling
   * flaw for a dead product.
   *
   * Fix as ONE piece of work: the projects UI + a trust control + the
   * `confirmUntrusted` contract amendment. Do not flip this default alone.
   */
  createProject(input: { name: string; workingDir: string; trust?: 'trusted' | 'untrusted' }): Promise<Tm8Project> {
    return this.client.post<Tm8Project>('/v2/projects', { trust: 'trusted', ...input });
  }

  async linkProject(spaceId: SpaceId, projectId: string): Promise<void> {
    await this.client.post(`/v2/spaces/${spaceId}/projects`, { projectId });
  }

  /** `spaces.create` keeps its wrapper — the subject is not an entity. */
  createSpace(name: string): Promise<{ space: SpaceSummary; memberId?: EntityId }> {
    return this.client.post<{ space: SpaceSummary; memberId?: EntityId }>('/v2/spaces', {
      name,
      clientMutationId: mutationRoot('space-create'),
    });
  }

  // =========================================================================
  // Realtime — polling, and named as such
  // =========================================================================

  subscribe(spaceId: SpaceId, cb: (event: WorkspaceEvent) => void): Unsubscribe {
    let poller = this.pollers.get(spaceId);
    if (!poller) {
      poller = new EventPoller(this.client, spaceId);
      this.pollers.set(spaceId, poller);
    }
    return poller.subscribe(cb);
  }

  /**
   * Presence and typing are client-synthesized (DEV-4) and nothing on this node
   * produces them. A no-op unsubscribe is the truthful implementation: the
   * channel exists, and it is genuinely silent.
   */
  subscribePresence(_spaceId: SpaceId, _cb: (e: PresenceWorkspaceEvent) => void): Unsubscribe {
    void _spaceId; void _cb;
    return () => {};
  }

  // --- ConnectionControl (DEF-17) -----------------------------------------

  isConnected(): boolean { return this.client.isConnected(); }
  subscribeConnection(cb: (connected: boolean) => void): Unsubscribe {
    return this.client.onConnectionChange(cb);
  }
}

/** Convenience construction for the app root. */
export function createRealFacade(baseUrl?: string): RealFacade {
  return new RealFacade(new TmClient(baseUrl));
}
