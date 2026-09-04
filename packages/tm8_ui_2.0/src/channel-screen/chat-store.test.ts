import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableWorkspaceEvent, EntityFeedPage, FeedItem } from '@tm8/contract';
import {
  chatStateKey,
  createChatStore,
  draftStorageKey,
  readDraft,
  writeDraft,
  type ChatSyncSeam,
} from './chat-store';
/*
 * REPOINTED, NOT RETIRED. `createChatSessionController` is gone — the union
 * reader supersedes it — but everything it guaranteed is still a guarantee, so
 * these assertions moved to its replacement rather than being deleted with it.
 * They pass unchanged, which is the useful fact: the union did not quietly
 * drop a behaviour the session chat depended on.
 */
import { createAnchorFeedController } from './anchor-feed-controller';

const SESSION = '01900000-0000-7000-8000-000000000201';
const SPACE = '01900000-0000-7000-8000-000000000202';

function item(id: string, createdAt: string, kind: 'message' | 'activity' = 'message'): FeedItem {
  return {
    itemKind: kind,
    itemId: id,
    createdAt,
    sortId: `${createdAt}#${id}`,
    via: [],
    actor: null,
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: null,
    ...(kind === 'message'
      ? { message: { id }, delivery: [] }
      : { activity: { id, verb: 'test', summary: {}, createdAt } }),
  } as unknown as FeedItem;
}

