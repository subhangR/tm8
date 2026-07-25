/**
 * MockWorld — the in-memory Collab V2 entity graph with REAL semantics.
 *
 * Everything the contract says the backend owns is computed here, not faked in
 * components: version bumps on content writes, activity_at bumps on messages/
 * edges, counter maintenance, blocked rollups from unresolved hard deps,
 * PullState staleness, channel auto-tab derivation, completion → award →
 * leaderboard, unblock ripple, undo tokens for placements.
 *
 * MockWorld is synchronous and deterministic (injectable clock). MockFacade
 * wraps it with latency, error injection, and event dispatch.
 */
import {
  CollabError,
  type ActivityItem, type ActorSummary, type ChannelTab, type CollectionGroup,
  type CollectionQuery, type CollectionResult, type CommandContext,
  type CommandResult, type CompleteTaskInput, type Connections,
  type CreateEdgeInput, type CreateEntityInput, type CreateTaskInput,
  type Cursor, type EdgeGroup, type EdgeView, type EntityContent,
  type EntityDetail, type EntityId, type EntityKind, type EntityState,
  type EntitySummary, type GraphQuery, type GraphResult, type Hierarchy,
  type HomeSnapshot, type LeaderboardRow, type LinkPrInput, type LiveWork,
  type MessageView, type PresenceWorkspaceEvent,
  type MoveEntityInput, type NotificationItem, type Page, type PaletteAction,
  type PatchEdgeInput, type PatchEntityInput, type PatchMessageInput,
  type PatchTaskInput, type PlacementInput, type PointEventView,
  type PostMessageInput, type PresenceSnapshot, type PullInput,
  type GrantPointsInput, type ReactionInput, type SavedView, type SavedViewInput,
  type SpaceId, type SpaceNavigation, type NavChannelNode, type SpaceSettings,
  type SpaceSummary, type TaskAxis, type TaskAxisInput, type TrackingRefreshInput,
  type UndoToken, type WorkInput, type WorkspaceEvent, type PullState,
  type EntityBadges, type WorkStatus,
} from '../types/contract';
import {
  EDGE_TYPES, REACTION_TYPES, decodeCursor, edgeTypeLabel, embedToken,
  encodeCursor, excerptOf, iso, validateEdgeType,
  type ActivityRec, type Clock, type EdgeRec, type EntityRec, type KindData,
  type NotificationRec, type PointEventRec, type PresenceRec, type SavedViewRec,
  type SpaceRec, type TaskAxisRec, type VersionRec,
} from './internal';
import { COMMAND_FIELDS, CREATE_CONTENT, PATCH_CONTENT, assertContent, assertInput } from './validate';

const DEFAULT_PAGE = 50;
const PR_STALE_MS = 15 * 60 * 1000;
/** DEV-11: undo tokens are redeemable for 5 minutes. */
const UNDO_TTL_MS = 5 * 60 * 1000;
const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const STATUS_ORDER: WorkStatus[] = ['open', 'pulled', 'working', 'in_review', 'blocked', 'done', 'cancelled'];

export class MockWorld {
  readonly clock: Clock;
  /** The member entity all reads are scoped to (unread, viewerReaction, home). */
  viewerId: EntityId = '';

  readonly spaces = new Map<SpaceId, SpaceRec>();
  readonly entities = new Map<EntityId, EntityRec>();
  readonly edges = new Map<string, EdgeRec>();
  readonly pointEvents: PointEventRec[] = [];
  readonly notifications: NotificationRec[] = [];
  readonly activity: ActivityRec[] = [];
  readonly versions = new Map<EntityId, VersionRec[]>();
  readonly readMarks = new Map<string, number>();
  readonly taskAxes = new Map<string, TaskAxisRec>();
  readonly savedViews = new Map<string, SavedViewRec>();
  readonly presence = new Map<EntityId, PresenceRec>();

  private pending: WorkspaceEvent[] = [];
  /** DEV-4: presence/typing never enter `pending` — they drain separately. */
  private pendingPresence: PresenceWorkspaceEvent[] = [];
  private undoOps = new Map<string, { label: string; mintedAt: number; run: () => CommandResult }>();
  /**
   * DEV-9 command ledger: every mutation records (clientMutationId, operation,
   * result); a retry with the same id + op replays the stored result, a same-id
   * DIFFERENT-op call is an invariant_violation (04 §5.1).
   */
  private ledger = new Map<string, { op: string; value: unknown }>();
  private seq = 0;
  /**
   * Recursion guard: badges embed entity summaries (waitingOn, LiveWork.task),
   * which would recompute badges forever (task ↔ workingActors). Summaries
   * nested inside badge/live-work projections carry empty badges instead.
   */
  private badgeDepth = 0;

  constructor(clock: Clock = () => Date.now()) {
    this.clock = clock;
  }

  // ==========================================================================
  // ids, clock, event plumbing
  // ==========================================================================

  nextId(prefix: string): string { this.seq += 1; return `${prefix}_${this.seq.toString(36).padStart(4, '0')}`; }
  private nextEventId(): string { return this.nextId('evt'); }
  now(): number { return this.clock(); }

  /** Returns and clears the DURABLE events produced by the last mutation batch. */
  drainEvents(): WorkspaceEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** Returns and clears pending client-synthesized presence/typing events (DEV-4). */
  drainPresenceEvents(): PresenceWorkspaceEvent[] {
    const out = this.pendingPresence;
    this.pendingPresence = [];
    return out;
  }

  private emitEntity(id: EntityId, clientMutationId?: string): void {
    const rec = this.entities.get(id);
    if (!rec) return;
    if (rec.deletedAt != null) {
      this.pending.push({ type: 'entity.deleted', eventId: this.nextEventId(), entity: this.summary(rec), clientMutationId });
    } else {
      this.pending.push({ type: 'entity.upsert', eventId: this.nextEventId(), entity: this.summary(rec), clientMutationId });
    }
  }
  private emitEdge(edge: EdgeRec, deleted = false, clientMutationId?: string): void {
    this.pending.push({
      type: deleted ? 'edge.deleted' : 'edge.upsert', eventId: this.nextEventId(),
      edge: this.edgeView(edge), clientMutationId,
    });
  }
  private emitCounter(id: EntityId): void {
    const rec = this.entities.get(id);
    if (!rec) return;
    this.pending.push({
      type: 'counter.changed', eventId: this.nextEventId(), entityId: id,
      counters: { ...rec.counters, viewerReaction: this.viewerReactionOf(id) },
    });
  }
  private emitMessage(type: 'message.created'|'message.updated'|'message.deleted', id: EntityId): void {
    const rec = this.entities.get(id);
    if (!rec || rec.data.kind !== 'message') return;
    this.pending.push({
      type, eventId: this.nextEventId(), anchorId: rec.data.message.anchorId,
      message: this.messageView(rec),
    });
  }
  private pushActivity(partial: Omit<ActivityRec, 'id' | 'createdAt'>): ActivityItem {
    const rec: ActivityRec = { ...partial, id: this.nextId('act'), createdAt: this.now() };
    this.activity.push(rec);
    const item = this.activityItem(rec);
    this.pending.push({ type: 'activity.created', eventId: this.nextEventId(), activity: item });
    return item;
  }
  private pushNotification(partial: Omit<NotificationRec, 'id' | 'createdAt' | 'readAt'>): void {
    const rec: NotificationRec = { ...partial, id: this.nextId('ntf'), createdAt: this.now(), readAt: null };
    this.notifications.push(rec);
    this.pending.push({ type: 'notification.created', eventId: this.nextEventId(), notification: this.notificationItem(rec) });
  }

  // ==========================================================================
  // lookups + guards
  // ==========================================================================

  private rec(id: EntityId, opts: { allowDeleted?: boolean } = {}): EntityRec {
    const rec = this.entities.get(id);
    if (!rec) throw new CollabError('not_found', `entity ${id} not found`);
    if (rec.deletedAt != null && !opts.allowDeleted) {
      throw new CollabError('not_found', `entity ${id} is deleted`);
    }
    return rec;
  }

  private actorRec(id: EntityId | undefined): EntityRec {
    const actorId = id ?? this.viewerId;
    const rec = this.rec(actorId);
    if (rec.kind !== 'member' && rec.kind !== 'team_member') {
      throw new CollabError('invalid_input', `actor ${actorId} is not a member or team_member`);
    }
    return rec;
  }

  /** The human member an actor resolves to (a TM resolves to its owner). */
  private ownerMemberIdOf(actorId: EntityId): EntityId {
    const rec = this.entities.get(actorId);
    if (!rec) return actorId;
    return rec.data.kind === 'team_member' ? rec.data.teamMember.ownerMemberId : actorId;
  }

  private edgesFrom(srcId: EntityId, type?: string): EdgeRec[] {
    const out: EdgeRec[] = [];
    for (const e of this.edges.values()) {
      if (e.srcId === srcId && (!type || e.type === type)) out.push(e);
    }
    return out;
  }
  private edgesTo(dstId: EntityId, type?: string): EdgeRec[] {
    const out: EdgeRec[] = [];
    for (const e of this.edges.values()) {
      if (e.dstId === dstId && (!type || e.type === type)) out.push(e);
    }
    return out;
  }
  private findEdge(srcId: EntityId, dstId: EntityId, type: string): EdgeRec | undefined {
    for (const e of this.edges.values()) {
      if (e.srcId === srcId && e.dstId === dstId && e.type === type) return e;
    }
    return undefined;
  }

  private liveEntity(id: EntityId): EntityRec | undefined {
    const rec = this.entities.get(id);
    return rec && rec.deletedAt == null ? rec : undefined;
  }

  // ==========================================================================
  // Derived semantics (the backend-owned fields of contract §6)
  // ==========================================================================

  /** Kind-aware dependency resolution (design §7.4). */
  isResolved(id: EntityId): boolean {
    const rec = this.entities.get(id);
    if (!rec || rec.deletedAt != null) return false;
    if (rec.data.kind === 'task') return rec.data.task.workStatus === 'done';
    if (rec.data.kind === 'pull_request') return rec.data.pullRequest.state === 'merged';
    return true; // doc/spell/skill/file/commit/…: exists and not deleted
  }

  unresolvedHardDeps(id: EntityId): EdgeRec[] {
    return this.edgesFrom(id, 'depends_on').filter((e) => {
      const hard = e.props.hard !== false;
      return hard && this.liveEntity(e.dstId) != null && !this.isResolved(e.dstId);
    });
  }

  private pullStatesOf(id: EntityId): PullState[] {
    const rec = this.entities.get(id);
    if (!rec) return [];
    return this.edgesTo(id, 'pulled')
      .filter((e) => this.liveEntity(e.srcId))
      .map((e) => {
        const pulledAtMs = typeof e.props.pulledAt === 'number' ? (e.props.pulledAt as number) : e.createdAt;
        const pinnedVersion = typeof e.props.pinnedVersion === 'number' ? (e.props.pinnedVersion as number) : rec.version;
        return {
          actor: this.actorSummary(e.srcId),
          localId: (e.props.localId as string | null | undefined) ?? null,
          pinnedVersion,
          contentStale: pinnedVersion < rec.version,
          discussionMoved: rec.activityAt > pulledAtMs,
          workStatus: (e.props.workStatus as string | null | undefined) ?? null,
          pulledAt: iso(pulledAtMs),
        };
      });
  }

  private liveWorkOf(actorId: EntityId): LiveWork | null {
    const e = this.edgesFrom(actorId, 'working_on').find((x) => this.liveEntity(x.dstId));
    if (!e) return null;
    return {
      actor: this.actorSummary(actorId),
      task: this.summary(this.rec(e.dstId)),
      startedAt: iso(typeof e.props.startedAt === 'number' ? (e.props.startedAt as number) : e.createdAt),
      note: (e.props.note as string | null | undefined) ?? null,
    };
  }

  private workingActorsOf(id: EntityId): LiveWork[] {
    return this.edgesTo(id, 'working_on')
      .filter((e) => this.liveEntity(e.srcId))
      .map((e) => ({
        actor: this.actorSummary(e.srcId),
        task: this.summary(this.rec(id)),
        startedAt: iso(typeof e.props.startedAt === 'number' ? (e.props.startedAt as number) : e.createdAt),
        note: (e.props.note as string | null | undefined) ?? null,
      }));
  }

  private assigneesOf(taskId: EntityId): ActorSummary[] {
    return this.edgesFrom(taskId, 'assigned_to')
      .filter((e) => this.liveEntity(e.dstId))
      .map((e) => this.actorSummary(e.dstId));
  }

  private viewerReactionOf(id: EntityId): 'like'|'dislike'|'star'|null {
    if (!this.viewerId) return null;
    if (this.findEdge(this.viewerId, id, 'likes')) return 'like';
    if (this.findEdge(this.viewerId, id, 'dislikes')) return 'dislike';
    if (this.findEdge(this.viewerId, id, 'stars')) return 'star';
    return null;
  }

  scoreOf(actorEntityId: EntityId): number {
    let sum = 0;
    for (const pe of this.pointEvents) if (pe.entityId === actorEntityId) sum += pe.amount;
    return sum;
  }

  private taskDoneCountOf(actorEntityId: EntityId): number {
    return this.edgesTo(actorEntityId, 'completed_by').filter((e) => this.liveEntity(e.srcId)).length;
  }

