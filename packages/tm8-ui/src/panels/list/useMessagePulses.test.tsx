// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableWorkspaceEvent } from '@tm8/contract';

import {
  MAX_CONCURRENT_PULSES,
  useMessagePulses,
  type MessagePulseSeamPort,
} from './useMessagePulses';

function messageEvent(seq: number): DurableWorkspaceEvent {
  return {
    type: 'message.created',
    spaceId: 'space-1',
    seq,
    occurredAt: '2026-09-04T12:00:00.000Z',
    schemaVersion: 1,
    anchorId: 'receiver',
    sourceWorkSessionId: 'sender',
    message: { id: `message-${seq}` },
  } as DurableWorkspaceEvent;
}

function harness(): {
  seam: MessagePulseSeamPort;
  emit: (event: DurableWorkspaceEvent) => void;
  listeners: Set<(event: DurableWorkspaceEvent) => void>;
  off: ReturnType<typeof vi.fn>;
} {
  const listeners = new Set<(event: DurableWorkspaceEvent) => void>();
  const off = vi.fn();
  return {
    listeners,
    off,
    seam: {
      onEvent(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          off();
        };
      },
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useMessagePulses', () => {
  it('caps concurrent motion and drops the oldest arrivals', () => {
    vi.useFakeTimers();
    const h = harness();
    const view = renderHook(() => useMessagePulses(h.seam));

    act(() => {
      for (let seq = 1; seq <= MAX_CONCURRENT_PULSES + 3; seq += 1) {
        h.emit(messageEvent(seq));
      }
    });

    expect(view.result.current).toHaveLength(MAX_CONCURRENT_PULSES);
    expect(view.result.current[0]?.key).toBe('message-4');
    expect(view.result.current.at(-1)?.key).toBe(`message-${MAX_CONCURRENT_PULSES + 3}`);
    view.unmount();
  });

  it('unsubscribes and clears every pending expiry on unmount', () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const h = harness();
    const view = renderHook(() => useMessagePulses(h.seam));

    act(() => h.emit(messageEvent(1)));
    expect(h.listeners.size).toBe(1);
    view.unmount();

    expect(h.listeners.size).toBe(0);
    expect(h.off).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalled();
    act(() => vi.runAllTimers());
    clear.mockRestore();
  });
});
