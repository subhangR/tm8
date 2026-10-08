// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useGameIdentitySignal } from './identity-lifetime';
afterEach(cleanup);

describe('Game identity cancellation', () => {
  it('survives StrictMode replay, aborts old account/space/server signals and cancels on final unmount', async () => {
    const server = {}, nextServer = {};
    let signal!: AbortSignal;
    function Host({ space = 'space', member = 'member', account = 'account', node = server }) {
      signal = useGameIdentitySignal(node, space, member, account);
      return null;
    }
    const screen = render(<StrictMode><Host /></StrictMode>);
    await act(async () => {});
    expect(signal.aborted).toBe(false);
    const original = signal;
    screen.rerender(<StrictMode><Host account="next-account" /></StrictMode>);
    await act(async () => {});
    expect(original.aborted).toBe(true); expect(signal.aborted).toBe(false);
    const second = signal;
    screen.rerender(<StrictMode><Host account="next-account" space="next-space" node={nextServer} /></StrictMode>);
    await act(async () => {});
    expect(second.aborted).toBe(true); expect(signal.aborted).toBe(false);
    screen.unmount(); await act(async () => {});
    expect(signal.aborted).toBe(true);
  });
});
