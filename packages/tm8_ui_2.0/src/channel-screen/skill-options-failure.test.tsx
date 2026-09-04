// @vitest-environment jsdom
/**
 * A FAILED SKILL READ IS NOT A MEASURED ZERO.
 *
 * The primitive's central law is that `options: undefined` means the
 * CAPABILITY IS ABSENT and `[]` means a measured zero — the difference
 * between "there is no `/` here" and "there are no skills yet". This hook
 * collapsed them: its catch set `[]`, so a service outage rendered the `/`
 * control (the composer gates on `skillOptions ?`, and `[]` is truthy) and
 * reported "No matching skills". A reader cannot tell that apart from an
 * empty catalog, and the one that lies is the outage.
 *
 * `SessionChatSurface` already mapped the same failure class to `undefined`,
 * so the two channel surfaces disagreed about the same fact. These pin all
 * three states at the hook's own seam: unread, failed, and measured zero.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { EntityId, SpaceId } from '@tm8/contract';
import { useChannelFeed, type ChannelFeedPort } from './useChannelFeed';

afterEach(cleanup);

const SPACE = '019f0000-0000-7000-8000-0000000000aa' as SpaceId;
const CHANNEL = '019f0000-0000-7000-8000-0000000000bb' as EntityId;

function portWith(query: ChannelFeedPort['seam']['query']): ChannelFeedPort {
  const seam = {
    feed: vi.fn(async () => ({ items: [], nextCursor: null })),
    onEvent: () => () => undefined,
    /* The real `Seam` has always had these; this double predates the feed
       unification, when the channel hook subscribed to events ALONE and got
       no reconnect reload and no resync. It does now, through
       `useAnchorFeed`, so the double has to answer for them. */
    onConnection: () => () => undefined,
    onResync: () => () => undefined,
    commands: { postMessage: vi.fn(async () => ({ patches: [] })) },
    query,
    liveness: { statusOf: () => 'unknown', refresh: vi.fn() },
    entity: vi.fn(async () => { throw new Error('not needed'); }),
    files: {},
    messages: {},
  } as unknown as ChannelFeedPort['seam'];
  return {
    seam,
    spaceId: SPACE,
    liveIds: [],
    postMessage: vi.fn(async () => undefined),
    spawn: vi.fn(async () => CHANNEL),
    projects: [],
  };
}

const emptyPage = { page: { items: [], nextCursor: null } } as never;

describe('the `/` capability distinguishes a failure from a zero', () => {
  it('a FAILED read leaves the capability absent — `/` types plain text', async () => {
    const query = vi.fn(async () => { throw new Error('upstream_unavailable'); });
    /* Built ONCE, outside the render callback: this hook's effects key on the
       port's identity, and a fresh object per render would re-run them
       forever. */
    const port = portWith(query);
    const { result } = renderHook(() => useChannelFeed(port, CHANNEL));

    await waitFor(() => expect(query).toHaveBeenCalled());
    // Never `[]`: that would draw a `/` control which answers an outage with
    // "no matching skills".
    await waitFor(() => expect(result.current.skillOptions).toBeUndefined());
  });

  it('an EMPTY page is a measured zero — the control stays and can say so', async () => {
    const query = vi.fn(async () => emptyPage);
    const port = portWith(query);
    const { result } = renderHook(() => useChannelFeed(port, CHANNEL));

    await waitFor(() => expect(result.current.skillOptions).toEqual([]));
  });

  it('before any read answers, the capability is not yet established', () => {
    // A promise that never settles: the state under test is the FIRST render,
    // which must not claim a zero it has not measured.
    const query = vi.fn(() => new Promise<never>(() => undefined));
    const port = portWith(query);
    const { result } = renderHook(() => useChannelFeed(port, CHANNEL));
    expect(result.current.skillOptions).toBeUndefined();
  });
});
