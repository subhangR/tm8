// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { EntityFeedPage, FeedItem, MessageView } from '@tm8/contract';
import { ChannelScreen } from './ChannelScreen';

/**
 * T10 CHAT SURFACE — the channel destination, at LINK-LEVEL COMPLETENESS.
 *
 * WHAT THIS SUITE IS FOR, stated so a later reader does not mistake its scope:
 * it asserts that every control the canvas draws EXISTS and is either wired to
 * a real dispatcher or rendered disabled-with-reason (R7). It does NOT assert
 * pixels — a later parity session owns fidelity, and a test that pinned
 * geometry now would have to be rewritten by that session.
 *
 * The zero-silent-void law is the spine of nearly every case below: for each
 * control there are TWO tests, one proving it works when a dispatcher is
 * supplied and one proving it refuses visibly when there is none. The pairs
 * exist because the R5 finding ("I click run and nothing happens") was five
 * dead verbs, a class — so the absent-handler branch is tested as carefully as
 * the present-handler one.
 *
 * ORACLE: `T10 Chat Surface Hi-Fi.dc.html` (repo root, ` (1)` directory).
 */

const ANCHOR = 'ent-channel';

function msg(over: Partial<MessageView> = {}): MessageView {
  return {
    id: 'msg-1',
    kind: 'message',
    title: '',
    spaceId: 'sp-1',
    parentId: null,
    createdAt: '2026-07-29T11:24:00.000Z',
    updatedAt: '2026-07-29T11:24:00.000Z',
    deletedAt: null,
    version: 1,
    createdBy: { id: 'act-1', displayName: 'alex', isAgent: false },
    state: {
      kind: 'message',
      anchorId: ANCHOR,
      author: { id: 'act-1', displayName: 'alex', isAgent: false },
      messageBatchId: null,
    },
    content: { kind: 'message', body: 'Focus on the guide x-offsets first.' },
    replyCount: 0,
    ...over,
  } as unknown as MessageView;
}

function messageItem(over: Partial<FeedItem> = {}, message = msg()): FeedItem {
  return {
    itemId: `feed-${message.id}`,
    createdAt: message.createdAt,
    sortId: `${message.createdAt}#${message.id}`,
    via: ['anchored'],
    actor: message.state.author,
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: null,
    itemKind: 'message',
    message,
    delivery: [],
    ...over,
  } as FeedItem;
}

function page(items: FeedItem[], over: Partial<EntityFeedPage> = {}): EntityFeedPage {
  return {
    resolvedScope: 'direct_v1',
    predicates: ['anchored'],
    items,
    nextCursor: null,
    ...over,
  };
}

const base = {
  anchorId: ANCHOR,
  anchorNoun: 'this channel',
};

