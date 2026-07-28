/**
 * createFixtureSeam() — the fixture implementation of the co-owned Facade seam
 * (LLD §10, C-5). Drop-in interchangeable with createRealSeam():
 *
 * - Reads resolve from the FE-owned dataset in ../../fixtures (READ-ONLY —
 *   the whole dataset is deep-cloned once at seam creation, so commands never
 *   mutate the module-level fixture objects and every seam instance is
 *   isolated from every other).
 * - Commands mutate the in-memory clone and synthesize BOTH the authoritative
 *   `CommandResult.patches` AND an echo `DurableWorkspaceEvent` carrying the
 *   caller's `clientMutationId` with a strictly-increasing per-space seq,
 *   dispatched asynchronously (queueMicrotask) through `onEvent` — so FE
 *   stores exercise the REAL optimistic-reconcile path against fixtures.
 * - Events are delivered only for OPEN spaces, matching the seam guarantee
 *   ("durable events for open spaces").
 * - Honesty rules hold: presence is NEVER synthesized (R8 dormant), delivery
 *   facets pass through UNCOLLAPSED ('unknown' stays 'unknown'), menu()
 *   resolves null (C-4 — the UI substitutes its shipped default), and the
 *   liveness predicate is the R-UI-5 rule verbatim — sessionStale evaluates
 *   'stale' and sessionLive 'live' out of the box.
 *
 * Determinism: no Date.now() / Math.random(). Time advances on a fixed
 * 1-second tick from FIXTURE_NOW per mutation; ids and seqs are counters.
 */
import {
  CollabError,
  WORKSPACE_EVENT_SCHEMA_VERSION,
  type ActivityItem,
  type ActorSummary,
  type CollectionQuery,
  type CollectionResult,
  type CommandContext,
  type CommandResult,
  type CompleteTaskInput,
  type CreateEntityInput,
  type CreateTaskInput,
  type CustomEntityState,
  type CustomFieldDef,
  type DurableWorkspaceEvent,
  type EdgeView,
  type EntityContent,
  type EntityDetail,
  type EntityFeedPage,
  type EntityId,
  type EntityKindDef,
  type EntityState,
  type EntitySummary,
  type ExecutionPromptInput,
  type ExecutionSpawnInput,
  type ExecutionTerminateInput,
  type FeedItem,
  type HandoffView,
  type MenuConfig,
  type MessageBatchResult,
  type MessageDeliveryRecord,
  type MessageDeliveryView,
  type MessageView,
  type MoveEntityInput,
  type NotificationItem,
  type Page,
  type PatchEntityInput,
  type PatchMessageInput,
  type PatchTaskInput,
  type PostMessageInput,
  type ReactionInput,
  type SpaceId,
  type SpaceSummary,
  type WorkInput,
  type WorkStatus,
} from '@tm8/contract';
import type {
  ConnectionState,
  FeedOpts,
  FixtureSeam,
  IdentityView,
  LivenessSnapshot,
  PageOpts,
  SessionLiveness,
  Unsubscribe,
} from '../seam';
import {
  FIXTURE_NOW,
  FIXTURE_SPACE_ID,
  ada,
  fixtureDetails,
  fixtureHandoffsBySession,
  fixtureSummaries,
  sessionLive,
} from '../../fixtures';

export const FIXTURE_NODE_BOOT_ID = 'boot-fixture-1';

const clone = <T>(x: T): T => structuredClone(x);

const FIXTURE_BASE_MS = Date.parse(FIXTURE_NOW);

const CAPS_FULL: EntityDetail['capabilities'] = {
  canEdit: true, canDelete: true, canAddChild: true, canLink: true,
  canPull: true, canReact: true, canGrantPoints: true, canComplete: true,
};

const NO_CONNECTIONS: EntityDetail['connections'] = {
  outgoing: [], incoming: [], unresolvedHardDependencyCount: 0,
};

