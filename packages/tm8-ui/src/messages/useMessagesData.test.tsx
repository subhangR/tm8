// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { CollectionQuery, CollectionResult, DurableWorkspaceEvent, EntitySummary, SpaceId } from '@tm8/contract';
import { useMessagesData, type MessagesSeamPort } from './useMessagesData';

/**
 * The hook's live wiring, which the pure model tests cannot reach: the flat
 * reading must land in a space where messages keep arriving.
 */

const SPACE = 'sp-1' as SpaceId;

function conversation(id: string): EntitySummary {
  return {
    id,
    spaceId: SPACE,
    kind: 'task',
    title: `Conversation ${id}`,
    activityAt: '2026-08-01T10:00:00.000Z',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    deletedAt: null,
    counters: { messages: 1 },
    state: { kind: 'task' },
  } as unknown as EntitySummary;
}

function result(items: EntitySummary[]): CollectionResult {
  return { page: { items, nextCursor: null } } as unknown as CollectionResult;
}

function harness() {
  let emit: ((event: DurableWorkspaceEvent) => void) | null = null;
  const flatReads: Array<(value: CollectionResult) => void> = [];
  /** Off: a message query is the conversation page's previews, answered at
   *  once. On: it is the flat reading, held open until the test lands it. */
  let holdMessageReads = false;
  const query = vi.fn((input: CollectionQuery): Promise<CollectionResult> => {
    if (!input.kinds) return Promise.resolve(result([conversation('ent-1')]));
    if (!holdMessageReads) return Promise.resolve(result([]));
    return new Promise((resolve) => flatReads.push(resolve));
  });
  const seam = {
    query,
    feed: vi.fn(),
    onEvent: (cb: (event: DurableWorkspaceEvent) => void) => { emit = cb; return () => { emit = null; }; },
    onConnection: () => () => undefined,
    onResync: () => () => undefined,
    getConnection: () => ({ phase: 'live' }),
    commands: { postMessage: vi.fn() },
  } as unknown as MessagesSeamPort;
  return {
    seam,
    flatReads,
    holdMessageReads: () => { holdMessageReads = true; },
    emit: (event: DurableWorkspaceEvent) => emit?.(event),
  };
}

describe('useMessagesData — the flat reading', () => {
  it('lands even when a message arrives on a shown conversation while it is in flight', async () => {
    const h = harness();
    const { result: hook } = renderHook(() => useMessagesData(h.seam, SPACE));
    await waitFor(() => expect(hook.current.conversations).toHaveLength(1));

    h.holdMessageReads();
    act(() => hook.current.setMode('all'));
    await waitFor(() => expect(h.flatReads).toHaveLength(1));

    act(() => h.emit({
      type: 'message.created',
      anchorId: 'ent-1',
      message: {
        id: 'msg-9',
        createdAt: '2026-08-01T11:00:00.000Z',
        state: { kind: 'message', anchorId: 'ent-1' },
        content: { body: 'new' },
      },
    } as unknown as DurableWorkspaceEvent));
    await act(async () => { h.flatReads[0]!(result([])); });

    // One read, and it landed: the event did not cancel and re-issue it.
    expect(h.flatReads).toHaveLength(1);
    expect(hook.current.allMessages).toEqual([]);
  });
});