  private messagesAnchoredTo(anchorId: EntityId, opts: { includeDeleted?: boolean } = {}): EntityRec[] {
    const out: EntityRec[] = [];
    for (const rec of this.entities.values()) {
      if (rec.data.kind !== 'message') continue;
      if (rec.data.message.anchorId !== anchorId) continue;
      if (rec.deletedAt != null && !opts.includeDeleted) continue;
      out.push(rec);
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  private unreadCountFor(anchorId: EntityId, memberId: EntityId): number {
    const mark = this.readMarks.get(`${memberId}|${anchorId}`) ?? 0;
    // Only the member's OWN messages are auto-read; their agents' messages
    // still count as unread (progress reports are exactly what you came for).
    return this.messagesAnchoredTo(anchorId).filter((m) =>
      m.createdAt > mark && (m.data.kind === 'message' ? m.data.message.authorId : '') !== memberId,
    ).length;
  }

  private workingAgentCountOf(channelId: EntityId): number {
    // Agents with an active working_on edge to a task attached to this channel.
    const attachedTaskIds = new Set(
      this.edgesTo(channelId, 'attached_to')
        .filter((e) => this.liveEntity(e.srcId)?.kind === 'task')
        .map((e) => e.srcId),
    );
    const agents = new Set<EntityId>();
    for (const e of this.edges.values()) {
      if (e.type !== 'working_on') continue;
      if (!attachedTaskIds.has(e.dstId)) continue;
      const actor = this.liveEntity(e.srcId);
      if (actor?.kind === 'team_member') agents.add(actor.id);
    }
    return agents.size;
  }

  /** Channel auto-tabs: non-empty kind tabs derived from attached_to edges. */
  autoTabsOf(channelId: EntityId): ChannelTab[] {
    const channel = this.rec(channelId);
    const attached = this.edgesTo(channelId, 'attached_to')
      .map((e) => this.liveEntity(e.srcId))
      .filter((r): r is EntityRec => r != null);
    const byKey = new Map<string, { label: string; kinds: EntityKind[]; count: number }>();
    const KIND_TAB: Array<{ key: string; label: string; kinds: EntityKind[] }> = [
      { key: 'tasks', label: 'Tasks', kinds: ['task'] },
      { key: 'docs', label: 'Docs', kinds: ['doc', 'file'] },
      { key: 'team', label: 'Team', kinds: ['member', 'team_member'] },
      { key: 'prs', label: 'PRs', kinds: ['pull_request', 'commit'] },
      { key: 'kit', label: 'Kit', kinds: ['spell', 'skill'] },
    ];
    for (const def of KIND_TAB) {
      const count = attached.filter((r) => def.kinds.includes(r.kind)).length;
      if (count > 0) byKey.set(def.key, { label: def.label, kinds: def.kinds, count });
    }
    const tabs: ChannelTab[] = [{
      key: 'feed', label: 'Feed', count: channel.counters.messages,
      query: { spaceId: channel.spaceId, kinds: ['message'] },
    }];
    for (const [key, v] of byKey) {
      tabs.push({
        key, label: v.label, count: v.count,
        query: {
          spaceId: channel.spaceId,
          kinds: v.kinds,
          filters: { edge: { type: 'attached_to', direction: 'outgoing', entityId: channelId } },
        },
      });
    }
    return tabs;
  }

  private pinnedOf(channelId: EntityId): EntitySummary[] {
    return this.edgesTo(channelId, 'attached_to')
      .filter((e) => e.props.pinned === true && this.liveEntity(e.srcId))
      .map((e) => this.summary(this.rec(e.srcId)));
  }

  // ==========================================================================
  // Projections → contract DTOs
  // ==========================================================================

  actorSummary(id: EntityId): ActorSummary {
    const rec = this.entities.get(id);
    if (!rec) {
      return { id, kind: 'member', displayName: 'Unknown', avatar: null, role: null, isAgent: false };
    }
    if (rec.data.kind === 'team_member') {
      const tm = rec.data.teamMember;
      return {
        id: rec.id, kind: 'team_member', displayName: tm.name, avatar: tm.avatar,
        role: tm.role || null, ownerMemberId: tm.ownerMemberId, isAgent: true,
      };
    }
    if (rec.data.kind === 'member') {
      const m = rec.data.member;
      return { id: rec.id, kind: 'member', displayName: m.displayName, avatar: m.avatar, role: m.role, isAgent: false };
    }
    return { id, kind: 'member', displayName: this.titleOf(rec), avatar: null, role: null, isAgent: false };
  }

  titleOf(rec: EntityRec): string {
    if (rec.deletedAt != null && rec.data.kind === 'message') return '(deleted message)';
    switch (rec.data.kind) {
      case 'task': return rec.data.task.title;
      case 'channel': return rec.data.channel.name;
      case 'doc': return rec.data.doc.title;
      case 'message': return excerptOf(rec.data.message.body, 60);
      case 'member': return rec.data.member.displayName;
      case 'team_member': return rec.data.teamMember.name;
      case 'pull_request': {
        const pr = rec.data.pullRequest;
        return pr.title || `${pr.repo}#${pr.number}`;
      }
      case 'commit': return excerptOf(rec.data.commit.message.split('\n')[0], 60);
      case 'file': return rec.data.file.name;
      case 'spell': return rec.data.spell.name;
      case 'skill': return rec.data.skill.name;
    }
  }

  private excerptFieldOf(rec: EntityRec): string | undefined {
    switch (rec.data.kind) {
      case 'task': return rec.data.task.description ? excerptOf(rec.data.task.description) : undefined;
      case 'doc': return excerptOf(rec.data.doc.body);
      case 'message': return excerptOf(rec.data.message.body);
      case 'channel': return rec.data.channel.topic || undefined;
      case 'spell': return rec.data.spell.description || undefined;
      case 'skill': return rec.data.skill.description || undefined;
      case 'commit': return excerptOf(rec.data.commit.message);
      default: return undefined;
    }
  }

  private isEquipped(id: EntityId): boolean {
    return this.edgesTo(id, 'equips').some((e) => this.liveEntity(e.srcId));
  }

  private stateOf(rec: EntityRec): EntityState {
    switch (rec.data.kind) {
      case 'task': {
        const t = rec.data.task;
        return {
          kind: 'task', workStatus: t.workStatus, priority: t.priority, axes: { ...t.axes },
          dueDate: t.dueDate, assignees: this.assigneesOf(rec.id),
          acceptance: {
            total: t.acceptanceCriteria.length,
            completed: t.acceptanceCriteria.filter((c) => c.done).length,
          },
        };
      }
      case 'channel':
        return {
          kind: 'channel', topic: rec.data.channel.topic,
          unreadCount: this.viewerId ? this.unreadCountFor(rec.id, this.viewerId) : 0,
          workingAgentCount: this.workingAgentCountOf(rec.id),
        };
      case 'doc':
        return {
          kind: 'doc', format: rec.data.doc.format,
          childCount: this.childrenOf(rec.id).length,
        };
      case 'message': {
        const m = rec.data.message;
        return {
          kind: 'message', anchorId: m.anchorId, rootMessageId: m.rootMessageId,
          author: this.actorSummary(m.authorId),
          editedAt: m.editedAt != null ? iso(m.editedAt) : null,
        };
      }
      case 'member': {
        const m = rec.data.member;
        return {
          kind: 'member', role: m.role, score: this.scoreOf(rec.id),
          taskDoneCount: this.taskDoneCountOf(rec.id),
        };
      }
      case 'team_member': {
        const tm = rec.data.teamMember;
        return {
          kind: 'team_member', owner: this.actorSummary(tm.ownerMemberId),
          model: tm.model, agentTool: tm.agentTool, liveWork: this.liveWorkOf(rec.id),
        };
      }
      case 'pull_request': {
        const pr = rec.data.pullRequest;
        return {
          kind: 'pull_request', repository: pr.repo, number: pr.number, state: pr.state,
          url: pr.url, fetchedAt: pr.fetchedAt != null ? iso(pr.fetchedAt) : null,
          stale: pr.fetchedAt == null || this.now() - pr.fetchedAt > PR_STALE_MS,
        };
      }
      case 'commit': {
        const c = rec.data.commit;
        return {
          kind: 'commit', repository: c.repo, sha: c.sha, message: c.message,
          committedAt: c.committedAt != null ? iso(c.committedAt) : null,
        };
      }
      case 'file': {
        const f = rec.data.file;
        return { kind: 'file', name: f.name, mimeType: f.mimeType, sizeBytes: f.sizeBytes };
      }
      case 'spell':
        return { kind: 'spell', description: rec.data.spell.description, equipped: this.isEquipped(rec.id) };
      case 'skill':
        return { kind: 'skill', description: rec.data.skill.description, equipped: this.isEquipped(rec.id) };
    }
  }

  private badgesOf(rec: EntityRec): EntityBadges {
    this.badgeDepth += 1;
    try {
      const badges: EntityBadges = {};
      const unresolved = this.unresolvedHardDeps(rec.id);
      if (unresolved.length > 0) {
        badges.blocked = {
          unresolvedHardDependencyCount: unresolved.length,
          waitingOn: unresolved.map((e) => this.summary(this.rec(e.dstId))),
        };
      }
      const pulls = this.pullStatesOf(rec.id);
      if (pulls.length > 0) badges.pulls = pulls;
      const working = this.workingActorsOf(rec.id);
      if (working.length > 0) badges.workingActors = working;
      if (rec.visibility === 'restricted') badges.restricted = true;
      return badges;
    } finally {
      this.badgeDepth -= 1;
    }
  }

  summary(rec: EntityRec): EntitySummary {
    const isBadgeBearer = rec.deletedAt == null && this.badgeDepth === 0;
    return {
      id: rec.id,
      spaceId: rec.spaceId,
      kind: rec.kind,
      title: this.titleOf(rec),
      excerpt: this.excerptFieldOf(rec),
      parentId: rec.parentId,
      position: rec.position,
      visibility: rec.visibility,
      version: rec.version,
      activityAt: iso(rec.activityAt),
      createdAt: iso(rec.createdAt),
      updatedAt: iso(rec.updatedAt),
      deletedAt: rec.deletedAt != null ? iso(rec.deletedAt) : null,
      createdBy: this.actorSummary(rec.createdById),
      counters: { ...rec.counters, viewerReaction: this.viewerReactionOf(rec.id) },
      state: this.stateOf(rec),
      badges: isBadgeBearer ? this.badgesOf(rec) : {},
    };
  }

  summaryById(id: EntityId, opts: { allowDeleted?: boolean } = {}): EntitySummary {
    return this.summary(this.rec(id, opts));
  }

  edgeView(edge: EdgeRec): EdgeView {
    const view: EdgeView = {
      id: edge.id,
      type: edge.type,
      source: this.summary(this.rec(edge.srcId, { allowDeleted: true })),
      target: this.summary(this.rec(edge.dstId, { allowDeleted: true })),
      props: { ...edge.props },
      createdBy: this.actorSummary(edge.createdById),
      createdAt: iso(edge.createdAt),
    };
    if (edge.type === 'depends_on') {
      view.hard = edge.props.hard !== false;
      view.resolved = this.isResolved(edge.dstId);
    }
    return view;
  }

  childrenOf(id: EntityId): EntityRec[] {
    const out: EntityRec[] = [];
    for (const rec of this.entities.values()) {
      if (rec.parentId === id && rec.deletedAt == null) out.push(rec);
    }
    out.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
    return out;
  }

  private pathOf(rec: EntityRec): EntitySummary[] {
    const path: EntitySummary[] = [];
    let cur = rec.parentId;
    let guard = 0;
    while (cur && guard < 50) {
      const parent = this.entities.get(cur);
      if (!parent) break;
      path.unshift(this.summary(parent));
      cur = parent.parentId;
      guard += 1;
    }
    return path;
  }

  hierarchyOf(id: EntityId, cursor?: Cursor, limit = DEFAULT_PAGE): Hierarchy {
    const rec = this.rec(id, { allowDeleted: true });
    const parent = rec.parentId ? this.liveEntity(rec.parentId) : undefined;
    const children = this.childrenOf(id)
      .filter((c) => c.kind !== 'message') // message replies render via the thread, not hierarchy children
      .map((c) => this.summary(c));
    return {
      parent: parent ? this.summary(parent) : null,
      children: this.paginate(children, cursor, limit),
      path: this.pathOf(rec),
    };
  }

  connectionsOf(id: EntityId): Connections {
    const groupEdges = (edges: EdgeRec[], direction: 'outgoing'|'incoming'): EdgeGroup[] => {
      const byType = new Map<string, EdgeRec[]>();
      for (const e of edges) {
        if (REACTION_TYPES.has(e.type)) continue;
        const otherId = direction === 'outgoing' ? e.dstId : e.srcId;
        if (!this.entities.get(otherId)) continue;
        const list = byType.get(e.type) ?? [];
        list.push(e);
        byType.set(e.type, list);
      }
      return [...byType.entries()].map(([type, list]) => ({
        type,
        direction,
        label: edgeTypeLabel(type),
        edges: list
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((e) => this.edgeView(e)),
      }));
    };
    return {
      outgoing: groupEdges(this.edgesFrom(id), 'outgoing'),
      incoming: groupEdges(this.edgesTo(id), 'incoming'),
      unresolvedHardDependencyCount: this.unresolvedHardDeps(id).length,
    };
  }

  private contentOf(rec: EntityRec): EntityContent {
    switch (rec.data.kind) {
      case 'task': {
        const t = rec.data.task;
        return {
          kind: 'task', description: t.description,
          acceptanceCriteria: t.acceptanceCriteria.map((c) => ({ ...c })),
          pointsEstimate: t.pointsEstimate,
        };
      }
      case 'channel':
        return {
          kind: 'channel', topic: rec.data.channel.topic,
          pinned: this.pinnedOf(rec.id), autoTabs: this.autoTabsOf(rec.id),
        };
      case 'doc':
        return { kind: 'doc', body: rec.data.doc.body, format: rec.data.doc.format };
      case 'message': {
        const m = rec.data.message;
        return { kind: 'message', body: m.body, mentions: [...m.mentions], attachments: [...m.attachments] };
      }
      case 'member': {
        const teamMembers: EntitySummary[] = [];
        for (const e of this.entities.values()) {
          if (e.data.kind === 'team_member' && e.data.teamMember.ownerMemberId === rec.id && e.deletedAt == null) {
            teamMembers.push(this.summary(e));
          }
        }
        const work = this.edgesTo(rec.id, 'assigned_to')
          .filter((e) => this.liveEntity(e.srcId))
          .map((e) => this.summary(this.rec(e.srcId)));
        return { kind: 'member', teamMembers, work };
      }
      case 'team_member': {
        const tm = rec.data.teamMember;
        const equipped = this.edgesFrom(rec.id, 'equips')
          .filter((e) => this.liveEntity(e.dstId))
          .map((e) => this.summary(this.rec(e.dstId)));
        const work = this.edgesTo(rec.id, 'assigned_to')
          .filter((e) => this.liveEntity(e.srcId))
          .map((e) => this.summary(this.rec(e.srcId)));
        return {
          kind: 'team_member', identity: tm.identity, memories: [...tm.memories],
          capabilities: { ...tm.capabilities }, commandPermissions: { ...tm.commandPermissions },
          equipped, work,
        };
      }
      case 'pull_request': {
        const pr = rec.data.pullRequest;
        return {
          kind: 'pull_request', provider: pr.provider, url: pr.url, repository: pr.repo,
          number: pr.number, title: pr.title, state: pr.state, headSha: pr.headSha,
          fetchedAt: pr.fetchedAt != null ? iso(pr.fetchedAt) : null,
        };
      }
      case 'commit': {
        const c = rec.data.commit;
        return {
          kind: 'commit', repository: c.repo, sha: c.sha, message: c.message,
          author: c.author, url: c.url, committedAt: c.committedAt != null ? iso(c.committedAt) : null,
        };
      }
      case 'file': {
        const f = rec.data.file;
        return { kind: 'file', name: f.name, mimeType: f.mimeType, sizeBytes: f.sizeBytes, storagePath: f.storagePath };
      }
      case 'spell':
        return { kind: 'spell', name: rec.data.spell.name, description: rec.data.spell.description };
      case 'skill':
        return { kind: 'skill', name: rec.data.skill.name, description: rec.data.skill.description, content: rec.data.skill.content };
    }
  }

  private capabilitiesOf(rec: EntityRec): EntityDetail['capabilities'] {
    const viewer = this.entities.get(this.viewerId);
    const viewerRole = viewer?.data.kind === 'member' ? viewer.data.member.role : 'member';
    const isPrivileged = viewerRole === 'owner' || viewerRole === 'admin';
    const isCreator = this.ownerMemberIdOf(rec.createdById) === this.viewerId;
    const pullable: EntityKind[] = ['task', 'doc', 'file', 'spell', 'skill', 'team_member'];
    return {
      canEdit: true,
      canDelete: isPrivileged || isCreator,
      canAddChild: rec.kind !== 'message',
      canLink: true,
      canPull: pullable.includes(rec.kind),
      canReact: true,
      canGrantPoints: true,
      canComplete: rec.data.kind === 'task' && rec.data.task.workStatus !== 'done' && rec.data.task.workStatus !== 'cancelled',
    };
  }

  detail(id: EntityId): EntityDetail {
    const rec = this.rec(id, { allowDeleted: true });
    return {
      ...this.summary(rec),
      content: this.contentOf(rec),
      hierarchy: this.hierarchyOf(id),
      connections: this.connectionsOf(id),
      capabilities: this.capabilitiesOf(rec),
    };
  }

  messageView(rec: EntityRec, opts: { withReplies?: boolean } = {}): MessageView {
    if (rec.data.kind !== 'message') throw new CollabError('invalid_input', `${rec.id} is not a message`);
    const base = this.summary(rec);
    const replies = this.childrenOf(rec.id).filter((c) => c.data.kind === 'message');
    const view: MessageView = {
      ...base,
      state: base.state as MessageView['state'],
      content: this.contentOf(rec) as MessageView['content'],
      replyCount: replies.length,
    };
    if (opts.withReplies && replies.length > 0) {
      view.replies = this.paginate(replies.map((r) => this.messageView(r)), undefined, DEFAULT_PAGE);
    }
    return view;
  }

  private activityItem(rec: ActivityRec): ActivityItem {
    return {
      id: rec.id,
      entityId: rec.entityId,
      actor: rec.actorId ? this.actorSummary(rec.actorId) : null,
      verb: rec.verb,
      summary: { ...rec.summary },
      createdAt: iso(rec.createdAt),
      refId: rec.refId,
    };
  }

  notificationItem(rec: NotificationRec): NotificationItem {
    const target = rec.targetId ? this.entities.get(rec.targetId) : undefined;
    return {
      id: rec.id,
      spaceId: rec.spaceId,
      kind: rec.kind,
      actor: rec.actorId ? this.actorSummary(rec.actorId) : null,
      target: target ? this.summary(target) : null,
      message: rec.message,
      readAt: rec.readAt != null ? iso(rec.readAt) : null,
      createdAt: iso(rec.createdAt),
    };
  }

  /**
   * DEV-5: opaque keyset pagination — the cursor names the LAST ITEM SERVED
   * (by identity key), never an offset. Malformed, legacy (`off:*`), or stale
   * cursors reject with CollabError('invalid_cursor').
   */
  paginate<T>(items: T[], cursor: Cursor | undefined, limit = DEFAULT_PAGE,
              keyOf: (item: T) => string = (i) => (i as { id: string }).id): Page<T> {
    let start = 0;
    if (cursor) {
      const key = decodeCursor(cursor);
      if (key == null) throw new CollabError('invalid_cursor', 'malformed or legacy cursor');
      const idx = items.findIndex((i) => keyOf(i) === key);
      if (idx < 0) throw new CollabError('invalid_cursor', 'stale cursor: resume point no longer exists');
      start = idx + 1;
    }
    const slice = items.slice(start, start + limit);
    const exhausted = start + slice.length >= items.length;
    return {
      items: slice,
      nextCursor: !exhausted && slice.length > 0 ? encodeCursor(keyOf(slice[slice.length - 1])) : null,
      total: items.length,
    };
  }

  // ==========================================================================
  // Envelope helpers for mutations
  // ==========================================================================

  createEntityRec(opts: {
    id?: string; spaceId: SpaceId; parentId?: EntityId | null; position?: number;
    createdById: EntityId; data: KindData; visibility?: 'space'|'restricted'; at?: number;
  }): EntityRec {
    const at = opts.at ?? this.now();
    const kind = opts.data.kind;
    if (opts.parentId) {
      const parent = this.rec(opts.parentId);
      if (parent.kind !== kind) {
        throw new CollabError('invalid_input', `hierarchy is homogeneous: ${kind} cannot be a child of ${parent.kind}`);
      }
      if (parent.spaceId !== opts.spaceId) {
        throw new CollabError('invalid_input', 'parent must be in the same space');
      }
    }
    const rec: EntityRec = {
      id: opts.id ?? this.nextId('ent'),
      spaceId: opts.spaceId,
      kind,
      parentId: opts.parentId ?? null,
      position: opts.position ?? this.childrenOf(opts.parentId ?? '').length,
      visibility: opts.visibility ?? 'space',
      version: 1,
      activityAt: at,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      createdById: opts.createdById,
      counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0 },
      data: opts.data,
    };
    this.entities.set(rec.id, rec);
    this.versions.set(rec.id, [{ version: 1, changedById: opts.createdById, changedAt: at }]);
    return rec;
  }

  /** Content write: bump version + snapshot (contract §6 / design §12.2). */
  private touchContent(rec: EntityRec, actorId: EntityId): void {
    rec.version += 1;
    rec.updatedAt = this.now();
    const list = this.versions.get(rec.id) ?? [];
    list.push({ version: rec.version, changedById: actorId, changedAt: rec.updatedAt });
    this.versions.set(rec.id, list);
  }

  /** Neighborhood moved (message/edge): bump activity_at only. */
  private touchActivity(rec: EntityRec): void {
    rec.activityAt = this.now();
  }

  private assertVersion(rec: EntityRec, expectedVersion: number): void {
    if (expectedVersion !== rec.version) {
      throw new CollabError('version_conflict',
        `expected version ${expectedVersion} but ${rec.id} is at ${rec.version}`,
        { current: this.detail(rec.id) });
    }
  }

  private addEdgeRec(opts: {
    srcId: EntityId; dstId: EntityId; type: string; props?: Record<string, unknown>;
    createdById: EntityId; bumpActivity?: boolean;
  }): EdgeRec {
    const src = this.rec(opts.srcId);
    const dst = this.rec(opts.dstId);
    const err = validateEdgeType(opts.type, src.kind, dst.kind);
    if (err) throw new CollabError('invalid_input', err);
    if (src.spaceId !== dst.spaceId) throw new CollabError('invalid_input', 'edges cannot cross spaces');
    const existing = this.findEdge(opts.srcId, opts.dstId, opts.type);
    if (existing) {
      existing.props = { ...existing.props, ...(opts.props ?? {}) };
      return existing;
    }
    if (EDGE_TYPES[opts.type]?.acyclic) {
      // bounded walk: reject if dst can already reach src through this type
      const seen = new Set<EntityId>();
      const stack = [opts.dstId];
      while (stack.length > 0 && seen.size < 500) {
        const cur = stack.pop() as EntityId;
        if (cur === opts.srcId) throw new CollabError('invalid_input', `edge would create a ${opts.type} cycle`);
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const e of this.edgesFrom(cur, opts.type)) stack.push(e.dstId);
      }
    }
    const edge: EdgeRec = {
      id: this.nextId('edg'), spaceId: src.spaceId,
      srcId: opts.srcId, dstId: opts.dstId, type: opts.type,
      props: { ...(opts.props ?? {}) },
      createdById: opts.createdById, createdAt: this.now(),
    };
    this.edges.set(edge.id, edge);
    if (opts.bumpActivity !== false && !REACTION_TYPES.has(opts.type)) {
      this.touchActivity(src);
      this.touchActivity(dst);
    }
    return edge;
  }

