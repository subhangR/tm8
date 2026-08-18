/**
 * THE ANCHOR FEED CONTROLLER — one feed reader for every anchor kind.
 *
 * It supersedes `createChatSessionController` (which reads only a work_session,
 * with a hardcoded scope) and the read half of `useChannelFeed` (which reads
 * only a channel, likewise hardcoded). Framework-free on purpose, exactly like
 * the controller it replaces: the React binding is `useAnchorFeed`, and the
 * behaviour below is testable without a renderer.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SCOPE RULE, WHICH THE REST OF THIS FILE OBEYS
 *
 * `key.scope` is OPTIONAL and absent unless a caller can defend it. The server
 * already resolves the right reading per anchor kind
 * (`feed-context.ts:176 defaultScopeFor` — work_session → session_chat_v1,
 * channel → channel_threads_v1, task → task_discussion_v1, message → thread_v1,
 * else direct_v1), and `feed-context.ts:265` treats `undefined` and the literal
 * `'default'` identically. Naming a scope from here is the client re-deciding
 * what the server knows better, and it does not fail softly: an inapplicable
 * scope raises `invalid_input` / `feed_scope_not_applicable` at
 * `feed-context.ts:267-276`, so today's hardcoded `channel_threads_v1` is a
 * 400 on a task anchor rather than a degraded reading.
 *
 * TWO CONSEQUENCES THAT ARE EASY TO GET WRONG:
 *
 * 1. THE RESOLVED SCOPE IS NEVER SENT BACK. `EntityFeedPage.resolvedScope` tells
 *    you what the server picked, and the tempting optimisation is to send it on
 *    page two "now that we know". That breaks paging: a keyset cursor is
 *    fingerprinted over its scope, so `undefined` then `channel_threads_v1` is
 *    two spellings of one scope and the second page rejects the first page's
 *    cursor. `feedQuery()` below is the ONLY place a scope is spelled, and it
 *    spells `key.scope` and nothing else, on every read.
 *
 * 2. THE STATE KEY CARRIES THE REQUESTED SCOPE, NOT THE RESOLVED ONE. The key
 *    is also the localStorage draft key (`draftStorageKey`), and the resolved
 *    scope is not known until a read completes — keying on it would change
 *    identity mid-flight and orphan the viewer's half-written message. The
 *    requested scope is known before the first byte moves.
 */
import type {
  Cursor,
  DurableWorkspaceEvent,
  EntityFeedPage,
  EntityFeedQuery,
  EntityId,
  FeedItem,
  MessageView,
  Page,
} from '@tm8/contract';
import type { ConnectionState, FeedOpts, Seam, Unsubscribe } from '../data/seam';
import type { ChannelRefusal } from './feed-model';
import {
  chatStateKey,
  type ChatEntry,
  type ChatStateKeyParts,
  type ChatStoreState,
} from './chat-store';
import type { StoreApi } from 'zustand/vanilla';

/** The seam slice a feed read needs. A full `Seam` satisfies it structurally. */
export interface AnchorFeedSeam {
  feed: Seam['feed'];
  onEvent: Seam['onEvent'];
  onConnection: Seam['onConnection'];
  onResync: Seam['onResync'];
  /** The branch read. Required only when `threads` is on. */
  messages?: Seam['messages'];
}

/**
 * The open branch, owned by the controller because reads are host-sequenced:
 * the pane renders what was read for it and never fetches. `replies === undefined`
 * means the branch read has not completed — a different fact from a measured zero.
 */
