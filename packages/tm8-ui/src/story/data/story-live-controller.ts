/**
 * The story page's live data: one detail read of the story, kept current off
 * the ordinary event stream.
 *
 * MEMBERSHIP. The story is computed at read time (migration 282), so the
 * client cannot know an event's effect on it — it only knows whether the
 * event TOUCHES it: an entity, an edge end, a message anchor, an activity row
 * inside the last read's membership set (page nodes + the story + child
 * stories, and messages on `page.feedAnchorIds`). An edge or a child that
 * touches the set can change membership, so it counts too. Every touching
 * event schedules ONE coalesced re-read of the story; progress and the graph
 * come back from the server, never recomputed here.
 *
 * Between re-reads the page still moves at once: messages land in the feed
 * from the event itself, an `entity.upsert` of the story carries a fresh
 * `state` (the projector computes it), and every touched id gets a short
 * "landed" pulse so the graph can flash its node.
 *
 * PAUSE holds touching events in a queue (the page stops moving) and applies
 * them on resume. Re-reads still run while paused — they are what resume
 * shows — but the view handed out is frozen until resume.
 *
 * Framework-free like `anchor-feed-controller.ts`; `useStoryLive` is the React
 * binding.
 */
import type { DurableWorkspaceEvent, EntityDetail, EntityId, MessageView, SpaceId, StoryPage } from '@tm8/contract';
import type { ConnectionState, Seam, Unsubscribe } from '../../data/seam';
import { createCoalescedTrigger } from '../../views/event-refresh';
import type { StoryFeedRow, StoryView } from '../model';
import { feedRowFromMessage, rememberActor, storyPageOf, storyStateOf, toStoryView, type PeopleBook } from './toStoryView';

/** How long a touched node stays "landed" (the graph's flash). */
export const LANDED_MS = 1_400;
/** The live-feed tail kept on top of the page's backlog. */
const LIVE_FEED_CAP = 200;
const MINUTE = 60_000;

export interface StoryLiveSnapshot {
  view: StoryView | null;
  loading: boolean;
  /** The last read's failure; the last good view stays up. */
  error: Error | null;
  /** Ids touched in the last LANDED_MS. */
  landed: ReadonlySet<string>;
  paused: boolean;
  /** Touching events held while paused. */
  queued: number;
  /** Touching events applied in the last minute ("N updates in the last minute"). */
  updatesLastMinute: number;
  connection: ConnectionState['phase'];
}

export interface StoryLiveController {
  getSnapshot(): StoryLiveSnapshot;
  subscribe(listener: () => void): Unsubscribe;
  /** Start reading and listening. Returns the detach. */
  attach(): Unsubscribe;
  refresh(): Promise<void>;
  setPaused(paused: boolean): void;
  /** Membership as of the last read (for callers that filter their own data). */
  membership(): ReadonlySet<string>;
  dispose(): void;
}

export interface StoryLiveOptions {
  seam: Seam;
  storyId: EntityId;
  /** Coalescing window for the re-read. */
  quietMs?: number;
  maxWaitMs?: number;
  now?: () => number;
}

/** Ids an event touches — the ones it can flash. Empty = not a story event candidate. */
export function eventTouchedIds(event: DurableWorkspaceEvent): string[] {
  switch (event.type) {
    case 'entity.upsert':
    case 'entity.deleted':
      return event.entity.parentId ? [event.entity.id, event.entity.parentId] : [event.entity.id];
    case 'entity.activity_touched':
      return [event.id];
    case 'edge.upsert':
    case 'edge.deleted':
      return [event.edge.source.id, event.edge.target.id];
    case 'message.created':
    case 'message.updated':
    case 'message.deleted':
      return [event.anchorId];
    case 'message.attachments.updated':
      return [event.message.state.anchorId];
    case 'counter.changed':
      return [event.entityId];
    case 'activity.created':
      return event.activity.entityId ? [event.activity.entityId] : [];
    case 'git.commit_recorded':
      return [event.commitEntityId];
    case 'git.pr_state_changed':
      return [event.prEntityId];
    default:
      return [];
  }
}

export function membershipOf(storyId: string, page: StoryPage | null): Set<string> {
  const set = new Set<string>([storyId]);
  if (!page) return set;
  for (const n of page.nodes) set.add(n.id);
  for (const c of page.childStories) set.add(c.id);
  for (const a of page.feedAnchorIds) set.add(a);
  return set;
}

