// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { CommandResult } from '@tm8/contract';
import { PANEL_PRIMARY_ACTIONS, usePanelPrimaries } from './usePanelPrimaries';

/**
 * THE DISPATCHER, on its own. `panels.test.tsx` proves the button calls
 * `onAction`; this proves `onAction` reaches the seam — the other half of the
 * defect, and the half a rendering test cannot see.
 */

const OK = { ok: true } as unknown as CommandResult;

function seamWith(terminate: ReturnType<typeof vi.fn>) {
  return { commands: { terminate } } as unknown as Parameters<typeof usePanelPrimaries>[0]['seam'];
}

describe('usePanelPrimaries', () => {
  it('terminate sends execution.terminate for THAT entity, then reconciles', async () => {
    const terminate = vi.fn().mockResolvedValue(OK);
    const reconcileCommand = vi.fn();
    const { result } = renderHook(() =>
      usePanelPrimaries({ seam: seamWith(terminate), reconcileCommand }),
    );

    act(() => result.current.forEntity('sess-1')?.('terminate'));

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate.mock.calls[0]?.[0]).toBe('sess-1');
    // A per-command mutation id, or the optimistic journal collides two kills.
    expect(String(terminate.mock.calls[0]?.[1]?.clientMutationId)).toContain('terminate:sess-1:');
    await waitFor(() => expect(reconcileCommand).toHaveBeenCalledWith(OK));
  });

  it('the node refusal reaches the host VERBATIM, never a generic failure', async () => {
    const terminate = vi.fn().mockRejectedValue(new Error('session already exited'));
    const onError = vi.fn();
    const { result } = renderHook(() =>
      usePanelPrimaries({ seam: seamWith(terminate), onError }),
    );

    act(() => result.current.forEntity('sess-1')?.('terminate'));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    const [verb, entityId, error] = onError.mock.calls[0]!;
    expect(verb).toBe('terminate');
    expect(entityId).toBe('sess-1');
    expect((error as Error).message).toBe('session already exited');
  });

  it('a verb outside wiredActions sends NOTHING — the switch has no default arm', () => {
    const terminate = vi.fn().mockResolvedValue(OK);
    const { result } = renderHook(() => usePanelPrimaries({ seam: seamWith(terminate) }));

    // `add-child` is a real panel primary on doc and channel with no executor.
    // Reaching this dispatcher at all would already be a bug; absorbing it
    // silently INTO a terminate would be a much worse one.
    act(() => result.current.forEntity('doc-1')?.('add-child'));
    expect(terminate).not.toHaveBeenCalled();
    expect(PANEL_PRIMARY_ACTIONS).not.toContain('add-child');
  });

  it('NO SEAM ⇒ no dispatcher, so the panel refuses instead of drawing a dead button', () => {
    // GraphScreen's port makes `seam` optional. Returning a no-op function
    // here would render the verb ENABLED over a command that can never be
    // sent — the exact enabled-inert lie this whole change removes.
    const { result } = renderHook(() => usePanelPrimaries({}));
    expect(result.current.forEntity('sess-1')).toBeUndefined();
  });

  it('the terminate the ✕ calls and the one the button calls are ONE function', () => {
    // The list tile's ✕ worked and the panel button did not. Two code paths
    // would let them drift apart again; this pins them to the same executor.
    const terminate = vi.fn().mockResolvedValue(OK);
    const { result } = renderHook(() => usePanelPrimaries({ seam: seamWith(terminate) }));

    act(() => result.current.terminate('sess-1'));
    act(() => result.current.forEntity('sess-2')?.('terminate'));

    expect(terminate.mock.calls.map((call) => call[0])).toEqual(['sess-1', 'sess-2']);
  });
});