describe('the feed region', () => {
  it('renders a labelled list of ARTICLES, not ARIA chat semantics', () => {
    // §10 accessibility contract, verbatim: "a labelled chronological list of
    // articles — no ARIA chat semantics the virtualizer can't honour."
    render(<ChannelScreen {...base} page={page([messageItem()])} />);
    const feed = screen.getByRole('list', { name: /messages and activity/i });
    expect(within(feed).getAllByRole('article')).toHaveLength(1);
  });

  it('shows the direction, the author, and the body as TEXT', () => {
    render(<ChannelScreen {...base} page={page([messageItem()])} />);
    expect(screen.getByText('to this channel')).toBeTruthy();
    expect(screen.getByText('alex')).toBeTruthy();
    expect(screen.getByText(/Focus on the guide x-offsets/)).toBeTruthy();
  });

  it('distinguishes a read that found nothing from a read that never ran', () => {
    // The two absences are DIFFERENT FACTS (the HubBody LatestMessage law,
    // applied to a whole surface). `page === undefined` is hollow; `items: []`
    // is a real zero and says where the agent's output actually lives (S07).
    const { unmount } = render(<ChannelScreen {...base} page={page([])} />);
    expect(screen.getByTestId('chs-empty')).toBeTruthy();
    expect(screen.getByText(/No explicit tm8 messages or activity yet/i)).toBeTruthy();
    unmount();

    render(<ChannelScreen {...base} />);
    expect(screen.queryByTestId('chs-empty')).toBeNull();
    expect(screen.getByTestId('chs-unread')).toBeTruthy();
  });

  it('renders a redacted message as a tombstone that keeps its place (S14)', () => {
    const removed = msg({ id: 'msg-dead', deletedAt: '2026-07-29T11:42:00.000Z' });
    render(<ChannelScreen {...base} page={page([messageItem({ itemId: 'f-dead' }, removed)])} />);
    expect(screen.getByTestId('chs-tombstone')).toBeTruthy();
    // The body must NOT survive redaction — a cached excerpt would leak it.
    expect(screen.queryByText(/Focus on the guide x-offsets/)).toBeNull();
  });

  it('renders an activity variant it does not understand rather than dropping it (S15)', () => {
    // Oracle: "A pinned template can be older than the feed … rows are never
    // silently dropped." The safe card always carries timestamp + actor +
    // open-details, so an unknown row is still navigable.
    const unknown = {
      itemId: 'f-unk',
      createdAt: '2026-07-29T11:50:00.000Z',
      sortId: 'x',
      via: ['caused'],
      actor: { id: 'act-2', displayName: 'forge', isAgent: true },
      sourceWorkSessionId: null,
      anchor: null,
      logicalOperationId: null,
      itemKind: 'activity',
      activity: {
        id: 'a1', verb: 'harness.checkpoint_v3', summary: {},
        createdAt: '2026-07-29T11:50:00.000Z',
      },
    } as unknown as FeedItem;
    render(<ChannelScreen {...base} page={page([unknown])} />);
    expect(screen.getByTestId('chs-unknown')).toBeTruthy();
    expect(screen.getByText('harness.checkpoint_v3')).toBeTruthy();
  });
});

describe('delivery is a FACET on the row, never a row of its own', () => {
  it('badges a delivered message and scopes the claim in its tooltip', () => {
    const item = messageItem({
      delivery: [{
        deliveryId: 'd1', targetWorkSessionId: 'ws-forge', status: 'delivered',
        attemptNo: 1, failureReason: null, updatedAt: '2026-07-29T11:24:05.000Z',
      }],
    });
    render(<ChannelScreen {...base} page={page([item])} />);
    const badge = screen.getByTestId('chs-delivery');
    expect(badge.textContent).toContain('delivered');
    expect(badge.getAttribute('title')).toContain('governed PTY write completed');
  });

  it('keeps the message visible when delivery FAILED, and offers Send again (S19)', async () => {
    // "The bubble never regresses to a failed draft." The stored message stays;
    // Send again is a deliberate NEW message, which is why it routes through
    // the same onPost as the composer rather than a delivery-only retry.
    const onPost = vi.fn().mockResolvedValue(undefined);
    const item = messageItem({
      delivery: [{
        deliveryId: 'd1', targetWorkSessionId: 'ws-forge', status: 'failed_retryable',
        attemptNo: 1, failureReason: 'pty closed', updatedAt: '2026-07-29T11:24:05.000Z',
      }],
    });
    render(<ChannelScreen {...base} page={page([item])} onPost={onPost} />);
    expect(screen.getByText(/Focus on the guide x-offsets/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /send again/i }));
    expect(onPost).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Focus on the guide x-offsets first.' }),
    );
  });

  it('refuses Send again visibly when no dispatcher is wired', () => {
    const item = messageItem({
      delivery: [{
        deliveryId: 'd1', targetWorkSessionId: 'ws-forge', status: 'failed_retryable',
        attemptNo: 1, failureReason: null, updatedAt: '2026-07-29T11:24:05.000Z',
      }],
    });
    render(<ChannelScreen {...base} page={page([item])} />);
    const again = screen.getByRole('button', { name: /send again/i });
    expect(again.getAttribute('aria-disabled')).toBe('true');
  });

  it('expands per-target delivery without collapsing unknown into success (S20)', () => {
    const item = messageItem({
      delivery: [
        { deliveryId: 'd1', targetWorkSessionId: 'ws-forge', status: 'delivered', attemptNo: 1, failureReason: null, updatedAt: 'x' },
        { deliveryId: 'd2', targetWorkSessionId: 'ws-relay', status: 'unknown', attemptNo: 1, failureReason: null, updatedAt: 'x' },
      ],
    });
    render(<ChannelScreen {...base} page={page([item])} />);
    const toggle = screen.getByRole('button', { name: /delivery · 1 of 2 delivered/i });
    expect(screen.queryByTestId('chs-targets')).toBeNull();
    fireEvent.click(toggle);
    const targets = screen.getByTestId('chs-targets');
    expect(within(targets).getByText(/unknown/)).toBeTruthy();
    expect(within(targets).getByText(/delivered/)).toBeTruthy();
  });
});

