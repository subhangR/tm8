/**
 * MockFacade — CollabFacade implemented over the seeded MockWorld.
 *
 * Adds the "backend feel" on top of the synchronous world: configurable
 * latency (~120–400ms by default), optional error injection, WorkspaceEvent
 * fan-out to subscribers after every mutation. Latency 0 + a manual clock
 * makes it fully deterministic for tests.
 */
import type { CollabFacade } from '../facade/CollabFacade';
import {
  CollabError,
  type ActivityItem, type ChannelTab, type CollectionQuery, type CollectionResult,
  type CommandContext, type CommandResult, type CompleteTaskInput, type Connections,
  type CreateEdgeInput, type CreateEntityInput, type CreateTaskInput, type Cursor,
  type EntityDetail, type EntityId, type EntityKind, type EntitySummary,
  type GraphQuery, type GraphResult, type GrantPointsInput, type Hierarchy,
  type HomeSnapshot, type LeaderboardRow, type LinkPrInput, type MessageView,
  type MoveEntityInput, type NotificationItem, type Page, type PaletteAction,
  type PatchEdgeInput, type PatchEntityInput, type PatchMessageInput,
  type PatchTaskInput, type PlacementInput, type PointEventView,
  type PostMessageInput, type PresenceSnapshot, type PresenceWorkspaceEvent,
  type ProjectFromRepo, type PullInput, type ReactionInput, type SavedView, type SavedViewInput,
  type SpaceId, type SpaceNavigation, type SpaceSettings, type SpaceSummary,
  type TaskAxis, type TaskAxisInput, type TrackingRefreshInput, type UndoToken,
  type Unsubscribe, type WorkInput, type WorkspaceEvent,
} from '../types/contract';
import type { Clock } from './internal';
import { createSeededWorld, type SeedIds } from './seed';
import type { MockWorld } from './world';

export interface MockFacadeOptions {
  /** Latency range in ms; pass 0 for deterministic tests. Default 120–400. */
  latency?: { min: number; max: number } | 0;
  /** Probability [0..1] that a command fails with a network-style error. */
  errorRate?: number;
  /** RNG seed for latency/error determinism. */
  rngSeed?: number;
}

