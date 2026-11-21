// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAttentionPending } from './useAttentionPending';
import type { AttentionPendingSeam } from './useAttentionPending';
import { req, SPACE } from './fake-attention-seam.test-support';

type Page = Awaited<ReturnType<AttentionPendingSeam['attentionRequests']>>;
const empty: Page = { items: [], nextCursor: null };

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function seamOf(attentionRequests: AttentionPendingSeam['attentionRequests']): AttentionPendingSeam {
  return { attentionRequests, onEvent: () => () => {}, onResync: () => () => {} };
}

it('holds read ownership after one status fails until the other pending page settles, then performs one refresh', async () => {
  const openPage = deferred<Page>();
  const legacyPage = deferred<Page>();
  let openReads = 0;
  let legacyReads = 0;
  const attentionRequests = vi.fn<AttentionPendingSeam['attentionRequests']>(async input => {
    if (input.status === 'open') {
      openReads += 1;
      return openReads === 1 ? openPage.promise : empty;
    }
    if (input.cursor === 'legacy-page-2') return legacyPage.promise;
    legacyReads += 1;
    return legacyReads === 1 ? { items: [], nextCursor: 'legacy-page-2' as Page['nextCursor'] } : empty;
  });
  const seam = seamOf(attentionRequests);
  const { result } = renderHook(() => useAttentionPending(seam, SPACE));
  await waitFor(() => expect(attentionRequests).toHaveBeenCalledTimes(3));
  await act(async () => { openPage.reject(new Error('Open requests unavailable')); });
  await waitFor(() => expect(result.current.state.phase).toBe('error'));

  act(() => {
    result.current.refresh();
    result.current.refresh();
  });
  expect(attentionRequests).toHaveBeenCalledTimes(3);
  expect(result.current.readsStarted()).toBe(1);

  await act(async () => {
    legacyPage.resolve({ items: [], nextCursor: 'abandoned-page-3' as Page['nextCursor'] });
  });
  await waitFor(() => expect(result.current.state.phase).toBe('ready'));
  expect(openReads).toBe(2);
  expect(legacyReads).toBe(2);
  expect(result.current.readsStarted()).toBe(2);
  expect(attentionRequests).toHaveBeenCalledTimes(5);
  expect(attentionRequests.mock.calls.some(([input]) => input.cursor === 'abandoned-page-3')).toBe(false);
});

it('retains the last complete snapshot as stale on refresh failure and clears the marker only after a successful read', async () => {
  const old = req({ entityId: 'last-complete' });
  const fresh = req({ entityId: 'new-complete' });
  const attentionRequests = vi.fn<AttentionPendingSeam['attentionRequests']>(async input => input.status === 'open'
    ? { items: [old], nextCursor: null } : empty);
  const seam = seamOf(attentionRequests);
  const { result } = renderHook(() => useAttentionPending(seam, SPACE));
  await waitFor(() => expect(result.current.state).toMatchObject({ phase: 'ready', rows: [old], refreshError: null, readNo: 1 }));

  attentionRequests.mockRejectedValueOnce(new Error('Refresh unavailable'));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.state).toMatchObject({ phase: 'ready', rows: [old], refreshError: 'Refresh unavailable', readNo: 1 }));

  attentionRequests.mockImplementation(async input => input.status === 'open'
    ? { items: [fresh], nextCursor: null } : empty);
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.state).toMatchObject({ phase: 'ready', rows: [fresh], refreshError: null, readNo: 3 }));
});