describe('the composer', () => {
  it('posts through the dispatcher with the anchor and body', () => {
    const onPost = vi.fn().mockResolvedValue(undefined);
    render(<ChannelScreen {...base} page={page([])} onPost={onPost} />);
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), {
      target: { value: 'Kick off the tree-rule port next.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(onPost).toHaveBeenCalledWith({
      anchorIds: [ANCHOR],
      body: 'Kick off the tree-rule port next.',
      parentMessageId: null,
    });
  });

  it('sends on Enter and inserts a newline on Shift+Enter', () => {
    // The oracle states this contract in the composer's own footer copy, so a
    // build that only wires the button has drawn a promise it does not keep.
    const onPost = vi.fn().mockResolvedValue(undefined);
    render(<ChannelScreen {...base} page={page([])} onPost={onPost} />);
    const ta = screen.getByRole('textbox', { name: /message/i });
    fireEvent.change(ta, { target: { value: 'ack' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(onPost).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onPost).toHaveBeenCalledTimes(1);
  });

  it('refuses to send with no dispatcher, and says which fact is missing', () => {
    render(<ChannelScreen {...base} page={page([])} />);
    const send = screen.getByRole('button', { name: /^send$/i });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('chs-send-reason').textContent).toMatch(/isn’t connected/i);
  });

  it('carries a reply through to the dispatcher as parentMessageId', () => {
    const onPost = vi.fn().mockResolvedValue(undefined);
    render(<ChannelScreen {...base} page={page([messageItem()])} onPost={onPost} />);
    fireEvent.click(screen.getByRole('button', { name: /reply to alex/i }));
    expect(screen.getByTestId('chs-replying')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), {
      target: { value: 'on it' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(onPost).toHaveBeenCalledWith({
      anchorIds: [ANCHOR],
      body: 'on it',
      parentMessageId: 'msg-1',
    });
  });

  it('cancels a reply while KEEPING the draft', () => {
    // Oracle tooltip, verbatim: "cancel reply — draft text is kept". Clearing
    // the draft here would destroy typed work to undo a targeting choice.
    render(<ChannelScreen {...base} page={page([messageItem()])} onPost={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /reply to alex/i }));
    const ta = screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'half a thought' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel reply/i }));
    expect(screen.queryByTestId('chs-replying')).toBeNull();
    expect(ta.value).toBe('half a thought');
  });

  it('disables Send while OFFLINE — there is no contracted offline queue (S11)', () => {
    render(
      <ChannelScreen
        {...base}
        page={page([messageItem()])}
        onPost={vi.fn()}
        connection={{ phase: 'offline', disconnectedSince: '2026-07-29T11:20:00.000Z' }}
      />,
    );
    expect(screen.getByRole('button', { name: /^send$/i }).getAttribute('aria-disabled')).toBe('true');
    // Cached items stay on screen — offline is not a reason to blank history.
    expect(screen.getByText(/Focus on the guide x-offsets/)).toBeTruthy();
  });

  it('warns that Send is STORE-ONLY on an exited session, without disabling it (S21)', () => {
    // "The UI never implies Send wakes anything" — and never implies the
    // message was lost either. Both halves are the same sentence.
    render(<ChannelScreen {...base} page={page([])} onPost={vi.fn()} sessionExited />);
    expect(screen.getByTestId('chs-exited').textContent).toMatch(/nothing is delivered, nothing wakes/i);
    expect(screen.getByRole('button', { name: /^send$/i }).getAttribute('aria-disabled')).not.toBe('true');
  });

  it('renders the attach control DISABLED with its true reason — no upload seam exists', () => {
    // GAP, not a decision: the facade seam has no attachment-upload command.
    // Hiding the control would teach the user the feature does not exist.
    render(<ChannelScreen {...base} page={page([])} onPost={vi.fn()} />);
    const attach = screen.getByRole('button', { name: /attach a file/i });
    expect(attach.getAttribute('aria-disabled')).toBe('true');
  });

  it('holds the failure beside the text that failed, and keeps the draft (S17)', async () => {
    const onPost = vi.fn().mockRejectedValue(new Error('Mention @relay isn’t permitted here'));
    render(<ChannelScreen {...base} page={page([])} onPost={onPost} />);
    const ta = screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '@relay take over' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('Mention @relay');
    // "Draft and attachments kept" — the message was NOT stored, so losing the
    // text would lose the only copy that exists anywhere.
    expect(ta.value).toBe('@relay take over');
  });
});