/** mulberry32 — tiny deterministic PRNG so latency/errors are replayable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MockFacade implements CollabFacade {
  readonly world: MockWorld;
  readonly ids: SeedIds;
  private readonly latency: { min: number; max: number } | 0;
  private errorRate: number;
  private readonly rng: () => number;
  private nextFailure: Error | null = null;
  private readonly subscribers = new Map<SpaceId, Set<(e: WorkspaceEvent) => void>>();
  /** DEV-4: separate client-synthesized channel — presence never hits `subscribers`. */
  private readonly presenceSubscribers = new Map<SpaceId, Set<(e: PresenceWorkspaceEvent) => void>>();
  private connected = true;
  /** Durable events held while disconnected — replayed in order on reconnect (no loss). */
  private readonly offlineBuffer: WorkspaceEvent[] = [];
  private readonly connectionSubscribers = new Set<(connected: boolean) => void>();

  constructor(seeded?: { world: MockWorld; ids: SeedIds }, opts: MockFacadeOptions = {}) {
    const s = seeded ?? createSeededWorld();
    this.world = s.world;
    this.ids = s.ids;
    this.latency = opts.latency ?? { min: 120, max: 400 };
    this.errorRate = opts.errorRate ?? 0;
    this.rng = mulberry32(opts.rngSeed ?? 1);
  }

  // --- test / simulation hooks ---------------------------------------------

  /** Force the next command to reject with `err` (one-shot). */
  failNextWith(err: Error): void { this.nextFailure = err; }

  setErrorRate(rate: number): void { this.errorRate = rate; }

  // --- connection seam (DEF-17) ---------------------------------------------

  isConnected(): boolean { return this.connected; }

  /**
   * Mock-side connection control (NOT a contract route) — drives W7's offline
   * banner + queued composer. While disconnected: commands reject
   * `upstream_unavailable` (retryable), the durable stream buffers (replayed
   * in order on reconnect — no event loss), and presence pulses are DROPPED
   * (ephemeral by design). Reads keep serving the local world so offline
   * screens still render.
   */
  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const cb of [...this.connectionSubscribers]) cb(connected);
    if (connected && this.offlineBuffer.length > 0) {
      this.deliverDurable(this.offlineBuffer.splice(0));
    }
  }

  /** Observe connection flips (fires on every change; read `isConnected()` for the initial state). */
  subscribeConnection(cb: (connected: boolean) => void): Unsubscribe {
    this.connectionSubscribers.add(cb);
    return () => { this.connectionSubscribers.delete(cb); };
  }

  /**
   * Run a mutation directly against the world and fan out the resulting
   * events — the simulation driver's escape hatch (presence, scripted edits).
   */
  withWorld<T>(fn: (world: MockWorld) => T): T {
    const out = fn(this.world);
    this.dispatch(this.world.drainEvents());
    this.dispatchPresence(this.world.drainPresenceEvents());
    return out;
  }

  // --- plumbing ---------------------------------------------------------------

  private delay(): Promise<void> {
    if (this.latency === 0) return Promise.resolve();
    const span = this.latency.max - this.latency.min;
    const ms = this.latency.min + Math.floor(this.rng() * span);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private dispatch(events: WorkspaceEvent[]): void {
    // DEV-4 invariant: the durable stream NEVER carries presence/typing.
    const durable = events.filter((e) => e.type !== 'presence.changed' && e.type !== 'typing.changed');
    if (durable.length === 0) return;
    if (!this.connected) { this.offlineBuffer.push(...durable); return; }
    this.deliverDurable(durable);
  }

  private deliverDurable(events: WorkspaceEvent[]): void {
    // Mock world is effectively single-space: fan out to every subscriber.
    for (const set of this.subscribers.values()) {
      for (const cb of set) for (const e of events) cb(e);
    }
  }

  private dispatchPresence(events: PresenceWorkspaceEvent[]): void {
    if (events.length === 0) return;
    if (!this.connected) return; // ephemeral — dropped while offline, never buffered
    for (const set of this.presenceSubscribers.values()) {
      for (const cb of set) for (const e of events) cb(e);
    }
  }

  private async read<T>(fn: () => T): Promise<T> {
    await this.delay();
    return fn();
  }

  private async command<T>(fn: () => T): Promise<T> {
    await this.delay();
    if (!this.connected) {
      // DEF-17: offline commands never touch the world — W7 queues composers on this.
      throw new CollabError('upstream_unavailable', 'offline: commands are unavailable while disconnected', { retryable: true });
    }
    if (this.nextFailure) {
      const err = this.nextFailure;
      this.nextFailure = null;
      this.world.drainEvents();
      throw err;
    }
    if (this.errorRate > 0 && this.rng() < this.errorRate) {
      this.world.drainEvents();
      // DEV-8: injected failures use the contract taxonomy (retryable 503).
      throw new CollabError('upstream_unavailable', 'mock: injected upstream failure');
    }
    try {
      const out = fn();
      this.dispatch(this.world.drainEvents());
      this.dispatchPresence(this.world.drainPresenceEvents());
      return out;
    } catch (e) {
      this.world.drainEvents(); // failed op: drop partial events
      this.world.drainPresenceEvents();
      throw e;
    }
  }

  /** Durable events only — presence/typing arrive via `subscribePresence` (DEV-4). */
  subscribe(spaceId: SpaceId, cb: (event: WorkspaceEvent) => void): Unsubscribe {
    const set = this.subscribers.get(spaceId) ?? new Set();
    set.add(cb);
    this.subscribers.set(spaceId, set);
    return () => { set.delete(cb); };
  }

  /** Client-synthesized presence/typing channel (DEV-4). */
  subscribePresence(spaceId: SpaceId, cb: (event: PresenceWorkspaceEvent) => void): Unsubscribe {
    const set = this.presenceSubscribers.get(spaceId) ?? new Set();
    set.add(cb);
    this.presenceSubscribers.set(spaceId, set);
    return () => { set.delete(cb); };
  }

  // --- reads -------------------------------------------------------------------

  listSpaces(): Promise<SpaceSummary[]> { return this.read(() => this.world.listSpaces()); }
  getNavigation(spaceId: SpaceId): Promise<SpaceNavigation> { return this.read(() => this.world.navigation(spaceId)); }
  getEntity(id: EntityId): Promise<EntityDetail> { return this.read(() => this.world.detail(id)); }
  getHierarchy(id: EntityId, cursor?: Cursor): Promise<Hierarchy> { return this.read(() => this.world.hierarchyOf(id, cursor)); }
  getConnections(id: EntityId): Promise<Connections> { return this.read(() => this.world.connectionsOf(id)); }
  getActivity(id: EntityId, cursor?: Cursor): Promise<Page<ActivityItem>> { return this.read(() => this.world.activityPage(id, cursor)); }
  getVersions(id: EntityId, cursor?: Cursor): Promise<Page<{ version: number; changedBy: EntityId; changedAt: string }>> {
    return this.read(() => this.world.versionsPage(id, cursor));
  }
  getPresence(id: EntityId): Promise<PresenceSnapshot> { return this.read(() => this.world.presenceOf(id)); }
  queryCollection(query: CollectionQuery): Promise<CollectionResult> { return this.read(() => this.world.queryCollection(query)); }
  queryGraph(query: GraphQuery): Promise<GraphResult> { return this.read(() => this.world.queryGraph(query)); }
  getHome(spaceId: SpaceId): Promise<HomeSnapshot> { return this.read(() => this.world.home(spaceId)); }
  getChannelTabs(channelId: EntityId): Promise<ChannelTab[]> { return this.read(() => this.world.autoTabsOf(channelId)); }
  getMessages(anchorId: EntityId, opts?: { cursor?: Cursor; order?: 'asc'|'desc'; rootId?: EntityId }): Promise<Page<MessageView>> {
    return this.read(() => this.world.messagesPage(anchorId, opts));
  }
  getSpaceActivity(spaceId: SpaceId, cursor?: Cursor): Promise<Page<ActivityItem>> { return this.read(() => this.world.spaceActivity(spaceId, cursor)); }
  getInbox(cursor?: Cursor): Promise<Page<NotificationItem>> { return this.read(() => this.world.inbox(cursor)); }
  getLeaderboard(spaceId: SpaceId, cursor?: Cursor): Promise<Page<LeaderboardRow>> { return this.read(() => this.world.leaderboard(spaceId, cursor)); }
  getAwards(spaceId: SpaceId, cursor?: Cursor): Promise<Page<PointEventView>> { return this.read(() => this.world.awards(spaceId, cursor)); }
  getTaskAxes(spaceId: SpaceId): Promise<TaskAxis[]> { return this.read(() => this.world.taskAxesList(spaceId)); }
  getSettings(spaceId: SpaceId): Promise<SpaceSettings> { return this.read(() => this.world.settings(spaceId)); }
  listSavedViews(spaceId: SpaceId): Promise<SavedView[]> { return this.read(() => this.world.savedViewsList(spaceId)); }
  /** DEV-13: search is deferred for v1 — typed not_implemented, method stays for v2. */
  search(_q: string, _opts?: { spaceId?: SpaceId; kinds?: EntityKind[]; cursor?: Cursor }): Promise<Page<EntitySummary>> {
    return this.read(() => {
      throw new CollabError('not_implemented', 'search is deferred for v1 (DEV-13) — palette runs on recent/known entities');
    });
  }
  getActions(contextEntityId?: EntityId): Promise<PaletteAction[]> { return this.read(() => this.world.actions(contextEntityId)); }

  // --- commands -------------------------------------------------------------------

  createTask(input: CreateTaskInput): Promise<CommandResult> { return this.command(() => this.world.createTask(input)); }
  patchTask(id: EntityId, input: PatchTaskInput): Promise<CommandResult> { return this.command(() => this.world.patchTask(id, input)); }
  createEntity(input: CreateEntityInput): Promise<CommandResult> { return this.command(() => this.world.createEntity(input)); }
  patchEntity(id: EntityId, input: PatchEntityInput): Promise<CommandResult> { return this.command(() => this.world.patchEntity(id, input)); }
  moveEntity(id: EntityId, input: MoveEntityInput): Promise<CommandResult> { return this.command(() => this.world.moveEntity(id, input)); }
  deleteEntity(id: EntityId, ctx?: CommandContext): Promise<CommandResult> { return this.command(() => this.world.deleteEntity(id, ctx)); }
  createEdge(input: CreateEdgeInput): Promise<CommandResult> { return this.command(() => this.world.createEdge(input)); }
  patchEdge(edgeId: string, input: PatchEdgeInput): Promise<CommandResult> { return this.command(() => this.world.patchEdge(edgeId, input)); }
  deleteEdge(edgeId: string, ctx?: CommandContext): Promise<CommandResult> { return this.command(() => this.world.deleteEdge(edgeId, ctx)); }
  placements(input: PlacementInput): Promise<CommandResult> { return this.command(() => this.world.placements(input)); }
  undo(token: UndoToken | string, ctx?: CommandContext): Promise<CommandResult> { return this.command(() => this.world.undo(token, ctx)); }
  postMessage(input: PostMessageInput): Promise<CommandResult> { return this.command(() => this.world.postMessage(input)); }
  patchMessage(id: EntityId, input: PatchMessageInput): Promise<CommandResult> { return this.command(() => this.world.patchMessage(id, input)); }
  deleteMessage(id: EntityId, ctx?: CommandContext): Promise<CommandResult> { return this.command(() => this.world.deleteMessage(id, ctx)); }
  setReaction(id: EntityId, input: ReactionInput): Promise<CommandResult> { return this.command(() => this.world.setReaction(id, input)); }
  grantPoints(id: EntityId, input: GrantPointsInput): Promise<CommandResult> { return this.command(() => this.world.grantPoints(id, input)); }
  completeTask(id: EntityId, input: CompleteTaskInput): Promise<CommandResult> { return this.command(() => this.world.completeTask(id, input)); }
  pullEntity(id: EntityId, input: PullInput): Promise<CommandResult> { return this.command(() => this.world.pullEntity(id, input)); }
  setWork(id: EntityId, input: WorkInput): Promise<CommandResult> { return this.command(() => this.world.setWork(id, input)); }
  linkPr(id: EntityId, input: LinkPrInput): Promise<CommandResult> { return this.command(() => this.world.linkPr(id, input)); }
  trackingRefresh(input: TrackingRefreshInput): Promise<CommandResult> { return this.command(() => this.world.trackingRefresh(input)); }
  markRead(anchorId: EntityId, ctx?: CommandContext): Promise<CommandResult> { return this.command(() => this.world.markRead(anchorId, ctx)); }
  markNotificationRead(notificationId: string, ctx?: CommandContext): Promise<CommandResult> {
    return this.command(() => this.world.markNotificationRead(notificationId, ctx));
  }
  createProjectFromRepo(spaceId: SpaceId, input: { repoUrl: string; name?: string }): Promise<ProjectFromRepo> { return this.command(() => this.world.createProjectFromRepo(spaceId, input)); }
  createTaskAxis(spaceId: SpaceId, input: TaskAxisInput): Promise<TaskAxis> { return this.command(() => this.world.createTaskAxis(spaceId, input)); }
  updateTaskAxis(spaceId: SpaceId, axisId: string, input: Partial<TaskAxisInput>): Promise<TaskAxis> {
    return this.command(() => this.world.updateTaskAxis(spaceId, axisId, input));
  }
  deleteTaskAxis(spaceId: SpaceId, axisId: string): Promise<void> { return this.command(() => this.world.deleteTaskAxis(spaceId, axisId)); }
  createSavedView(spaceId: SpaceId, input: SavedViewInput): Promise<SavedView> { return this.command(() => this.world.createSavedView(spaceId, input)); }
  updateSavedView(viewId: string, input: Partial<SavedViewInput>): Promise<SavedView> { return this.command(() => this.world.updateSavedView(viewId, input)); }
  deleteSavedView(viewId: string): Promise<void> { return this.command(() => this.world.deleteSavedView(viewId)); }
}

/** One-call boot: seeded world + facade. */
export function createSeededFacade(opts: MockFacadeOptions & { clock?: Clock } = {}): MockFacade {
  return new MockFacade(createSeededWorld(opts.clock), opts);
}