  private result(opts: {
    entityId?: EntityId; edge?: EdgeRec; activity?: ActivityItem;
    patchIds?: EntityId[]; undo?: UndoToken; cmid?: string; op?: string;
  }): CommandResult {
    const patches: EntitySummary[] = [];
    const seen = new Set<EntityId>();
    for (const id of opts.patchIds ?? []) {
      const rec = this.entities.get(id);
      if (rec && !seen.has(id)) { patches.push(this.summary(rec)); seen.add(id); }
    }
    const res: CommandResult = { patches };
    if (opts.entityId) res.entity = this.detail(opts.entityId);
    if (opts.edge) res.edge = this.edgeView(opts.edge);
    if (opts.activity) res.activity = opts.activity;
    if (opts.undo) res.undo = opts.undo;
    if (opts.cmid) this.ledger.set(opts.cmid, { op: opts.op ?? 'command', value: res });
    return res;
  }

  /**
   * DEV-9 ledger check. Same id + same op → stored result (no-op replay);
   * same id + different op → invariant_violation.
   */
  private replayIfSeen(op: string, ctx: CommandContext): CommandResult | null {
    return this.replayValue<CommandResult>(op, ctx);
  }

  private replayValue<T>(op: string, ctx: CommandContext): T | null {
    const cmid = ctx.clientMutationId;
    if (!cmid) return null;
    const entry = this.ledger.get(cmid);
    if (!entry) return null;
    if (entry.op !== op) {
      throw new CollabError('invariant_violation',
        `clientMutationId ${cmid} was already used for "${entry.op}", not "${op}"`);
    }
    return entry.value as T;
  }

  private remember<T>(op: string, ctx: CommandContext | undefined, value: T): T {
    if (ctx?.clientMutationId) this.ledger.set(ctx.clientMutationId, { op, value });
    return value;
  }

  private mintUndo(label: string, run: () => CommandResult): UndoToken {
    const token = this.nextId('undo');
    const mintedAt = this.now();
    this.undoOps.set(token, { label, mintedAt, run });
    return { token, label, expiresAt: iso(mintedAt + UNDO_TTL_MS) };
  }

  /**
   * Unblock ripple (design §7.4): after `id` resolves, every live source of an
   * incoming hard depends_on edge is re-rolled-up, notified, and patched.
   */
  private rippleUnblock(id: EntityId, actorId: EntityId, patchIds: EntityId[]): void {
    for (const e of this.edgesTo(id, 'depends_on')) {
      if (e.props.hard === false) continue;
      const dependent = this.liveEntity(e.srcId);
      if (!dependent) continue;
      this.touchActivity(dependent);
      const nowUnblocked = this.unresolvedHardDeps(dependent.id).length === 0;
      this.pushActivity({
        spaceId: dependent.spaceId, entityId: dependent.id, actorId,
        verb: nowUnblocked ? 'unblocked' : 'dependency_resolved',
        summary: { dependencyId: id, title: this.titleOf(dependent) }, refId: id,
      });
      if (nowUnblocked) {
        const recipients = new Set<EntityId>([this.ownerMemberIdOf(dependent.createdById)]);
        for (const a of this.assigneesOf(dependent.id)) recipients.add(this.ownerMemberIdOf(a.id));
        for (const memberId of recipients) {
          this.pushNotification({
            spaceId: dependent.spaceId, kind: 'unblock', actorId, targetId: dependent.id,
            message: `${this.titleOf(dependent)} is unblocked — ${this.titleOf(this.rec(id, { allowDeleted: true }))} resolved`,
            recipientMemberId: memberId,
          });
        }
      }
      patchIds.push(dependent.id);
      this.emitEntity(dependent.id);
    }
  }

  // ==========================================================================
  // Commands
  // ==========================================================================

