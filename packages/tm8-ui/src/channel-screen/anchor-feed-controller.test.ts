/**
 * The union feed reader, tested on the four things that made three readers
 * necessary — and on the three defects that shipped because only one of the
 * three ever got the fix.
 *
 * Every test below FAILS against `useChannelFeed`'s behaviour. That is the
 * point: the union is worth building because of what the other two readers
 * cannot do, so each claim is pinned to a test rather than to a docblock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableWorkspaceEvent, EntityFeedPage, FeedItem, MessageView } from '@tm8/contract';
import { chatStateKey, createChatStore, type ChatStateKeyParts } from './chat-store';
import {
  createAnchorFeedController,
  eventTouchesAnchor,
  type AnchorFeedSeam,
  type AnchorFeedThread,
} from './anchor-feed-controller';

const ANCHOR = '01900000-0000-7000-8000-000000000301';
const SPACE = '01900000-0000-7000-8000-000000000302';

function item(id: string, createdAt: string): FeedItem {
  return {
    itemKind: 'message',
    itemId: id,
    createdAt,
    sortId: `${createdAt}#${id}`,
    via: [],
    actor: null,
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: null,
    message: { id },
    delivery: [],
  } as unknown as FeedItem;
}

function page(items: FeedItem[], nextCursor: string | null = null): EntityFeedPage {
  return { resolvedScope: 'channel_threads_v1', predicates: ['anchored'], items, nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
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

function harness() {
  let event: ((value: DurableWorkspaceEvent) => void) | null = null;
  let connection: ((value: { phase: 'live' | 'polling' | 'offline' | 'connecting' }) => void) | null = null;
  let resync: ((spaceId: string) => void) | null = null;
  const feed = vi.fn<AnchorFeedSeam['feed']>();
  const messages = vi.fn<NonNullable<AnchorFeedSeam['messages']>>();
  const seam = {
    feed,
    messages,
    onEvent(listener: typeof event) { event = listener; return () => { event = null; }; },
    onConnection(listener: typeof connection) { connection = listener; return () => { connection = null; }; },
    onResync(listener: typeof resync) { resync = listener; return () => { resync = null; }; },
  } as unknown as AnchorFeedSeam;
  return {
    seam,
    feed,
    messages,
    event: (value: DurableWorkspaceEvent) => event?.(value),
    connection: (phase: 'live' | 'offline') => connection?.({ phase }),
    resync: (spaceId: string) => resync?.(spaceId),
  };
}

/** No scope — the reading every anchor kind should get. */
const key: ChatStateKeyParts = {
  viewerMemberId: 'member-a',
  sessionId: ANCHOR,
  filter: 'chronological',
};

function build(h: ReturnType<typeof harness>, overrides: Partial<Parameters<typeof createAnchorFeedController>[0]> = {}) {
  const store = createChatStore({ storage: memoryStorage() });
  const controller = createAnchorFeedController({
    store,
    seam: h.seam,
    key,
    spaceId: SPACE,
    ...overrides,
  });
  return { store, controller, entry: () => store.getState().entries[chatStateKey(key)]! };
}

