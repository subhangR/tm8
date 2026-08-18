import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  DurableWorkspaceEvent,
  EntityFeedPage,
  EntityFeedQuery,
  EntityId,
  FeedItem,
  FeedScope,
  MessageView,
  SpaceId,
} from '@tm8/contract';
import type { ConnectionState, Seam, Unsubscribe } from '../data/seam';
import type { ChannelRefusal } from './feed-model';

const DRAFT_VERSION = 1;
const EMPTY_DRAFT = Object.freeze({ newMessage: '', replies: Object.freeze({}), updatedAt: '' });

export interface ChatStateKeyParts {
  viewerMemberId: string;
  sessionId: string;
  /**
   * The REQUESTED scope, and ABSENT unless the caller can defend one.
   *
   * Omitting it is the correct reading for every anchor kind: the server
   * resolves it (`feed-context.ts:176 defaultScopeFor`) and treats `undefined`
   * and the literal `'default'` identically (`:265`). Naming one that does not
   * apply to the anchor is not a soft degrade — `:267-276` raises
   * `invalid_input` / `feed_scope_not_applicable`.
   *
   * REQUESTED, NEVER RESOLVED. This value is part of the localStorage draft key
   * below, and `EntityFeedPage.resolvedScope` is not known until a read
   * completes — keying on it would change the key mid-flight and orphan the
   * viewer's half-written message.
   */
  scope?: FeedScope;
  /** Stable projection/filter identity; `chronological` is the default feed. */
  filter: string;
}

export interface ChatDrafts {
  newMessage: string;
  replies: Readonly<Record<string, string>>;
  updatedAt: string;
}

export interface ChatScrollAnchor {
  itemKey: string;
  offsetPx: number;
}

export interface ChatMutationJournalEntry {
  clientMutationId: string;
  command: import('@tm8/contract').PostMessageInput;
  mutationState: 'pending' | 'reconciling' | 'settled' | 'rejected' | 'uncertain';
  storageState: 'unconfirmed' | 'stored' | 'not_stored' | 'unknown';
  storedMessageIds: EntityId[];
  createdAt: string;
  error: string | null;
  spaceId: string;
}

export interface ChatEntry {
  key: ChatStateKeyParts;
  page?: EntityFeedPage;
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'refused';
  error: string | null;
  refusal: ChannelRefusal | null;
  loadingEarlier: boolean;
  loadingNewer: boolean;
  olderCursor: string | null;
  newerCursor: string | null;
  refreshedFromNewest: boolean;
  focusedItemId: EntityFeedQuery['around'] | null;
  replyToId: EntityId | null;
  drafts: ChatDrafts;
  scrollAnchor: ChatScrollAnchor | null;
  /** Delivery never enters this journal; it remains a facet of feed truth. */
  mutations: Record<string, ChatMutationJournalEntry>;
}

export interface ChatStoreState {
  entries: Record<string, ChatEntry>;
  ensure(key: ChatStateKeyParts): void;
  patch(key: string, update: Partial<ChatEntry> | ((current: ChatEntry) => ChatEntry)): void;
  setDraft(key: ChatStateKeyParts, body: string, replyToId?: EntityId | null): void;
  setReplyTarget(key: string, replyToId: EntityId | null): void;
  setScrollAnchor(key: string, anchor: ChatScrollAnchor | null): void;
  /**
   * Drop every entry. `chatStore` below is a MODULE-LEVEL singleton, so its
   * loaded pages, reply targets and in-memory drafts outlive the sign-out that
   * ends the session they were read under (`auth/session-reset.ts`).
   *
   * The entry key carries `viewerMemberId`, so the next viewer could never have
   * READ these entries — this is the belt to that suspender, and it is what
   * makes "the pages the last viewer loaded are still in this tab's memory"
   * false rather than merely unreachable.
   *
   * The PERSISTED drafts are deliberately not touched: they are keyed by viewer
   * as well, they are the one thing here a viewer would want back when they
   * sign in again, and destroying half-written messages is a worse failure than
   * the one this guards. Same shape as the known-accounts rule in `session.ts`.
   */
  clearAll(): void;
}

export interface ChatSyncSeam {
  feed: Seam['feed'];
  onEvent: Seam['onEvent'];
  onConnection: Seam['onConnection'];
  onResync: Seam['onResync'];
}

export interface ChatStoreOptions {
  storage?: Storage | null;
  now?: () => string;
}

/**
 * An absent scope is spelled `'default'` DELIBERATELY, not left to
 * `JSON.stringify` (which would emit `null` for a missing array element). It is
 * the same word the wire uses for the same meaning — `EntityFeedQuery.scope` is
 * `'default' | FeedScope` — so one vocabulary covers the request and the key.
 *
 * Every existing caller passes a scope, so no key spelled before this change
 * moves, and no persisted draft is orphaned by it.
 */