  /**
   * DEV-1: task create routed through the generic entity handler — this is the
   * canonical implementation `createEntity({ kind: 'task', … })` delegates to.
   */
  createTask(input: CreateTaskInput): CommandResult {
    assertInput('createTask', input, COMMAND_FIELDS.createTask);
    const replay = this.replayIfSeen('entity.create', input);
    if (replay) return replay;
    if (!input.title.trim()) throw new CollabError('invalid_input', 'task title is required');
    if (!this.spaces.has(input.spaceId)) throw new CollabError('not_found', `space ${input.spaceId} not found`);
    const actor = this.actorRec(input.actorId);
    const rec = this.createEntityRec({
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      position: input.position,
      createdById: actor.id,
      data: {
        kind: 'task',
        task: {
          title: input.title,
          description: input.description ?? '',
          axes: { ...(input.axes ?? {}) },
          workStatus: 'open',
          priority: input.priority ?? 'medium',
          acceptanceCriteria: (input.acceptanceCriteria ?? []).map((c, i) => ({
            id: c.id ?? this.nextId('ac'), text: c.text, done: c.done ?? false,
            doneBy: c.doneBy, doneAt: c.doneAt,
          })),
          pointsEstimate: input.pointsEstimate ?? null,
          dueDate: input.dueDate ?? null,
        },
      },
    });
    const patchIds: EntityId[] = [rec.id];
    let edge: EdgeRec | undefined;
    if (input.attachTo) {
      edge = this.addEdgeRec({
        srcId: rec.id, dstId: input.attachTo.entityId,
        type: input.attachTo.edgeType, createdById: actor.id,
      });
      patchIds.push(input.attachTo.entityId);
      this.emitEdge(edge, false, input.clientMutationId);
      this.emitEntity(input.attachTo.entityId);
    }
    if (input.parentId) { patchIds.push(input.parentId); this.emitEntity(input.parentId); }
    const activity = this.pushActivity({
      spaceId: rec.spaceId, entityId: rec.id, actorId: actor.id,
      verb: 'created', summary: { kind: 'task', title: input.title }, refId: null,
    });
    this.emitEntity(rec.id, input.clientMutationId);
    return this.result({ entityId: rec.id, edge, activity, patchIds, cmid: input.clientMutationId, op: 'entity.create' });
  }

  patchTask(id: EntityId, input: PatchTaskInput): CommandResult {
    assertInput('patchTask', input, COMMAND_FIELDS.patchTask);
    const replay = this.replayIfSeen('entity.patch', input);
    if (replay) return replay;
    const rec = this.rec(id);
    if (rec.data.kind !== 'task') throw new CollabError('invalid_input', `${id} is not a task`);
    this.assertVersion(rec, input.expectedVersion);
    const actor = this.actorRec(input.actorId);
    const t = rec.data.task;
    const wasResolved = this.isResolved(id);

    let contentChanged = false;
    if (input.title !== undefined && input.title !== t.title) { t.title = input.title; contentChanged = true; }
    if (input.description !== undefined && input.description !== t.description) { t.description = input.description; contentChanged = true; }
    if (input.axes !== undefined) { t.axes = { ...input.axes }; contentChanged = true; }
    if (input.priority !== undefined && input.priority !== t.priority) { t.priority = input.priority; contentChanged = true; }
    if (input.acceptanceCriteria !== undefined) { t.acceptanceCriteria = input.acceptanceCriteria.map((c) => ({ ...c })); contentChanged = true; }
    if (input.pointsEstimate !== undefined) { t.pointsEstimate = input.pointsEstimate; contentChanged = true; }
    if (input.dueDate !== undefined) { t.dueDate = input.dueDate; contentChanged = true; }
    // workStatus is a workflow rollup, not versioned content — staleness pins
    // are against content (title/description/criteria/axes), per design §12.2.
    if (input.workStatus !== undefined && input.workStatus !== t.workStatus) {
      t.workStatus = input.workStatus;
      rec.updatedAt = this.now();
    }
    if (contentChanged) this.touchContent(rec, actor.id);
    this.touchActivity(rec);

    const patchIds: EntityId[] = [id];
    const activity = this.pushActivity({
      spaceId: rec.spaceId, entityId: id, actorId: actor.id,
      verb: contentChanged ? 'updated' : 'status_changed',
      summary: { workStatus: t.workStatus, version: rec.version }, refId: null,
    });
    if (!wasResolved && this.isResolved(id)) this.rippleUnblock(id, actor.id, patchIds);
    this.emitEntity(id, input.clientMutationId);
    return this.result({ entityId: id, activity, patchIds, cmid: input.clientMutationId, op: 'entity.patch' });
  }

  createEntity(input: CreateEntityInput): CommandResult {
    assertInput('createEntity', input, COMMAND_FIELDS.createEntity);
    assertContent('createEntity', input.content, CREATE_CONTENT[input.kind]);
    const replay = this.replayIfSeen('entity.create', input);
    if (replay) return replay;
    if (!this.spaces.has(input.spaceId)) throw new CollabError('not_found', `space ${input.spaceId} not found`);
    const actor = this.actorRec(input.actorId);
    const c = input.content ?? {};
    const str = (k: string, fallback = ''): string => (typeof c[k] === 'string' ? (c[k] as string) : fallback);
    const num = (k: string, fallback: number): number => (typeof c[k] === 'number' ? (c[k] as number) : fallback);
    // DEV-1: tasks ride the generic route with their payload inside `content`
    // (same ledger op, so a retry via either form replays identically).
    if (input.kind === 'task') {
      return this.createTask({
        actorId: input.actorId, clientMutationId: input.clientMutationId,
        spaceId: input.spaceId, title: input.title,
        parentId: input.parentId, position: input.position, attachTo: input.attachTo,
        description: str('description') || undefined,
        axes: (c.axes as Record<string, string> | undefined) ?? undefined,
        priority: (c.priority as CreateTaskInput['priority']) ?? undefined,
        acceptanceCriteria: (c.acceptanceCriteria as CreateTaskInput['acceptanceCriteria']) ?? undefined,
        pointsEstimate: typeof c.pointsEstimate === 'number' ? c.pointsEstimate : undefined,
        dueDate: str('dueDate') || undefined,
      });
    }
    let data: KindData;
    switch (input.kind) {
      case 'channel':
        data = { kind: 'channel', channel: { name: input.title, topic: str('topic') } };
        break;
      case 'doc':
        data = { kind: 'doc', doc: { title: input.title, body: str('body'), format: (str('format', 'markdown') as 'markdown'|'mermaid'|'excalidraw') } };
        break;
      case 'file':
        data = { kind: 'file', file: { name: input.title, mimeType: str('mimeType', 'application/octet-stream'), sizeBytes: num('sizeBytes', 0), storagePath: str('storagePath', `spaces/${input.spaceId}/${input.title}`) } };
        break;
      case 'spell':
        data = { kind: 'spell', spell: { name: input.title, description: str('description') } };
        break;
      case 'skill':
        data = { kind: 'skill', skill: { name: input.title, description: str('description'), content: str('content') } };
        break;
      case 'pull_request':
        data = { kind: 'pull_request', pullRequest: {
          provider: str('provider', 'github'), url: str('url'), repo: str('repo', str('repository')),
          number: num('number', 0), title: input.title,
          state: (str('state', 'open') as 'open'|'merged'|'closed'|'draft'),
          headSha: str('headSha') || null, fetchedAt: this.now(),
        } };
        break;
      case 'commit':
        data = { kind: 'commit', commit: {
          repo: str('repo', str('repository')), sha: str('sha'), message: str('message', input.title),
          author: str('author'), url: str('url') || null, committedAt: this.now(),
        } };
        break;
      case 'team_member': {
        const ownerId = str('ownerMemberId', this.ownerMemberIdOf(actor.id));
        data = { kind: 'team_member', teamMember: {
          ownerMemberId: ownerId, name: input.title, role: str('role'),
          identity: str('identity'), memories: [], model: str('model') || null,
          agentTool: str('agentTool') || null, mode: str('mode') || null,
          avatar: str('avatar') || null, capabilities: {}, commandPermissions: {},
        } };
        break;
      }
      default:
        throw new CollabError('invalid_input', `createEntity does not support kind "${input.kind}"`);
    }
    const rec = this.createEntityRec({
      spaceId: input.spaceId, parentId: input.parentId ?? null,
      position: input.position, createdById: actor.id, data,
    });
    const patchIds: EntityId[] = [rec.id];
    let edge: EdgeRec | undefined;
    if (input.attachTo) {
      edge = this.addEdgeRec({ srcId: rec.id, dstId: input.attachTo.entityId, type: input.attachTo.edgeType, createdById: actor.id });
      patchIds.push(input.attachTo.entityId);
      this.emitEdge(edge, false, input.clientMutationId);
      this.emitEntity(input.attachTo.entityId);
    }
    if (input.parentId) { patchIds.push(input.parentId); this.emitEntity(input.parentId); }
    const activity = this.pushActivity({
      spaceId: rec.spaceId, entityId: rec.id, actorId: actor.id,
      verb: 'created', summary: { kind: input.kind, title: input.title }, refId: null,
    });
    this.emitEntity(rec.id, input.clientMutationId);
    return this.result({ entityId: rec.id, edge, activity, patchIds, cmid: input.clientMutationId, op: 'entity.create' });
  }

  patchEntity(id: EntityId, input: PatchEntityInput): CommandResult {
    assertInput('patchEntity', input, COMMAND_FIELDS.patchEntity);
    const replay = this.replayIfSeen('entity.patch', input);
    if (replay) return replay;
    const rec = this.rec(id);
    // Kind-typed content keys: unknown/mistyped keys reject BEFORE any write
    // (kinds without a patch table reject below with their own error).
    assertContent('patchEntity', input.content, PATCH_CONTENT[rec.data.kind]);
    // DEV-1: task patches ride the generic route with fields inside `content`
    // (delegation happens before assertVersion so patchTask owns the guard).
    if (rec.data.kind === 'task') {
      const c = input.content ?? {};
      return this.patchTask(id, {
        actorId: input.actorId, clientMutationId: input.clientMutationId,
        expectedVersion: input.expectedVersion,
        title: input.title,
        description: typeof c.description === 'string' ? c.description : undefined,
        axes: (c.axes as Record<string, string> | undefined) ?? undefined,
        workStatus: (c.workStatus as PatchTaskInput['workStatus']) ?? undefined,
        priority: (c.priority as PatchTaskInput['priority']) ?? undefined,
        acceptanceCriteria: (c.acceptanceCriteria as PatchTaskInput['acceptanceCriteria']) ?? undefined,
        pointsEstimate: typeof c.pointsEstimate === 'number' || c.pointsEstimate === null ? (c.pointsEstimate as number | null) : undefined,
        dueDate: typeof c.dueDate === 'string' || c.dueDate === null ? (c.dueDate as string | null) : undefined,
      });
    }
    this.assertVersion(rec, input.expectedVersion);
    const actor = this.actorRec(input.actorId);
    const wasResolved = this.isResolved(id);
    const c = input.content ?? {};
    switch (rec.data.kind) {
      case 'doc': {
        if (input.title !== undefined) rec.data.doc.title = input.title;
        if (typeof c.body === 'string') rec.data.doc.body = c.body;
        if (typeof c.format === 'string') rec.data.doc.format = c.format as 'markdown'|'mermaid'|'excalidraw';
        break;
      }
      case 'channel': {
        if (input.title !== undefined) rec.data.channel.name = input.title;
        if (typeof c.topic === 'string') rec.data.channel.topic = c.topic;
        break;
      }
      case 'pull_request': {
        const pr = rec.data.pullRequest;
        if (input.title !== undefined) pr.title = input.title;
        if (typeof c.state === 'string') pr.state = c.state as typeof pr.state;
        if (typeof c.headSha === 'string') pr.headSha = c.headSha;
        break;
      }
      case 'spell': {
        if (input.title !== undefined) rec.data.spell.name = input.title;
        if (typeof c.description === 'string') rec.data.spell.description = c.description;
        break;
      }
      case 'skill': {
        if (input.title !== undefined) rec.data.skill.name = input.title;
        if (typeof c.description === 'string') rec.data.skill.description = c.description;
        if (typeof c.content === 'string') rec.data.skill.content = c.content;
        break;
      }
      case 'team_member': {
        const tm = rec.data.teamMember;
        if (input.title !== undefined) tm.name = input.title;
        if (typeof c.identity === 'string') tm.identity = c.identity;
        if (typeof c.model === 'string') tm.model = c.model;
        if (Array.isArray(c.memories)) tm.memories = c.memories as unknown[];
        break;
      }
      case 'file': {
        if (input.title !== undefined) rec.data.file.name = input.title;
        break;
      }
      case 'message':
        throw new CollabError('invalid_input', 'use patchMessage for messages');
      case 'member':
        throw new CollabError('forbidden', 'member profiles are not editable here');
      case 'commit':
        throw new CollabError('invalid_input', 'commits are immutable');
    }
    this.touchContent(rec, actor.id);
    this.touchActivity(rec);
    const patchIds: EntityId[] = [id];
    const activity = this.pushActivity({
      spaceId: rec.spaceId, entityId: id, actorId: actor.id,
      verb: 'updated', summary: { kind: rec.kind, version: rec.version }, refId: null,
    });
    if (!wasResolved && this.isResolved(id)) this.rippleUnblock(id, actor.id, patchIds);
    // Content bump flips PullState.contentStale for every puller — patch them in.
    for (const e of this.edgesTo(id, 'pulled')) {
      const owner = this.ownerMemberIdOf(e.srcId);
      this.pushNotification({
        spaceId: rec.spaceId, kind: 'stale', actorId: actor.id, targetId: id,
        message: `${this.titleOf(rec)} changed (v${rec.version}) — your pull is pinned to v${e.props.pinnedVersion as number}`,
        recipientMemberId: owner,
      });
    }
    this.emitEntity(id, input.clientMutationId);
    return this.result({ entityId: id, activity, patchIds, cmid: input.clientMutationId, op: 'entity.patch' });
  }

