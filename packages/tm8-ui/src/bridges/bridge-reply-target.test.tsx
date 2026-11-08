// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ActorSummary, MessageBatchResult, MessageBridgeView, MessageView } from '@tm8/contract';
import { Composer } from '../channel-screen/Composer';
import { createChatStore } from '../channel-screen/chat-store';
import { createChatMutationController } from '../channel-screen/chat-mutations';

/**
 * §4.5, D76: replying to a bridged message defaults the composer to *Reply in
 * WhatsApp*, with a one-tap *Reply here only*. Here only the composer's half:
 * the post carries `hereOnly`, and the mutation journal hands it to
 * `messages.post`. That the server then never enqueues it is held in
 * packages/server/test/db/bridge-message-badges.pg.test.ts.
 */
const ANCHOR = '019f0000-0000-7000-8000-0000000000e1';
const BRIDGE = '019f0000-0000-7000-8000-0000000000b1';
const RAHUL: ActorSummary = { id: BRIDGE, displayName: 'Rahul', isAgent: false };
const ALEX: ActorSummary = { id: '019f0000-0000-7000-8000-0000000000a1', displayName: 'alex', isAgent: false };

const inbound: MessageBridgeView = {
  bridgeId: BRIDGE, provider: 'whatsapp', conversation: 'Infra', direction: 'in',
  participant: 'Rahul', trust: 'guest', delivery: null,
};

function msg(id: string, author: ActorSummary, bridge?: MessageBridgeView): MessageView {
  return {
    id, kind: 'message', title: '', spaceId: 'sp-1', parentId: null,
    createdAt: '2026-10-30T10:41:00.000Z', updatedAt: '2026-10-30T10:41:00.000Z', deletedAt: null, version: 1,
    createdBy: author,
    state: { kind: 'message', anchorId: ANCHOR, author, messageBatchId: null },
    content: { kind: 'message', body: 'is the deploy done?', mentions: [], attachments: [] },
    replyCount: 0,
    ...(bridge ? { bridge } : {}),
  } as unknown as MessageView;
}

const bridgedRoot = msg('msg-bridged', RAHUL, inbound);
const plainRoot = msg('msg-plain', ALEX);

function send(text: string) {
  const input = screen.getByRole('textbox', { name: /message this thread/i });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('the composer under a bridged message (§4.5, D76)', () => {
  it('defaults to Reply in WhatsApp: the switch, the placeholder, and a post with no hereOnly', async () => {
    const onPost = vi.fn();
    render(<Composer anchorId={ANCHOR} anchorNoun="this thread" onPost={onPost}
      replyTo={null} onCancelReply={vi.fn()} threadRoot={bridgedRoot} />);
    const target = screen.getByTestId('bridge-reply');
    expect(target.getAttribute('data-target')).toBe('bridge');
    expect(within(target).getByRole('button', { name: /reply in whatsapp/i }).getAttribute('aria-pressed')).toBe('true');
    expect(within(target).getByRole('button', { name: /reply here only/i }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('textbox', { name: /message this thread/i }).getAttribute('placeholder')).toBe('Reply in WhatsApp…');

    send('yes, 1.4.2');
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    expect(onPost.mock.calls[0][0]).toMatchObject({ parentMessageId: 'msg-bridged' });
    expect(onPost.mock.calls[0][0]).not.toHaveProperty('hereOnly');
  });

  it('one tap switches to Reply here only, and the post carries hereOnly; the next reply starts at the default again', async () => {
    const onPost = vi.fn();
    render(<Composer anchorId={ANCHOR} anchorNoun="this thread" onPost={onPost}
      replyTo={null} onCancelReply={vi.fn()} threadRoot={bridgedRoot} />);
    fireEvent.click(screen.getByRole('button', { name: /reply here only/i }));
    const target = screen.getByTestId('bridge-reply');
    expect(target.getAttribute('data-target')).toBe('here');
    expect(within(target).getByRole('button', { name: /reply here only/i }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('textbox', { name: /message this thread/i }).getAttribute('placeholder')).toBe('Message this thread…');

    send('noting it here');
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    expect(onPost.mock.calls[0][0]).toMatchObject({ parentMessageId: 'msg-bridged', hereOnly: true });
    await waitFor(() => expect(screen.getByTestId('bridge-reply').getAttribute('data-target')).toBe('bridge'));
  });

  it('a reply to a message no bridge touched shows no switch and never sends hereOnly', async () => {
    const onPost = vi.fn();
    render(<Composer anchorId={ANCHOR} anchorNoun="this thread" onPost={onPost}
      replyTo={null} onCancelReply={vi.fn()} threadRoot={plainRoot} />);
    expect(screen.queryByTestId('bridge-reply')).toBeNull();
    send('plain reply');
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    expect(onPost.mock.calls[0][0]).not.toHaveProperty('hereOnly');
  });

  it('the switch follows the armed parent: a plain branch reply under a bridged root has none', () => {
    const { rerender } = render(<Composer anchorId={ANCHOR} anchorNoun="this thread"
      replyTo={plainRoot} onCancelReply={vi.fn()} threadRoot={bridgedRoot} />);
    expect(screen.queryByTestId('bridge-reply')).toBeNull();
    rerender(<Composer anchorId={ANCHOR} anchorNoun="this thread"
      replyTo={null} onCancelReply={vi.fn()} threadRoot={bridgedRoot} />);
    expect(screen.getByTestId('bridge-reply')).toBeTruthy();
  });
});

describe('the mutation journal hands hereOnly to messages.post', () => {
  const key = { viewerMemberId: ALEX.id, sessionId: ANCHOR, scope: 'session_chat_v1' as const, filter: 'chronological' };
  function controller(postMessage: ReturnType<typeof vi.fn>) {
    const store = createChatStore({ storage: null, now: () => '2026-10-30T10:42:00.000Z' });
    store.getState().ensure(key);
    return createChatMutationController({
      store, key, spaceId: 'sp-1', postMessage, refresh: vi.fn().mockResolvedValue(undefined),
      now: () => '2026-10-30T10:42:00.000Z',
    });
  }
  const ok = (): MessageBatchResult => ({ messageBatchId: 'batch-1', messages: [msg('019f0000-0000-7000-8000-0000000000f1', ALEX)] });

  it('only when set', async () => {
    const postMessage = vi.fn().mockResolvedValue(ok());
    const c = controller(postMessage);
    await c.submit({ anchorIds: [ANCHOR], body: 'here only', parentMessageId: 'msg-bridged', hereOnly: true });
    expect(postMessage.mock.calls[0][0]).toMatchObject({ parentMessageId: 'msg-bridged', hereOnly: true });
    await c.submit({ anchorIds: [ANCHOR], body: 'to WhatsApp', parentMessageId: 'msg-bridged' });
    expect(postMessage.mock.calls[1][0]).not.toHaveProperty('hereOnly');
  });
});
