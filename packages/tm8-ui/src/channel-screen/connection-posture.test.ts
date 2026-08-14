/**
 * @vitest-environment jsdom
 *
 * `renderHook` needs a document. This file is `.test.ts` rather than `.test.tsx`
 * because it contains no JSX, and the config keys jsdom off the extension.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canSendUnder,
  DEGRADED_SETTLE_MS,
  postureOf,
  useSettledPosture,
} from './connection-posture';

/**
 * The bug this file pins shut: the composer collapsed `offline` and `polling`
 * into one boolean, printed "You're offline — nothing is reaching the node"
 * over both, and withdrew Send on both. For `polling` every part of that is
 * wrong — the node IS answering (over HTTP, which is the transport a send
 * uses), so the sentence is false and the refusal denies a write that would
 * have succeeded.
 */
describe('postureOf — offline and polling are different facts', () => {
  it('maps offline to offline and polling to degraded, never to each other', () => {
    expect(postureOf({ phase: 'offline', disconnectedSince: 'x' })).toBe('offline');
    expect(postureOf({ phase: 'polling', disconnectedSince: 'x' })).toBe('degraded');
  });

  it('treats live, connecting and an absent reading as ready', () => {
    expect(postureOf({ phase: 'live' })).toBe('ready');
    // `connecting` is the first socket, before it has opened OR failed. It is
    // not yet evidence of anything, and warning on it would put a notice on
    // every cold start.
    expect(postureOf({ phase: 'connecting' })).toBe('ready');
    expect(postureOf(undefined)).toBe('ready');
  });

  it('withdraws Send ONLY when the write cannot leave the browser', () => {
    expect(canSendUnder('offline')).toBe(false);
    // THE REGRESSION GUARD. `messages.post` is an ordinary HTTP write, and
    // `polling` is positive evidence that HTTP reaches the node — so a send
    // under it succeeds. Disabling it refused something the product can do.
    expect(canSendUnder('degraded')).toBe(true);
    expect(canSendUnder('ready')).toBe(true);
  });
});

describe('useSettledPosture — the flicker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holds `degraded` back until it has persisted', () => {
    const { result, rerender } = renderHook(({ p }) => useSettledPosture(p), {
      initialProps: { p: 'ready' as const },
    });
    expect(result.current).toBe('ready');

    rerender({ p: 'degraded' as never });
    // Not yet — a socket that opens and dies cycles live→polling→live in about
    // half a second (handleOpen resets reconnectAttempt to backoffBaseMs), and
    // mirroring that directly is what strobed the composer.
    expect(result.current).toBe('ready');

    act(() => void vi.advanceTimersByTime(DEGRADED_SETTLE_MS));
    expect(result.current).toBe('degraded');
  });

  it('never shows a degraded blip that resolves before it settles', () => {
    const { result, rerender } = renderHook(({ p }) => useSettledPosture(p), {
      initialProps: { p: 'ready' as const },
    });
    rerender({ p: 'degraded' as never });
    act(() => void vi.advanceTimersByTime(DEGRADED_SETTLE_MS / 2));
    rerender({ p: 'ready' as never });
    act(() => void vi.advanceTimersByTime(DEGRADED_SETTLE_MS * 2));
    // The whole point: one full cycle of the flicker produces NO visible change.
    expect(result.current).toBe('ready');
  });

  it('applies `offline` IMMEDIATELY — the delay is for advisories only', () => {
    const { result, rerender } = renderHook(({ p }) => useSettledPosture(p), {
      initialProps: { p: 'ready' as const },
    });
    rerender({ p: 'offline' as never });
    // No timer advance. `offline` withdraws Send, and a control that stayed
    // live for three seconds after the write became impossible would invite
    // exactly the send that cannot succeed.
    expect(result.current).toBe('offline');
  });

  it('recovers immediately — good news is never delayed', () => {
    const { result, rerender } = renderHook(({ p }) => useSettledPosture(p), {
      initialProps: { p: 'ready' as const },
    });
    rerender({ p: 'degraded' as never });
    act(() => void vi.advanceTimersByTime(DEGRADED_SETTLE_MS));
    expect(result.current).toBe('degraded');

    rerender({ p: 'ready' as never });
    // Asymmetric on purpose: bad news waits to be confirmed, good news lands at
    // once, so this can only ever make the UI quieter — never staler.
    expect(result.current).toBe('ready');
  });
});
