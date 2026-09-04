// @vitest-environment jsdom
/**
 * P2 — the induced graph's read policy: one `entities.connections` call per
 * seed EVER (R14), settled per seed (R11), nothing re-issued for the set.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { EdgeView, Page } from '@tm8/contract';
import type { ConnectionsReader } from '../session-graph/load';
import { CONNECTIONS_LIMIT, useInducedConnections } from './use-induced-connections';

const A = '01900000-00dd-7000-8000-000000000001';
const B = '01900000-00dd-7000-8000-000000000002';
const C = '01900000-00dd-7000-8000-000000000003';

function harness(behaviour?: (id: string) => Promise<Page<EdgeView>>) {
  const calls: { id: string; limit: number | undefined }[] = [];
  const read: ConnectionsReader = (id, opts) => {
    calls.push({ id, limit: opts?.limit });
    return behaviour
      ? behaviour(id)
      : Promise.resolve({ items: [], nextCursor: null } as unknown as Page<EdgeView>);
  };
  return { calls, read };
}

describe('useInducedConnections', () => {
  it('reads each seed once at the page limit; a NEW seed issues exactly ONE new read', async () => {
    const { calls, read } = harness();
    const { result, rerender } = renderHook(
      ({ ids }: { ids: readonly string[] }) => useInducedConnections(ids, read),
      { initialProps: { ids: [A, B] as readonly string[] } },
    );
    await waitFor(() => expect(result.current.get(B)?.state).toBe('loaded'));
    expect(calls.map((c) => c.id)).toEqual([A, B]);
    expect(calls.every((c) => c.limit === CONNECTIONS_LIMIT)).toBe(true);

    rerender({ ids: [A, B, C] });
    await waitFor(() => expect(result.current.get(C)?.state).toBe('loaded'));
    expect(calls.map((c) => c.id)).toEqual([A, B, C]); // A and B were NOT re-read
  });

  it('R11: one failure marks ONE seed failed and leaves the others loaded', async () => {
    const { calls, read } = harness((id) =>
      id === B
        ? Promise.reject(new Error('403'))
        : Promise.resolve({
            items: [{ id: 'e1' }] as unknown as EdgeView[],
            nextCursor: 'more',
          } as unknown as Page<EdgeView>),
    );
    const { result } = renderHook(() => useInducedConnections([A, B], read));
    await waitFor(() => {
      expect(result.current.get(A)?.state).toBe('loaded');
      expect(result.current.get(B)?.state).toBe('failed');
    });
    const a = result.current.get(A)!;
    expect(a.state === 'loaded' && a.pageCapped).toBe(true); // nextCursor ⇒ degree is a floor
    expect(calls).toHaveLength(2);
  });

  it('without a reader, seeds stay pending-free and unread — no calls, no throw', () => {
    const { result } = renderHook(() => useInducedConnections([A], undefined));
    expect(result.current.get(A)).toBeUndefined();
  });

  it('a re-render with the SAME seed list issues nothing', async () => {
    const { calls, read } = harness();
    const { result, rerender } = renderHook(
      ({ ids }: { ids: readonly string[] }) => useInducedConnections(ids, read),
      { initialProps: { ids: [A] as readonly string[] } },
    );
    await waitFor(() => expect(result.current.get(A)?.state).toBe('loaded'));
    act(() => rerender({ ids: [A] }));
    expect(calls).toHaveLength(1);
  });
});