function page(
  items: FeedItem[],
  nextCursor: string | null = null,
  previousCursor?: string | null,
): EntityFeedPage {
  return {
    resolvedScope: 'session_chat_v1',
    predicates: ['anchored'],
    items,
    nextCursor,
    ...(previousCursor !== undefined ? { previousCursor } : {}),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function seamHarness() {
  let event: ((value: DurableWorkspaceEvent) => void) | null = null;
  let connection: ((value: { phase: 'live' | 'polling' | 'offline' | 'connecting'; disconnectedSince?: string }) => void) | null = null;
  let resync: ((spaceId: string) => void) | null = null;
  const feed = vi.fn<ChatSyncSeam['feed']>();
  const seam: ChatSyncSeam = {
    feed,
    onEvent(listener) {
      event = listener;
      return () => { event = null; };
    },
    onConnection(listener) {
      connection = listener;
      return () => { connection = null; };
    },
    onResync(listener) {
      resync = listener;
      return () => { resync = null; };
    },
  };
  return {
    seam,
    feed,
    event: (value: DurableWorkspaceEvent) => event?.(value),
    connection: (value: Parameters<NonNullable<typeof connection>>[0]) => connection?.(value),
    resync: (value: string) => resync?.(value),
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

const parts = {
  viewerMemberId: 'member-a',
  sessionId: SESSION,
  scope: 'session_chat_v1' as const,
  filter: 'chronological',
};

describe('Chat state identity and durable drafts', () => {
  it('keys by viewer/member + session + scope + filter without collisions', () => {
    expect(chatStateKey(parts)).not.toBe(chatStateKey({ ...parts, viewerMemberId: 'member-b' }));
    expect(chatStateKey(parts)).not.toBe(chatStateKey({ ...parts, sessionId: `${SESSION}-other` }));
    expect(chatStateKey(parts)).not.toBe(chatStateKey({ ...parts, filter: 'around:message:m1' }));
  });

  it('restores versioned new-message and per-reply drafts and ignores incompatible data', () => {
    const storage = memoryStorage();
    const key = draftStorageKey(parts);
    writeDraft(storage, parts, {
      newMessage: 'new draft',
      replies: { 'message-1': 'reply draft' },
      updatedAt: '2026-07-30T00:00:00.000Z',
    });
    expect(JSON.parse(storage.getItem(key)!)).toMatchObject({ version: 1 });
    expect(readDraft(storage, parts)).toMatchObject({
      newMessage: 'new draft', replies: { 'message-1': 'reply draft' },
    });

    storage.setItem(key, JSON.stringify({ version: 99, newMessage: 'unsafe' }));
    expect(readDraft(storage, parts)).toMatchObject({ newMessage: '', replies: {} });
  });

  it('survives storage read/write failures without losing in-memory state', () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    } as unknown as Storage;
    expect(readDraft(broken, parts)).toMatchObject({ newMessage: '', replies: {} });
    expect(() => writeDraft(broken, parts, { newMessage: 'kept', replies: {}, updatedAt: 'now' }))
      .not.toThrow();
  });
});

describe('Chat feed synchronization controller (now createAnchorFeedController)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('loads newest, presents chronologically, and deduplicates by typed feed identity', async () => {
    const h = seamHarness();
    const store = createChatStore({ storage: memoryStorage() });
    h.feed.mockResolvedValue(page([
      item('same', '2026-07-30T00:03:00.000Z', 'message'),
      item('same', '2026-07-30T00:02:00.000Z', 'activity'),
      item('same', '2026-07-30T00:01:00.000Z', 'message'),
    ], 'older'));
    const controller = createAnchorFeedController({ store, seam: h.seam, key: parts, spaceId: SPACE, limit: 25 });

    await controller.loadNewest();
    const entry = store.getState().entries[chatStateKey(parts)]!;
    expect(h.feed).toHaveBeenCalledWith(SESSION, {
      scope: 'session_chat_v1', order: 'newest', limit: 25,
    });
    expect(entry.page?.items.map((row) => `${row.itemKind}:${row.itemId}`)).toEqual([
      'activity:same', 'message:same',
    ]);
    expect(entry.olderCursor).toBe('older');
  });

  it('paginates older items without duplicates and preserves the next cursor', async () => {
    const h = seamHarness();
    const store = createChatStore({ storage: memoryStorage() });
    h.feed
      .mockResolvedValueOnce(page([
        item('m3', '2026-07-30T00:03:00.000Z'),
        item('m2', '2026-07-30T00:02:00.000Z'),
      ], 'c-old'))
      .mockResolvedValueOnce(page([
        item('m2', '2026-07-30T00:02:00.000Z'),
        item('m1', '2026-07-30T00:01:00.000Z'),
      ], 'c-older'));
    const controller = createAnchorFeedController({ store, seam: h.seam, key: parts, spaceId: SPACE, limit: 2 });
    await controller.loadNewest();
    await controller.loadOlder();

    expect(h.feed).toHaveBeenLastCalledWith(SESSION, {
      scope: 'session_chat_v1', order: 'newest', cursor: 'c-old', limit: 2,
    });
    const entry = store.getState().entries[chatStateKey(parts)]!;
    expect(entry.page?.items.map((row) => row.itemId)).toEqual(['m1', 'm2', 'm3']);
    expect(entry.olderCursor).toBe('c-older');
  });

  it('loads a chronological around window and keeps both directional cursors and focus', async () => {
    const h = seamHarness();
    const store = createChatStore({ storage: memoryStorage() });
    h.feed.mockResolvedValue(page([item('m2', '2026-07-30T00:02:00.000Z')], 'newer', 'older'));
    const controller = createAnchorFeedController({ store, seam: h.seam, key: parts, spaceId: SPACE, limit: 21 });
    await controller.loadAround('message:m2');

    expect(h.feed).toHaveBeenCalledWith(SESSION, {
      scope: 'session_chat_v1', order: 'oldest', around: 'message:m2', limit: 21,
    });
    expect(store.getState().entries[chatStateKey(parts)]).toMatchObject({
      olderCursor: 'older', newerCursor: 'newer', focusedItemId: 'message:m2',
    });
  });

  it('ignores stale responses and cancels responses after disposal', async () => {
    const h = seamHarness();
    const store = createChatStore({ storage: memoryStorage() });
    const old = deferred<EntityFeedPage>();
    const fresh = deferred<EntityFeedPage>();
    h.feed.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const controller = createAnchorFeedController({ store, seam: h.seam, key: parts, spaceId: SPACE });
    const first = controller.loadNewest();
    const second = controller.loadNewest();
    fresh.resolve(page([item('fresh', '2026-07-30T00:02:00.000Z')]));
    await second;
    old.resolve(page([item('stale', '2026-07-30T00:01:00.000Z')]));
    await first;
    expect(store.getState().entries[chatStateKey(parts)]!.page?.items[0]?.itemId).toBe('fresh');

    const afterDispose = deferred<EntityFeedPage>();
    h.feed.mockReturnValueOnce(afterDispose.promise);
    const pending = controller.loadNewest();
    controller.dispose();
    afterDispose.resolve(page([item('disposed', '2026-07-30T00:03:00.000Z')]));
    await pending;
    expect(store.getState().entries[chatStateKey(parts)]!.page?.items[0]?.itemId).toBe('fresh');
  });

  it('uses events as targeted hints and refreshes after reconnect or matching resync', async () => {
    const h = seamHarness();
    const store = createChatStore({ storage: memoryStorage() });
    h.feed.mockResolvedValue(page([]));
    const controller = createAnchorFeedController({ store, seam: h.seam, key: parts, spaceId: SPACE });
    const detach = controller.attach();
    await controller.loadNewest();

    h.event({ type: 'message.created', anchorId: 'other' } as DurableWorkspaceEvent);
    expect(h.feed).toHaveBeenCalledTimes(1);
    h.event({ type: 'message.created', anchorId: SESSION } as DurableWorkspaceEvent);
    await vi.waitFor(() => expect(h.feed).toHaveBeenCalledTimes(2));
    h.connection({ phase: 'polling', disconnectedSince: 'now' });
    h.event({ type: 'message.updated', anchorId: SESSION } as DurableWorkspaceEvent);
    await vi.waitFor(() => expect(h.feed).toHaveBeenCalledTimes(3));
    h.connection({ phase: 'live' });
    await vi.waitFor(() => expect(h.feed).toHaveBeenCalledTimes(4));
    h.resync('other-space');
    expect(h.feed).toHaveBeenCalledTimes(4);
    h.resync(SPACE);
    await vi.waitFor(() => expect(h.feed).toHaveBeenCalledTimes(5));
    detach();
  });

  it('recovers an invalid pagination cursor from newest and marks the snapshot refresh', async () => {
    const h = seamHarness();
    const store = createChatStore({ storage: memoryStorage() });
    h.feed
      .mockResolvedValueOnce(page([item('m2', '2026-07-30T00:02:00.000Z')], 'expired'))
      .mockRejectedValueOnce(Object.assign(new Error('expired cursor'), { code: 'invalid_cursor' }))
      .mockResolvedValueOnce(page([item('m3', '2026-07-30T00:03:00.000Z')], null));
    const controller = createAnchorFeedController({ store, seam: h.seam, key: parts, spaceId: SPACE });
    await controller.loadNewest();
    await controller.loadOlder();

    expect(store.getState().entries[chatStateKey(parts)]).toMatchObject({
      refreshedFromNewest: true,
      olderCursor: null,
    });
    expect(store.getState().entries[chatStateKey(parts)]!.page?.items[0]?.itemId).toBe('m3');
  });
});