describe('paging and the honest absences', () => {
  it('offers `load earlier` only when there IS an earlier page', () => {
    const { unmount } = render(<ChannelScreen {...base} page={page([messageItem()])} />);
    expect(screen.queryByRole('button', { name: /load earlier/i })).toBeNull();
    unmount();
    render(
      <ChannelScreen
        {...base}
        page={page([messageItem()], { nextCursor: 'cur-1' as never })}
        onLoadEarlier={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /load earlier/i })).toBeTruthy();
  });

  it('refuses `load earlier` visibly when a cursor exists but nothing dispatches it', () => {
    render(<ChannelScreen {...base} page={page([messageItem()], { nextCursor: 'cur-1' as never })} />);
    expect(
      screen.getByRole('button', { name: /load earlier/i }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('never states a total — only what returned and whether more exists (S09)', () => {
    render(<ChannelScreen {...base} page={page([messageItem()], { nextCursor: 'cur-1' as never })} onLoadEarlier={vi.fn()} />);
    const footer = screen.getByTestId('chs-provenance').textContent ?? '';
    expect(footer).toContain('1 item returned');
    expect(footer).not.toMatch(/\bof \d+\b/);
  });

  it('names the scope the SERVER resolved, not the one we asked for', () => {
    // Two-source honesty at the read layer: `resolvedScope` outranks any scope
    // this surface requested, and the footer prints the server's answer.
    render(<ChannelScreen {...base} page={page([], { resolvedScope: 'session_chat_v1' })} />);
    expect(screen.getByTestId('chs-provenance').textContent).toContain('session_chat_v1');
  });

  it('replaces the surface without leaking a thing when Chat permission is lost (S12)', () => {
    render(
      <ChannelScreen
        {...base}
        page={page([messageItem()])}
        refusal={{ kind: 'forbidden', message: 'You no longer have access to this channel’s Chat.' }}
      />,
    );
    expect(screen.getByTestId('chs-refusal')).toBeTruthy();
    // "Nothing about its contents is shown" — the cached rows must not survive.
    expect(screen.queryByText(/Focus on the guide x-offsets/)).toBeNull();
    expect(screen.queryByRole('textbox', { name: /message/i })).toBeNull();
  });
});