  moveEntity(id: EntityId, input: MoveEntityInput): CommandResult {
    assertInput('moveEntity', input, COMMAND_FIELDS.moveEntity);
    const replay = this.replayIfSeen('entity.move', input);
    if (replay) return replay;
    const rec = this.rec(id);
    this.assertVersion(rec, input.expectedVersion);
    const actor = this.actorRec(input.actorId);
    const oldParentId = rec.parentId;
    if (input.parentId != null) {
      const parent = this.rec(input.parentId);
      if (parent.kind !== rec.kind) throw new CollabError('invalid_input', 'reparent requires the same kind');
      if (parent.spaceId !== rec.spaceId) throw new CollabError('invalid_input', 'reparent cannot cross spaces');
      let cur: EntityId | null = input.parentId;
      let guard = 0;
      while (cur && guard < 100) {
        if (cur === id) throw new CollabError('invalid_input', 'reparent would create a hierarchy cycle');
        cur = this.entities.get(cur)?.parentId ?? null;
        guard += 1;
      }
    }
    rec.parentId = input.parentId;
    rec.position = input.position;
    rec.updatedAt = this.now();
    this.touchActivity(rec);
    const patchIds: EntityId[] = [id];
    if (oldParentId) { patchIds.push(oldParentId); this.emitEntity(oldParentId); }
    if (input.parentId) { patchIds.push(input.parentId); this.emitEntity(input.parentId); }
    const activity = this.pushActivity({
      spaceId: rec.spaceId, entityId: id, actorId: actor.id,
      verb: 'moved', summary: { fromParentId: oldParentId, toParentId: input.parentId }, refId: null,
    });
    this.emitEntity(id, input.clientMutationId);
    return this.result({ entityId: id, activity, patchIds, cmid: input.clientMutationId, op: 'entity.move' });
  }

  deleteEntity(id: EntityId, ctx: CommandContext = {}): CommandResult {
    assertInput('deleteEntity', ctx, COMMAND_FIELDS.contextOnly);
    const replay = this.replayIfSeen('entity.delete', ctx);
    if (replay) return replay;
    const rec = this.rec(id);
    const actor = this.actorRec(ctx.actorId);
    const caps = this.capabilitiesOf(rec);
    if (this.ownerMemberIdOf(actor.id) === this.viewerId && !caps.canDelete) {
      throw new CollabError('forbidden', `viewer may not delete ${id}`);
    }
    const at = this.now();
    const deleted: EntityId[] = [];
    const walk = (cur: EntityRec): void => {
      cur.deletedAt = at;
      deleted.push(cur.id);
      for (const child of this.childrenOf(cur.id)) walk(child);
    };
    walk(rec);
    const patchIds = [...deleted];
    if (rec.parentId) patchIds.push(rec.parentId);
    for (const did of deleted) this.emitEntity(did);
    if (rec.parentId) this.emitEntity(rec.parentId);
    const activity = this.pushActivity({
      spaceId: rec.spaceId, entityId: id, actorId: actor.id,
      verb: 'deleted', summary: { subtreeSize: deleted.length }, refId: null,
    });
    return this.result({ activity, patchIds, cmid: ctx.clientMutationId, op: 'entity.delete' });
  }

  createEdge(input: CreateEdgeInput): CommandResult {
    assertInput('createEdge', input, COMMAND_FIELDS.createEdge);
    const replay = this.replayIfSeen('edge.create', input);
    if (replay) return replay;
    const actor = this.actorRec(input.actorId);
    const edge = this.addEdgeRec({
      srcId: input.srcId, dstId: input.dstId, type: input.type,
      props: input.props, createdById: actor.id,
    });
    const activity = this.pushActivity({
      spaceId: edge.spaceId, entityId: input.srcId, actorId: actor.id,
      verb: 'linked', summary: { type: input.type, dstId: input.dstId }, refId: edge.id,
    });
    // assignment notification
    if (input.type === 'assigned_to') {
      this.pushNotification({
        spaceId: edge.spaceId, kind: 'assignment', actorId: actor.id, targetId: input.srcId,
        message: `${this.titleOf(this.rec(input.srcId))} assigned to ${this.actorSummary(input.dstId).displayName}`,
        recipientMemberId: this.ownerMemberIdOf(input.dstId),
      });
    }
    this.emitEdge(edge, false, input.clientMutationId);
    this.emitEntity(input.srcId);
    this.emitEntity(input.dstId);
    return this.result({ edge, activity, patchIds: [input.srcId, input.dstId], cmid: input.clientMutationId, op: 'edge.create' });
  }

  patchEdge(edgeId: string, input: PatchEdgeInput): CommandResult {
    assertInput('patchEdge', input, COMMAND_FIELDS.patchEdge);
    const replay = this.replayIfSeen('edge.patch', input);
    if (replay) return replay;
    const edge = this.edges.get(edgeId);
    if (!edge) throw new CollabError('not_found', `edge ${edgeId} not found`);
    edge.props = { ...edge.props, ...input.props };
    this.emitEdge(edge, false, input.clientMutationId);
    this.emitEntity(edge.srcId);
    this.emitEntity(edge.dstId);
    return this.result({ edge, patchIds: [edge.srcId, edge.dstId], cmid: input.clientMutationId, op: 'edge.patch' });
  }

  deleteEdge(edgeId: string, ctx: CommandContext = {}): CommandResult {
    assertInput('deleteEdge', ctx, COMMAND_FIELDS.contextOnly);
    const replay = this.replayIfSeen('edge.delete', ctx);
    if (replay) return replay;
    const edge = this.edges.get(edgeId);
    if (!edge) throw new CollabError('not_found', `edge ${edgeId} not found`);
    this.edges.delete(edgeId);
    const src = this.entities.get(edge.srcId);
    const dst = this.entities.get(edge.dstId);
    if (src) this.touchActivity(src);
    if (dst) this.touchActivity(dst);
    this.emitEdge(edge, true, ctx.clientMutationId);
    this.emitEntity(edge.srcId);
    this.emitEntity(edge.dstId);
    return this.result({ patchIds: [edge.srcId, edge.dstId], cmid: ctx.clientMutationId, op: 'edge.delete' });
  }

  /**
   * Drag/drop grammar: resolve an explicit placement intent to edge/move/
   * message atomically, and mint an undo token (contract §4 "placements").
   */
  placements(input: PlacementInput): CommandResult {
    assertInput('placements', input, COMMAND_FIELDS.placements);
    const replay = this.replayIfSeen('placements', input);
    if (replay) return replay;
    const actor = this.actorRec(input.actorId);
    const source = this.rec(input.sourceId);
    const target = this.rec(input.targetId);
    const label = (verb: string): string => `${verb}: ${this.titleOf(source)} → ${this.titleOf(target)}`;
    // The placement caches its own result under clientMutationId (so replays
    // keep the undo token); inner ops must not claim the id for themselves.
    const finish = (res: CommandResult): CommandResult => this.remember('placements', input, res);

    switch (input.intent) {
      case 'attach': {
        const res = this.createEdge({
          srcId: source.id, dstId: target.id, type: 'attached_to',
          actorId: actor.id,
        });
        const edgeId = res.edge?.id as string;
        let embedId: EntityId | null = null;
        if (input.embedMessage !== undefined) {
          const msg = this.postMessage({
            anchorId: target.id, body: `${input.embedMessage} ${embedToken(source.id)}`.trim(),
            actorId: actor.id,
          });
          embedId = msg.entity?.id ?? null;
        }
        res.undo = this.mintUndo(label('Attached'), () => {
          const out = this.deleteEdge(edgeId, { actorId: actor.id });
          if (embedId) this.deleteMessage(embedId, { actorId: actor.id });
          return out;
        });
        return finish(res);
      }
      case 'assign': {
        const task = source.kind === 'task' ? source : target;
        const who = source.kind === 'task' ? target : source;
        if (task.kind !== 'task' || (who.kind !== 'member' && who.kind !== 'team_member')) {
          throw new CollabError('invalid_input', 'assign needs a task and a member/team_member');
        }
        const res = this.createEdge({
          srcId: task.id, dstId: who.id, type: 'assigned_to',
          actorId: actor.id,
        });
        const edgeId = res.edge?.id as string;
        res.undo = this.mintUndo(label('Assigned'), () => this.deleteEdge(edgeId, { actorId: actor.id }));
        return finish(res);
      }
      case 'depend': {
        // Dropping S onto T with "depend" makes T depend on S (S becomes a
        // prerequisite of T), consistent with attach/subtask making S a
        // constituent of T's world.
        const res = this.createEdge({
          srcId: target.id, dstId: source.id, type: 'depends_on', props: { hard: true },
          actorId: actor.id,
        });
        const edgeId = res.edge?.id as string;
        res.undo = this.mintUndo(label('Dependency'), () => this.deleteEdge(edgeId, { actorId: actor.id }));
        return finish(res);
      }
      case 'subtask':
      case 'reparent': {
        const oldParentId = source.parentId;
        const oldPosition = source.position;
        const res = this.moveEntity(source.id, {
          parentId: target.id, position: this.childrenOf(target.id).length,
          expectedVersion: source.version, actorId: actor.id,
        });
        res.undo = this.mintUndo(label(input.intent === 'subtask' ? 'Subtask' : 'Moved'), () =>
          this.moveEntity(source.id, {
            parentId: oldParentId, position: oldPosition,
            expectedVersion: this.rec(source.id).version, actorId: actor.id,
          }));
        return finish(res);
      }
      case 'embed': {
        const res = this.postMessage({
          anchorId: target.id,
          body: `${input.embedMessage ?? ''} ${embedToken(source.id)}`.trim(),
          actorId: actor.id,
        });
        const msgId = res.entity?.id as EntityId;
        res.undo = this.mintUndo(label('Embedded'), () => this.deleteMessage(msgId, { actorId: actor.id }));
        return finish(res);
      }
      default:
        throw new CollabError('invalid_input', `unknown placement intent "${input.intent as string}"`);
    }
  }

  /**
   * DEV-11: POST /v2/undo — redeems the token by executing the inverse
   * command. Single-use, 5-minute TTL on the injected clock: unknown/used →
   * not_found, expired → invariant_violation (04 §4/§5).
   */
  undo(token: UndoToken | string, ctx: CommandContext = {}): CommandResult {
    if (typeof token !== 'string'
        && (typeof token !== 'object' || token === null || typeof (token as UndoToken).token !== 'string')) {
      throw new CollabError('invalid_input', 'undo: token must be a string or an UndoToken');
    }
    assertInput('undo', ctx, COMMAND_FIELDS.contextOnly);
    const replay = this.replayIfSeen('undo', ctx);
    if (replay) return replay;
    const key = typeof token === 'string' ? token : token.token;
    const op = this.undoOps.get(key);
    if (!op) throw new CollabError('not_found', `undo token ${key} not found or already used`);
    if (this.now() - op.mintedAt > UNDO_TTL_MS) {
      this.undoOps.delete(key);
      throw new CollabError('invariant_violation', `undo token ${key} expired (5-minute TTL)`);
    }
    this.undoOps.delete(key);
    return this.remember('undo', ctx, op.run());
  }

  /**
   * DEV-3: link-pr command — creates or upserts (matched by URL, so seeded PRs
   * are reused) the pull_request entity and the `tracks` edge from `id`,
   * atomically. The PR summary rides in `patches` and `entity`.
   */
  linkPr(id: EntityId, input: LinkPrInput): CommandResult {
    assertInput('linkPr', input, COMMAND_FIELDS.linkPr);
    const replay = this.replayIfSeen('entity.link_pr', input);
    if (replay) return replay;
    const rec = this.rec(id);
    const actor = this.actorRec(input.actorId);
    const url = input.url.trim();
    const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
    if (!m) throw new CollabError('invalid_input', `unrecognized pull request url "${input.url}"`);
    const repo = `${m[1]}/${m[2]}`;
    const number = Number.parseInt(m[3], 10);
    let pr: EntityRec | undefined;
    for (const r of this.entities.values()) {
      if (r.data.kind === 'pull_request' && r.deletedAt == null && r.data.pullRequest.url === url) { pr = r; break; }
    }
    if (pr) {
      if (pr.data.kind === 'pull_request') pr.data.pullRequest.fetchedAt = this.now();
      pr.updatedAt = this.now();
    } else {
      pr = this.createEntityRec({
        spaceId: rec.spaceId, createdById: actor.id,
        data: { kind: 'pull_request', pullRequest: {
          provider: 'github', url, repo, number, title: `${repo}#${number}`,
          state: 'open', headSha: null, fetchedAt: this.now(),
        } },
      });
    }
    const edge = this.addEdgeRec({ srcId: id, dstId: pr.id, type: 'tracks', createdById: actor.id });
    const activity = this.pushActivity({
      spaceId: rec.spaceId, entityId: id, actorId: actor.id,
      verb: 'linked_pr', summary: { url, prId: pr.id }, refId: edge.id,
    });
    this.emitEdge(edge, false, input.clientMutationId);
    this.emitEntity(pr.id);
    this.emitEntity(id, input.clientMutationId);
    return this.result({ entityId: pr.id, edge, activity, patchIds: [id, pr.id], cmid: input.clientMutationId, op: 'entity.link_pr' });
  }

  postMessage(input: PostMessageInput): CommandResult {
    assertInput('postMessage', input, COMMAND_FIELDS.postMessage);
    const replay = this.replayIfSeen('message.post', input);
    if (replay) return replay;
    if (!input.body.trim()) throw new CollabError('invalid_input', 'message body is required');
    const anchor = this.rec(input.anchorId);
    const actor = this.actorRec(input.actorId);
    let rootMessageId: EntityId | null = null;
    let parentId: EntityId | null = null;
    if (input.parentMessageId) {
      const parent = this.rec(input.parentMessageId);
      if (parent.data.kind !== 'message') throw new CollabError('invalid_input', 'parentMessageId must be a message');
      parentId = parent.id;
      rootMessageId = parent.data.message.rootMessageId ?? parent.id;
    }
    const rec = this.createEntityRec({
      spaceId: anchor.spaceId, parentId, createdById: actor.id,
      data: {
        kind: 'message',
        message: {
          anchorId: anchor.id, rootMessageId, authorId: actor.id,
          body: input.body, mentions: [...(input.mentions ?? [])],
          attachments: [...(input.attachments ?? [])], editedAt: null,
        },
      },
    });
    anchor.counters.messages += 1;
    this.touchActivity(anchor);
    if (parentId) {
      const parent = this.rec(parentId);
      parent.counters.messages += 1;
      this.emitCounter(parentId);
    }
    // Mention notifications route to the mentioned actor's owning member.
    for (const m of input.mentions ?? []) {
      this.pushNotification({
        spaceId: anchor.spaceId, kind: 'mention', actorId: actor.id, targetId: anchor.id,
        message: `${this.actorSummary(actor.id).displayName} mentioned ${m.display} on ${this.titleOf(anchor)}`,
        recipientMemberId: this.ownerMemberIdOf(m.entityId),
      });
    }
    const activity = this.pushActivity({
      spaceId: anchor.spaceId, entityId: anchor.id, actorId: actor.id,
      verb: 'commented', summary: { messageId: rec.id, excerpt: excerptOf(input.body, 80) }, refId: rec.id,
    });
    this.emitMessage('message.created', rec.id);
    this.emitCounter(anchor.id);
    this.emitEntity(anchor.id, input.clientMutationId);
    return this.result({ entityId: rec.id, activity, patchIds: [anchor.id], cmid: input.clientMutationId, op: 'message.post' });
  }

