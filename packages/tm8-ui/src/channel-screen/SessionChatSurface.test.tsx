// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DurableWorkspaceEvent, EntityFeedPage } from '@tm8/contract';
import { createChatStore } from './chat-store';
import type { SessionChatSeam } from './SessionChatSurface';
import { SessionChatSurface } from './SessionChatSurface';

const SESSION_ID = '01900000-0000-7000-8000-000000000101';
const EMPTY_PAGE: EntityFeedPage = {
  resolvedScope: 'session_chat_v1',
  predicates: ['anchored'],
  items: [],
  nextCursor: null,
};

function harness() {
  const eventListeners = new Set<(event: DurableWorkspaceEvent) => void>();
  const feed = vi.fn().mockResolvedValue(EMPTY_PAGE);
  const postMessage = vi.fn().mockResolvedValue({ patches: [] });
  const seam: SessionChatSeam = {
    feed,
    commands: { postMessage },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    onConnection() {
      return () => undefined;
    },
    onResync() {
      return () => undefined;
    },
  };
  return {
    seam,
    feed,
    postMessage,
    emit: (event: DurableWorkspaceEvent) => {
      for (const listener of eventListeners) listener(event);
    },
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

const identityProps = {
  viewerMemberId: 'member-chat',
  spaceId: '01900000-0000-7000-8000-000000000102',
  composerPolicy: {
    schemaRef: 'tm8.composer.v1',
    supportsReply: true,
    supportsAttachments: true,
    allowedAttachmentKinds: ['file'],
    operationBindings: [
      'messages.post',
      'files.uploadInit',
      'files.uploadComplete',
      'files.uploadAbort',
    ],
  } as const,
};

describe('SessionChatSurface production adapter', () => {
  it('hydrates only the canonical session_chat_v1 feed and posts through messages.post', async () => {
    const h = harness();
    render(
      <SessionChatSurface
        {...identityProps}
        store={createChatStore({ storage: memoryStorage() })}
        seam={h.seam}
        sessionId={SESSION_ID}
        connection={{ phase: 'live' }}
        defaultLimit={37}
        onSwitchToTerminal={() => undefined}
      />,
    );

    await waitFor(() => expect(h.feed).toHaveBeenCalledWith(SESSION_ID, {
      scope: 'session_chat_v1',
      order: 'newest',
      limit: 37,
    }));
    fireEvent.change(screen.getByRole('textbox', { name: /message this session/i }), {
      target: { value: 'A provider-neutral message' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => expect(h.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      anchorIds: [SESSION_ID],
      body: 'A provider-neutral message',
      parentMessageId: null,
      clientMutationId: expect.any(String),
    })));
    await waitFor(() => expect(h.feed).toHaveBeenCalledTimes(2));
  });

  it('treats matching durable events as refetch hints and ignores other anchors', async () => {
    const h = harness();
    render(
      <SessionChatSurface
        {...identityProps}
        store={createChatStore({ storage: memoryStorage() })}
        seam={h.seam}
        sessionId={SESSION_ID}
        connection={{ phase: 'live' }}
        onSwitchToTerminal={() => undefined}
      />,
    );
    await waitFor(() => expect(h.feed).toHaveBeenCalledTimes(1));

    h.emit({ type: 'message.created', anchorId: 'another-session' } as DurableWorkspaceEvent);
    expect(h.feed).toHaveBeenCalledTimes(1);
    h.emit({ type: 'message.created', anchorId: SESSION_ID } as DurableWorkspaceEvent);
    await waitFor(() => expect(h.feed).toHaveBeenCalledTimes(2));
  });

  it('restores the member/session draft after the host is recreated', async () => {
    const h = harness();
    const storage = memoryStorage();
    const first = render(
      <SessionChatSurface
        {...identityProps}
        store={createChatStore({ storage })}
        seam={h.seam}
        sessionId={SESSION_ID}
        connection={{ phase: 'live' }}
        onSwitchToTerminal={() => undefined}
      />,
    );
    await waitFor(() => expect(h.feed).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('textbox', { name: /message this session/i }), {
      target: { value: 'durable draft' },
    });
    first.unmount();

    render(
      <SessionChatSurface
        {...identityProps}
        store={createChatStore({ storage })}
        seam={h.seam}
        sessionId={SESSION_ID}
        connection={{ phase: 'live' }}
        onSwitchToTerminal={() => undefined}
      />,
    );
    expect((screen.getByRole('textbox', { name: /message this session/i }) as HTMLTextAreaElement).value)
      .toBe('durable draft');
  });

  it('discovers mention candidates through collections.query and posts canonical ids', async () => {
    const h = harness();
    h.seam.query = vi.fn().mockResolvedValue({
      query: { spaceId: identityProps.spaceId },
      page: {
        items: [{ id: 'member-noor', kind: 'member', title: 'Noor' }],
        nextCursor: null,
      },
    });
    render(
      <SessionChatSurface
        {...identityProps}
        store={createChatStore({ storage: memoryStorage() })}
        seam={h.seam}
        sessionId={SESSION_ID}
        connection={{ phase: 'live' }}
        onSwitchToTerminal={() => undefined}
      />,
    );
    await waitFor(() => expect(h.seam.query).toHaveBeenCalledWith({
      spaceId: identityProps.spaceId,
      kinds: ['member', 'team_member'],
      sort: 'activityAt_desc',
      limit: 50,
    }));
    fireEvent.click(await screen.findByRole('button', { name: /mention someone/i }));
    fireEvent.click(screen.getByRole('option', { name: /noor/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /message this session/i }), {
      target: { value: '@Noor review this' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(h.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      mentionIds: ['member-noor'],
    })));
  });

  it('blocks new sends on an uncertain result and reconciles by replaying the same UUIDv7', async () => {
    const h = harness();
    h.postMessage
      .mockReset()
      .mockRejectedValueOnce(new TypeError('connection ended before response'))
      .mockResolvedValueOnce({ messageBatchId: 'batch-replay', messages: [] });
    render(
      <SessionChatSurface
        {...identityProps}
        store={createChatStore({ storage: memoryStorage() })}
        seam={h.seam}
        sessionId={SESSION_ID}
        connection={{ phase: 'live' }}
        onSwitchToTerminal={() => undefined}
      />,
    );
    await waitFor(() => expect(h.feed).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('textbox', { name: /message this session/i }), {
      target: { value: 'possibly stored' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => expect(screen.getByTestId('chs-uncertain')).toBeTruthy());
    expect(screen.getByRole('button', { name: /^send$/i }).getAttribute('aria-disabled')).toBe('true');
    const firstId = h.postMessage.mock.calls[0]![0].clientMutationId;
    expect(firstId).toMatch(/-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
    fireEvent.click(screen.getByRole('button', { name: /reconcile send/i }));

    await waitFor(() => expect(h.postMessage).toHaveBeenCalledTimes(2));
    expect(h.postMessage.mock.calls[1]![0].clientMutationId).toBe(firstId);
    await waitFor(() => expect(screen.queryByTestId('chs-uncertain')).toBeNull());
    expect((screen.getByRole('textbox', { name: /message this session/i }) as HTMLTextAreaElement).value)
      .toBe('');
  });
});
