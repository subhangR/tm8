// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { CommandResult, ContainersCreateInput, SpaceId } from '@tm8/contract';
import { NEW_CONTAINER_ACTIONS, useNewContainerSheet } from './useNewContainerSheet';
import { composeListActions } from './useChatAbout';

/**
 * THE BIRTH SHEET'S HOST STATE — and specifically THE MODAL OBLIGATIONS,
 * asserted rather than left to be inferred from a comment.
 *
 * Both come from `useLaunchSheet`, which documents what a sheet owes the shell.
 * They are the reason this hook exists at all rather than a `useState` in each
 * host, so they are what this file is mostly about:
 *
 *   1. **Esc must not fall through.** The keyboard contract's modal layer
 *      engages only when the shell DECLARES a modal. Undeclared, Esc reaches
 *      layer 5 and pops the panel underneath — the viewer dismisses a sheet
 *      and silently loses the panel behind it. Invisible in any test that does
 *      not open a sheet first, which is why it is tested here.
 *   2. **Orphan clearing**, in its space-shaped form. This sheet has no
 *      subject entity, so `useLaunchSheet`'s `hostedIds` check has nothing to
 *      guard; the analogous hazard is a SPACE switch leaving the sheet
 *      configuring a container for a graph the viewer has left.
 */

const SPACE = 'sp-atelier' as SpaceId;
const OK: CommandResult = { patches: [] };

function mk(over: Partial<Parameters<typeof useNewContainerSheet>[0]> = {}) {
  const createContainer = vi.fn(async (_i: ContainersCreateInput) => OK);
  const setKeyboardContext = vi.fn();
  const host = {
    spaceId: SPACE,
    seam: { commands: { createContainer } } as never,
    setKeyboardContext,
    ...over,
  };
  return { host, createContainer, setKeyboardContext };
}

describe('OBLIGATION 1 — the shell is told a modal is open', () => {
  it('declares modalDepth on open and takes it back on close', () => {
    const { host, setKeyboardContext } = mk();
    const { result } = renderHook(() => useNewContainerSheet(host));

    expect(result.current.isModalOpen()).toBe(false);
    act(() => result.current.open());
    expect(result.current.isModalOpen()).toBe(true);
    expect(setKeyboardContext).toHaveBeenLastCalledWith({ modalDepth: 1 });

    act(() => result.current.close());
    expect(result.current.isModalOpen()).toBe(false);
    // BACK TO ZERO, not merely decremented: a depth left at 1 keeps the
    // keyboard contract in modal mode forever, and Esc then does nothing at
    // all — the opposite failure to the one the obligation is about, and just
    // as invisible.
    expect(setKeyboardContext).toHaveBeenLastCalledWith({ modalDepth: 0 });
  });

  it('never drives the depth negative, however many times close is called', () => {
    // A host that closes an already-closed sheet (a scrim click racing an Esc)
    // must not push the depth below zero, or the NEXT open declares 0 and the
    // modal is never announced.
    const { host, setKeyboardContext } = mk();
    const { result } = renderHook(() => useNewContainerSheet(host));
    act(() => { result.current.close(); result.current.close(); });
    act(() => result.current.open());
    expect(setKeyboardContext).toHaveBeenLastCalledWith({ modalDepth: 1 });
  });

  it('works with no keyboard controller installed — it is optional, not required', () => {
    const { host } = mk({ setKeyboardContext: undefined });
    const { result } = renderHook(() => useNewContainerSheet(host));
    act(() => result.current.open());
    expect(result.current.isModalOpen()).toBe(true);
  });
});

describe('OBLIGATION 2 — orphan clearing, in its space-shaped form', () => {
  it('closes when the space changes underneath it', () => {
    /*
     * The sheet is space-scoped, so a space switch would leave it configuring
     * a container for a graph the viewer has left — and it would COMMIT there,
     * because `create` sends the hook's own `spaceId`. Keyed on the space
     * itself rather than on a nav event, so it holds for a hydration from an
     * external hash change that nobody dispatched.
     */
    const { host } = mk();
    const { result, rerender } = renderHook((p: { spaceId: SpaceId }) =>
      useNewContainerSheet({ ...host, spaceId: p.spaceId }), { initialProps: { spaceId: SPACE } });

    act(() => result.current.open());
    expect(result.current.isModalOpen()).toBe(true);

    rerender({ spaceId: 'sp-other' as SpaceId });
    expect(result.current.isModalOpen()).toBe(false);
  });

  it('stays open across a re-render that does NOT change the space', () => {
    // Guard the guard: an effect keyed too loosely would close the sheet on
    // every render, and the symptom would be a sheet that cannot be opened at
    // all — which reads as "the button is broken", not as an over-eager guard.
    const { host } = mk();
    const { result, rerender } = renderHook(() => useNewContainerSheet(host));
    act(() => result.current.open());
    rerender();
    rerender();
    expect(result.current.isModalOpen()).toBe(true);
  });
});