/** Detail-only extras kept beside the summary; hierarchy is recomputed live. */
interface DetailExtras {
  content: EntityContent;
  connections: EntityDetail['connections'];
  capabilities: EntityDetail['capabilities'];
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function isCustomState(s: EntityState): s is CustomEntityState {
  return s.kind.startsWith('c:');
}

/** Minimal kind-correct content for summaries the dataset gives no detail for. */
function synthesizeContent(s: EntitySummary): EntityContent {
  const state = s.state;
  if (isCustomState(state)) return { kind: state.kind, fields: { ...state.fields } };
  switch (state.kind) {
    case 'task':
      return { kind: 'task', description: s.excerpt ?? '', acceptanceCriteria: [], pointsEstimate: null };
    case 'channel':
      return { kind: 'channel', topic: state.topic, pinned: [], autoTabs: [] };
    case 'doc':
      return { kind: 'doc', body: s.excerpt ?? '', format: state.format };
    case 'message':
      return { kind: 'message', body: s.title, mentions: [], attachments: [] };
    case 'member':
      return { kind: 'member', teamMembers: [], work: [] };
    case 'team_member':
      return {
        kind: 'team_member', identity: s.excerpt ?? '', memories: [], capabilities: {},
        commandPermissions: {}, equipped: [], work: [],
      };
    case 'work_session':
      return { kind: 'work_session', nodeId: null, launchProjectId: null, workingOn: [], transcriptDoc: null };
    case 'collection':
      return { kind: 'collection', description: s.excerpt ?? '', items: [] };
    case 'project':
      return { kind: 'project', projectId: state.projectId, materializedVersion: state.materializedVersion };
    case 'interaction_profile':
      return {
        kind: 'interaction_profile', status: state.status, templateKey: 'fixture-template',
        templateVersion: 1, resolvedHash: state.activeHash, generatedByTeamMemberId: null,
      };
    default:
      // pull_request | commit | file | spell | skill — the open content variant
      return { kind: state.kind };
  }
}

export function createFixtureSeam(): FixtureSeam {
  // -- in-memory state (isolated clone of the FE dataset) --------------------
  const summaries = new Map<EntityId, EntitySummary>(
    clone(fixtureSummaries).map((s) => [s.id, s]),
  );
  const extras = new Map<EntityId, DetailExtras>(
    Object.values(clone(fixtureDetails)).map((d) => [
      d.id,
      { content: d.content, connections: d.connections, capabilities: d.capabilities },
    ]),
  );

  const openSpaces = new Set<SpaceId>();
  const seqBySpace = new Map<SpaceId, number>();
  const readMarks = new Map<EntityId, string>();

  const eventSubs = new Set<(e: DurableWorkspaceEvent) => void>();
  const connectionSubs = new Set<(s: ConnectionState) => void>();
  const resyncSubs = new Set<(spaceId: SpaceId) => void>();
  const livenessSubs = new Set<(snap: LivenessSnapshot) => void>();

  // The fixture seam IS its own server: it starts live. Scriptable via
  // fixtureControls.setConnection for the gate-screen honesty demos.
  let connection: ConnectionState = { phase: 'live' };

  let tickN = 0;
  const tick = (): string => new Date(FIXTURE_BASE_MS + ++tickN * 1000).toISOString();
  let idN = 0;
  const nextId = (kind: string): string => `fx-${kind.replace(/^c:/, 'c-')}-${++idN}`;

  // Out-of-the-box liveness truth (C-5): sessionLive is the ONLY live PTY;
  // sessionStale stays running-per-record but absent from the live set.
  const livenessBySpace = new Map<SpaceId, LivenessSnapshot>([
    [FIXTURE_SPACE_ID, {
      spaceId: FIXTURE_SPACE_ID,
      liveEntityIds: [sessionLive.id],
      nodeBootId: FIXTURE_NODE_BOOT_ID,
      checkedAt: FIXTURE_NOW,
    }],
  ]);

  // Deterministic delivery facets, UNCOLLAPSED: agent-batch messages carry one
  // delivered and one honestly-unknown record; everything else has none.
  const workSessionIds = [...summaries.values()]
    .filter((s) => s.kind === 'work_session')
    .map((s) => s.id);
  const deliveriesByMessage = new Map<EntityId, MessageDeliveryRecord[]>();
  for (const s of summaries.values()) {
    if (s.state.kind !== 'message' || s.state.messageBatchId === null) continue;
    deliveriesByMessage.set(s.id, [
      {
        deliveryId: `dlv-${s.id}-1`, messageId: s.id, sourceWorkSessionId: null,
        targetWorkSessionId: workSessionIds[0] ?? 'ws-unknown', status: 'delivered',
        attemptNo: 1, failureReason: null, reservedAt: s.createdAt,
        claimedAt: s.updatedAt, settledAt: s.updatedAt, updatedAt: s.updatedAt,
      },
      {
        deliveryId: `dlv-${s.id}-2`, messageId: s.id, sourceWorkSessionId: null,
        targetWorkSessionId: workSessionIds[1] ?? 'ws-unknown', status: 'unknown',
        attemptNo: 1, failureReason: null, reservedAt: s.createdAt,
        claimedAt: null, settledAt: null, updatedAt: s.updatedAt,
      },
    ]);
  }

  // -- internals -------------------------------------------------------------

  function requireSummary(id: EntityId): EntitySummary {
    const s = summaries.get(id);
    if (!s) throw new CollabError('not_found', `entity ${id} not found`);
    return s;
  }

  function requireVersion(s: EntitySummary, expectedVersion: number): void {
    if (s.version !== expectedVersion) {
      throw new CollabError('version_conflict', `expected version ${expectedVersion}, have ${s.version}`, {
        current: detailOf(s.id),
      });
    }
  }

  function extrasOf(id: EntityId): DetailExtras {
    let e = extras.get(id);
    if (!e) {
      const s = requireSummary(id);
      e = { content: synthesizeContent(s), connections: clone(NO_CONNECTIONS), capabilities: { ...CAPS_FULL } };
      extras.set(id, e);
    }
    return e;
  }

  function childrenOf(id: EntityId): EntitySummary[] {
    return [...summaries.values()]
      .filter((s) => s.parentId === id && s.deletedAt === null)
      .sort((a, b) => a.position - b.position);
  }

  function pathOf(s: EntitySummary): EntitySummary[] {
    const path: EntitySummary[] = [];
    const seen = new Set<EntityId>([s.id]);
    let cur = s.parentId ? summaries.get(s.parentId) : undefined;
    while (cur && !seen.has(cur.id)) {
      path.unshift(cur);
      seen.add(cur.id);
      cur = cur.parentId ? summaries.get(cur.parentId) : undefined;
    }
    return path;
  }

  function detailOf(id: EntityId): EntityDetail {
    const s = requireSummary(id);
    const e = extrasOf(id);
    return {
      ...s,
      content: e.content,
      hierarchy: {
        parent: s.parentId ? summaries.get(s.parentId) ?? null : null,
        children: { items: childrenOf(id), nextCursor: null, total: childrenOf(id).length },
        path: pathOf(s),
      },
      connections: e.connections,
      capabilities: e.capabilities,
    };
  }

  function toMessageView(s: EntitySummary): MessageView {
    if (s.state.kind !== 'message') throw new CollabError('invariant_violation', `${s.id} is not a message`);
    const content = extrasOf(s.id).content;
    if (content.kind !== 'message') throw new CollabError('invariant_violation', `${s.id} content is not a message`);
    const replyCount = [...summaries.values()]
      .filter((m) => m.state.kind === 'message' && m.state.rootMessageId === s.id).length;
    return { ...s, state: s.state, content, replyCount };
  }

  /** Strictly increasing per space; the client's dedupe/order key. */
  function nextSeq(spaceId: SpaceId): number {
    const seq = (seqBySpace.get(spaceId) ?? 1000) + 1;
    seqBySpace.set(spaceId, seq);
    return seq;
  }

  // Distributive omit: plain Omit over the event union collapses to the keys
  // common to every variant and rejects variant-specific payload fields.
  type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
  type EventBody = OmitEach<DurableWorkspaceEvent, 'spaceId' | 'seq' | 'occurredAt' | 'schemaVersion'>;

  /** Envelope + async dispatch. Delivered only for OPEN spaces (seam guarantee). */
  function emit(spaceId: SpaceId, body: EventBody, ctx?: CommandContext): void {
    if (!openSpaces.has(spaceId)) return;
    const event = {
      ...body,
      ...(ctx?.clientMutationId !== undefined ? { clientMutationId: ctx.clientMutationId } : {}),
      spaceId,
      seq: nextSeq(spaceId),
      occurredAt: tick(),
      schemaVersion: WORKSPACE_EVENT_SCHEMA_VERSION,
    } as DurableWorkspaceEvent;
    queueMicrotask(() => {
      const frozen = clone(event);
      for (const cb of eventSubs) cb(frozen);
    });
  }

  function touch(s: EntitySummary): void {
    s.version += 1;
    const at = tick();
    s.updatedAt = at;
    s.activityAt = at;
  }

  function pageOf<T>(all: T[], opts?: PageOpts): Page<T> {
    const start = opts?.cursor ? Math.max(0, Number.parseInt(opts.cursor, 10) || 0) : 0;
    const limit = opts?.limit ?? 50;
    const end = Math.min(all.length, start + limit);
    return { items: all.slice(start, end), nextCursor: end < all.length ? String(end) : null, total: all.length };
  }

  function subtreeIds(rootId: EntityId): Set<EntityId> {
    const ids = new Set<EntityId>([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of summaries.values()) {
        if (s.parentId !== null && ids.has(s.parentId) && !ids.has(s.id)) {
          ids.add(s.id);
          grew = true;
        }
      }
    }
    ids.delete(rootId);
    return ids;
  }

  function commandResult(s: EntitySummary, over: Partial<CommandResult> = {}): CommandResult {
    return clone({ entity: detailOf(s.id), patches: [s], ...over });
  }

  function defaultStateFor(input: CreateEntityInput): EntityState {
    const c = (input.content ?? {}) as Record<string, unknown>;
    const kind = input.kind;
    if (kind.startsWith('c:')) {
      return { kind: kind as `c:${string}`, fields: (c.fields as CustomEntityState['fields']) ?? {} };
    }
    switch (kind) {
      case 'task':
        return {
          kind: 'task', workStatus: 'open', priority: 'medium', axes: {},
          dueDate: null, assignees: [], acceptance: { total: 0, completed: 0 },
        };
      case 'channel':
        return { kind: 'channel', topic: (c.topic as string) ?? '', unreadCount: 0, workingAgentCount: 0 };
      case 'doc':
        return { kind: 'doc', format: (c.format as 'markdown') ?? 'markdown', childCount: 0 };
      case 'team_member':
        return { kind: 'team_member', owner: viewerActor, model: null, agentTool: null, liveWork: null };
      case 'file':
        return {
          kind: 'file', name: (c.name as string) ?? input.title,
          mimeType: (c.mimeType as string) ?? 'application/octet-stream',
          sizeBytes: (c.sizeBytes as number) ?? 0,
        };
      case 'spell':
      case 'skill':
        return { kind, description: c.description as string | undefined, equipped: false };
      case 'pull_request':
        return {
          kind: 'pull_request', repository: (c.repository as string) ?? '',
          number: (c.number as number) ?? 0, state: 'open', stale: false,
        };
      case 'commit':
        return {
          kind: 'commit', repository: (c.repository as string) ?? '',
          sha: (c.sha as string) ?? '', message: input.title, committedAt: null,
        };
      case 'collection':
        return { kind: 'collection', collectionType: (c.collectionType as string) ?? 'manual', itemCount: 0 };
      default:
        throw new CollabError('invalid_input', `kind ${kind} is not client-creatable`);
    }
  }

  function insertSummary(partial: Pick<EntitySummary, 'id' | 'kind' | 'title' | 'state'> & Partial<EntitySummary>): EntitySummary {
    const at = tick();
    const s: EntitySummary = {
      spaceId: FIXTURE_SPACE_ID,
      parentId: null,
      position: partial.parentId ? childrenOf(partial.parentId).length : 0,
      visibility: 'space',
      version: 1,
      activityAt: at,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      createdBy: viewerActor,
      counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
      badges: {},
      ...partial,
    };
    summaries.set(s.id, s);
    return s;
  }

  const viewerActor: ActorSummary = clone(ada);

  const identityView: IdentityView = {
    identityId: 'idn-ada',
    accountId: 'acct-ada',
    username: 'ada',
    displayName: viewerActor.displayName,
    avatar: viewerActor.avatar ?? null,
    email: null,
    isNodeAdmin: true,
    isOwner: true,
    status: 'active',
    actingAs: null,
    memberships: [{ spaceId: FIXTURE_SPACE_ID, memberId: viewerActor.id, role: 'owner' }],
  };

  const spaceSummary: SpaceSummary = {
    id: FIXTURE_SPACE_ID,
    name: 'atelier',
    description: 'Fixture space backing the tm8-ui gate screen.',
    memberCount: 2,
    unreadTotal: 12,
    githubRepo: 'subhang/tm8',
    createdAt: '2026-07-20T09:00:00.000Z',
  };

  // -- the seam --------------------------------------------------------------

  const seam: FixtureSeam = {
    async openSpace(spaceId) {
      openSpaces.add(spaceId);
      if (!seqBySpace.has(spaceId)) seqBySpace.set(spaceId, 1000);
    },
    closeSpace(spaceId) {
      openSpaces.delete(spaceId);
    },
    dispose() {
      openSpaces.clear();
      eventSubs.clear();
      connectionSubs.clear();
      resyncSubs.clear();
      livenessSubs.clear();
    },

    onEvent(cb) {
      eventSubs.add(cb);
      return () => eventSubs.delete(cb);
    },
    onConnection(cb) {
      connectionSubs.add(cb);
      return () => connectionSubs.delete(cb);
    },
    getConnection() {
      return clone(connection);
    },
    onResync(cb) {
      resyncSubs.add(cb);
      return () => resyncSubs.delete(cb);
    },

    async identity() {
      return clone(identityView);
    },
    async spaces() {
      return clone([spaceSummary]);
    },
    /** C-4: the dataset ships no menu row — resolve null, UI uses its default. */
    async menu(_spaceId): Promise<MenuConfig | null> {
      return null;
    },
    async query(input: CollectionQuery): Promise<CollectionResult> {
      const deleted = input.filters?.deleted ?? 'exclude';
      const subtree = input.subtreeOf ? subtreeIds(input.subtreeOf) : null;
      let rows = [...summaries.values()].filter((s) => {
        if (s.spaceId !== input.spaceId) return false;
        if (deleted === 'exclude' && s.deletedAt !== null) return false;
        if (deleted === 'only' && s.deletedAt === null) return false;
        if (input.kinds && !input.kinds.includes(s.kind)) return false;
        if (input.parentId !== undefined && s.parentId !== input.parentId) return false;
        if (subtree && !subtree.has(s.id)) return false;
        const f = input.filters;
        if (f?.workStatus && !(s.state.kind === 'task' && f.workStatus.includes(s.state.workStatus))) return false;
        if (f?.assigneeIds && !(s.state.kind === 'task'
          && s.state.assignees.some((a) => f.assigneeIds!.includes(a.id)))) return false;
        return true;
      });
      const sort = input.sort ?? 'activityAt_desc';
      rows = rows.sort((a, b) => {
        switch (sort) {
          case 'position': return a.position - b.position;
          case 'createdAt_desc': return b.createdAt.localeCompare(a.createdAt);
          case 'dueDate': {
            const da = a.state.kind === 'task' ? a.state.dueDate ?? '9999' : '9999';
            const db = b.state.kind === 'task' ? b.state.dueDate ?? '9999' : '9999';
            return da.localeCompare(db);
          }
          case 'priority': {
            const pa = a.state.kind === 'task' ? PRIORITY_RANK[a.state.priority] : 9;
            const pb = b.state.kind === 'task' ? PRIORITY_RANK[b.state.priority] : 9;
            return pa - pb;
          }
          default: return b.activityAt.localeCompare(a.activityAt);
        }
      });
      return clone({ query: input, page: pageOf(rows, input) });
    },
    /** LLD §14: custom-kind (`c:*`) existence + naming metadata ONLY. */
    async entityKinds(spaceId): Promise<EntityKindDef[]> {
      const custom = new Map<string, EntitySummary>();
      for (const s of summaries.values()) {
        if (s.kind.startsWith('c:') && !custom.has(s.kind)) custom.set(s.kind, s);
      }
      return clone([...custom.entries()].map(([kind, sample]): EntityKindDef => {
        const fields = isCustomState(sample.state) ? sample.state.fields : {};
        const fieldSchema: CustomFieldDef[] = Object.entries(fields).map(([name, v]) => ({
          name,
          type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'text',
        }));
        return {
          id: `kind-${kind}`, kind: kind as `c:${string}`, origin: 'custom', spaceId,
          icon: null, fieldSchema, capabilities: {}, createdBy: null, createdAt: FIXTURE_NOW,
        };
      }));
    },
    async entity(id) {
      return clone(detailOf(id));
    },
    async children(id, opts) {
      requireSummary(id);
      return clone(pageOf(childrenOf(id), opts));
    },
    async connections(id): Promise<Page<EdgeView>> {
      requireSummary(id);
      const c = extrasOf(id).connections;
      const edges = [...c.outgoing, ...c.incoming].flatMap((g) => g.edges);
      return clone({ items: edges, nextCursor: null, total: edges.length });
    },
    async activity(id, opts): Promise<Page<ActivityItem>> {
      const s = requireSummary(id);
      const items: ActivityItem[] = [{
        id: `act-${id}-created`, entityId: id, actor: s.createdBy, verb: 'created',
        summary: { title: s.title }, createdAt: s.createdAt, refId: null, workSessionId: null,
      }];
      if (s.updatedAt !== s.createdAt) {
        items.unshift({
          id: `act-${id}-updated`, entityId: id, actor: s.createdBy, verb: 'updated',
          summary: { title: s.title, version: s.version }, createdAt: s.updatedAt,
          refId: null, workSessionId: null,
        });
      }
      return clone(pageOf(items, opts));
    },
    async messages(anchorId, opts): Promise<Page<MessageView>> {
      requireSummary(anchorId);
      const rows = [...summaries.values()]
        .filter((s) => s.state.kind === 'message' && s.state.anchorId === anchorId && s.deletedAt === null)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(toMessageView);
      return clone(pageOf(rows, opts));
    },
    async handoffs(workSessionId, opts): Promise<Page<HandoffView>> {
      requireSummary(workSessionId);
      // FE's A1c dataset: the complete legal deliveryStatus × recordStatus
      // matrix, keyed by target work session — sessions without rows page empty.
      return clone(pageOf(fixtureHandoffsBySession[workSessionId] ?? [], opts));
    },
    async inbox(opts): Promise<Page<NotificationItem>> {
      // The dataset carries no notification rows: the inbox is honestly empty.
      return clone(pageOf<NotificationItem>([], opts));
    },
    async feed(id, opts?: FeedOpts): Promise<EntityFeedPage> {
      const anchor = requireSummary(id);
      const items: FeedItem[] = [...summaries.values()]
        .filter((s) => s.state.kind === 'message' && s.state.anchorId === id && s.deletedAt === null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((s) => {
          const view = toMessageView(s);
          return {
            itemId: `feed-${s.id}`,
            createdAt: s.createdAt,
            sortId: `${s.createdAt}#${s.id}`,
            via: ['anchored' as const],
            actor: view.state.author,
            // Honest G2 gap: authored_from is null through public writes.
            sourceWorkSessionId: null,
            anchor,
            logicalOperationId: null,
            itemKind: 'message' as const,
            message: view,
            delivery: (deliveriesByMessage.get(s.id) ?? []).map((d) => ({
              deliveryId: d.deliveryId, targetWorkSessionId: d.targetWorkSessionId,
              status: d.status, attemptNo: d.attemptNo, failureReason: d.failureReason,
              updatedAt: d.updatedAt,
            })),
          };
        });
      return clone({
        resolvedScope: opts?.scope ?? 'direct_v1',
        predicates: ['anchored' as const],
        items,
        nextCursor: null,
      });
    },
    /** Facets pass through UNCOLLAPSED — 'unknown' stays exactly 'unknown'. */
    async delivery(messageId): Promise<MessageDeliveryView> {
      const s = requireSummary(messageId);
      return clone({
        message: toMessageView(s),
        deliveries: deliveriesByMessage.get(messageId) ?? [],
      });
    },

    commands: {
      async createEntity(input) {
        if (input.parentId) requireSummary(input.parentId);
        const s = insertSummary({
          id: nextId(input.kind),
          kind: input.kind,
          title: input.title,
          spaceId: input.spaceId,
          parentId: input.parentId ?? null,
          ...(input.position !== undefined ? { position: input.position } : {}),
          state: defaultStateFor(input),
        });
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      async createTask(input: CreateTaskInput) {
        if (input.parentId) requireSummary(input.parentId);
        const criteria = (input.acceptanceCriteria ?? []).map((c, i) => ({
          id: c.id ?? `ac-fx-${i + 1}`, text: c.text, done: c.done ?? false,
        }));
        const s = insertSummary({
          id: nextId('task'),
          kind: 'task',
          title: input.title,
          spaceId: input.spaceId,
          parentId: input.parentId ?? null,
          ...(input.position !== undefined ? { position: input.position } : {}),
          excerpt: input.description,
          state: {
            kind: 'task', workStatus: 'open', priority: input.priority ?? 'medium',
            axes: input.axes ?? {}, dueDate: input.dueDate ?? null, assignees: [],
            acceptance: { total: criteria.length, completed: criteria.filter((c) => c.done).length },
          },
        });
        extras.set(s.id, {
          content: {
            kind: 'task', description: input.description ?? '',
            acceptanceCriteria: criteria, pointsEstimate: input.pointsEstimate ?? null,
          },
          connections: clone(NO_CONNECTIONS),
          capabilities: { ...CAPS_FULL },
        });
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      async patchEntity(id, input: PatchEntityInput) {
        const s = requireSummary(id);
        requireVersion(s, input.expectedVersion);
        if (input.title !== undefined) s.title = input.title;
        if (input.content !== undefined) {
          const e = extrasOf(id);
          e.content = { ...e.content, ...input.content } as EntityContent;
        }
        touch(s);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      async patchTask(id, input: PatchTaskInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'task') throw new CollabError('invariant_violation', `${id} is not a task`);
        requireVersion(s, input.expectedVersion);
        if (input.title !== undefined) s.title = input.title;
        if (input.workStatus !== undefined) s.state.workStatus = input.workStatus;
        if (input.priority !== undefined) s.state.priority = input.priority;
        if (input.axes !== undefined) s.state.axes = input.axes;
        if (input.dueDate !== undefined) s.state.dueDate = input.dueDate;
        const e = extrasOf(id);
        if (e.content.kind === 'task') {
          if (input.description !== undefined) e.content.description = input.description;
          if (input.pointsEstimate !== undefined) e.content.pointsEstimate = input.pointsEstimate;
          if (input.acceptanceCriteria !== undefined) {
            e.content.acceptanceCriteria = input.acceptanceCriteria;
            s.state.acceptance = {
              total: input.acceptanceCriteria.length,
              completed: input.acceptanceCriteria.filter((c) => c.done).length,
            };
          }
        }
        touch(s);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      async moveEntity(id, input: MoveEntityInput) {
        const s = requireSummary(id);
        requireVersion(s, input.expectedVersion);
        if (input.parentId !== null) requireSummary(input.parentId);
        s.parentId = input.parentId;
        s.position = input.position;
        touch(s);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      async deleteEntity(id, ctx) {
        const s = requireSummary(id);
        if (s.deletedAt !== null) throw new CollabError('conflict', `${id} is already deleted`);
        s.deletedAt = tick();
        touch(s);
        emit(s.spaceId, { type: 'entity.deleted', entity: clone(s) }, ctx);
        return commandResult(s, { undo: { token: `undo-${s.id}-${s.version}`, label: `Restore ${s.title}` } });
      },
      async restoreEntity(id, ctx) {
        const s = requireSummary(id);
        if (s.deletedAt === null) throw new CollabError('conflict', `${id} is not deleted`);
        s.deletedAt = null;
        touch(s);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, ctx);
        return commandResult(s);
      },
      async complete(id, input: CompleteTaskInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'task') throw new CollabError('invariant_violation', `${id} is not a task`);
        requireVersion(s, input.expectedVersion);
        s.state.workStatus = 'done';
        s.state.acceptance = { ...s.state.acceptance, completed: s.state.acceptance.total };
        touch(s);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      async work(id, input: WorkInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'task') throw new CollabError('invariant_violation', `${id} is not a task`);
        s.state.workStatus = input.status;
        touch(s);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      async postMessage(input: PostMessageInput): Promise<CommandResult | MessageBatchResult> {
        if (input.anchorIds.length === 0) throw new CollabError('invalid_input', 'anchorIds must not be empty');
        const anchors = input.anchorIds.map(requireSummary);
        const batchId = anchors.length > 1 ? `fx-batch-${++idN}` : null;
        const views: MessageView[] = [];
        for (const anchor of anchors) {
          const s = insertSummary({
            id: nextId('msg'),
            kind: 'message',
            title: input.body.slice(0, 80),
            spaceId: anchor.spaceId,
            parentId: anchor.id,
            state: {
              kind: 'message', anchorId: anchor.id,
              rootMessageId: input.parentMessageId ?? null,
              author: viewerActor, messageBatchId: batchId, editedAt: null,
            },
          });
          extras.set(s.id, {
            content: {
              kind: 'message', body: input.body,
              mentions: (input.mentionIds ?? []).flatMap((mid) => {
                const m = summaries.get(mid);
                return m && (m.kind === 'member' || m.kind === 'team_member')
                  ? [{ entityId: mid, kind: m.kind, display: m.title }] : [];
              }),
              attachments: (input.attachmentIds ?? []).flatMap((fid) => {
                const f = summaries.get(fid);
                return f && f.state.kind === 'file'
                  ? [{ fileEntityId: fid, name: f.state.name, mime: f.state.mimeType }] : [];
              }),
            },
            connections: clone(NO_CONNECTIONS),
            capabilities: { ...CAPS_FULL },
          });
          anchor.counters = { ...anchor.counters, messages: anchor.counters.messages + 1 };
          anchor.activityAt = s.createdAt;
          const view = toMessageView(s);
          views.push(view);
          emit(anchor.spaceId, { type: 'message.created', anchorId: anchor.id, message: clone(view) }, input);
        }
        if (batchId !== null) return clone({ messageBatchId: batchId, messages: views });
        const s = summaries.get(views[0].id)!;
        return commandResult(s, { patches: [s, anchors[0]] });
      },
      async editMessage(id, input: PatchMessageInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'message') throw new CollabError('invariant_violation', `${id} is not a message`);
        requireVersion(s, input.expectedVersion);
        const e = extrasOf(id);
        if (e.content.kind === 'message') {
          e.content.body = input.body;
          if (input.mentions !== undefined) e.content.mentions = input.mentions;
        }
        s.title = input.body.slice(0, 80);
        touch(s);
        s.state.editedAt = s.updatedAt;
        emit(s.spaceId, { type: 'message.updated', anchorId: s.state.anchorId, message: clone(toMessageView(s)) }, input);
        return commandResult(s);
      },
      async react(id, input: ReactionInput) {
        const s = requireSummary(id);
        const key = { like: 'likes', dislike: 'dislikes', star: 'stars' } as const;
        const counters = { ...s.counters };
        const prev = counters.viewerReaction;
        if (input.enabled) {
          if (prev && prev !== input.reaction) counters[key[prev]] -= 1;
          if (prev !== input.reaction) counters[key[input.reaction]] += 1;
          counters.viewerReaction = input.reaction;
        } else if (prev === input.reaction) {
          counters[key[input.reaction]] -= 1;
          counters.viewerReaction = null;
        }
        s.counters = counters;
        emit(s.spaceId, { type: 'counter.changed', entityId: id, counters: clone(counters) }, input);
        return clone({ patches: [s] });
      },
      async markRead(notificationId) {
        // The fixture inbox is honestly empty (no notification rows exist),
        // so every markRead is a not_found — exercising the rollback path.
        throw new CollabError('not_found', `notification ${notificationId} not found`);
      },
      async upsertReadMark(anchorId, lastReadAt) {
        requireSummary(anchorId);
        readMarks.set(anchorId, lastReadAt);
      },
      async spawn(input: ExecutionSpawnInput) {
        requireSummary(input.teamMemberId);
        const tasks = (input.taskIds ?? []).map(requireSummary);
        const startedAt = tick();
        const s = insertSummary({
          id: nextId('ws'),
          kind: 'work_session',
          title: input.title ?? `session · ${input.teamMemberId}`,
          spaceId: input.spaceId,
          parentId: tasks[0]?.id ?? null,
          state: {
            kind: 'work_session', status: 'running',
            agentTool: input.agentTool ?? 'claude-code', model: input.model ?? null,
            shareMode: 'space', startedAt, exitedAt: null,
          },
        });
        extras.set(s.id, {
          content: {
            kind: 'work_session', nodeId: 'node-fixture',
            launchProjectId: input.projectId ?? null,
            workingOn: clone(tasks), transcriptDoc: null,
          },
          connections: clone(NO_CONNECTIONS),
          capabilities: { ...CAPS_FULL },
        });
        const snap = livenessBySpace.get(input.spaceId);
        setLiveness(input.spaceId, [...(snap?.liveEntityIds ?? []), s.id], snap?.nodeBootId);
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
      async prompt(id, _input: ExecutionPromptInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'work_session') throw new CollabError('invariant_violation', `${id} is not a work_session`);
        if (s.state.status !== 'running') {
          throw new CollabError('invariant_violation', `session ${id} is not running`);
        }
        // PTY delivery, not graph state — only activity moves.
        s.activityAt = tick();
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, _input);
        return clone({ patches: [s] });
      },
      async terminate(id, input: ExecutionTerminateInput) {
        const s = requireSummary(id);
        if (s.state.kind !== 'work_session') throw new CollabError('invariant_violation', `${id} is not a work_session`);
        s.state.status = 'exited';
        s.state.exitedAt = tick();
        touch(s);
        const snap = livenessBySpace.get(s.spaceId);
        if (snap?.liveEntityIds.includes(id)) {
          setLiveness(s.spaceId, snap.liveEntityIds.filter((x) => x !== id), snap.nodeBootId);
        }
        emit(s.spaceId, { type: 'entity.upsert', entity: clone(s) }, input);
        return commandResult(s);
      },
    },

    liveness: {
      async refresh(spaceId) {
        let snap = livenessBySpace.get(spaceId);
        if (!snap) {
          snap = { spaceId, liveEntityIds: [], nodeBootId: FIXTURE_NODE_BOOT_ID, checkedAt: tick() };
          livenessBySpace.set(spaceId, snap);
        }
        return clone(snap);
      },
      onChange(cb) {
        livenessSubs.add(cb);
        return () => livenessSubs.delete(cb);
      },
      /**
       * THE R-UI-5 predicate — the only place liveness truth is computed:
       *   workStatus !== 'running'  → 'not-running'
       *   no snapshot for the space → 'unknown' (rendered neutral, NEVER live)
       *   id ∈ liveEntityIds        → 'live'
       *   otherwise                 → 'stale'
       * NOTE (flagged to bridge, not fixed here — seam.ts is locked): the seam
       * types `workStatus` with the task `WorkStatus` vocabulary, which cannot
       * express the work_session `'running'` literal; the comparison widens.
       */
      statusOf(session): SessionLiveness {
        if ((session.workStatus as string | null) !== 'running') return 'not-running';
        const s = summaries.get(session.id);
        const snap = s ? livenessBySpace.get(s.spaceId) : undefined;
        if (!snap) return 'unknown';
        return snap.liveEntityIds.includes(session.id) ? 'live' : 'stale';
      },
    },

    fixtureControls: {
      setConnection(state) {
        connection = clone(state);
        for (const cb of connectionSubs) cb(clone(state));
      },
      setLiveness,
      triggerResync(spaceId) {
        for (const cb of resyncSubs) cb(spaceId);
      },
    },
  };

  function setLiveness(spaceId: SpaceId, liveEntityIds: string[], nodeBootId?: string): void {
    const snap: LivenessSnapshot = {
      spaceId,
      liveEntityIds: [...liveEntityIds],
      nodeBootId: nodeBootId ?? livenessBySpace.get(spaceId)?.nodeBootId ?? FIXTURE_NODE_BOOT_ID,
      checkedAt: tick(),
    };
    livenessBySpace.set(spaceId, snap);
    for (const cb of livenessSubs) cb(clone(snap));
  }

  return seam;
}
