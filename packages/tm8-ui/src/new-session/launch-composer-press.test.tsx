// @vitest-environment jsdom
/**
 * THE PRESS AND JEV (lane E of "Tm8 Session Launch Improvements").
 *
 * Jev never holds Launch, and an answer that lands while a launch is on its
 * way is HELD — never applied under it. If the node refuses the launch and
 * the card stays up, the held answer is shown as if it had just landed: a
 * refused launch must not cost the person the ask.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import type { ExecutionSpawnInput, LaunchDefaultsResult } from '@tm8/contract';

import { LAUNCH_DEFAULTS, LAUNCH_REFERENCE_CANDIDATES } from '../views/launch-fixtures';
import type { LoadLaunchDefaults } from '../launch-selection';

import { answer, item, MEMORIES, okGroup, pendingPort } from '../jev/test-support';
import { DETACH_AFTER_MS } from './LaunchComposerPopup';
import { renderPopup } from './launch-test-kit';

beforeEach(() => { localStorage.clear(); });

/* Two suggested memories that are not defaults of the fixture launch, so an applied answer shows as "✦ 2". */
const JEV_MEMORIES = okGroup({
  ...MEMORIES,
  items: [item('mem-a', 'memory', 2.8, true), item('mem-b', 'memory', 1.9, true)],
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('Jev at the press', () => {
  it('Launch is not held while Jev is asking', async () => {
    const port = pendingPort();
    const view = renderPopup({ jev: port });
    await view.ready();
    await act(async () => { fireEvent.click(view.getByTestId('lcd3-jev')); });
    expect(view.getByTestId('lcd3-jev').getAttribute('data-status')).toBe('busy');
    expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false');
  });

  it('an answer landing while the launch is on its way is held; when the node REFUSES it, the answer is shown after all', async () => {
    const port = pendingPort();
    const spawn = deferred();
    const onSpawn = vi.fn((_input: ExecutionSpawnInput) => spawn.promise);
    const view = renderPopup({ jev: port, onSpawn });
    await view.ready();
    await act(async () => { fireEvent.click(view.getByTestId('lcd3-jev')); });

    // The press, while Jev is still asking: Launch commits on the first press.
    await act(async () => { fireEvent.click(view.getByTestId('nsx-send')); });
    expect(onSpawn).toHaveBeenCalledTimes(1);
    // The groups still asking at the press ride the spawn as `jev-pending`.
    expect(onSpawn.mock.calls[0]![0].selectionReasons?.memories).toBe('jev-pending');

    // Jev answers while the launch is on its way: held, nothing applied under it.
    await act(async () => { port.calls[0]!.resolve(answer(port.calls[0]!.input, { memories: JEV_MEMORIES })); });
    expect(view.queryByTestId('lcd3-group-memory')?.textContent ?? '').not.toMatch(/✦/);

    // The node refuses: the card stays, and the answer is shown — the person does not pay to ask again.
    await act(async () => { spawn.reject(Object.assign(new Error('No session slots free.'), { code: 'invalid_input' })); });
    await waitFor(() => expect(view.getByTestId('lcd3-group-memory').textContent).toMatch(/✦ 2/));
    expect(port.calls).toHaveLength(1);
  });
});

describe('Jev and a DETACHED press', () => {
  it('stays held while the detached press is unsettled; a refusal releases it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const port = pendingPort();
      const spawn = deferred();
      const onDetachedRefusal = vi.fn();
      const view = renderPopup({ jev: port, onSpawn: () => spawn.promise, onDetachedRefusal });
      await view.ready();
      await act(async () => { fireEvent.click(view.getByTestId('lcd3-jev')); });
      await act(async () => { fireEvent.click(view.getByTestId('nsx-send')); });
      await view.findByTestId('lcd3-launching');

      // Detached mid-flight (this host keeps the popup mounted), then Jev answers: still held.
      act(() => { vi.advanceTimersByTime(DETACH_AFTER_MS); });
      fireEvent.click(view.getByTestId('lcd3-detach'));
      expect(view.onDismiss).toHaveBeenCalledTimes(1);
      await act(async () => { port.calls[0]!.resolve(answer(port.calls[0]!.input, { memories: JEV_MEMORIES })); });
      expect(view.queryByTestId('lcd3-group-memory')?.textContent ?? '').not.toMatch(/✦/);

      // It settles as refused: the refusal goes to the host and the held answer is shown.
      await act(async () => { spawn.reject(Object.assign(new Error('No session slots free.'), { code: 'invalid_input' })); });
      await waitFor(() => expect(onDetachedRefusal).toHaveBeenCalledWith('No session slots free.'));
      await waitFor(() => expect(view.getByTestId('lcd3-group-memory').textContent).toMatch(/✦ 2/));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Jev after a timeout that found the session', () => {
  it('the card stays up and ✦ keeps working: the held answer is shown', async () => {
    const port = pendingPort();
    const spawn = deferred();
    const view = renderPopup({
      jev: port,
      onSpawn: () => spawn.promise,
      sessionsSince: async () => [{ id: 's-1', title: 'Wire the launch flow' }],
    });
    await view.ready();
    await act(async () => { fireEvent.click(view.getByTestId('lcd3-jev')); });
    await act(async () => { fireEvent.click(view.getByTestId('nsx-send')); });
    await act(async () => { port.calls[0]!.resolve(answer(port.calls[0]!.input, { memories: JEV_MEMORIES })); });
    await act(async () => { spawn.reject(Object.assign(new Error('the node did not answer within 30s'), { code: 'upstream_unavailable' })); });
    await waitFor(() => expect(view.getByTestId('lcd3-group-memory').textContent).toMatch(/✦ 2/));
  });
});

describe('defaults the node could not confirm', () => {
  it('the card offers the Retry it asks for: refusal → Retry → unblocked, the edit intact', async () => {
    const pending: Array<{ resolve(r: LaunchDefaultsResult): void; reject(e: unknown): void }> = [];
    const read = vi.fn(() => new Promise<LaunchDefaultsResult>((resolve, reject) => { pending.push({ resolve, reject }); }));
    const load: LoadLaunchDefaults = Object.assign(read, { peek: () => LAUNCH_DEFAULTS });
    const view = renderPopup({ selection: { load, candidates: { references: [...LAUNCH_REFERENCE_CANDIDATES] } } });
    await view.ready();
    // Untick the cached doc default, then the confirming read fails.
    const menu = await view.openGroup('doc');
    fireEvent.click(within(within(menu).getByTestId('lcd3-row-ent-doc-spec')).getByRole('menuitemcheckbox'));
    await act(async () => { pending.shift()!.reject(new Error('503')); });

    const send = view.getByTestId('nsx-send');
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(send.getAttribute('title')).toMatch(/Couldn’t confirm this launch’s references defaults/);
    fireEvent.click(view.getByTestId('launch-defaults-retry'));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => { pending.shift()!.resolve(LAUNCH_DEFAULTS); });

    await waitFor(() => expect(view.getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('false'));
    expect(view.queryByTestId('launch-defaults-retry')).toBeNull();
    // The edit is intact: the unticked default stays off the card (present-only, lane A)
    // and waits under Attach → Suggested, one click from coming back.
    expect(view.queryByTestId('lcd3-group-doc')).toBeNull();
    await act(async () => { fireEvent.click(view.getByTestId('lcd3-attach')); });
    expect(view.getByTestId('lcd3-attach-suggested-ent-doc-spec')).toBeTruthy();
  });
});