export function chatStateKey(parts: ChatStateKeyParts): string {
  return JSON.stringify([
    parts.viewerMemberId,
    parts.sessionId,
    parts.scope ?? 'default',
    parts.filter,
  ]);
}

export function draftStorageKey(parts: ChatStateKeyParts): string {
  return `tm8:chat-draft:v${DRAFT_VERSION}:${encodeURIComponent(chatStateKey(parts))}`;
}

export function readDraft(storage: Storage | null | undefined, parts: ChatStateKeyParts): ChatDrafts {
  if (!storage) return freshEmptyDraft();
  try {
    const raw = storage.getItem(draftStorageKey(parts));
    if (!raw) return freshEmptyDraft();
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.version !== DRAFT_VERSION) return freshEmptyDraft();
    if (typeof value.newMessage !== 'string' || !isRecord(value.replies)) return freshEmptyDraft();
    const replies: Record<string, string> = {};
    for (const [id, body] of Object.entries(value.replies).slice(0, 100)) {
      if (typeof body === 'string') replies[id] = body.slice(0, 12_000);
    }
    return {
      newMessage: value.newMessage.slice(0, 12_000),
      replies,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    };
  } catch {
    return freshEmptyDraft();
  }
}

export function writeDraft(
  storage: Storage | null | undefined,
  parts: ChatStateKeyParts,
  draft: ChatDrafts,
): void {
  if (!storage) return;
  try {
    storage.setItem(draftStorageKey(parts), JSON.stringify({ version: DRAFT_VERSION, ...draft }));
  } catch {
    // Storage may be disabled or full. The store remains the live owner.
  }
}

export function createChatStore(options: ChatStoreOptions = {}): StoreApi<ChatStoreState> {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const now = options.now ?? (() => new Date().toISOString());
  return createStore<ChatStoreState>((set, get) => ({
    entries: {},
    ensure(key) {
      const id = chatStateKey(key);
      if (get().entries[id]) return;
      set((state) => ({
        entries: {
          ...state.entries,
          [id]: emptyEntry(key, readDraft(storage, key)),
        },
      }));
    },
    patch(key, update) {
      set((state) => {
        const current = state.entries[key];
        if (!current) return state;
        const next = typeof update === 'function' ? update(current) : { ...current, ...update };
        if (next === current) return state;
        return { entries: { ...state.entries, [key]: next } };
      });
    },
    setDraft(key, body, replyToId = null) {
      get().ensure(key);
      const id = chatStateKey(key);
      const current = get().entries[id]!;
      const drafts: ChatDrafts = replyToId
        ? {
            ...current.drafts,
            replies: { ...current.drafts.replies, [replyToId]: body },
            updatedAt: now(),
          }
        : { ...current.drafts, newMessage: body, updatedAt: now() };
      writeDraft(storage, key, drafts);
      get().patch(id, { drafts });
    },
    setReplyTarget(key, replyToId) {
      get().patch(key, { replyToId });
    },
    setScrollAnchor(key, scrollAnchor) {
      get().patch(key, { scrollAnchor });
    },
    clearAll() {
      if (Object.keys(get().entries).length === 0) return;
      set({ entries: {} });
    },
  }));
}

export const chatStore = createChatStore();

export interface ChatSessionControllerOptions {
  store: StoreApi<ChatStoreState>;
  seam: ChatSyncSeam;
  key: ChatStateKeyParts;
  spaceId: SpaceId | string;
  limit?: number;
}

export interface ChatSessionController {
  loadNewest(refreshedFromNewest?: boolean): Promise<void>;
  loadOlder(): Promise<void>;
  loadNewer(): Promise<void>;
  loadAround(around: NonNullable<EntityFeedQuery['around']>): Promise<void>;
  attach(): Unsubscribe;
  dispose(): void;
}