  patchMessage(id: EntityId, input: PatchMessageInput): CommandResult {
    assertInput('patchMessage', input, COMMAND_FIELDS.patchMessage);
    const replay = this.replayIfSeen('message.patch', input);
    if (replay) return replay;
    const rec = this.rec(id);
    if (rec.data.kind !== 'message') throw new CollabError('invalid_input', `${id} is not a message`);
    const actor = this.actorRec(input.actorId);
    if (rec.data.message.authorId !== actor.id) {
      throw new CollabError('forbidden', 'only the author may edit a message');
    }
    rec.data.message.body = input.body;
    if (input.mentions) rec.data.message.mentions = [...input.mentions];
    rec.data.message.editedAt = this.now();
    this.touchContent(rec, actor.id); // editing bumps message version (contract §4)
    const anchor = this.entities.get(rec.data.message.anchorId);
    if (anchor) this.touchActivity(anchor);
    this.emitMessage('message.updated', id);
    if (anchor) this.emitEntity(anchor.id);
    return this.result({ entityId: id, patchIds: anchor ? [anchor.id] : [], cmid: input.clientMutationId, op: 'message.patch' });
  }

  deleteMessage(id: EntityId, ctx: CommandContext = {}): CommandResult {
    assertInput('deleteMessage', ctx, COMMAND_FIELDS.contextOnly);
    const replay = this.replayIfSeen('message.delete', ctx);
    if (replay) return replay;
    const rec = this.rec(id);
    if (rec.data.kind !== 'message') throw new CollabError('invalid_input', `${id} is not a message`);
    const actor = this.actorRec(ctx.actorId);
    rec.deletedAt = this.now();
    rec.data.message.body = ''; // body redacted; tombstone keeps history shape
    const anchor = this.entities.get(rec.data.message.anchorId);
    if (anchor) {
      anchor.counters.messages = Math.max(0, anchor.counters.messages - 1);
      this.touchActivity(anchor);
      this.emitCounter(anchor.id);
      this.emitEntity(anchor.id);
    }
    this.emitMessage('message.deleted', id);
    const activity = this.pushActivity({
      spaceId: rec.spaceId, entityId: anchor?.id ?? null, actorId: actor.id,
      verb: 'message_deleted', summary: { messageId: id }, refId: id,
    });
    return this.result({ activity, patchIds: anchor ? [anchor.id] : [], cmid: ctx.clientMutationId, op: 'message.delete' });
  }

  /** DEV-7: PUT-semantics reaction toggle — singular `reaction`, `enabled` flag. */
  setReaction(id: EntityId, input: ReactionInput): CommandResult {
    assertInput('setReaction', input, COMMAND_FIELDS.setReaction);
    const replay = this.replayIfSeen('reaction.set', input);
    if (replay) return replay;
    const rec = this.rec(id);
    const actor = this.actorRec(input.actorId);
    const typeOf = { like: 'likes', dislike: 'dislikes', star: 'stars' } as const;
    const counterOf = { like: 'likes', dislike: 'dislikes', star: 'stars' } as const;
    const type = typeOf[input.reaction];
    if (!type) throw new CollabError('invalid_input', `unknown reaction "${input.reaction}"`);

    const removeReaction = (t: 'likes'|'dislikes'|'stars'): void => {
      const existing = this.findEdge(actor.id, id, t);
      if (existing) {
        this.edges.delete(existing.id);
        rec.counters[t] = Math.max(0, rec.counters[t] - 1);
      }
    };

    if (input.enabled) {
      if (!this.findEdge(actor.id, id, type)) {
        // like/dislike are mutually exclusive — the toggle swaps, star is independent
        if (input.reaction === 'like') removeReaction('dislikes');
        if (input.reaction === 'dislike') removeReaction('likes');
        this.addEdgeRec({ srcId: actor.id, dstId: id, type, createdById: actor.id, bumpActivity: false });
        rec.counters[counterOf[input.reaction]] += 1;
      }
    } else {
      removeReaction(type);
    }
    this.emitCounter(id);
    this.emitEntity(id, input.clientMutationId);
    return this.result({ entityId: id, patchIds: [id], cmid: input.clientMutationId, op: 'reaction.set' });
  }

  grantPoints(id: EntityId, input: GrantPointsInput): CommandResult {
    assertInput('grantPoints', input, COMMAND_FIELDS.grantPoints);
    const replay = this.replayIfSeen('points.grant', input);
    if (replay) return replay;
    if (!Number.isFinite(input.amount) || input.amount === 0) {
      throw new CollabError('invalid_input', 'points amount must be a non-zero number');
    }
    const rec = this.rec(id);
    const actor = this.actorRec(input.actorId);
    this.pointEvents.push({
      id: this.nextId('pev'), spaceId: rec.spaceId, entityId: id, actorId: actor.id,
      amount: input.amount, reason: input.reason, refId: input.referenceId ?? null,
      createdAt: this.now(),
    });
    rec.counters.points += input.amount;
    this.touchActivity(rec);
    const activity = this.pushActivity({
      spaceId: rec.spaceId, entityId: id, actorId: actor.id,
      verb: input.reason === 'award' ? 'awarded' : 'granted_points',
      summary: { amount: input.amount, reason: input.reason }, refId: input.referenceId ?? null,
    });
    this.emitCounter(id);
    this.emitEntity(id, input.clientMutationId);
    return this.result({ entityId: id, activity, patchIds: [id], cmid: input.clientMutationId, op: 'points.grant' });
  }

  /**
   * Completion flow (design §11.3): criteria check → done → completed_by edges
   * → award the pool to each completer → unblock ripple. One transaction.
   */
  completeTask(id: EntityId, input: CompleteTaskInput): CommandResult {
    assertInput('completeTask', input, COMMAND_FIELDS.completeTask);
    const replay = this.replayIfSeen('task.complete', input);
    if (replay) return replay;
    const rec = this.rec(id);
    if (rec.data.kind !== 'task') throw new CollabError('invalid_input', `${id} is not a task`);
    this.assertVersion(rec, input.expectedVersion);
    if (rec.data.task.workStatus === 'done') {
      throw new CollabError('invariant_violation', `${id} is already completed (awards are idempotent)`);
    }
    if (input.completerIds.length === 0) throw new CollabError('invalid_input', 'completerIds must not be empty');
    const openCriteria = rec.data.task.acceptanceCriteria.filter((c) => !c.done);
    if (openCriteria.length > 0) {
      throw new CollabError('invalid_input',
        `cannot complete: ${openCriteria.length} acceptance criteria still open`);
    }
    const actor = this.actorRec(input.actorId);
    const completers = input.completerIds.map((cid) => this.actorRec(cid));

    rec.data.task.workStatus = 'done';
    rec.updatedAt = this.now();
    this.touchActivity(rec);
    // Clear working edges — the work is finished.
    for (const e of this.edgesTo(id, 'working_on')) this.edges.delete(e.id);

    const pool = rec.counters.points > 0 ? rec.counters.points : (rec.data.task.pointsEstimate ?? 0);
    const patchIds: EntityId[] = [id];
    for (const completer of completers) {
      const edge = this.addEdgeRec({
        srcId: id, dstId: completer.id, type: 'completed_by',
        props: { awardedPoints: pool }, createdById: actor.id,
      });
      this.emitEdge(edge);
      if (pool !== 0) {
        this.pointEvents.push({
          id: this.nextId('pev'), spaceId: rec.spaceId, entityId: completer.id,
          actorId: actor.id, amount: pool, reason: 'award', refId: id, createdAt: this.now(),
        });
        completer.counters.points += pool;
        this.emitCounter(completer.id);
      }
      this.pushNotification({
        spaceId: rec.spaceId, kind: 'award', actorId: actor.id, targetId: id,
        message: `${this.actorSummary(completer.id).displayName} awarded ${pool} points for ${this.titleOf(rec)}`,
        recipientMemberId: this.ownerMemberIdOf(completer.id),
      });
      patchIds.push(completer.id);
      this.emitEntity(completer.id);
    }
    const activity = this.pushActivity({
      spaceId: rec.spaceId, entityId: id, actorId: actor.id,
      verb: 'completed',
      summary: { completerIds: input.completerIds, awardedPoints: pool }, refId: null,
    });
    this.rippleUnblock(id, actor.id, patchIds);
    this.emitEntity(id, input.clientMutationId);
    return this.result({ entityId: id, activity, patchIds, cmid: input.clientMutationId, op: 'task.complete' });
  }

  pullEntity(id: EntityId, input: PullInput): CommandResult {
    assertInput('pullEntity', input, COMMAND_FIELDS.pullEntity);
    const replay = this.replayIfSeen('entity.pull', input);
    if (replay) return replay;
    const rec = this.rec(id);
    const actor = this.actorRec(input.actorId);
    const edge = this.addEdgeRec({
      srcId: actor.id, dstId: id, type: 'pulled',
      props: {
        localId: input.localId ?? null,
        pinnedVersion: input.pinnedVersion,
        workStatus: 'pulled',
        pulledAt: this.now(),
      },
      createdById: actor.id,
    });
    if (rec.data.kind === 'task' && rec.data.task.workStatus === 'open') {
      rec.data.task.workStatus = 'pulled'; // API-level rule, first pull transitions
      rec.updatedAt = this.now();
    }
    const activity = this.pushActivity({
      spaceId: rec.spaceId, entityId: id, actorId: actor.id,
      verb: 'pulled', summary: { pinnedVersion: input.pinnedVersion }, refId: edge.id,
    });
    this.emitEdge(edge, false, input.clientMutationId);
    this.emitEntity(id, input.clientMutationId);
    return this.result({ entityId: id, edge, activity, patchIds: [id], cmid: input.clientMutationId, op: 'entity.pull' });
  }

  setWork(id: EntityId, input: WorkInput): CommandResult {
    assertInput('setWork', input, COMMAND_FIELDS.setWork);
    if (input.startedAt !== undefined && Number.isNaN(Date.parse(input.startedAt))) {
      throw new CollabError('invalid_input', `setWork: "startedAt" must be an ISO timestamp, got ${JSON.stringify(input.startedAt)}`);
    }
    const replay = this.replayIfSeen('task.work', input);
    if (replay) return replay;
    const rec = this.rec(id);
    if (rec.data.kind !== 'task') throw new CollabError('invalid_input', `${id} is not a task`);
    if (input.status === 'done') {
      throw new CollabError('invariant_violation', 'use completeTask to finish a task (awards + edges are transactional)');
    }
    const actor = this.actorRec(input.actorId);
    const startedAtMs = input.startedAt ? Date.parse(input.startedAt) : this.now();

    if (input.status === 'working') {
      const edge = this.addEdgeRec({
        srcId: actor.id, dstId: id, type: 'working_on',
        props: { startedAt: startedAtMs, note: input.note ?? null }, createdById: actor.id,
      });
      this.emitEdge(edge, false, input.clientMutationId);
    } else {
      const existing = this.findEdge(actor.id, id, 'working_on');
      if (existing) { this.edges.delete(existing.id); this.emitEdge(existing, true); }
    }
    rec.data.task.workStatus = input.status;
    rec.updatedAt = this.now();
    this.touchActivity(rec);
    // keep the actor's pull edge status in sync
    const pull = this.findEdge(actor.id, id, 'pulled');
    if (pull) pull.props = { ...pull.props, workStatus: input.status };

    if (input.status === 'in_review') {
      this.pushNotification({
        spaceId: rec.spaceId, kind: 'review_request', actorId: actor.id, targetId: id,
        message: `${this.actorSummary(actor.id).displayName} requests review on ${this.titleOf(rec)}`,
        recipientMemberId: this.ownerMemberIdOf(rec.createdById),
      });
    }
    const activity = this.pushActivity({
      spaceId: rec.spaceId, entityId: id, actorId: actor.id,
      verb: 'status_changed', summary: { workStatus: input.status, note: input.note ?? null }, refId: null,
    });
    this.emitEntity(id, input.clientMutationId);
    return this.result({ entityId: id, activity, patchIds: [id], cmid: input.clientMutationId, op: 'task.work' });
  }

  trackingRefresh(input: TrackingRefreshInput): CommandResult {
    assertInput('trackingRefresh', input, COMMAND_FIELDS.trackingRefresh);
    const replay = this.replayIfSeen('tracking.refresh', input);
    if (replay) return replay;
    const targets: EntityRec[] = [];
    if (input.entityIds && input.entityIds.length > 0) {
      for (const id of input.entityIds) {
        const rec = this.rec(id);
        if (rec.kind !== 'pull_request' && rec.kind !== 'commit') {
          throw new CollabError('invalid_input', `${id} is not a tracking entity`);
        }
        targets.push(rec);
      }
    } else {
      for (const rec of this.entities.values()) {
        if ((rec.kind === 'pull_request' || rec.kind === 'commit') && rec.deletedAt == null) targets.push(rec);
      }
    }
    const patchIds: EntityId[] = [];
    for (const rec of targets) {
      if (rec.data.kind === 'pull_request') rec.data.pullRequest.fetchedAt = this.now();
      if (rec.data.kind === 'commit' && rec.data.commit.committedAt == null) rec.data.commit.committedAt = this.now();
      rec.updatedAt = this.now();
      patchIds.push(rec.id);
      this.emitEntity(rec.id, input.clientMutationId);
    }
    return this.result({ patchIds, cmid: input.clientMutationId, op: 'tracking.refresh' });
  }

