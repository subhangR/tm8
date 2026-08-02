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
 *      via `update_task_content` (…:963) — `workStatus` included.
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
  bindPath,
  type ActivityItem,
  type ArtifactPreviewSession,
  type ArtifactsPreviewStartInput,
  type AttentionRequestListQuery,
  type AttentionRequestMutationResult,
  type AttentionRequestPage,
  type CollectionQuery,
  type CollectionResult,
  type CommandContext,
  type CommandResult,
  type CompleteTaskInput,
  type CreateEntityInput,
  type CreateSpaceInput,
  type CreateSpaceResult,
  type CreateTaskInput,
  type DurableWorkspaceEvent,
  type EdgeView,
  type EntityDetail,
  type EntityFeedPage,
  type EntityId,
  type EntityKindDef,
  type EntitySummary,
  type ExecutionPromptInput,
  type ExecutionSpawnInput,
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
  type ProjectCreateInput,
  type ProjectDirectoryListing,
  type ProjectLinkInput,
  type ProjectResource,
  type ReactionInput,
  type ResolveEntityAttentionInput,
  type SessionJournalPage,
  type SpaceId,
  type SpaceKindCounts,
  type SpaceSettingsView,
  type SpaceSummary,
  type WorkInput,
} from '@tm8/contract';
import type { HttpClient, QueryParams } from './http';
import type { FeedOpts, IdentityView, JournalOpts, LivenessSnapshot, PageOpts } from '../seam';

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

function defaultMutationId(prefix: string): string {
  mutationSeq += 1;
  return `${prefix}_${mutationSeq.toString(36)}_${Date.now().toString(36)}`;
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

    projects(spaceId: SpaceId): Promise<ProjectResource[]> {
      return http.call<ProjectResource[]>('projects.list', { query: { spaceId } });
    },

    projectDirectories(path?: string): Promise<ProjectDirectoryListing> {
      return http.call<ProjectDirectoryListing>('projects.directories.list', { query: { path } });
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

    connections(id: EntityId, opts?: PageOpts): Promise<Page<EdgeView>> {
      return http.call<Page<EdgeView>>('entities.connections', { params: { id }, query: pageQuery(opts) });
    },

    activity(id: EntityId, opts?: PageOpts): Promise<Page<ActivityItem>> {
      return http.call<Page<ActivityItem>>('entities.activity', { params: { id }, query: pageQuery(opts) });
    },

    messages(anchorId: EntityId, opts?: PageOpts): Promise<Page<MessageView>> {
      return http.call<Page<MessageView>>('messages.list', { params: { anchorId }, query: pageQuery(opts) });
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
      return { ...raw, spaceId };
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

    /** Note 1 again: `update_task_content` reads every task field off `content`. */
    patchTask(id: EntityId, input: PatchTaskInput): Promise<CommandResult> {
      const body: PatchEntityInput = {
        ...compact({ actorId: input.actorId, clientMutationId: input.clientMutationId, title: input.title }),
        expectedVersion: input.expectedVersion,
        content: compact({
          description: input.description,
          axes: input.axes,
          workStatus: input.workStatus,
          priority: input.priority,
          acceptanceCriteria: input.acceptanceCriteria,
          pointsEstimate: input.pointsEstimate,
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

    spawn(input: ExecutionSpawnInput): Promise<CommandResult> {
      return http.call<CommandResult>('execution.spawn', { body: input });
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

    resume(id: EntityId, input: ExecutionResumeInput): Promise<CommandResult> {
      return http.call<CommandResult>('execution.resume', { params: { id }, body: input });
    },
  };
}
