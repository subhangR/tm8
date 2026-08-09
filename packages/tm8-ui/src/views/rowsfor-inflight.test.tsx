// @vitest-environment jsdom
/**
 * A cache MISS is one network read, including the time BETWEEN dispatch and
 * response.
 *
 * The original miss queue was cleared as soon as its effect dispatched the
 * reads. A response from one filtered band then re-rendered the screen while
 * the other bands were still unresolved. Those unresolved keys looked like
 * fresh misses and were dispatched again. With several bands answering in
 * turn, each response re-armed its siblings and the browser issued hundreds
 * of successful `collections.query` calls before exhausting its own network
 * resources.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CollectionQuery } from '@tm8/contract';
import { createFixtureSeam } from '../data';
import { useGateData } from './useGateData';

const RUNNING = { sessionStatus: ['running'] };
const EXITED = { sessionStatus: ['exited'] };

function filterKey(filter: unknown): string {
  return JSON.stringify(filter);
}

describe('rowsFor keeps a cache miss claimed while its query is in flight', () => {
  it('does not re-dispatch an unresolved sibling when another band answers', async () => {
    const seam = createFixtureSeam();
    const query = seam.query.bind(seam);
    const calls = new Map<string, number>();
    const releases = new Map<string, Array<() => void>>();

    seam.query = async (input: CollectionQuery) => {
      if (input.filters === undefined) return query(input);

      const key = filterKey(input.filters);
      calls.set(key, (calls.get(key) ?? 0) + 1);
      await new Promise<void>((resolve) => {
        const pending = releases.get(key) ?? [];
        pending.push(resolve);
        releases.set(key, pending);
      });
      return query(input);
    };

    const { result, unmount } = renderHook(() => {
      const data = useGateData({
        leftKind: 'task',
        rightKind: 'work_session',
        seam,
      });

      // Called FROM RENDER, as EntityListPanel calls every lifecycle band.
      // That is the production condition: every response re-renders these
      // reads while their siblings may still be unresolved.
      const running = data.rowsFor('work_session')(RUNNING);
      const exited = data.rowsFor('work_session')(EXITED);
      const runningPage = data.pageStateOf('work_session')(RUNNING);
      return { data, running, exited, runningPage };
    });

    await waitFor(() => expect(result.current.data.ready).toBe(true));
    await waitFor(() => {
      expect(calls.get(filterKey(RUNNING))).toBe(1);
      expect(calls.get(filterKey(EXITED))).toBe(1);
    });

    await act(async () => {
      for (const release of releases.get(filterKey(RUNNING)) ?? []) release();
    });
    await waitFor(() => expect(result.current.runningPage.loading).toBe(false));

    // The exited request is STILL unresolved. The running response updated
    // both the entity store and row cache, so at least one full render/effect
    // pass occurred. It must not have mistaken the sibling for a new miss.
    expect(calls.get(filterKey(EXITED))).toBe(1);

    unmount();
    seam.dispose();
  });
});