  markRead(anchorId: EntityId, ctx: CommandContext = {}): CommandResult {
    assertInput('markRead', ctx, COMMAND_FIELDS.contextOnly);
    const replay = this.replayIfSeen('read.mark', ctx);
    if (replay) return replay;
    const rec = this.rec(anchorId);
    const actor = this.actorRec(ctx.actorId);
    const memberId = this.ownerMemberIdOf(actor.id);
    this.readMarks.set(`${memberId}|${anchorId}`, this.now());
    this.emitEntity(anchorId, ctx.clientMutationId);
    return this.result({ entityId: anchorId, patchIds: [rec.id], cmid: ctx.clientMutationId, op: 'read.mark' });
  }

  markNotificationRead(notificationId: string, ctx: CommandContext = {}): CommandResult {
    assertInput('markNotificationRead', ctx, COMMAND_FIELDS.contextOnly);
    const replay = this.replayIfSeen('notification.read', ctx);
    if (replay) return replay;
    const rec = this.notifications.find((n) => n.id === notificationId);
    if (!rec) throw new CollabError('not_found', `notification ${notificationId} not found`);
    if (rec.readAt == null) {
      rec.readAt = this.now();
      this.pending.push({ type: 'notification.read', eventId: this.nextEventId(), notification: this.notificationItem(rec) });
    }
    return this.result({ patchIds: [], cmid: ctx.clientMutationId, op: 'notification.read' });
  }

  // --- axes & saved views ---------------------------------------------------

  createTaskAxis(spaceId: SpaceId, input: TaskAxisInput): TaskAxis {
    assertInput('createTaskAxis', input, COMMAND_FIELDS.createTaskAxis);
    const replay = this.replayValue<TaskAxis>('axis.create', input);
    if (replay) return replay;
    if (!this.spaces.has(spaceId)) throw new CollabError('not_found', `space ${spaceId} not found`);
    for (const axis of this.taskAxes.values()) {
      if (axis.spaceId === spaceId && axis.name === input.name) {
        throw new CollabError('invalid_input', `axis "${input.name}" already exists`);
      }
    }
    const rec: TaskAxisRec = {
      id: this.nextId('axis'), spaceId, name: input.name,
      axisValues: [...input.axisValues], kind: input.kind, position: input.position,
    };
    this.taskAxes.set(rec.id, rec);
    return this.remember('axis.create', input, { ...rec, axisValues: [...rec.axisValues] });
  }

  updateTaskAxis(spaceId: SpaceId, axisId: string, input: Partial<TaskAxisInput>): TaskAxis {
    assertInput('updateTaskAxis', input, COMMAND_FIELDS.updateTaskAxis);
    const replay = this.replayValue<TaskAxis>('axis.update', input);
    if (replay) return replay;
    const rec = this.taskAxes.get(axisId);
    if (!rec || rec.spaceId !== spaceId) throw new CollabError('not_found', `axis ${axisId} not found`);
    if (input.name !== undefined) rec.name = input.name;
    if (input.axisValues !== undefined) rec.axisValues = [...input.axisValues];
    if (input.position !== undefined) rec.position = input.position;
    return this.remember('axis.update', input, { ...rec, axisValues: [...rec.axisValues] });
  }

  deleteTaskAxis(spaceId: SpaceId, axisId: string): void {
    const rec = this.taskAxes.get(axisId);
    if (!rec || rec.spaceId !== spaceId) throw new CollabError('not_found', `axis ${axisId} not found`);
    if (rec.kind === 'default') throw new CollabError('forbidden', 'the default axis cannot be deleted');
    this.taskAxes.delete(axisId);
  }

  createSavedView(spaceId: SpaceId, input: SavedViewInput): SavedView {
    assertInput('createSavedView', input, COMMAND_FIELDS.createSavedView);
    const replay = this.replayValue<SavedView>('view.create', input);
    if (replay) return replay;
    const rec: SavedViewRec = {
      id: this.nextId('view'), spaceId, name: input.name, shareMode: input.shareMode,
      query: input.query, graphLayout: input.graphLayout,
      createdById: input.actorId ?? this.viewerId, createdAt: this.now(),
    };
    this.savedViews.set(rec.id, rec);
    return this.remember('view.create', input, this.savedViewOf(rec));
  }

  updateSavedView(viewId: string, input: Partial<SavedViewInput>): SavedView {
    assertInput('updateSavedView', input, COMMAND_FIELDS.updateSavedView);
    const replay = this.replayValue<SavedView>('view.update', input);
    if (replay) return replay;
    const rec = this.savedViews.get(viewId);
    if (!rec) throw new CollabError('not_found', `saved view ${viewId} not found`);
    if (input.name !== undefined) rec.name = input.name;
    if (input.shareMode !== undefined) rec.shareMode = input.shareMode;
    if (input.query !== undefined) rec.query = input.query;
    if (input.graphLayout !== undefined) rec.graphLayout = input.graphLayout;
    return this.remember('view.update', input, this.savedViewOf(rec));
  }

  deleteSavedView(viewId: string): void {
    if (!this.savedViews.delete(viewId)) throw new CollabError('not_found', `saved view ${viewId} not found`);
  }

  private savedViewOf(rec: SavedViewRec): SavedView {
    return {
      id: rec.id, spaceId: rec.spaceId, name: rec.name, shareMode: rec.shareMode,
      query: rec.query as CollectionQuery, graphLayout: rec.graphLayout,
      createdBy: this.actorSummary(rec.createdById), createdAt: iso(rec.createdAt),
    };
  }

  // --- presence (fed by the simulation driver) ------------------------------

  /**
   * DEV-4: presence pulses queue on the SEPARATE client-side channel
   * (`drainPresenceEvents` → `subscribePresence`), never the durable stream.
   */
  setPresence(entityId: EntityId, viewerIds: EntityId[], typingActorIds: EntityId[] = []): void {
    const rec: PresenceRec = { viewerIds, typingActorIds, updatedAt: this.now() };
    this.presence.set(entityId, rec);
    this.pendingPresence.push({
      type: 'presence.changed', eventId: this.nextEventId(), entityId,
      presence: this.presenceOf(entityId),
    });
    this.pendingPresence.push({
      type: 'typing.changed', eventId: this.nextEventId(), anchorId: entityId,
      typingActorIds: [...typingActorIds],
    });
  }

