// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ActorSummary, EntityFeedPage, FeedItem, MessageView, Page } from '@tm8/contract';
import { ChannelScreen } from './ChannelScreen';
import { ChannelChatSurface } from './ChannelChatSurface';
import type { ChannelFeedPort } from './useChannelFeed';
import { participantNames } from './feed-model';
import { relTime } from '../kit/time';

/**
 * SLICE 2 — the thread pane and the thread footer.
 *
 * The same zero-silent-void spine as the main suite: for each new control, one
 * test proves it works with a dispatcher and one proves it refuses visibly
 * without one. Two extra laws specific to this slice are pinned here because
 * both were explicit rulings:
 *
 *   · THE FOOTER IS PERSISTENT, NOT HOVER — an unseen thread is a lost
 *     thread. It renders in the row's resting state, no hover required.
 *   · THE COMPOSER SPLIT — the channel composer posts ROOTS ONLY; the reply
 *     path lives on the THREAD composer. The session surface (threads off)
 *     keeps its inline-reply grammar byte-for-byte.
 */

const ANCHOR = 'ent-channel';

const NOOR: ActorSummary = { id: 'act-noor', displayName: 'Noor', isAgent: false };
const FORGE: ActorSummary = { id: 'act-forge', displayName: 'Forge', isAgent: true };
const ALEX: ActorSummary = { id: 'act-1', displayName: 'alex', isAgent: false };

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
    createdBy: ALEX,
    state: {
      kind: 'message',
      anchorId: ANCHOR,
      author: ALEX,
      messageBatchId: null,
    },
    content: { kind: 'message', body: 'Focus on the guide x-offsets first.', mentions: [], attachments: [] },
    replyCount: 0,
    ...over,
  } as unknown as MessageView;
}

