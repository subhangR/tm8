// @vitest-environment jsdom
/**
 * THE LEDGER'S `N live` FOLLOWS THE SEAM'S SNAPSHOT (L4's finding).
 *
 * The surface memoised `livenessOf` on the seam alone and nothing subscribed
 * to `liveness.onChange`, so a consumer that listed it as an input never asked
 * again: `2 live` after both workers had exited.
 *
 * AND ONLY WHEN THE ANSWER CAN MOVE (#878 review, F5): a scheduled re-read of
 * the same live set must not re-mint the function and re-run every consumer.
 */
import { act, render, renderHook } from '@testing-library/react';
import { useMemo } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { LivenessSnapshot, SessionLiveness } from '../data/seam';
import { DEFAULT_LIVENESS_CONFIG } from '../data/real/liveness';
import { useLivenessOf, type LivenessOf } from './use-liveness-of';

const SPACE = 'space-a';
const T0 = Date.parse('2026-09-26T10:00:00.000Z');

function snapshot(liveEntityIds: string[], atMs: number, over: Partial<LivenessSnapshot> = {}): LivenessSnapshot {
  return {
    spaceId: SPACE,
    liveEntityIds,
    nodeBootId: 'boot-1',
    checkedAt: new Date(atMs).toISOString(),
    ...over,
  } as LivenessSnapshot;
}

function fakeLiveness(initial: SessionLiveness) {
  let verdict = initial;
  const listeners = new Set<(snap: LivenessSnapshot) => void>();
  return {
    liveness: {
      onChange: vi.fn((cb: (snap: LivenessSnapshot) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      }),
      statusOf: vi.fn(() => verdict),
    },
    /** A fresh snapshot lands; `next` is what `statusOf` answers after it. */
    publish(snap: LivenessSnapshot, next: SessionLiveness = verdict) {
      verdict = next;
      for (const cb of listeners) cb(snap);
    },
    listeners,
  };
}

/** A consumer shaped like the ledger panel: a memo keyed on `livenessOf`. */
function LiveCount({ livenessOf }: { livenessOf: LivenessOf }) {
  const live = useMemo(
    () => ['s1', 's2'].filter((id) => livenessOf({ id, status: 'running' }) === 'live').length,
    [livenessOf],
  );
  return <span data-testid="live">{`${live} live`}</span>;
}

function Host({ liveness }: { liveness: ReturnType<typeof fakeLiveness>['liveness'] }) {
  const livenessOf = useLivenessOf(liveness as never, SPACE);
  return <LiveCount livenessOf={livenessOf} />;
}

/** The hook with a first snapshot already seen, and the identity it settled on. */
function settled() {
  const fake = fakeLiveness('live' as SessionLiveness);
  const hook = renderHook(() => useLivenessOf(fake.liveness as never, SPACE));
  act(() => fake.publish(snapshot(['s1', 's2'], T0)));
  return { fake, hook, first: hook.result.current };
}

describe('useLivenessOf', () => {
  it('re-asks the seam when a new liveness snapshot lands', () => {
    const fake = fakeLiveness('live' as SessionLiveness);
    const view = render(<Host liveness={fake.liveness} />);
    expect(view.getByTestId('live').textContent).toBe('2 live');
    act(() => fake.publish(snapshot(['s1', 's2'], T0)));
    act(() => fake.publish(snapshot([], T0 + 30_000), 'stale' as SessionLiveness));
    expect(view.getByTestId('live').textContent).toBe('0 live');
  });

  it('keeps one identity between snapshots and unsubscribes on unmount', () => {
    const fake = fakeLiveness('live' as SessionLiveness);
    const hook = renderHook(() => useLivenessOf(fake.liveness as never, SPACE));
    const first = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(first);
    expect(fake.listeners.size).toBe(1);
    hook.unmount();
    expect(fake.listeners.size).toBe(0);
  });

  /* HINGES ON: the change check. A scheduled re-read of the SAME live set —
     the 30s cadence, in any order — cannot move a verdict, so it must not
     re-mint the function and re-run every consumer (#878 review, F5). */
  it('keeps its identity when a re-read finds the same live set', () => {
    const { fake, hook, first } = settled();
    act(() => fake.publish(snapshot(['s2', 's1'], T0 + 30_000)));
    act(() => fake.publish(snapshot(['s1', 's2'], T0 + 60_000)));
    expect(hook.result.current).toBe(first);
  });

  it('re-mints when an id joins or leaves the live set', () => {
    const { fake, hook, first } = settled();
    act(() => fake.publish(snapshot(['s1'], T0 + 30_000)));
    expect(hook.result.current).not.toBe(first);
  });

  it('re-mints when the node restarted, even with the same ids', () => {
    const { fake, hook, first } = settled();
    act(() => fake.publish(snapshot(['s1', 's2'], T0 + 30_000, { nodeBootId: 'boot-2' })));
    expect(hook.result.current).not.toBe(first);
  });

  /* The store answers 'unknown' once a snapshot is older than its freshness
     window; a later snapshot with the same ids turns that back into 'live',
     so a gap wider than the window is a change. */
  it('re-mints when the previous snapshot had gone stale before this one', () => {
    const { fake, hook, first } = settled();
    act(() => fake.publish(snapshot(['s1', 's2'], T0 + DEFAULT_LIVENESS_CONFIG.staleAfterMs + 1)));
    expect(hook.result.current).not.toBe(first);
  });

  it('ignores another space’s snapshot', () => {
    const { fake, hook, first } = settled();
    act(() => fake.publish(snapshot(['x9'], T0 + 30_000, { spaceId: 'space-b' as LivenessSnapshot['spaceId'] })));
    expect(hook.result.current).toBe(first);
  });
});