export function createStoryLiveController(opts: StoryLiveOptions): StoryLiveController {
  const { seam, storyId } = opts;
  const now = opts.now ?? (() => Date.now());

  let entity: EntityDetail | null = null;
  let page: StoryPage | null = null;
  let members = membershipOf(storyId, null);
  let feedAnchors = new Set<string>([storyId]);
  let liveFeed: StoryFeedRow[] = [];
  const deletedMessages = new Set<string>();
  const seen: PeopleBook = new Map();
  let loading = true;
  let error: Error | null = null;
  let paused = false;
  let queue: DurableWorkspaceEvent[] = [];
  const landedUntil = new Map<string, number>();
  let applied: number[] = [];
  let connection: ConnectionState['phase'] = seam.getConnection().phase;
  let disposed = false;
  let generation = 0;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;

  /** The view shown while paused. */
  let frozen: StoryView | null = null;
  const listeners = new Set<() => void>();
  let snapshot: StoryLiveSnapshot = build();

  function computeView(): StoryView | null {
    if (!entity) return null;
    return toStoryView({ entity, liveFeed, deleted: deletedMessages, seen });
  }

  function build(): StoryLiveSnapshot {
    const t = now();
    applied = applied.filter((at) => t - at < MINUTE);
    for (const [id, until] of landedUntil) if (until <= t) landedUntil.delete(id);
    const view = paused && frozen ? frozen : computeView();
    return {
      view,
      loading,
      error,
      landed: new Set(landedUntil.keys()),
      paused,
      queued: queue.length,
      updatesLastMinute: applied.length,
      connection,
    };
  }

  function emit(): void {
    if (disposed) return;
    snapshot = build();
    scheduleSweep();
    for (const l of listeners) l();
  }

  /** Re-emit when a pulse ends or a minute-counter entry ages out. */
  function scheduleSweep(): void {
    if (sweepTimer !== null) clearTimeout(sweepTimer);
    sweepTimer = null;
    const t = now();
    let next = Infinity;
    for (const until of landedUntil.values()) next = Math.min(next, until);
    if (applied.length) next = Math.min(next, applied[0]! + MINUTE);
    if (next === Infinity) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      emit();
    }, Math.max(16, next - t + 5));
  }

  async function read(): Promise<void> {
    const mine = ++generation;
    try {
      const next = await seam.entity(storyId);
      if (disposed || mine !== generation) return;
      const nextPage = storyPageOf(next);
      entity = next;
      if (nextPage) {
        page = nextPage;
        members = membershipOf(storyId, page);
        feedAnchors = new Set([storyId, ...page.feedAnchorIds]);
        // The backlog now covers what it covers; keep only newer live rows.
        const inBacklog = new Set(page.recentMessages.map((m) => m.id));
        liveFeed = liveFeed.filter((f) => !inBacklog.has(f.id));
      }
      error = null;
    } catch (e) {
      if (disposed || mine !== generation) return;
      error = e instanceof Error ? e : new Error(String(e));
    } finally {
      if (!disposed && mine === generation) {
        loading = false;
        emit();
      }
    }
  }

  const trigger = createCoalescedTrigger({
    quietMs: opts.quietMs ?? 400,
    maxWaitMs: opts.maxWaitMs ?? 1_500,
    run: read,
    now,
  });

  function touches(event: DurableWorkspaceEvent): boolean {
    if (event.type === 'message.created' || event.type === 'message.updated' || event.type === 'message.deleted') {
      return feedAnchors.has(event.anchorId) || members.has(event.anchorId);
    }
    return eventTouchedIds(event).some((id) => members.has(id));
  }

  function upsertLive(message: MessageView): void {
    rememberActor(seen, message.state.author);
    const row = feedRowFromMessage(page, { id: storyId, title: entity?.title ?? '' }, message);
    liveFeed = [row, ...liveFeed.filter((f) => f.id !== row.id)].slice(0, LIVE_FEED_CAP);
  }

  function apply(event: DurableWorkspaceEvent): void {
    const t = now();
    for (const id of eventTouchedIds(event)) if (members.has(id)) landedUntil.set(id, t + LANDED_MS);
    applied.push(t);
    switch (event.type) {
      case 'message.created':
        upsertLive(event.message);
        break;
      case 'message.updated':
        if (liveFeed.some((f) => f.id === event.message.id)) upsertLive(event.message);
        break;
      case 'message.deleted':
        deletedMessages.add(event.message.id);
        break;
      case 'entity.upsert':
        // The story's own upsert carries a fresh StoryState; the page stays
        // as last read until the re-read lands.
        if (event.entity.id === storyId && entity && storyStateOf(event.entity)) {
          entity = { ...entity, title: event.entity.title, version: event.entity.version, state: event.entity.state };
        }
        break;
      default:
        break;
    }
    trigger.note();
  }

  function onEvent(event: DurableWorkspaceEvent): void {
    if (disposed || !touches(event)) return;
    if (paused) {
      queue.push(event);
      emit();
      return;
    }
    apply(event);
    emit();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attach() {
      void read();
      const offEvent = seam.onEvent(onEvent);
      const offConnection = seam.onConnection((c) => {
        const previous = connection;
        connection = c.phase;
        if (c.phase === 'live' && previous !== 'live') void read();
        else emit();
      });
      const offResync = seam.onResync((spaceId: SpaceId) => {
        if (!entity || spaceId === entity.spaceId) void read();
      });
      return () => {
        offEvent();
        offConnection();
        offResync();
      };
    },
    refresh: read,
    setPaused(next) {
      if (next === paused) return;
      if (next) {
        frozen = computeView();
        paused = true;
      } else {
        paused = false;
        frozen = null;
        const held = queue;
        queue = [];
        for (const e of held) apply(e);
      }
      emit();
    },
    membership: () => members,
    dispose() {
      disposed = true;
      trigger.dispose();
      if (sweepTimer !== null) clearTimeout(sweepTimer);
      listeners.clear();
    },
  };
}
