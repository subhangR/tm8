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
import { act, fireEvent, waitFor } from '@testing-library/react';
import type { ExecutionSpawnInput } from '@tm8/contract';

import { answer, item, MEMORIES, okGroup, pendingPort } from '../jev/test-support';
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

    // The press, while Jev is still asking: Launch, then the preview's Launch.
    fireEvent.click(view.getByTestId('nsx-send'));
    await act(async () => { fireEvent.click(await view.findByTestId('lcd3-preview-confirm')); });
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
