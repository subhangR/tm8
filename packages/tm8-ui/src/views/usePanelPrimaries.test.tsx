// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor, render, fireEvent } from '@testing-library/react';
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

/**
 * SPEC D1 §5.4 / §5.5 — the outcome dialogs the hook owns. A host opts in with
 * `stateOf` and renders `dialog`; Terminate on an OPEN session then asks,
 * and on a settled one it only closes the process.
 */
describe('usePanelPrimaries — Spec D1 outcome verbs', () => {
  const open = { kind: 'work_session', status: 'running' } as never;
  const completed = { kind: 'work_session', status: 'running', outcome: 'completed' } as never;

  function outcomeSeam() {
    const commands = {
      terminate: vi.fn().mockResolvedValue(OK),
      completeSession: vi.fn().mockResolvedValue(OK),
      releaseClaim: vi.fn().mockResolvedValue(OK),
      postMessage: vi.fn().mockResolvedValue({ messageBatchId: 'b', messages: [{ id: 'm-new' }] }),
      resume: vi.fn().mockResolvedValue(OK),
    };
    const seam = {
      commands,
      entity: vi.fn().mockResolvedValue({
        title: 'S',
        state: open,
        connections: { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 },
      }),
      messages: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    } as unknown as Parameters<typeof usePanelPrimaries>[0]['seam'];
    return { seam, commands };
  }

  it('§5.4: Terminate on an OPEN session opens the dialog and sends nothing yet', () => {
    const { seam, commands } = outcomeSeam();
    const { result } = renderHook(() => usePanelPrimaries({ seam, stateOf: () => open }));
    act(() => result.current.terminate('s1'));
    expect(commands.terminate).not.toHaveBeenCalled();
    expect(result.current.dialog).not.toBeNull();
  });

  it('§5.4: on a COMPLETED session Terminate is "Close process" — no dialog, no outcome', () => {
    const { seam, commands } = outcomeSeam();
    const { result } = renderHook(() => usePanelPrimaries({ seam, stateOf: () => completed }));
    act(() => result.current.terminate('s1'));
    expect(result.current.dialog).toBeNull();
    expect(commands.terminate).toHaveBeenCalledTimes(1);
    expect(commands.terminate.mock.calls[0]?.[1]).not.toHaveProperty('outcome');
  });

  it('close-process, dismiss-session and mark-lost send the terminate each one means', () => {
    const { seam, commands } = outcomeSeam();
    const { result } = renderHook(() => usePanelPrimaries({ seam, stateOf: () => open }));
    act(() => result.current.sessionVerb('close-process', 's1'));
    act(() => result.current.sessionVerb('dismiss-session', 's2'));
    act(() => result.current.sessionVerb('mark-lost', 's3'));
    const inputs = commands.terminate.mock.calls.map((c: unknown[]) => [c[0], c[1]]);
    expect(inputs[0]?.[1]).not.toHaveProperty('outcome');
    expect(inputs[1]?.[1]).toMatchObject({ outcome: 'stop' });
    expect(inputs[2]?.[1]).toMatchObject({ markLost: true });
  });

  it('complete-session is wired only for a host that renders the dialogs', () => {
    const { seam } = outcomeSeam();
    expect(renderHook(() => usePanelPrimaries({ seam })).result.current.wiredActions).not.toContain('complete-session');
    expect(renderHook(() => usePanelPrimaries({ seam, stateOf: () => open })).result.current.wiredActions)
      .toContain('complete-session');
  });

  it('§5.3 bulk: Stop all finished closes each process; Complete all completes each with its latest receipt', () => {
    const { seam, commands } = outcomeSeam();
    const { result } = renderHook(() => usePanelPrimaries({ seam, stateOf: () => open }));
    act(() => result.current.sessionBulk('stop-all-finished', ['a', 'b']));
    expect(commands.terminate).toHaveBeenCalledTimes(2);
    act(() => result.current.sessionBulk('complete-all', ['c']));
    expect(commands.completeSession).toHaveBeenCalledTimes(1);
    expect(commands.completeSession.mock.calls[0]?.[1]).not.toHaveProperty('receiptMessageId');
  });

  it('scenario 6 end to end: Terminate → "Stop without completing" sends outcome stop', async () => {
    const { seam, commands } = outcomeSeam();
    let api: ReturnType<typeof usePanelPrimaries> | null = null;
    function Host() {
      api = usePanelPrimaries({ seam, stateOf: () => open });
      return <>{api.dialog}</>;
    }
    const view = render(<Host />);
    act(() => api!.terminate('s1'));
    fireEvent.click(await view.findByTestId('session-terminate-dialog-stop'));
    await waitFor(() => expect(commands.terminate).toHaveBeenCalledTimes(1));
    expect(commands.terminate.mock.calls[0]?.[1]).toMatchObject({ outcome: 'stop' });
    await waitFor(() => expect(view.queryByTestId('session-terminate-dialog')).toBeNull());
  });

  it('scenario 13 end to end: a written receipt is posted on the session first, then completes with its id', async () => {
    const { seam, commands } = outcomeSeam();
    let api: ReturnType<typeof usePanelPrimaries> | null = null;
    function Host() {
      api = usePanelPrimaries({ seam, stateOf: () => open });
      return <>{api.dialog}</>;
    }
    const view = render(<Host />);
    act(() => api!.completeSession('s1'));
    fireEvent.change(await view.findByTestId('session-receipt-text'), { target: { value: 'All done.' } });
    fireEvent.click(view.getByTestId('session-complete-dialog-go'));
    await waitFor(() => expect(commands.completeSession).toHaveBeenCalledTimes(1));
    expect(commands.postMessage.mock.calls[0]?.[0]).toMatchObject({ anchorIds: ['s1'], body: 'All done.' });
    expect(commands.completeSession.mock.calls[0]?.[1]).toMatchObject({ receiptMessageId: 'm-new', closeProcess: true });
  });

  it('Q2 = B: Reopen on a completed session asks first ("its receipt stays in history"), then resumes', async () => {
    const { seam, commands } = outcomeSeam();
    let api: ReturnType<typeof usePanelPrimaries> | null = null;
    function Host() {
      api = usePanelPrimaries({ seam, stateOf: () => completed });
      return <>{api.dialog}</>;
    }
    const view = render(<Host />);
    act(() => api!.sessionVerb('reopen-session', 's1'));
    const dialog = await view.findByTestId('session-reopen-dialog');
    expect(dialog.textContent).toContain('Reopens this completed session; its receipt stays in history.');
    expect(commands.resume).not.toHaveBeenCalled();
    fireEvent.click(view.getByTestId('session-reopen-dialog-go'));
    await waitFor(() => expect(commands.resume).toHaveBeenCalledTimes(1));
    expect(commands.resume.mock.calls[0]?.[0]).toBe('s1');
    await waitFor(() => expect(view.queryByTestId('session-reopen-dialog')).toBeNull());
  });
});
