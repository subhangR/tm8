// @vitest-environment jsdom
/**
 * THE LEDGER'S `N live` FOLLOWS THE SEAM'S SNAPSHOT (L4's finding).
 *
 * The surface memoised `livenessOf` on the seam alone and nothing subscribed
 * to `liveness.onChange`, so a consumer that listed it as an input never asked
 * again: `2 live` after both workers had exited.
 */
import { act, render, renderHook } from '@testing-library/react';
import { useMemo } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionLiveness } from '../data/seam';
import { useLivenessOf, type LivenessOf } from './use-liveness-of';

function fakeLiveness(initial: SessionLiveness) {
  let verdict = initial;
  const listeners = new Set<() => void>();
  return {
    liveness: {
      onChange: vi.fn((cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      }),
      statusOf: vi.fn(() => verdict),
    },
    /** A fresh snapshot lands with a different verdict. */
    publish(next: SessionLiveness) {
      verdict = next;
      for (const cb of listeners) cb();
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
  const livenessOf = useLivenessOf(liveness as never);
  return <LiveCount livenessOf={livenessOf} />;
}

describe('useLivenessOf', () => {
  it('re-asks the seam when a new liveness snapshot lands', () => {
    const fake = fakeLiveness('live' as SessionLiveness);
    const view = render(<Host liveness={fake.liveness} />);
    expect(view.getByTestId('live').textContent).toBe('2 live');
    act(() => fake.publish('exited' as SessionLiveness));
    expect(view.getByTestId('live').textContent).toBe('0 live');
  });

  it('keeps one identity between snapshots and unsubscribes on unmount', () => {
    const fake = fakeLiveness('live' as SessionLiveness);
    const hook = renderHook(() => useLivenessOf(fake.liveness as never));
    const first = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(first);
    expect(fake.listeners.size).toBe(1);
    hook.unmount();
    expect(fake.listeners.size).toBe(0);
  });
});
