import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  EntityFeedPage,
  EntityFeedQuery,
  EntityId,
  FeedScope,
  MessageView,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
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
  /**
   * `legacy` is a PREVIOUS spelling of this same conversation's key, read only
   * when the current one holds no draft.
   *
   * Dropping a hardcoded scope changes the key — and the key is also the
   * localStorage draft key, so the correct fix silently discards whatever the
   * viewer had half-written. One fallback read carries it across. It is not a
   * merge: a draft under the current key always wins, so this can only ever
   * recover text that would otherwise be lost.
   */
  ensure(key: ChatStateKeyParts, legacy?: ChatStateKeyParts): void;
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
    ensure(key, legacy) {
      const id = chatStateKey(key);
      if (get().entries[id]) return;
      const own = readDraft(storage, key);
      const drafts = legacy && !own.newMessage && Object.keys(own.replies).length === 0
        ? readDraft(storage, legacy)
        : own;
      set((state) => ({
        entries: {
          ...state.entries,
          [id]: emptyEntry(key, drafts),
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

/*
 * `createChatSessionController`, ITS OPTIONS TYPE, AND ITS FEED HELPERS LIVED
 * HERE — `chronologicalPage`, `mergePages`, `dedupe`, `chronological`,
 * `eventTouchesSession`, `refusalFrom` and the error/refusal copy.
 *
 * They read a work_session with a hardcoded `session_chat_v1`, and they were
 * the best of the three readers this codebase had — generation-guarded reads,
 * a coalesced refresh, a reconnect reload, `onResync`, bidirectional paging
 * and `loadAround`. None of that is lost: it is the foundation of
 * `anchor-feed-controller.ts`, which does the same things for ANY anchor kind
 * and no longer names a scope the server already resolves. The tests that
 * guaranteed this behaviour were repointed at the replacement rather than
 * deleted, and they pass unchanged.
 *
 * What remains in this file is the part that was never duplicated and is still
 * exactly right: the keyed store, the persisted drafts and the reply target.
 */

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