describe('the verb, and what refuses it', () => {
  it('dispatches `new-container` by OPENING, never by committing', () => {
    // The two-clicks-to-launch rule: a container has a profile, a project, a
    // network preset and a lifetime, so the configuration must be visible at
    // the moment it is committed. A verb that created one on click would
    // commit a configuration nobody saw.
    const { host, createContainer } = mk();
    const { result } = renderHook(() => useNewContainerSheet(host));
    act(() => result.current.onAction?.('new-container', ''));
    expect(result.current.isModalOpen()).toBe(true);
    expect(createContainer).not.toHaveBeenCalled();
  });

  it('offers NO dispatcher without a seam, so the control renders refused', () => {
    const { host } = mk({ seam: undefined });
    const { result } = renderHook(() => useNewContainerSheet(host));
    expect(result.current.onAction).toBeUndefined();
  });

  it('offers NO dispatcher without a space — the same rule, the other input', () => {
    const { host } = mk({ spaceId: null });
    const { result } = renderHook(() => useNewContainerSheet(host));
    expect(result.current.onAction).toBeUndefined();
  });

  it('THROWS rather than no-oping if a host calls create with neither', async () => {
    // The `usePanelPrimaries.terminate` posture: unreachable through
    // `onAction`, so a host reaching it directly has wired a control it cannot
    // perform. Absorbing that as a silent no-op is how a dead button survives
    // review.
    const { host } = mk({ seam: undefined });
    const { result } = renderHook(() => useNewContainerSheet(host));
    await expect(result.current.create({} as ContainersCreateInput)).rejects.toThrow(/cannot perform/);
  });
});

describe('committing', () => {
  it('sends the input, reconciles, opens the newborn, and closes', async () => {
    const reconcileCommand = vi.fn();
    const onOpen = vi.fn();
    const created: CommandResult = { patches: [{ id: 'ent-ctr-new-1' } as never] };
    const { host, createContainer } = mk();
    createContainer.mockResolvedValue(created);
    const { result } = renderHook(() => useNewContainerSheet({ ...host, reconcileCommand, onOpen }));

    act(() => result.current.open());
    await act(async () => { await result.current.create({ profile: 'shell' } as ContainersCreateInput); });

    expect(createContainer).toHaveBeenCalledWith({ profile: 'shell' });
    expect(reconcileCommand).toHaveBeenCalledWith(created);
    expect(onOpen).toHaveBeenCalledWith('ent-ctr-new-1');
    expect(result.current.isModalOpen()).toBe(false);
  });

  it('STAYS OPEN on a refusal, and reports it verbatim', async () => {
    /*
     * A sheet that closed on a refusal would take the viewer's whole
     * configuration with it and show the error somewhere else — so the remedy
     * ("confirm the untrusted project", "no provider satisfies this profile")
     * arrives with nothing left to apply it to.
     */
    const onError = vi.fn();
    const { host, createContainer } = mk();
    createContainer.mockRejectedValue(new Error('no provider satisfies profile shell'));
    const { result } = renderHook(() => useNewContainerSheet({ ...host, onError }));

    act(() => result.current.open());
    await act(async () => { await result.current.create({ profile: 'shell' } as ContainersCreateInput); });

    expect(result.current.isModalOpen()).toBe(true);
    expect(onError).toHaveBeenCalledWith('new-container', expect.objectContaining({
      message: 'no provider satisfies profile shell',
    }));
    // And the modal declaration is still standing, so Esc still cannot fall
    // through while the viewer reads the refusal.
    expect(result.current.isModalOpen()).toBe(true);
  });
});

describe('composeListActions — one onAction, two dispatchers', () => {
  it('routes each verb to the part that claims it', () => {
    const birth = vi.fn();
    const terminal = vi.fn();
    const composed = composeListActions([
      { onAction: terminal, wiredActions: ['start-terminal'] },
      { onAction: birth, wiredActions: NEW_CONTAINER_ACTIONS },
    ]);
    composed.onAction('new-container', '');
    composed.onAction('start-terminal', '');
    expect(birth).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    // BOTH verb sets reach the panel. Passing either hook alone would drop the
    // other's verb back to disabled-with-reason — the defect both hooks were
    // extracted to fix, reintroduced by the composition.
    expect([...composed.wiredActions].sort()).toEqual(['new-container', 'start-terminal']);
  });

  it('drops a part with no dispatcher, so its verbs stay refused', () => {
    const composed = composeListActions([
      { onAction: undefined, wiredActions: ['start-terminal'] },
      { onAction: vi.fn(), wiredActions: NEW_CONTAINER_ACTIONS },
    ]);
    expect(composed.wiredActions).toEqual(['new-container']);
  });

  it('carries the entityId through — the signature that made it a separate composer', () => {
    // `composePanelActions` is `(ref) => void`. Reusing it here would compile
    // under a structural rule and silently drop the row id.
    const seen: string[] = [];
    const composed = composeListActions([
      { onAction: (_r, id) => seen.push(id), wiredActions: ['start-terminal'] },
    ]);
    composed.onAction('start-terminal', 'ent-row-7');
    expect(seen).toEqual(['ent-row-7']);
  });
});
