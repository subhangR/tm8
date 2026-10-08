import { describe, expect, it, vi } from 'vitest';
import { createGameMailboxReader } from '../game-mailboxes';
import { createRealSeam } from './seam-real';
import { fakeFetch, fakeSocketPool } from './test-support';

const SPACE = '00000000-0000-7000-8000-000000000001';
const ANCHOR = '00000000-0000-7000-8000-000000000002';

describe('real Seam lazy unread and local read-mark invalidation', () => {
  it('fetches bounded counts only on demand, without identity or read-mark parameters', async () => {
    const counts = { spaceId: SPACE, counts: [{ anchorId: ANCHOR, unread: 2 }], complete: true };
    const f = fakeFetch(() => ({ data: counts }));
    const seam = createRealSeam({ baseUrl: '', wsUrl: 'ws://fake.invalid/v2/ws', fetch: f.fetch,
      webSocketFactory: fakeSocketPool().factory });
    const reader = createGameMailboxReader(seam, SPACE);
    expect(f.calls).toEqual([]);
    expect(await reader()).toEqual(counts);
    expect(f.calls).toHaveLength(1);
    expect(f.last()).toMatchObject({ url: `/v2/spaces/${SPACE}/unread-counts`, method: 'GET', body: undefined });
    seam.dispose();
  });

  it('notifies only after a successful read-mark command and supports unsubscribe/dispose', async () => {
    let refuse = false;
    const f = fakeFetch(() => refuse ? { status: 403, error: { code: 'forbidden', message: 'refused', requestId: 'r', retryable: false } }
      : { data: { anchorId: ANCHOR, lastReadAt: '2026-10-08T12:00:00.000Z' } });
    const seam = createRealSeam({ baseUrl: '', wsUrl: 'ws://fake.invalid/v2/ws', fetch: f.fetch,
      webSocketFactory: fakeSocketPool().factory });
    const listener = vi.fn();
    const stop = createGameMailboxReader(seam, SPACE).onInvalidated!(listener);
    const command = seam.commands.upsertReadMark(ANCHOR, 'client-clock-is-ignored');
    expect(listener).not.toHaveBeenCalled();
    await command;
    expect(listener).toHaveBeenCalledExactlyOnceWith(ANCHOR);
    expect(f.last().body).not.toHaveProperty('lastReadAt');
    refuse = true;
    await expect(seam.commands.upsertReadMark(ANCHOR, '')).rejects.toMatchObject({ code: 'forbidden' });
    expect(listener).toHaveBeenCalledTimes(1);
    refuse = false;
    stop();
    await seam.commands.upsertReadMark(ANCHOR, '');
    expect(listener).toHaveBeenCalledTimes(1);
    seam.onReadMark!(listener);
    seam.dispose();
    await seam.commands.upsertReadMark(ANCHOR, '');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