  presenceOf(entityId: EntityId): PresenceSnapshot {
    const rec = this.presence.get(entityId);
    if (!rec) return { viewers: [], typingActorIds: [], updatedAt: iso(this.now()) };
    return {
      viewers: rec.viewerIds.map((id) => this.actorSummary(id)),
      typingActorIds: [...rec.typingActorIds],
      updatedAt: iso(rec.updatedAt),
    };
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  listSpaces(): SpaceSummary[] {
    return [...this.spaces.values()].map((s) => this.spaceSummaryOf(s));
  }

  private spaceSummaryOf(s: SpaceRec): SpaceSummary {
    let memberCount = 0;
    let unreadTotal = 0;
    for (const rec of this.entities.values()) {
      if (rec.spaceId !== s.id || rec.deletedAt != null) continue;
      if (rec.kind === 'member') memberCount += 1;
      if (rec.kind === 'channel' && this.viewerId) unreadTotal += this.unreadCountFor(rec.id, this.viewerId);
    }
    return {
      id: s.id, name: s.name, description: s.description, memberCount,
      unreadTotal, githubRepo: s.githubRepo, createdAt: iso(s.createdAt),
    };
  }

  navigation(spaceId: SpaceId): SpaceNavigation {
    const space = this.spaces.get(spaceId);
    if (!space) throw new CollabError('not_found', `space ${spaceId} not found`);
    const channelRoots = [...this.entities.values()]
      .filter((r) => r.spaceId === spaceId && r.kind === 'channel' && r.deletedAt == null && r.parentId == null)
      .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
    const toNode = (rec: EntityRec): NavChannelNode => {
      const children = this.childrenOf(rec.id).map(toNode);
      return { entity: this.summary(rec), childCount: children.length, children };
    };
    return {
      spaceId,
      viewer: this.actorSummary(this.viewerId),
      unreadTotal: this.spaceSummaryOf(space).unreadTotal,
      channels: channelRoots.map(toNode),
    };
  }

  /**
   * The actor's "stable": their owning member plus every team_member that
   * member owns — the scope actor-preset filters (inFlightForActorId,
   * needsActorId, home presets) expand to server-side.
   */
  private actorStable(actorId: EntityId): Set<EntityId> {
    const memberId = this.ownerMemberIdOf(actorId);
    const out = new Set<EntityId>([memberId]);
    for (const rec of this.entities.values()) {
      if (rec.data.kind === 'team_member' && rec.data.teamMember.ownerMemberId === memberId && rec.deletedAt == null) {
        out.add(rec.id);
      }
    }
    return out;
  }

  private descendantIds(rootId: EntityId): Set<EntityId> {
    const out = new Set<EntityId>();
    const stack = [rootId];
    while (stack.length > 0) {
      const cur = stack.pop() as EntityId;
      for (const child of this.childrenOf(cur)) {
        if (!out.has(child.id)) { out.add(child.id); stack.push(child.id); }
      }
    }
    return out;
  }

  queryCollection(query: CollectionQuery): CollectionResult {
    if (!this.spaces.has(query.spaceId)) throw new CollabError('not_found', `space ${query.spaceId} not found`);
    const f = query.filters ?? {};
    const deletedMode = f.deleted ?? 'exclude';
    const subtree = query.subtreeOf ? this.descendantIds(query.subtreeOf) : null;
    const inFlightStable = f.inFlightForActorId ? this.actorStable(f.inFlightForActorId) : null;

    let items: EntityRec[] = [];
    for (const rec of this.entities.values()) {
      if (rec.spaceId !== query.spaceId) continue;
      if (deletedMode === 'exclude' && rec.deletedAt != null) continue;
      if (deletedMode === 'only' && rec.deletedAt == null) continue;
      if (query.kinds && !query.kinds.includes(rec.kind)) continue;
      if (subtree && !subtree.has(rec.id)) continue;
      if (query.parentId !== undefined && rec.parentId !== query.parentId) continue;
      if (f.workStatus && (rec.data.kind !== 'task' || !f.workStatus.includes(rec.data.task.workStatus))) continue;
      if (f.axes) {
        if (rec.data.kind !== 'task') continue;
        const axes = rec.data.task.axes;
        let ok = true;
        for (const [axis, values] of Object.entries(f.axes)) {
          if (!values.includes(axes[axis] ?? '')) { ok = false; break; }
        }
        if (!ok) continue;
      }
      if (f.assigneeIds && f.assigneeIds.length > 0) {
        const assigned = this.edgesFrom(rec.id, 'assigned_to').map((e) => e.dstId);
        if (!f.assigneeIds.some((a) => assigned.includes(a))) continue;
      }
      if (f.edge) {
        const hit = f.edge.direction === 'outgoing'
          ? this.findEdge(rec.id, f.edge.entityId, f.edge.type)
          : this.findEdge(f.edge.entityId, rec.id, f.edge.type);
        if (!hit) continue;
      }
      if (f.readyToPull) {
        if (rec.data.kind !== 'task') continue;
        if (rec.data.task.workStatus !== 'open') continue;
        if (this.unresolvedHardDeps(rec.id).length > 0) continue;
      }
      if (f.inReviewForActorId) {
        if (rec.data.kind !== 'task' || rec.data.task.workStatus !== 'in_review') continue;
        const memberId = this.ownerMemberIdOf(f.inReviewForActorId);
        const involved = this.ownerMemberIdOf(rec.createdById) === memberId
          || this.assigneesOf(rec.id).some((a) => this.ownerMemberIdOf(a.id) === memberId);
        if (!involved) continue;
      }
      if (f.mentionedActorId) {
        const mentioned = this.messagesAnchoredTo(rec.id).some((m) =>
          m.data.kind === 'message' && m.data.message.mentions.some((mm) => mm.entityId === f.mentionedActorId));
        if (!mentioned) continue;
      }
      if (inFlightStable) {
        // Home preset `inFlight`: tasks the actor's stable has pulled or is
        // working on, still open-ended (not done/cancelled).
        if (rec.data.kind !== 'task') continue;
        if (rec.data.task.workStatus === 'done' || rec.data.task.workStatus === 'cancelled') continue;
        let held = false;
        for (const e of this.edges.values()) {
          if ((e.type === 'pulled' || e.type === 'working_on') && e.dstId === rec.id && inFlightStable.has(e.srcId)) {
            held = true;
            break;
          }
        }
        if (!held) continue;
      }
      if (f.needsActorId) {
        // Home preset `needsMe`: UNION of in_review involvement (the
        // inReviewForActorId semantics) and entities where the actor is
        // @mentioned (the mentionedActorId semantics).
        const memberId = this.ownerMemberIdOf(f.needsActorId);
        const inReview = rec.data.kind === 'task' && rec.data.task.workStatus === 'in_review'
          && (this.ownerMemberIdOf(rec.createdById) === memberId
            || this.assigneesOf(rec.id).some((a) => this.ownerMemberIdOf(a.id) === memberId));
        const mentioned = !inReview && this.messagesAnchoredTo(rec.id).some((m) =>
          m.data.kind === 'message' && m.data.message.mentions.some((mm) => mm.entityId === f.needsActorId));
        if (!inReview && !mentioned) continue;
      }
      items.push(rec);
    }

    const sort = query.sort ?? 'activityAt_desc';
    items = items.sort((a, b) => {
      switch (sort) {
        case 'position': return a.position - b.position || a.createdAt - b.createdAt;
        case 'createdAt_desc': return b.createdAt - a.createdAt;
        case 'dueDate': {
          const da = a.data.kind === 'task' && a.data.task.dueDate ? Date.parse(a.data.task.dueDate) : Number.POSITIVE_INFINITY;
          const db = b.data.kind === 'task' && b.data.task.dueDate ? Date.parse(b.data.task.dueDate) : Number.POSITIVE_INFINITY;
          return da - db;
        }
        case 'priority': {
          const pa = a.data.kind === 'task' ? PRIORITY_ORDER[a.data.task.priority] : 9;
          const pb = b.data.kind === 'task' ? PRIORITY_ORDER[b.data.task.priority] : 9;
          return pa - pb;
        }
        case 'activityAt_desc':
        default:
          return b.activityAt - a.activityAt;
      }
    });

    const summaries = items.map((r) => this.summary(r));
    const page = this.paginate(summaries, query.cursor, query.limit ?? DEFAULT_PAGE);
    const result: CollectionResult = { query, page };

    if (query.groupBy) {
      const groups = new Map<string, { label: string; items: EntitySummary[] }>();
      const push = (key: string, label: string, s: EntitySummary): void => {
        const g = groups.get(key) ?? { label, items: [] };
        g.items.push(s);
        groups.set(key, g);
      };
      for (const s of page.items) {
        if (query.groupBy === 'workStatus') {
          const status = s.state.kind === 'task' ? s.state.workStatus : 'open';
          push(status, status.replace('_', ' '), s);
        } else if (query.groupBy === 'assignee') {
          const assignees = s.state.kind === 'task' ? s.state.assignees : [];
          if (assignees.length === 0) push('unassigned', 'Unassigned', s);
          for (const a of assignees) push(a.id, a.displayName, s);
        } else {
          const axis = query.groupBy.slice('axis:'.length);
          const value = s.state.kind === 'task' ? (s.state.axes[axis] ?? '') : '';
          push(value || 'none', value || 'None', s);
        }
      }
      let ordered: CollectionGroup[] = [...groups.entries()].map(([key, g]) => ({ key, label: g.label, items: g.items }));
      if (query.groupBy === 'workStatus') {
        ordered = ordered.sort((a, b) =>
          STATUS_ORDER.indexOf(a.key as WorkStatus) - STATUS_ORDER.indexOf(b.key as WorkStatus));
      }
      result.groups = ordered;
    }
    return result;
  }

  queryGraph(query: GraphQuery): GraphResult {
    const edgeTypeOk = (type: string): boolean => {
      if (REACTION_TYPES.has(type)) return false;
      if (query.mode === 'dependency') return type === 'depends_on';
      if (query.edgeTypes && query.edgeTypes.length > 0) return query.edgeTypes.includes(type);
      return true;
    };

    let nodeIds: Set<EntityId>;
    if (query.focusId) {
      nodeIds = new Set([query.focusId]);
      const hops = query.hops ?? 2;
      let frontier = [query.focusId];
      for (let h = 0; h < hops; h += 1) {
        const next: EntityId[] = [];
        for (const id of frontier) {
          const neighbors: EntityId[] = [];
          for (const e of this.edges.values()) {
            if (!edgeTypeOk(e.type)) continue;
            if (e.srcId === id) neighbors.push(e.dstId);
            if (e.dstId === id) neighbors.push(e.srcId);
          }
          const rec = this.entities.get(id);
          if (rec?.parentId) neighbors.push(rec.parentId);
          for (const child of this.childrenOf(id)) neighbors.push(child.id);
          for (const n of neighbors) {
            if (!nodeIds.has(n) && this.liveEntity(n)) { nodeIds.add(n); next.push(n); }
          }
        }
        frontier = next;
      }
      if (query.kinds) {
        for (const id of [...nodeIds]) {
          const rec = this.entities.get(id);
          if (id !== query.focusId && rec && !query.kinds.includes(rec.kind)) nodeIds.delete(id);
        }
      }
    } else {
      const collection = this.queryCollection({ ...query, cursor: undefined, limit: query.limit ?? 200 });
      nodeIds = new Set(collection.page.items.map((s) => s.id));
    }

    const nodes = [...nodeIds]
      .map((id) => this.liveEntity(id))
      .filter((r): r is EntityRec => r != null)
      .map((r) => this.summary(r));
    const included = new Set(nodes.map((n) => n.id));
    const edges: EdgeView[] = [];
    for (const e of this.edges.values()) {
      if (!edgeTypeOk(e.type)) continue;
      if (included.has(e.srcId) && included.has(e.dstId)) edges.push(this.edgeView(e));
    }
    const clusterMap = new Map<EntityId, EntityId[]>();
    for (const n of nodes) {
      if (n.parentId && included.has(n.parentId)) {
        const list = clusterMap.get(n.parentId) ?? [];
        list.push(n.id);
        clusterMap.set(n.parentId, list);
      }
    }
    return {
      nodes, edges,
      clusters: [...clusterMap.entries()].map(([parentId, childIds]) => ({ parentId, childIds })),
    };
  }

  /**
   * Home presets are SERVER-defined and must be FAITHFUL: each returned
   * CollectionQuery re-executes to exactly the snapshot's items (parity-
   * tested), so the Home screen can re-run/paginate presets instead of
   * hand-building scoped queries. Actor scope (viewer + owned agents) rides
   * in the filters — `assigneeIds` for readyToPull, the server-preset
   * `inFlightForActorId`/`needsActorId` expansions for the other two.
   */
  home(spaceId: SpaceId): HomeSnapshot {
    const viewerId = this.viewerId;
    const ready = this.queryCollection({
      spaceId, kinds: ['task'],
      filters: { readyToPull: true, assigneeIds: [...this.actorStable(viewerId)] },
      sort: 'priority',
    });
    const inFlight = this.queryCollection({
      spaceId, kinds: ['task'], filters: { inFlightForActorId: viewerId }, sort: 'activityAt_desc',
    });
    const needsMe = this.queryCollection({
      spaceId, filters: { needsActorId: viewerId }, sort: 'activityAt_desc',
    });
    return { readyToPull: ready, inFlight, needsMe, activity: this.spaceActivity(spaceId, undefined, 20) };
  }

  messagesPage(anchorId: EntityId, opts: { cursor?: Cursor; order?: 'asc'|'desc'; rootId?: EntityId } = {}): Page<MessageView> {
    this.rec(anchorId, { allowDeleted: true });
    let messages = this.messagesAnchoredTo(anchorId, { includeDeleted: true })
      .filter((m) => m.deletedAt == null || this.childrenOf(m.id).length > 0); // tombstones only where replies hang off them
    if (opts.rootId) {
      messages = messages.filter((m) =>
        m.data.kind === 'message' && (m.data.message.rootMessageId === opts.rootId || m.id === opts.rootId));
    } else {
      messages = messages.filter((m) => m.data.kind === 'message' && m.data.message.rootMessageId == null);
    }
    if (opts.order === 'desc') messages = [...messages].reverse();
    return this.paginate(messages.map((m) => this.messageView(m, { withReplies: !opts.rootId })), opts.cursor);
  }

  activityPage(entityId: EntityId, cursor?: Cursor): Page<ActivityItem> {
    this.rec(entityId, { allowDeleted: true });
    const items = this.activity
      .filter((a) => a.entityId === entityId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((a) => this.activityItem(a));
    return this.paginate(items, cursor);
  }

  spaceActivity(spaceId: SpaceId, cursor?: Cursor, limit = DEFAULT_PAGE): Page<ActivityItem> {
    const items = this.activity
      .filter((a) => a.spaceId === spaceId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((a) => this.activityItem(a));
    return this.paginate(items, cursor, limit);
  }

  versionsPage(entityId: EntityId, cursor?: Cursor): Page<{ version: number; changedBy: EntityId; changedAt: string }> {
    this.rec(entityId, { allowDeleted: true });
    const items = [...(this.versions.get(entityId) ?? [])]
      .sort((a, b) => b.version - a.version)
      .map((v) => ({ version: v.version, changedBy: v.changedById, changedAt: iso(v.changedAt) }));
    return this.paginate(items, cursor, DEFAULT_PAGE, (v) => String(v.version));
  }

  inbox(cursor?: Cursor): Page<NotificationItem> {
    const items = this.notifications
      .filter((n) => n.recipientMemberId === this.viewerId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((n) => this.notificationItem(n));
    return this.paginate(items, cursor);
  }

  leaderboard(spaceId: SpaceId, cursor?: Cursor): Page<LeaderboardRow> {
    const rows: LeaderboardRow[] = [];
    for (const rec of this.entities.values()) {
      if (rec.spaceId !== spaceId || rec.deletedAt != null) continue;
      if (rec.kind !== 'member' && rec.kind !== 'team_member') continue;
      rows.push({ actor: this.actorSummary(rec.id), score: this.scoreOf(rec.id), rank: 0 });
    }
    rows.sort((a, b) => b.score - a.score || a.actor.displayName.localeCompare(b.actor.displayName));
    rows.forEach((r, i) => { r.rank = i + 1; });
    return this.paginate(rows, cursor, DEFAULT_PAGE, (r) => r.actor.id);
  }

  awards(spaceId: SpaceId, cursor?: Cursor): Page<PointEventView> {
    const items = this.pointEvents
      .filter((pe) => pe.spaceId === spaceId && pe.reason === 'award')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((pe): PointEventView => ({
        id: pe.id,
        recipient: this.actorSummary(pe.entityId),
        actor: this.actorSummary(pe.actorId),
        amount: pe.amount,
        reason: pe.reason,
        onEntity: this.entities.has(pe.entityId) ? this.summary(this.rec(pe.entityId, { allowDeleted: true })) : null,
        ref: pe.refId && this.entities.has(pe.refId) ? this.summary(this.rec(pe.refId, { allowDeleted: true })) : null,
        createdAt: iso(pe.createdAt),
      }));
    return this.paginate(items, cursor);
  }

  taskAxesList(spaceId: SpaceId): TaskAxis[] {
    return [...this.taskAxes.values()]
      .filter((a) => a.spaceId === spaceId)
      .sort((a, b) => a.position - b.position)
      .map((a) => ({ ...a, axisValues: [...a.axisValues] }));
  }

  settings(spaceId: SpaceId): SpaceSettings {
    const space = this.spaces.get(spaceId);
    if (!space) throw new CollabError('not_found', `space ${spaceId} not found`);
    const members: SpaceSettings['members'] = [];
    for (const rec of this.entities.values()) {
      if (rec.spaceId === spaceId && rec.data.kind === 'member' && rec.deletedAt == null) {
        members.push({
          actor: this.actorSummary(rec.id),
          role: rec.data.member.role,
          joinedAt: iso(rec.data.member.joinedAt),
        });
      }
    }
    return {
      space: this.spaceSummaryOf(space),
      members,
      invites: space.invites.map((i) => ({
        ...i, expiresAt: i.expiresAt != null ? iso(i.expiresAt) : null,
      })),
      taskAxes: this.taskAxesList(spaceId),
    };
  }

  savedViewsList(spaceId: SpaceId): SavedView[] {
    return [...this.savedViews.values()]
      .filter((v) => v.spaceId === spaceId
        && (v.shareMode === 'space' || v.createdById === this.viewerId))
      .map((v) => this.savedViewOf(v));
  }

  search(q: string, opts: { spaceId?: SpaceId; kinds?: EntityKind[]; cursor?: Cursor } = {}): Page<EntitySummary> {
    const needle = q.trim().toLowerCase();
    if (!needle) return { items: [], nextCursor: null, total: 0 };
    const scored: Array<{ rec: EntityRec; score: number }> = [];
    for (const rec of this.entities.values()) {
      if (rec.deletedAt != null) continue;
      if (opts.spaceId && rec.spaceId !== opts.spaceId) continue;
      if (opts.kinds && !opts.kinds.includes(rec.kind)) continue;
      const title = this.titleOf(rec).toLowerCase();
      const excerpt = (this.excerptFieldOf(rec) ?? '').toLowerCase();
      let score = -1;
      if (title.startsWith(needle)) score = 0;
      else if (title.includes(needle)) score = 1;
      else if (excerpt.includes(needle)) score = 2;
      if (score >= 0) scored.push({ rec, score });
    }
    scored.sort((a, b) => a.score - b.score || b.rec.activityAt - a.rec.activityAt);
    return this.paginate(scored.map((s) => this.summary(s.rec)), opts.cursor);
  }

  actions(contextEntityId?: EntityId): PaletteAction[] {
    const out: PaletteAction[] = [
      { id: 'create-task', label: 'Create task…', kind: 'create' },
      { id: 'go-home', label: 'Go to Home', kind: 'navigate' },
      { id: 'go-tasks', label: 'Go to Tasks', kind: 'navigate' },
      { id: 'go-graph', label: 'Go to Graph', kind: 'navigate' },
    ];
    if (contextEntityId) {
      const rec = this.liveEntity(contextEntityId);
      if (rec) {
        const caps = this.capabilitiesOf(rec);
        out.unshift({ id: `link-${rec.id}`, label: `Link ${this.titleOf(rec)} to…`, kind: 'link', targetEntityId: rec.id });
        if (caps.canPull) out.unshift({ id: `pull-${rec.id}`, label: `Pull ${this.titleOf(rec)}`, kind: 'pull', targetEntityId: rec.id });
        if (rec.kind === 'task') out.unshift({ id: `status-${rec.id}`, label: 'Set status…', kind: 'status', targetEntityId: rec.id });
        if (caps.canComplete) out.unshift({ id: `complete-${rec.id}`, label: `Complete ${this.titleOf(rec)}…`, kind: 'status', targetEntityId: rec.id });
      }
    }
    return out;
  }
}
