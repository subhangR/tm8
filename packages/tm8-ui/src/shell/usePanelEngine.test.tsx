// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import type { NavPort, NavPanelState } from './nav-port';
import { usePanelEngine } from './usePanelEngine';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}` as EntityId;
const ids = (count: number) => Array.from({ length: count }, (_, index) => id(index + 1));

function navFor(state: NavPanelState, applyNormalization = vi.fn()): NavPort {
  return {
    ...state,
    push: vi.fn(),
    pop: vi.fn(),
    close: vi.fn(),
    pin: vi.fn(() => ({ ok: true as const })),
    unpin: vi.fn(),
    promote: vi.fn(),
    applyNormalization,
  };
}

describe('usePanelEngine viewport/authored normalization split (R13)', () => {
  it('keeps width-only demotion presentational: no route write or notice, authored pins intact', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const onNotice = vi.fn();
    const nav = navFor({ stack: [id(9)], pinned: ids(2) });
    const before = window.location.hash;

    const { result } = renderHook(() => usePanelEngine({ nav, centerWidth: 700, onNotice }));

    expect(result.current.visible).toEqual({ stack: [id(9), id(1)], pinned: [id(2)] });
    expect(nav.pinned).toEqual(ids(2));
    expect(nav.applyNormalization).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(before);
    expect(onNotice).not.toHaveBeenCalled();
    replaceState.mockRestore();
  });

  it('applies an over-cap settle exactly once and preserves its demotion notice', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const applyNormalization = vi.fn(() => {
      window.history.replaceState(null, '', '#/settled');
    });
    const onNotice = vi.fn();
    const nav = navFor({ stack: [], pinned: ids(5) }, applyNormalization);

    const { result } = renderHook(() =>
      usePanelEngine({ nav, centerWidth: 100_000, onNotice }),
    );

    await waitFor(() => expect(applyNormalization).toHaveBeenCalledTimes(1));
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(applyNormalization).toHaveBeenCalledWith({ stack: ids(2), pinned: ids(5).slice(2) });
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(result.current.visible).toEqual({ stack: ids(2), pinned: ids(5).slice(2) });
    replaceState.mockRestore();
  });

  it('narrow → wide → narrow keeps the hash byte-identical and never notices', () => {
    const onNotice = vi.fn();
    const nav = navFor({ stack: [id(9)], pinned: ids(2) });
    const before = window.location.hash;
    const { result, rerender } = renderHook(
      ({ width }) => usePanelEngine({ nav, centerWidth: width, onNotice }),
      { initialProps: { width: 700 } },
    );

    expect(result.current.visible.pinned).not.toEqual(nav.pinned);
    rerender({ width: 4_000 });
    expect(result.current.visible).toEqual({ stack: nav.stack, pinned: nav.pinned });
    rerender({ width: 700 });
    expect(result.current.visible.pinned).not.toEqual(nav.pinned);
    expect(window.location.hash).toBe(before);
    expect(nav.applyNormalization).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
  });
});