export function createChatSessionController({
  store,
  seam,
  key,
  spaceId,
  limit = 50,
}: ChatSessionControllerOptions): ChatSessionController {
  const id = chatStateKey(key);
  store.getState().ensure(key);
  let generation = 0;
  let disposed = false;
  let lastConnectionPhase: ConnectionState['phase'] | null = null;

  const current = () => store.getState().entries[id]!;
  const patch = (update: Partial<ChatEntry> | ((entry: ChatEntry) => ChatEntry)) => {
    if (!disposed) store.getState().patch(id, update);
  };
  const begin = (): number => {
    const token = ++generation;
    return token;
  };
  const accepts = (token: number): boolean => !disposed && generation === token;

  const loadNewest = async (refreshedFromNewest = false): Promise<void> => {
    const token = begin();
    patch({ phase: current().page ? current().phase : 'loading', error: null, refusal: null });
    try {
      const response = await seam.feed(key.sessionId as EntityId, {
        scope: key.scope,
        order: 'newest',
        limit,
      });
      if (!accepts(token)) return;
      const page = chronologicalPage(response);
      patch({
        page,
        phase: 'ready',
        error: null,
        refusal: null,
        olderCursor: response.nextCursor,
        newerCursor: null,
        refreshedFromNewest,
        focusedItemId: null,
      });
    } catch (reason: unknown) {
      if (!accepts(token)) return;
      const refusal = refusalFrom(reason);
      patch(refusal
        ? { phase: 'refused', refusal, error: null }
        : { phase: 'error', error: errorMessage(reason), refusal: null });
    }
  };

  const loadOlder = async (): Promise<void> => {
    const cursor = current().olderCursor;
    if (!cursor || current().loadingEarlier) return;
    const token = begin();
    patch({ loadingEarlier: true });
    try {
      const response = await seam.feed(key.sessionId as EntityId, {
        scope: key.scope,
        order: current().focusedItemId ? 'oldest' : 'newest',
        cursor,
        limit,
      });
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
      const response = await seam.feed(key.sessionId as EntityId, {
        scope: key.scope,
        order: 'oldest',
        cursor,
        limit,
      });
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
    patch({ phase: current().page ? current().phase : 'loading', error: null, refusal: null });
    try {
      const response = await seam.feed(key.sessionId as EntityId, {
        scope: key.scope,
        order: 'oldest',
        around,
        limit,
      });
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
      const refusal = refusalFrom(reason);
      patch(refusal
        ? { phase: 'refused', refusal, error: null }
        : { phase: 'error', error: errorMessage(reason), refusal: null });
    }
  };

  /**
   * Event-driven refreshes are COALESCED, not issued per event.
   *
   * A streaming session emits a durable event per frame-worth of activity, and
   * this used to call `loadNewest()` for each one — a full newest-page feed
   * read PER EVENT, i.e. the busier the agent, the harder its own chat surface
   * hammered the node (and each call bumps `generation`, so an in-flight
   * pagination merge was cancelled by every keystroke of agent output).
   * Trailing-edge debounce, with a max-wait so a CONTINUOUS stream still
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
      if (eventTouchesSession(event, key.sessionId as EntityId)) scheduleRefresh();
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
    attach,
    dispose() {
      disposed = true;
      generation += 1;
      clearRefresh();
    },
  };
}

export function messageForReply(entry: ChatEntry): MessageView | null {
  if (!entry.replyToId) return null;
  for (const item of entry.page?.items ?? []) {
    if (item.itemKind === 'message' && item.message.id === entry.replyToId) return item.message;
  }
  return null;
}

function emptyEntry(key: ChatStateKeyParts, drafts: ChatDrafts): ChatEntry {
  return {
    key,
    phase: 'idle',
    error: null,
    refusal: null,
    loadingEarlier: false,
    loadingNewer: false,
    olderCursor: null,
    newerCursor: null,
    refreshedFromNewest: false,
    focusedItemId: null,
    replyToId: null,
    drafts,
    scrollAnchor: null,
    mutations: {},
  };
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

function eventTouchesSession(event: DurableWorkspaceEvent, sessionId: EntityId): boolean {
  if ('anchorId' in event && event.anchorId === sessionId) return true;
  if (event.type === 'activity.created') {
    return event.activity.entityId === sessionId || event.activity.workSessionId === sessionId;
  }
  if (event.type === 'message.attachments.updated') {
    return event.message.state.anchorId === sessionId;
  }
  if (event.type === 'message.delivery_reserved' || event.type === 'message.delivery_settled') {
    return event.delivery.targetWorkSessionId === sessionId;
  }
  return false;
}

function refusalFrom(error: unknown): ChannelRefusal | null {
  const code = errorCode(error);
  if (code !== 'forbidden' && code !== 'not_found') return null;
  return {
    kind: code,
    message: error instanceof Error && error.message
      ? error.message
      : code === 'forbidden'
      ? 'You no longer have access to this session’s Chat.'
      : 'This work session no longer exists.',
  };
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === 'string' ? error.code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The session Chat feed could not be read.';
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function freshEmptyDraft(): ChatDrafts {
  return { newMessage: EMPTY_DRAFT.newMessage, replies: {}, updatedAt: EMPTY_DRAFT.updatedAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