describe('the scope is requested, never re-sent, and never invented', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('OMITS scope entirely when the caller does not name one, so the server resolves it', async () => {
    const h = harness();
    h.feed.mockResolvedValue(page([item('a', '2026-08-18T00:01:00.000Z')]));
    const { controller } = build(h);
    await controller.loadNewest();

    expect(h.feed).toHaveBeenCalledWith(ANCHOR, expect.not.objectContaining({ scope: expect.anything() }));
    // Absent, not present-and-undefined: `'scope' in opts` must be false, or a
    // serializer that distinguishes them sends a different body.
    expect('scope' in (h.feed.mock.calls[0]![1] ?? {})).toBe(false);
  });

  it('NEVER echoes the resolved scope back on a later page — a cursor is fingerprinted over its scope', async () => {
    const h = harness();
    h.feed.mockResolvedValue(page([item('a', '2026-08-18T00:01:00.000Z')], 'older-cursor'));
    const { controller } = build(h);
    await controller.loadNewest();
    await controller.loadOlder();

    expect(h.feed).toHaveBeenCalledTimes(2);
    // The server ANSWERED `channel_threads_v1`. Sending that back on page two
    // would be a second spelling of one scope, and the keyset cursor would be
    // rejected. Every read for a key spells the scope identically: not at all.
    for (const [, opts] of h.feed.mock.calls) {
      expect('scope' in (opts ?? {})).toBe(false);
    }
  });

  it('sends a NAMED scope byte-identically on every read when a caller defends one', async () => {
    const h = harness();
    h.feed.mockResolvedValue(page([item('a', '2026-08-18T00:01:00.000Z')], 'older-cursor'));
    const { controller } = build(h, { key: { ...key, scope: 'thread_v1' } });
    await controller.loadNewest();
    await controller.loadOlder();

    for (const [, opts] of h.feed.mock.calls) {
      expect(opts).toMatchObject({ scope: 'thread_v1' });
    }
  });

  it('keys state on the REQUESTED scope, spelling an absent one `default`', () => {
    // The key is also the localStorage draft key. Keying on the RESOLVED scope
    // would change identity once the first read landed and orphan the draft.
    expect(chatStateKey(key)).toContain('"default"');
    expect(chatStateKey(key)).not.toBe(chatStateKey({ ...key, scope: 'direct_v1' }));
    // Every key spelled before scope became optional must be unchanged.
    expect(chatStateKey({ ...key, scope: 'session_chat_v1' }))
      .toBe(JSON.stringify(['member-a', ANCHOR, 'session_chat_v1', 'chronological']));
  });
});

describe('D1 — a slow read can never overwrite a newer one', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('discards a superseded response instead of letting the last one to land win', async () => {
    const h = harness();
    const slow = deferred<EntityFeedPage>();
    const fast = deferred<EntityFeedPage>();
    h.feed.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const { controller, entry } = build(h);

    const first = controller.loadNewest();
    const second = controller.loadNewest();

    // The SECOND read answers first, then the first read finally lands. Without
    // a generation guard the stale page wins — `useChannelFeed.reload()` has
    // none and reloads on every event, so this ordering is its normal case.
    fast.resolve(page([item('new', '2026-08-18T00:02:00.000Z')]));
    await second;
    slow.resolve(page([item('stale', '2026-08-18T00:01:00.000Z')]));
    await first;

    expect(entry().page?.items.map((i) => i.itemId)).toEqual(['new']);
  });
});

describe('D2 — a refresh is not a load', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('does not drop back to `loading` once a page exists', async () => {
    const h = harness();
    h.feed.mockResolvedValue(page([item('a', '2026-08-18T00:01:00.000Z')]));
    const { controller, entry } = build(h);
    await controller.loadNewest();
    expect(entry().phase).toBe('ready');

    const pending = deferred<EntityFeedPage>();
    h.feed.mockReturnValueOnce(pending.promise);
    const refreshing = controller.loadNewest();

    // Mid-refresh, with a page already on screen. `useChannelFeed.ts:246` sets
    // loading unconditionally here, so a busy channel strobes its own feed.
    expect(entry().phase).toBe('ready');
    pending.resolve(page([item('a', '2026-08-18T00:01:00.000Z')]));
    await refreshing;
  });

  it('DOES show `loading` when there is genuinely nothing on screen yet', () => {
    const h = harness();
    h.feed.mockReturnValue(deferred<EntityFeedPage>().promise);
    const { controller, entry } = build(h);
    void controller.loadNewest();
    expect(entry().phase).toBe('loading');
  });
});

describe('D3 — delivery state reaches an anchor that is not a work session', () => {
  it('treats a delivery settlement as touching the anchor it targets', () => {
    const settled = {
      type: 'message.delivery_settled',
      delivery: { targetWorkSessionId: ANCHOR },
    } as unknown as DurableWorkspaceEvent;

    expect(eventTouchesAnchor(settled, ANCHOR)).toBe(true);
    // The narrow test `useChannelFeed` uses. A delivery event carries its
    // subject on `delivery`, never on `anchorId`, which is why a channel's
    // 8-state delivery chips do not refresh live today.
    expect('anchorId' in settled).toBe(false);
  });

  it('still ignores an event for a different anchor', () => {
    const elsewhere = {
      type: 'message.created',
      anchorId: 'someone-else',
    } as unknown as DurableWorkspaceEvent;
    expect(eventTouchesAnchor(elsewhere, ANCHOR)).toBe(false);
  });
});

