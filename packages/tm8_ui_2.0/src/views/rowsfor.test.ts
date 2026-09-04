// @vitest-environment jsdom
/**
 * THE CALL, not the declaration, the data, or the executor (D57's fifth layer).
 *
 * `rowsFor` declared `(filter: unknown)` and its implementation never bound the
 * parameter, so every tier received the same pre-hydrated array: four sessions
 * rendered as twelve, one set counted three times, and the seam's executor
 * clause could never run because nothing invoked it with a filter.
 *
 * Four green verifications sat around that hole and none could see it:
 *   · the DECLARATION type-checks — `(filter: unknown)` promises acceptance,
 *     and an implementation ignoring its argument is type-legal, so tsc is
 *     structurally blind;
 *   · the DATA (tier definitions) was correct;
 *   · the EXECUTOR implemented the clause, with its own passing test calling
 *     the seam directly;
 *   · the PANELS passed, injecting their own `rowsFor` and exercising their
 *     call rather than the shell's.
 * The gap was exactly BETWEEN the two suites that were both green. An executor
 * that is never invoked with the filter is indistinguishable, from every one of
 * those checks, from one that ignores it.
 *
 * So this test asserts the one thing none of them could: that a filter handed
 * to `rowsFor` DISCRIMINATES — different filters must yield different rows.
 */
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGateData } from './useGateData';

describe('rowsFor passes its filter to the seam (D57 — the CALL)', () => {
  it('different filters return different rows', async () => {
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session' }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    // Re-derive from result.current on every read: the hook returns a fresh
    // closure per render, and holding one captures a stale `rows` snapshot
    // that can never observe hydration landing.
    const read = (f?: unknown) => result.current.rowsFor('work_session')(f);

    const all = read();
    await waitFor(() => expect(read().length).toBeGreaterThan(0));

    // Two disjoint status partitions. If the filter never reaches the seam,
    // BOTH return the same array as `all` — precisely the defect, and
    // precisely what "four shown as twelve" looked like on screen.
    read({ sessionStatus: ['running'] });
    read({ sessionStatus: ['exited'] });
    await waitFor(() => {
      const running = read({ sessionStatus: ['running'] });
      const exited = read({ sessionStatus: ['exited'] });
      expect(running.length + exited.length).toBeGreaterThan(0);
      // The discriminating assertion: the partitions are not the same set, and
      // neither is simply the whole list handed back.
      expect(running).not.toEqual(exited);
      expect(running.length).toBeLessThan(read().length);
    });
  });

  it('caches per (kind, filter) — the same filter does not re-key', async () => {
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session' }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    const read = (f?: unknown) => result.current.rowsFor('work_session')(f);
    read({ sessionStatus: ['running'] });
    await waitFor(() => expect(read({ sessionStatus: ['running'] }).length).toBeGreaterThan(0));

    // The same filter must not re-key: an order-dependent key would silently
    // create two cache rows for one filter and two reads for one question.
    const a = read({ sessionStatus: ['running'] });
    const b = read({ sessionStatus: ['running'] });
    expect(a).toBe(b);
  });

  it('returns an EMPTY set for an unhydrated key, not the unfiltered list', async () => {
    // The honest miss. Returning the cached unfiltered array on a miss is what
    // made three tiers identical — "not loaded yet" and "everything" must never
    // be the same value.
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session' }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    const first = result.current.rowsFor('work_session')({ sessionStatus: ['zzz-none'] });
    expect(first).toEqual([]);
  });
});