export interface AnchorFeedThread {
  root: MessageView;
  replies?: Page<MessageView>;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

export interface AnchorFeedControllerOptions {
  store: StoreApi<ChatStoreState>;
  seam: AnchorFeedSeam;
  key: ChatStateKeyParts;
  spaceId: string;
  limit?: number;
  /**
   * Branch reads and the thread pane. REGISTRY CONFIG decides this, never a
   * kind literal — `registry.ts:894-901` rules that the session chat mounts the
   * same surface and keeps its flat, replies-inline read, while a channel takes
   * `panel.threads`. The capability is universal; the offer is not.
   */
  threads?: boolean;
  onThreadChange?: (thread: AnchorFeedThread | null) => void;
}

export interface AnchorFeedController {
  loadNewest(refreshedFromNewest?: boolean): Promise<void>;
  loadOlder(): Promise<void>;
  loadNewer(): Promise<void>;
  loadAround(around: NonNullable<EntityFeedQuery['around']>): Promise<void>;
  openThread(root: MessageView): void;
  closeThread(): void;
  loadMoreReplies(cursor: Cursor): Promise<void>;
  attach(): Unsubscribe;
  dispose(): void;
}

export function createAnchorFeedController({
  store,
  seam,
  key,
  spaceId,
  limit = 50,
  threads = false,
  onThreadChange,
}: AnchorFeedControllerOptions): AnchorFeedController {
  const id = chatStateKey(key);
  const anchorId = key.sessionId as EntityId;
  store.getState().ensure(key);

  let generation = 0;
  let disposed = false;
  let lastConnectionPhase: ConnectionState['phase'] | null = null;
  let thread: AnchorFeedThread | null = null;

  const current = (): ChatEntry => store.getState().entries[id]!;
  const patch = (update: Partial<ChatEntry> | ((entry: ChatEntry) => ChatEntry)) => {
    if (!disposed) store.getState().patch(id, update);
  };
  const begin = (): number => ++generation;
  const accepts = (token: number): boolean => !disposed && generation === token;

  /**
   * THE ONLY PLACE A SCOPE IS SPELLED. Omitted entirely when absent rather than
   * sent as `undefined`, so the request body is byte-identical across every
   * read for this key and a keyset cursor stays valid across pages.
   */
  const feedQuery = (extra: Omit<FeedOpts, 'scope'>): FeedOpts => ({
    ...(key.scope ? { scope: key.scope } : {}),
    ...extra,
  });

  /**
   * A REFRESH IS NOT A LOAD. `loading` means "there is nothing to show yet";
   * once a page exists, a re-read leaves the phase alone. Getting this wrong is
   * visible: `useChannelFeed.ts:246` sets `loading` unconditionally at the top
   * of every reload while reloading on every event, so a busy channel strobes.
   */
  const beginRead = () => {
    patch({ phase: current().page ? current().phase : 'loading', error: null, refusal: null });
  };

  const loadNewest = async (refreshedFromNewest = false): Promise<void> => {
    const token = begin();
    beginRead();
    try {
      const response = await seam.feed(anchorId, feedQuery({ order: 'newest', limit }));
      if (!accepts(token)) return;
      patch({
        page: chronologicalPage(response),
        phase: 'ready',
        error: null,
        refusal: null,
        olderCursor: response.nextCursor,
        newerCursor: null,
        refreshedFromNewest,
        focusedItemId: null,
      });
      /*
       * An open branch rides every refresh: the ROOT's rollup (replyCount,
       * participants, last-reply time) refreshes from the new page, and the
       * branch re-reads so a reply another client just posted appears without
       * closing and reopening the pane.
       */
      if (thread) {
        const fresh = response.items.find(
          (item) => item.itemKind === 'message' && item.message.id === thread!.root.id,
        );
        if (fresh?.itemKind === 'message') setThread({ ...thread, root: fresh.message });
        void readBranch(thread.root);
      }
    } catch (reason: unknown) {
      if (!accepts(token)) return;
      failRead(reason);
    }
  };

  const loadOlder = async (): Promise<void> => {
    const cursor = current().olderCursor;
    if (!cursor || current().loadingEarlier) return;
    const token = begin();
    patch({ loadingEarlier: true });
    try {
      const response = await seam.feed(anchorId, feedQuery({
        order: current().focusedItemId ? 'oldest' : 'newest',
        cursor,
        limit,
      }));
      if (!accepts(token)) return;
      patch((entry) => ({
        ...entry,
        page: mergePages(response, entry.page),
        olderCursor: response.nextCursor,
        loadingEarlier: false,
      }));
    } catch (reason: unknown) {
      if (!accepts(token)) return;
      if (errorCode(reason) === 'invalid_cursor') {
        patch({ loadingEarlier: false });
        await loadNewest(true);
        return;
      }
      patch({ loadingEarlier: false, error: errorMessage(reason), phase: 'error' });
    }
  };

  const loadNewer = async (): Promise<void> => {
    const cursor = current().newerCursor;
    if (!cursor || current().loadingNewer) return;
    const token = begin();
    patch({ loadingNewer: true });
    try {
      const response = await seam.feed(anchorId, feedQuery({ order: 'oldest', cursor, limit }));
      if (!accepts(token)) return;
      patch((entry) => ({
        ...entry,
        page: mergePages(entry.page, response),
        newerCursor: response.nextCursor,
        loadingNewer: false,
      }));
    } catch (reason: unknown) {
      if (!accepts(token)) return;
      if (errorCode(reason) === 'invalid_cursor') {
        patch({ loadingNewer: false });
        await loadNewest(true);
        return;
      }
      patch({ loadingNewer: false, error: errorMessage(reason), phase: 'error' });
    }
  };

  const loadAround = async (
    around: NonNullable<EntityFeedQuery['around']>,
  ): Promise<void> => {
    const token = begin();
    beginRead();
    try {
      const response = await seam.feed(anchorId, feedQuery({ order: 'oldest', around, limit }));
      if (!accepts(token)) return;
      patch({
        page: chronologicalPage(response),
        phase: 'ready',
        error: null,
        refusal: null,
        olderCursor: response.previousCursor ?? null,
        newerCursor: response.nextCursor,
        focusedItemId: around,
        refreshedFromNewest: false,
      });
    } catch (reason: unknown) {
      if (!accepts(token)) return;
      failRead(reason);
    }
  };

  const failRead = (reason: unknown): void => {
    const refusal = refusalFrom(reason);
    patch(refusal
      ? { phase: 'refused', refusal, error: null }
      : { phase: 'error', error: errorMessage(reason), refusal: null });
  };

  // -- the branch ------------------------------------------------------------

  const setThread = (next: AnchorFeedThread | null): void => {
    if (disposed) return;
    thread = next;
    onThreadChange?.(next);
  };

  /**
   * `messages.list?rootMessageId=`, keyset-paginated OLDEST-FIRST by the server
   * (a conversation reads in the order it happened; no client re-sort). Guarded
   * on the root id so a stale response can never land in a branch opened after
   * it — the same guard the feed reads get from `accepts`, expressed as an
   * identity check because a branch outlives a single read.
   */
  const readBranch = async (root: MessageView): Promise<void> => {
    if (!seam.messages) return;
    try {
      const branch = await seam.messages(anchorId, { rootMessageId: root.id });
      if (thread?.root.id !== root.id) return;
      setThread({ ...thread, replies: branch, loading: false, error: null });
    } catch (reason: unknown) {
      if (thread?.root.id !== root.id) return;
      setThread({
        ...thread,
        loading: false,
        error: errorMessage(reason, 'The thread could not be read.'),
      });
    }
  };

  const openThread = (root: MessageView): void => {
    if (!threads) return;
    setThread({ root, replies: undefined, loading: true, loadingMore: false, error: null });
    void readBranch(root);
  };

  const loadMoreReplies = async (cursor: Cursor): Promise<void> => {
    if (!seam.messages || !thread?.replies) return;
    const rootId = thread.root.id;
    setThread({ ...thread, loadingMore: true });
    try {
      const next = await seam.messages(anchorId, { rootMessageId: rootId, cursor });
      if (thread?.root.id !== rootId || !thread.replies) return;
      const seen = new Set(thread.replies.items.map((message) => message.id));
      setThread({
        ...thread,
        loadingMore: false,
        replies: {
          items: [...thread.replies.items, ...next.items.filter((m) => !seen.has(m.id))],
          nextCursor: next.nextCursor,
        },
      });
    } catch (reason: unknown) {
      if (thread?.root.id !== rootId) return;
      setThread({
        ...thread,
        loadingMore: false,
        error: errorMessage(reason, 'More replies could not be read.'),
      });
    }
  };

  // -- live ------------------------------------------------------------------

  /**
   * Event-driven refreshes are COALESCED, not issued per event.
   *
   * A streaming anchor emits a durable event per frame-worth of activity.
   * `useChannelFeed.ts:297-302` calls an unguarded `reload()` for each one, and
   * that is worse than the obvious load problem: `reload()` has no generation
   * guard, so overlapping reloads race and the response that happens to land
   * last wins — a feed can render an OLDER page than the one it already had.
   * Here every read is bracketed by `begin`/`accepts`, AND the trigger is
   * debounced on the trailing edge with a max wait so a continuous stream still
   * refreshes on a bounded cadence rather than starving until it pauses.
   */
  const REFRESH_DEBOUNCE_MS = 300;
  const REFRESH_MAX_WAIT_MS = 1_500;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshDeadline: number | null = null;
  const clearRefresh = () => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    refreshDeadline = null;
  };
  const scheduleRefresh = () => {
    if (disposed) return;
    const at = Date.now();
    if (refreshDeadline === null) refreshDeadline = at + REFRESH_MAX_WAIT_MS;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshDeadline = null;
      void loadNewest();
    }, Math.min(REFRESH_DEBOUNCE_MS, Math.max(0, refreshDeadline - at)));
  };

  const attach = (): Unsubscribe => {
    const offEvent = seam.onEvent((event) => {
      if (eventTouchesAnchor(event, anchorId)) scheduleRefresh();
    });
    const offConnection = seam.onConnection((connection) => {
      const previous = lastConnectionPhase;
      lastConnectionPhase = connection.phase;
      if (connection.phase === 'live' && previous !== null && previous !== 'live') {
        void loadNewest();
      }
    });
    const offResync = seam.onResync((resyncedSpaceId) => {
      if (resyncedSpaceId === spaceId) void loadNewest(true);
    });
    return () => {
      clearRefresh();
      offEvent();
      offConnection();
      offResync();
    };
  };

  return {
    loadNewest,
    loadOlder,
    loadNewer,
    loadAround,
    openThread,
    closeThread: () => setThread(null),
    loadMoreReplies,
    attach,
    dispose() {
      disposed = true;
      generation += 1;
      clearRefresh();
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Does this event change what THIS anchor's feed should show?
 *
 * Generalised from `chat-store`'s `eventTouchesSession`, and deliberately wider
 * than `useChannelFeed`'s `'anchorId' in event && event.anchorId === channelId`.
 * That narrow test is why a channel's 8-state delivery chips do not refresh
 * live today: `message.delivery_reserved` and `message.delivery_settled` carry
 * their subject on `delivery`, not on `anchorId`, so they never triggered a
 * re-read and a settled delivery only appeared if something unrelated did.
 */
export function eventTouchesAnchor(event: DurableWorkspaceEvent, anchorId: EntityId): boolean {
  if ('anchorId' in event && event.anchorId === anchorId) return true;
  if (event.type === 'activity.created') {
    return event.activity.entityId === anchorId || event.activity.workSessionId === anchorId;
  }
  if (event.type === 'message.attachments.updated') {
    return event.message.state.anchorId === anchorId;
  }
  if (event.type === 'message.delivery_reserved' || event.type === 'message.delivery_settled') {
    return event.delivery.targetWorkSessionId === anchorId;
  }
  return false;
}

function chronologicalPage(page: EntityFeedPage): EntityFeedPage {
  return { ...page, items: chronological(dedupe(page.items)) };
}

function mergePages(
  left: EntityFeedPage | undefined,
  right: EntityFeedPage | undefined,
): EntityFeedPage | undefined {
  if (!left) return right ? chronologicalPage(right) : undefined;
  if (!right) return chronologicalPage(left);
  return {
    ...left,
    ...right,
    resolvedScope: right.resolvedScope,
    predicates: right.predicates,
    items: chronological(dedupe([...left.items, ...right.items])),
  };
}

function dedupe(items: readonly FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.itemKind}:${item.itemId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function chronological(items: readonly FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.itemId.localeCompare(b.itemId));
}

function refusalFrom(error: unknown): ChannelRefusal | null {
  const code = errorCode(error);
  if (code !== 'forbidden' && code !== 'not_found') return null;
  return {
    kind: code,
    message: error instanceof Error && error.message
      ? error.message
      : code === 'forbidden'
      ? 'You no longer have access to this conversation.'
      : 'This conversation no longer exists.',
  };
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

function errorMessage(error: unknown, fallback = 'The feed could not be read.'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