describe('coalesced refresh, reconnect and resync — on every anchor, not just a session', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.useFakeTimers(); });

  it('collapses a burst of events into ONE re-read', async () => {
    const h = harness();
    h.feed.mockResolvedValue(page([]));
    const { controller } = build(h);
    const detach = controller.attach();

    for (let n = 0; n < 20; n += 1) {
      h.event({ type: 'message.created', anchorId: ANCHOR } as unknown as DurableWorkspaceEvent);
    }
    expect(h.feed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);

    // `useChannelFeed.ts:297-302` would have issued twenty full feed reads.
    expect(h.feed).toHaveBeenCalledTimes(1);
    detach();
    vi.useRealTimers();
  });

  it('re-reads when the connection returns, and on a resync of ITS space only', async () => {
    const h = harness();
    h.feed.mockResolvedValue(page([]));
    const { controller } = build(h);
    const detach = controller.attach();

    h.connection('live');   // first observation establishes posture, no read
    expect(h.feed).not.toHaveBeenCalled();
    h.connection('offline');
    h.connection('live');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.feed).toHaveBeenCalledTimes(1);

    h.resync('a-different-space');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.feed).toHaveBeenCalledTimes(1);

    h.resync(SPACE);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.feed).toHaveBeenCalledTimes(2);
    detach();
    vi.useRealTimers();
  });

  it('stops refreshing once disposed', async () => {
    const h = harness();
    h.feed.mockResolvedValue(page([]));
    const { controller } = build(h);
    const detach = controller.attach();
    h.event({ type: 'message.created', anchorId: ANCHOR } as unknown as DurableWorkspaceEvent);
    detach();
    controller.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.feed).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('the branch read, available on any anchor and never crossed with another', () => {
  beforeEach(() => vi.restoreAllMocks());

  const root = { id: 'root-1' } as unknown as MessageView;
  const other = { id: 'root-2' } as unknown as MessageView;

  it('reads the branch for the root that is open, oldest-first, without re-sorting', async () => {
    const h = harness();
    h.feed.mockResolvedValue(page([]));
    const replies = { items: [{ id: 'r1' }, { id: 'r2' }], nextCursor: null };
    h.messages.mockResolvedValue(replies as never);
    const seen: (AnchorFeedThread | null)[] = [];
    const { controller } = build(h, { threads: true, onThreadChange: (t) => seen.push(t) });

    controller.openThread(root);
    await vi.waitFor(() => expect(seen.at(-1)?.replies).toBeDefined());

    expect(h.messages).toHaveBeenCalledWith(ANCHOR, { rootMessageId: 'root-1' });
    expect(seen.at(-1)?.replies?.items.map((m) => m.id)).toEqual(['r1', 'r2']);
    expect(seen.at(-1)?.loading).toBe(false);
  });

  it('drops a branch response for a root the viewer has already left', async () => {
    const h = harness();
    h.feed.mockResolvedValue(page([]));
    const first = deferred<{ items: { id: string }[]; nextCursor: null }>();
    h.messages.mockReturnValueOnce(first.promise as never)
      .mockResolvedValue({ items: [{ id: 'b1' }], nextCursor: null } as never);
    const seen: (AnchorFeedThread | null)[] = [];
    const { controller } = build(h, { threads: true, onThreadChange: (t) => seen.push(t) });

    controller.openThread(root);
    controller.openThread(other);           // switched before the first landed
    first.resolve({ items: [{ id: 'a1' }], nextCursor: null });
    await vi.waitFor(() => expect(seen.at(-1)?.replies).toBeDefined());

    expect(seen.at(-1)?.root.id).toBe('root-2');
    expect(seen.at(-1)?.replies?.items.map((m) => m.id)).toEqual(['b1']);
  });

  it('refuses to open a branch on a surface that does not offer threads', () => {
    const h = harness();
    h.feed.mockResolvedValue(page([]));
    const seen: (AnchorFeedThread | null)[] = [];
    const { controller } = build(h, { threads: false, onThreadChange: (t) => seen.push(t) });

    controller.openThread(root);
    expect(seen).toEqual([]);
    expect(h.messages).not.toHaveBeenCalled();
  });
});