function reply(id: string, rootId: string, body: string, author: ActorSummary, createdAt: string): MessageView {
  return msg({
    id,
    createdAt,
    updatedAt: createdAt,
    createdBy: author,
    state: {
      kind: 'message',
      anchorId: ANCHOR,
      author,
      messageBatchId: null,
      rootMessageId: rootId,
    } as MessageView['state'],
    content: { kind: 'message', body, mentions: [], attachments: [] },
  });
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

function feedPage(items: FeedItem[], over: Partial<EntityFeedPage> = {}): EntityFeedPage {
  return {
    resolvedScope: 'channel_threads_v1',
    predicates: ['anchored', 'subject'],
    items,
    nextCursor: null,
    ...over,
  };
}

const rootWithReplies = () => msg({
  replyCount: 3,
  lastReplyAt: '2026-07-29T13:24:00.000Z',
  replyParticipants: [NOOR, FORGE],
});

const base = {
  anchorId: ANCHOR,
  anchorNoun: 'this channel',
  threads: true,
  anchorTitle: '#design-review',
};

describe('the thread footer', () => {
  it('renders PERSISTENTLY on a root with replies — count, facepile names, relative time — as ONE click target', () => {
    const onOpenThread = vi.fn();
    render(
      <ChannelScreen
        {...base}
        page={feedPage([messageItem({}, rootWithReplies())])}
        onOpenThread={onOpenThread}
      />,
    );
    const footer = screen.getByTestId('chs-thread-footer');
    // Resting state — no hover event has been fired before this query.
    const open = within(footer).getByRole('button', { name: /open thread · 3 replies/i });
    expect(open.textContent).toMatch(/3 replies/);
    expect(open.textContent).toMatch(/Noor, Forge/);
    // The footer's "when" is the shared Timestamp: relative inside the 7-day
    // window, an absolute date past it. The fixture's reply is older than the
    // window, so assert the ELEMENT and its machine-readable instant rather
    // than a wording that changes with the calendar.
    const when = within(footer).getByText((_, el) => el?.tagName === 'TIME');
    expect(when.getAttribute('datetime')).toBe(rootWithReplies().lastReplyAt);
    expect(when.textContent?.trim()).not.toBe('');
    fireEvent.click(open);
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread.mock.calls[0][0].id).toBe('msg-1');
  });

  it('renders NO footer at all on a root with zero replies', () => {
    render(<ChannelScreen {...base} page={feedPage([messageItem()])} onOpenThread={vi.fn()} />);
    expect(screen.queryByTestId('chs-thread-footer')).toBeNull();
  });

  it('renders no footer when threads are off — the session grammar draws replies inline instead', () => {
    render(
      <ChannelScreen
        anchorId={ANCHOR}
        anchorNoun="this session"
        page={feedPage([messageItem({}, rootWithReplies())])}
      />,
    );
    expect(screen.queryByTestId('chs-thread-footer')).toBeNull();
  });

  it('refuses visibly when threads are on but no dispatcher opens them (R7 — no silent vanish)', () => {
    render(<ChannelScreen {...base} page={feedPage([messageItem({}, rootWithReplies())])} />);
    const footer = screen.getByTestId('chs-thread-footer');
    // The disabled-with-reason treatment still names the control and count —
    // present, focusable, and honestly disabled rather than absent.
    const refusal = within(footer).getByRole('button', { name: /open thread · 3 replies/i });
    expect(refusal.getAttribute('aria-disabled')).toBe('true');
    expect(footer.textContent).toMatch(/3 replies/);
  });

  it('keeps the footer on a REDACTED root — a roots-only feed without it would orphan the branch', () => {
    const onOpenThread = vi.fn();
    const redacted = msg({
      replyCount: 2,
      lastReplyAt: '2026-07-29T13:00:00.000Z',
      replyParticipants: [NOOR],
      state: {
        kind: 'message',
        anchorId: ANCHOR,
        author: ALEX,
        messageBatchId: null,
        redactedAt: '2026-07-29T12:00:00.000Z',
      } as MessageView['state'],
    });
    render(<ChannelScreen {...base} page={feedPage([messageItem({}, redacted)])} onOpenThread={onOpenThread} />);
    expect(screen.getByTestId('chs-tombstone')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /open thread · 2 replies/i }));
    expect(onOpenThread).toHaveBeenCalled();
  });

  it('routes ↩ to the thread in threads mode, and refuses visibly without the dispatcher', () => {
    const onOpenThread = vi.fn();
    const view = render(
      <ChannelScreen {...base} page={feedPage([messageItem()])} onOpenThread={onOpenThread} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /reply in thread to alex/i }));
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    view.rerender(<ChannelScreen {...base} page={feedPage([messageItem()])} />);
    // Still present, disabled-with-reason — never a hidden control.
    const refusal = screen.getByRole('button', { name: /reply in thread to alex/i });
    expect(refusal.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('the composer split', () => {
  it('posts ROOTS ONLY from the channel composer in threads mode — parentMessageId is always null', async () => {
    const onPost = vi.fn();
    render(<ChannelScreen {...base} page={feedPage([messageItem()])} onPost={onPost} />);
    const input = screen.getByRole('textbox', { name: /message this channel/i });
    fireEvent.change(input, { target: { value: 'a fresh root' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onPost).toHaveBeenCalled());
    expect(onPost.mock.calls[0][0].parentMessageId).toBeNull();
  });

  it('draws no ParentPreview in a threads-mode feed; the session surface keeps it', () => {
    const child = msg({
      id: 'msg-2',
      state: {
        kind: 'message',
        anchorId: ANCHOR,
        author: ALEX,
        messageBatchId: null,
        rootMessageId: 'msg-parent',
      } as MessageView['state'],
    });
    const view = render(<ChannelScreen {...base} page={feedPage([messageItem({}, child)])} />);
    expect(screen.queryByTestId('chs-parent')).toBeNull();
    view.rerender(
      <ChannelScreen anchorId={ANCHOR} anchorNoun="this session" page={feedPage([messageItem({}, child)])} />,
    );
    expect(screen.getByTestId('chs-parent')).toBeTruthy();
  });
});

describe('the thread pane', () => {
  const branch: Page<MessageView> = {
    items: [
      reply('msg-r1', 'msg-1', 'first answer', NOOR, '2026-07-29T12:00:00.000Z'),
      reply('msg-r2', 'msg-1', 'second answer', FORGE, '2026-07-29T13:24:00.000Z'),
    ],
    nextCursor: null,
  };

  it('renders root pinned, an N-replies divider, the branch oldest-first, and its own composer', () => {
    render(
      <ChannelScreen
        {...base}
        page={feedPage([messageItem({}, rootWithReplies())])}
        thread={{ root: rootWithReplies(), replies: branch }}
        onOpenThread={vi.fn()}
        onCloseThread={vi.fn()}
      />,
    );
    const pane = screen.getByTestId('chs-thread');
    const rootRegion = within(pane).getByRole('list', { name: /thread root/i });
    expect(within(rootRegion).getAllByRole('article')).toHaveLength(1);
    expect(within(pane).getByTestId('chs-thread-divider').textContent).toMatch(/3 replies/);
    const rows = within(pane).getByRole('list', { name: /thread replies/i });
    const bodies = within(rows).getAllByTestId('chs-text').map((el) => el.textContent);
    expect(bodies).toEqual(['first answer', 'second answer']);
    expect(within(pane).getByRole('textbox', { name: /message this thread/i })).toBeTruthy();
    // The three-column split is stated on the surface root for the collapse CSS.
    expect(screen.getByTestId('chs-root').getAttribute('data-thread-open')).toBe('true');
    // NO "in reply to" cards anywhere in the pane: the root is pinned by
    // construction, and a parent id that is NOT a loaded branch message (the
    // fixture points `parentId` at the CHANNEL entity) must not draw either —
    // the first browser run showed "↩ in reply to ch-design" under every row.
    expect(within(pane).queryByTestId('chs-parent')).toBeNull();
  });

  it('draws no parent card for an entity-parented message inside the pane (parentId → the channel)', () => {
    const entityParented = {
      ...reply('msg-r1', 'msg-1', 'first answer', NOOR, '2026-07-29T12:00:00.000Z'),
      parentId: ANCHOR,
    } as MessageView;
    render(
      <ChannelScreen
        {...base}
        page={feedPage([messageItem({}, rootWithReplies())])}
        thread={{ root: rootWithReplies(), replies: { items: [entityParented], nextCursor: null } }}
        onCloseThread={vi.fn()}
      />,
    );
    expect(within(screen.getByTestId('chs-thread')).queryByTestId('chs-parent')).toBeNull();
  });

  it('keeps "no branch read ran" and "a measured zero" distinct', () => {
    const view = render(
      <ChannelScreen
        {...base}
        page={feedPage([messageItem({}, rootWithReplies())])}
        thread={{ root: rootWithReplies() }}
        onCloseThread={vi.fn()}
      />,
    );
    expect(screen.getByTestId('chs-thread-unread')).toBeTruthy();
    expect(screen.queryByTestId('chs-thread-empty')).toBeNull();
    view.rerender(
      <ChannelScreen
        {...base}
        page={feedPage([messageItem({}, rootWithReplies())])}
        thread={{ root: rootWithReplies(), replies: { items: [], nextCursor: null } }}
        onCloseThread={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('chs-thread-unread')).toBeNull();
    expect(screen.getByTestId('chs-thread-empty')).toBeTruthy();
  });

  it('replies to the ROOT by default, and to an armed branch message instead', async () => {
    const onPost = vi.fn();
    render(
      <ChannelScreen
        {...base}
        page={feedPage([messageItem({}, rootWithReplies())])}
        thread={{ root: rootWithReplies(), replies: branch }}
        onPost={onPost}
        onCloseThread={vi.fn()}
      />,
    );
    const pane = screen.getByTestId('chs-thread');
    const input = within(pane).getByRole('textbox', { name: /message this thread/i });
    fireEvent.change(input, { target: { value: 'to the root' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    expect(onPost.mock.calls[0][0].parentMessageId).toBe('msg-1');

    // Arm a branch message — the replyTo path, now living on the THREAD composer.
    fireEvent.click(within(pane).getByRole('button', { name: /reply to noor/i }));
    expect(within(pane).getByTestId('chs-replying').textContent).toMatch(/noor/i);
    fireEvent.change(input, { target: { value: 'to the first answer' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(2));
    expect(onPost.mock.calls[1][0].parentMessageId).toBe('msg-r1');
  });

  it('closes from ✕, names the way back in the breadcrumb, and pages the branch forward', () => {
    const onCloseThread = vi.fn();
    const onLoadMoreReplies = vi.fn();
    render(
      <ChannelScreen
        {...base}
        page={feedPage([messageItem({}, rootWithReplies())])}
        thread={{ root: rootWithReplies(), replies: { ...branch, nextCursor: 'cur-next' } }}
        onCloseThread={onCloseThread}
        onLoadMoreReplies={onLoadMoreReplies}
      />,
    );
    const pane = screen.getByTestId('chs-thread');
    expect(within(pane).getByRole('button', { name: /← #design-review/i })).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: /load more replies/i }));
    expect(onLoadMoreReplies).toHaveBeenCalledWith('cur-next');
    fireEvent.click(within(pane).getByRole('button', { name: /close thread/i }));
    expect(onCloseThread).toHaveBeenCalled();
  });

  it('states a failed branch read as an alert with a retry — never the hollow "never ran" claim', () => {
    const onOpenThread = vi.fn();
    render(
      <ChannelScreen
        {...base}
        page={feedPage([messageItem({}, rootWithReplies())])}
        thread={{ root: rootWithReplies(), error: 'The thread could not be read.' }}
        onOpenThread={onOpenThread}
        onCloseThread={vi.fn()}
      />,
    );
    expect(screen.getByTestId('chs-thread-error').textContent).toMatch(/could not be read/);
    expect(screen.queryByTestId('chs-thread-unread')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retry thread/i }));
    expect(onOpenThread).toHaveBeenCalled();
  });

  it('offers no session/spawn @routes in the thread composer — every post there is a reply', () => {
    render(
      <ChannelScreen
        {...base}
        page={feedPage([messageItem({}, rootWithReplies())])}
        thread={{ root: rootWithReplies(), replies: branch }}
        onPost={vi.fn()}
        onCloseThread={vi.fn()}
        mentionOptions={[
          { id: 'member-noor', kind: 'member', display: 'Noor' },
          { id: 'tm-forge', kind: 'team_member', display: 'Forge', route: 'spawn-team-member' },
        ] as never}
      />,
    );
    const pane = screen.getByTestId('chs-thread');
    fireEvent.click(within(pane).getByRole('button', { name: /mention someone/i }));
    const listbox = within(pane).getByRole('listbox', { name: /available @tag options/i });
    expect(within(listbox).getByRole('option', { name: /noor/i })).toBeTruthy();
    expect(within(listbox).queryByRole('option', { name: /forge/i })).toBeNull();
  });
});

describe('the host-sequenced thread read (ChannelChatSurface + useChannelFeed)', () => {
  function fakePort(overrides: Partial<{ replies: MessageView[] }> = {}) {
    const root = rootWithReplies();
    const messages = vi.fn(async (_anchor: string, opts?: { rootMessageId?: string }) => {
      expect(opts?.rootMessageId).toBe('msg-1');
      return { items: overrides.replies ?? [
        reply('msg-r1', 'msg-1', 'first answer', NOOR, '2026-07-29T12:00:00.000Z'),
      ], nextCursor: null };
    });
    const port = {
      seam: {
        feed: vi.fn(async () => feedPage([messageItem({}, root)])),
        onEvent: vi.fn(() => () => undefined),
        query: vi.fn(async () => { throw new Error('no query in this fixture'); }),
        liveness: { refresh: vi.fn(async () => ({ liveEntityIds: [] })) },
        entity: vi.fn(async () => { throw new Error('no entity in this fixture'); }),
        files: undefined,
        messages,
      },
      spaceId: 'sp-1',
      liveIds: [],
      postMessage: vi.fn(async () => undefined),
      spawn: vi.fn(async () => 'ws-new'),
      projects: [],
    } as unknown as ChannelFeedPort;
    return { port, messages };
  }

  it('opens a footer into a branch read keyed by rootMessageId, renders it, and posts replies to the root', async () => {
    const { port, messages } = fakePort();
    render(
      <ChannelChatSurface
        port={port}
        channelId={ANCHOR}
        connection={{ phase: 'live' }}
        threads
        anchorTitle="#design-review"
      />,
    );
    const open = await screen.findByRole('button', { name: /open thread · 3 replies/i });
    fireEvent.click(open);
    await waitFor(() => expect(messages).toHaveBeenCalled());
    const pane = await screen.findByTestId('chs-thread');
    await within(pane).findByText('first answer');

    const input = within(pane).getByRole('textbox', { name: /message this thread/i });
    fireEvent.change(input, { target: { value: 'a reply through the seam' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const postMessage = (port as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage;
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    expect(postMessage.mock.calls[0][0].parentMessageId).toBe('msg-1');
    // The post reloads the feed AND re-reads the open branch.
    await waitFor(() => expect(messages.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe('author-run clustering in threads mode', () => {
  it('clusters consecutive roots by one author — the entity parentId is not a reply fact there', () => {
    // `parentId` on a channel message is the ENTITY parent (the channel), and
    // it froze clustering: every root repeated its byline (Lane D's report).
    const first = msg({ id: 'msg-a', parentId: ANCHOR, createdAt: '2026-07-29T11:24:00.000Z' } as Partial<MessageView>);
    const second = msg({ id: 'msg-b', parentId: ANCHOR, createdAt: '2026-07-29T11:26:00.000Z' } as Partial<MessageView>);
    const items = [messageItem({ itemId: 'f-a' }, first), messageItem({ itemId: 'f-b' }, second)];
    const view = render(<ChannelScreen {...base} page={feedPage(items)} />);
    // One byline for the run of two.
    expect(screen.getAllByText('alex')).toHaveLength(1);

    // Threads OFF (session grammar): the guard is untouched — a message with
    // a parent fact never clusters, so both bylines repeat.
    view.rerender(
      <ChannelScreen anchorId={ANCHOR} anchorNoun="this session" page={feedPage(items)} />,
    );
    expect(screen.getAllByText('alex')).toHaveLength(2);
  });

  it('a clustered root keeps its thread footer — clustering hides the byline, never the branch', () => {
    const first = msg({ id: 'msg-a', createdAt: '2026-07-29T11:24:00.000Z' });
    const second = msg({
      id: 'msg-b',
      createdAt: '2026-07-29T11:26:00.000Z',
      replyCount: 2,
      lastReplyAt: '2026-07-29T13:00:00.000Z',
      replyParticipants: [NOOR],
    });
    render(
      <ChannelScreen
        {...base}
        page={feedPage([messageItem({ itemId: 'f-a' }, first), messageItem({ itemId: 'f-b' }, second)])}
        onOpenThread={vi.fn()}
      />,
    );
    expect(screen.getAllByText('alex')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /open thread · 2 replies/i })).toBeTruthy();
  });
});

describe('footer helpers', () => {
  // The footer's private `replyTimeAgo` is gone; the shared `relTime` grades
  // the same buckets, with 'just now' where the private copy said 'now'.
  it('relTime grades now/minutes/hours/days against an explicit clock', () => {
    const now = Date.parse('2026-07-29T12:00:00.000Z');
    expect(relTime('2026-07-29T11:59:40.000Z', now)).toBe('just now');
    expect(relTime('2026-07-29T11:45:00.000Z', now)).toBe('15m ago');
    expect(relTime('2026-07-29T09:00:00.000Z', now)).toBe('3h ago');
    expect(relTime('2026-07-25T12:00:00.000Z', now)).toBe('4d ago');
  });

  it('participantNames caps at two names plus a count', () => {
    expect(participantNames([])).toBe('');
    expect(participantNames([NOOR])).toBe('Noor');
    expect(participantNames([NOOR, FORGE])).toBe('Noor, Forge');
    expect(participantNames([NOOR, FORGE, ALEX, { id: 'x', displayName: 'Rin', isAgent: false }]))
      .toBe('Noor, Forge +2');
  });
});
