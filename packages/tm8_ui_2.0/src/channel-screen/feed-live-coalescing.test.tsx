// @vitest-environment jsdom
/**
 * LIVE-FEED COALESCING (ruling 2026-08-18): a busy channel must not issue a
 * full feed read PER EVENT — event-driven reloads are trailing-edge debounced
 * with a bounded max-wait, and the sender's own post() resolves on COMMIT,
 * not on the repaint round-trip. FeedItems are never synthesised client-side
 * (UNIFIED-MESSAGES-VIEW §3 — tried and reverted); the read stays the only
 * writer of the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { useChannelFeed, type ChannelFeedPort } from './useChannelFeed';

const CHANNEL = 'ent-channel' as EntityId;

function stubPort() {
  const handlers: Array<(event: unknown) => void> = [];
  const feed = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const port: ChannelFeedPort = {
    seam: {
      feed,
      onEvent: (handler: (event: unknown) => void) => {
        handlers.push(handler);
        return () => {};
      },
      /* The union reader attaches a reconnect reload and a resync listener
         alongside the event subscription. Both are on the real `Seam`; this
         double predates the channel reading through it. */
      onConnection: () => () => {},
      onResync: () => () => {},
      commands: { postMessage: vi.fn().mockResolvedValue({ patches: [] }) },
      query: vi.fn().mockResolvedValue({ page: { items: [], nextCursor: null } }),
      liveness: () => 'unknown',
      entity: vi.fn(),
      files: undefined,
      messages: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    } as unknown as ChannelFeedPort['seam'],
    spaceId: 'sp-1' as never,
    liveIds: [],
    /* Result-bearing: the mutation journal settles a pending row against the
       stored ids, and an `undefined` result leaves that row uncertain. */
    postMessage: vi.fn().mockResolvedValue({ patches: [] }),
    spawn: vi.fn(),
    projects: [],
  };
  return { port, handlers, feed };
}

describe('channel feed live coalescing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a burst of events costs ONE reload after the debounce, not one per event', async () => {
    const { port, handlers, feed } = stubPort();
    renderHook(() => useChannelFeed(port, CHANNEL));
    // Let the mount reload settle, then count from zero.
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    feed.mockClear();

    act(() => {
      for (let i = 0; i < 8; i += 1) handlers.forEach((h) => h({ anchorId: CHANNEL }));
    });
    expect(feed).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(feed).toHaveBeenCalledTimes(1);
  });

  it('a continuous stream still refreshes on the max-wait cadence', async () => {
    const { port, handlers, feed } = stubPort();
    renderHook(() => useChannelFeed(port, CHANNEL));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    feed.mockClear();

    // Events every 100ms for 2s: the trailing edge never goes quiet, so only
    // the max-wait (1.5s) can fire — and it must.
    await act(async () => {
      for (let t = 0; t < 20; t += 1) {
        handlers.forEach((h) => h({ anchorId: CHANNEL }));
        await vi.advanceTimersByTimeAsync(100);
      }
    });
    expect(feed.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(feed.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("post() resolves on the write's commit, before the echo read lands", async () => {
    const { port, feed } = stubPort();
    const view = renderHook(() => useChannelFeed(port, CHANNEL));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    feed.mockClear();

    let feedResolved = false;
    feed.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => { feedResolved = true; resolve({ items: [], nextCursor: null }); }, 5_000);
    }));
    await act(async () => {
      await view.result.current.post({ anchorIds: [CHANNEL], body: 'hi' } as never);
    });
    // The send resolved while the repaint read was still in flight.
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    expect(feedResolved).toBe(false);
    expect(feed).toHaveBeenCalledTimes(1);
  });
});
