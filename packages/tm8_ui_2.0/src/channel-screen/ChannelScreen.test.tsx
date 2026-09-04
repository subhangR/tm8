// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    content: { kind: 'message', body: 'Focus on the guide x-offsets first.', mentions: [], attachments: [] },
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

function activityItem(
  verb: string,
  summary: Record<string, unknown>,
  over: Partial<FeedItem> = {},
): FeedItem {
  return {
    itemId: `feed-activity-${verb}`,
    createdAt: '2026-07-29T11:33:00.000Z',
    sortId: `2026-07-29T11:33:00.000Z#${verb}`,
    via: ['caused'],
    actor: { id: 'act-2', displayName: 'forge', isAgent: true },
    sourceWorkSessionId: 'ws-forge',
    anchor: null,
    logicalOperationId: null,
    itemKind: 'activity',
    activity: {
      id: `activity-${verb}`,
      entityId: null,
      actor: { id: 'act-2', displayName: 'forge', isAgent: true },
      verb,
      summary,
      createdAt: '2026-07-29T11:33:00.000Z',
      workSessionId: 'ws-forge',
    },
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

  it('shows the author and the body as TEXT, without per-row boilerplate', () => {
    render(<ChannelScreen {...base} page={page([messageItem()])} />);
    expect(screen.getByText('alex')).toBeTruthy();
    expect(screen.getByText(/Focus on the guide x-offsets/)).toBeTruthy();
    // A message posted to this channel, shown in this channel, repeats no
    // direction rail and no canonical-anchor line — cross-surface provenance
    // renders only when it is news (foreign anchor or source session).
    expect(screen.queryByText(/to this channel/i)).toBeNull();
    expect(screen.queryByTestId('chs-message-meta')).toBeNull();
  });

  it('clusters an author run into one byline and opens each day with a divider', () => {
    const first = msg({ id: 'msg-first' });
    const follow = msg({
      id: 'msg-follow',
      createdAt: '2026-07-29T11:26:00.000Z',
      content: { kind: 'message', body: 'And the y-offsets after.', mentions: [], attachments: [] },
    });
    const nextDay = msg({
      id: 'msg-next-day',
      createdAt: '2026-07-30T09:00:00.000Z',
      content: { kind: 'message', body: 'Fresh morning thread.', mentions: [], attachments: [] },
    });
    render(<ChannelScreen {...base} page={page([
      messageItem({ itemId: 'f-first' }, first),
      messageItem({ itemId: 'f-follow' }, follow),
      messageItem({ itemId: 'f-next-day' }, nextDay),
    ])} />);
    // The 2-minute follow-up repeats no byline; the new day starts a new run.
    expect(screen.getAllByText('alex')).toHaveLength(2);
    expect(screen.getAllByTestId('chs-day')).toHaveLength(2);
    // Every message keeps its own article — clustering is presentation only.
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.getByText('And the y-offsets after.')).toBeTruthy();
  });

  it('renders a mention the body carries INLINE once, not repeated as a trailing chip', () => {
    const onOpenEntity = vi.fn();
    const rich = msg({
      content: {
        kind: 'message',
        body: 'Thanks @Noor — ship it.',
        mentions: [{ entityId: 'member-noor', kind: 'member', display: 'Noor' }],
        attachments: [],
      },
    });
    render(<ChannelScreen {...base} page={page([messageItem({}, rich)])} onOpenEntity={onOpenEntity} />);
    // Exactly ONE control for the mention — getByRole throws on a duplicate.
    const control = screen.getByRole('button', { name: /open mention noor/i });
    expect(control.textContent).toBe('@Noor');
    fireEvent.click(control);
    expect(onOpenEntity).toHaveBeenCalledWith('member-noor');
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

  it('renders only an explicitly redacted message as a tombstone with no content leak (S14)', () => {
    const removed = msg({
      id: 'msg-dead',
      deletedAt: null,
      state: {
        ...msg().state,
        redactedAt: '2026-07-29T11:42:00.000Z',
      },
      content: {
        kind: 'message',
        body: 'SECRET body from stale cache',
        mentions: [{ entityId: 'member-secret', kind: 'member', display: 'Secret Person' }],
        attachments: [{ fileEntityId: 'file-secret', name: 'secret.txt', mime: 'text/plain' }],
      },
    });
    render(<ChannelScreen {...base} page={page([messageItem({ itemId: 'f-dead' }, removed)])} />);
    expect(screen.getByTestId('chs-tombstone')).toBeTruthy();
    expect(screen.queryByText(/SECRET body/)).toBeNull();
    expect(screen.queryByText(/Secret Person/)).toBeNull();
    expect(screen.queryByText(/secret\.txt/)).toBeNull();
  });

  it('does not infer redaction from an empty body, deletedAt, or a legacy omission', () => {
    const empty = msg({
      id: 'msg-empty',
      deletedAt: '2026-07-29T11:42:00.000Z',
      state: { ...msg().state, redactedAt: null },
      content: { kind: 'message', body: '', mentions: [], attachments: [] },
    });
    const legacy = msg({ id: 'msg-legacy' });
    render(<ChannelScreen {...base} page={page([
      messageItem({ itemId: 'f-empty' }, empty),
      messageItem({ itemId: 'f-legacy' }, legacy),
    ])} />);
    expect(screen.queryByTestId('chs-tombstone')).toBeNull();
    expect(screen.getByText(/Focus on the guide x-offsets/)).toBeTruthy();
  });

  it('shows edited, source-session, canonical-anchor, and full timestamp details with canonical navigation', () => {
    const onOpenEntity = vi.fn();
    const item = messageItem({
      sourceWorkSessionId: 'ws-forge',
      anchor: { id: 'task-114', kind: 'task', title: 'T-114 · Align the rail' } as never,
    }, msg({ state: { ...msg().state, editedAt: '2026-07-29T11:30:00.000Z' } }));
    render(<ChannelScreen {...base} page={page([item])} onOpenEntity={onOpenEntity} />);
    expect(screen.getByText('edited')).toBeTruthy();
    expect(screen.getByText(/from session/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /open canonical anchor/i }).textContent).toContain('T-114 · Align the rail');
    expect(screen.getByRole('time').getAttribute('aria-label')).toContain('2026');
    fireEvent.click(screen.getByRole('button', { name: /open source session/i }));
    fireEvent.click(screen.getByRole('button', { name: /open canonical anchor/i }));
    expect(onOpenEntity.mock.calls).toEqual([['ws-forge'], ['task-114']]);
  });

  it('hydrates a reply preview from the loaded page and focuses its parent', () => {
    const onOpenEntity = vi.fn();
    const parent = msg({
      id: 'msg-parent',
      content: { kind: 'message', body: 'Parent context', mentions: [], attachments: [] },
    });
    const reply = msg({
      id: 'msg-reply',
      state: { ...msg().state, rootMessageId: 'msg-parent' },
      content: { kind: 'message', body: 'Reply body', mentions: [], attachments: [] },
    });
    render(<ChannelScreen {...base} page={page([
      messageItem({ itemId: 'f-parent' }, parent),
      messageItem({ itemId: 'f-reply' }, reply),
    ])} onOpenEntity={onOpenEntity} />);
    const preview = screen.getByTestId('chs-parent');
    expect(preview.textContent).toContain('in reply to');
    expect(preview.textContent).toContain('alex');
    expect(preview.textContent).toContain('Parent context');
    fireEvent.click(within(preview).getByRole('button', { name: /focus parent message/i }));
    expect((document.activeElement as HTMLElement).dataset.feedMessageId).toBe('msg-parent');
    expect(onOpenEntity).not.toHaveBeenCalled();
  });

  it('uses the direct parent for a nested reply instead of collapsing it to the thread root', () => {
    const root = msg({ id: 'msg-root' });
    const parent = msg({
      id: 'msg-parent',
      parentId: 'msg-root',
      state: { ...msg().state, rootMessageId: 'msg-root' },
      content: { kind: 'message', body: 'Immediate parent', mentions: [], attachments: [] },
    });
    const nested = msg({
      id: 'msg-nested',
      parentId: 'msg-parent',
      state: { ...msg().state, rootMessageId: 'msg-root' },
      content: { kind: 'message', body: 'Nested reply', mentions: [], attachments: [] },
    });
    render(<ChannelScreen {...base} page={page([
      messageItem({ itemId: 'f-root' }, root),
      messageItem({ itemId: 'f-parent' }, parent),
      messageItem({ itemId: 'f-nested' }, nested),
    ])} />);
    const nestedRow = document.querySelector('[data-feed-message-id="msg-nested"]')!;
    expect(within(nestedRow as HTMLElement).getByTestId('chs-parent').textContent).toContain('Immediate parent');
  });

  it('shows a canonical, openable chip for a session linked or spawned from the channel', () => {
    const onOpenEntity = vi.fn();
    const item = messageItem({
      linkedWorkSessions: [{
        id: 'ws-forge',
        kind: 'work_session',
        title: 'Forge · channel run',
      } as never],
    });
    render(<ChannelScreen {...base} page={page([item])} onOpenEntity={onOpenEntity} />);
    const chip = screen.getByRole('button', { name: /open linked session forge · channel run/i });
    expect(screen.getByTestId('chs-session-links')).toBeTruthy();
    expect(chip.textContent).toContain('Forge · channel run');
    fireEvent.click(chip);
    expect(onOpenEntity).toHaveBeenCalledWith('ws-forge');
  });

  it('renders mentions and attachments as canonical entity controls', () => {
    const onOpenEntity = vi.fn();
    const rich = msg({
      content: {
        kind: 'message',
        body: 'See the attached plan.',
        mentions: [{ entityId: 'member-noor', kind: 'member', display: 'Noor' }],
        attachments: [{ fileEntityId: 'file-plan', name: 'plan.pdf', mime: 'application/pdf' }],
      },
    });
    render(<ChannelScreen {...base} page={page([messageItem({}, rich)])} onOpenEntity={onOpenEntity} />);
    fireEvent.click(screen.getByRole('button', { name: /open mention noor/i }));
    fireEvent.click(screen.getByRole('button', { name: /open attachment plan\.pdf/i }));
    expect(onOpenEntity.mock.calls).toEqual([['member-noor'], ['file-plan']]);
  });

  it('renders created entities as artifact cards and typed work changes as state rows', () => {
    const onOpenEntity = vi.fn();
    const artifact = activityItem('created', { kind: 'doc' }, {
      anchor: { id: 'doc-layout', kind: 'doc', title: 'Layout specification', excerpt: 'Panel geometry' } as never,
    });
    const changed = activityItem('work.changed', { status: 'in_review' }, { itemId: 'feed-work' });
    render(<ChannelScreen {...base} page={page([artifact, changed])} onOpenEntity={onOpenEntity} />);
    const card = screen.getByTestId('chs-artifact');
    expect(card.textContent).toContain('Layout specification');
    expect(card.textContent).toContain('doc');
    fireEvent.click(within(card).getByRole('button', { name: /open layout specification/i }));
    expect(onOpenEntity).toHaveBeenCalledWith('doc-layout');
    expect(screen.getByTestId('chs-state').textContent).toMatch(/work status.*in_review/i);
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

  it('renders all eight target states and only allowlisted safe reason text', () => {
    const statuses = [
      'pending', 'dispatching', 'delivered', 'failed_retryable',
      'failed_permanent', 'unknown', 'expired', 'cancelled',
    ] as const;
    const item = messageItem({
      delivery: statuses.map((status, index) => ({
        deliveryId: `d-${status}`,
        targetWorkSessionId: `ws-${index}`,
        status,
        attemptNo: 1,
        failureReason: status === 'unknown'
          ? 'restart_during_dispatch'
          : status === 'failed_permanent'
            ? 'postgres://user:secret@example.invalid/private'
            : null,
        updatedAt: '2026-07-29T11:24:05.000Z',
      })),
    });
    render(<ChannelScreen {...base} page={page([item])} />);
    fireEvent.click(screen.getByRole('button', { name: /delivery · 1 of 8 delivered/i }));
    const targets = screen.getByTestId('chs-targets');
    for (const status of statuses) {
      expect(targets.querySelector(`[data-delivery-status="${status}"]`)).toBeTruthy();
    }
    expect(targets.textContent).toContain('Node restarted during delivery');
    expect(targets.textContent).not.toContain('user:secret');
    expect(targets.textContent).toContain('Details unavailable');
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

  it('stages a canonical uploaded file and includes its entity id only when Send stores', async () => {
    const onPost = vi.fn().mockResolvedValue(undefined);
    const onStartAttachmentUpload = vi.fn().mockReturnValue({
      cancel: vi.fn(),
      result: Promise.resolve({
        fileEntityId: 'file-plan',
        name: 'plan.txt',
        mime: 'text/plain',
        sizeBytes: 4,
        maxSizeBytes: 1024,
      }),
    });
    render(
      <ChannelScreen
        {...base}
        page={page([])}
        onPost={onPost}
        onStartAttachmentUpload={onStartAttachmentUpload}
      />,
    );
    const file = new File(['plan'], 'plan.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText(/choose files to attach/i), { target: { files: [file] } });
    expect(onStartAttachmentUpload).toHaveBeenCalledWith(file);
    await screen.findByText(/uploaded/i);
    fireEvent.change(screen.getByRole('textbox', { name: /message/i }), { target: { value: 'See plan' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(onPost).toHaveBeenCalledWith({
      anchorIds: [ANCHOR],
      body: 'See plan',
      parentMessageId: null,
      attachmentIds: ['file-plan'],
    });
  });

  it('keeps a failed upload with safe copy, retries it, and cancels through its task', async () => {
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    const onStartAttachmentUpload = vi.fn()
      .mockImplementationOnce(() => ({
        cancel: firstCancel,
        result: Promise.reject(new Error('s3://private-bucket/grant-secret')),
      }))
      .mockImplementationOnce(() => ({
        cancel: secondCancel,
        result: Promise.resolve({
          fileEntityId: 'file-retry', name: 'plan.txt', mime: 'text/plain', sizeBytes: 4, maxSizeBytes: 1024,
        }),
      }));
    render(
      <ChannelScreen
        {...base}
        page={page([])}
        onPost={vi.fn()}
        onStartAttachmentUpload={onStartAttachmentUpload}
      />,
    );
    fireEvent.change(screen.getByLabelText(/choose files to attach/i), {
      target: { files: [new File(['plan'], 'plan.txt', { type: 'text/plain' })] },
    });
    const failure = await screen.findByRole('alert');
    expect(failure.textContent).toContain('Upload failed. Try again.');
    expect(failure.textContent).not.toContain('private-bucket');
    fireEvent.click(screen.getByRole('button', { name: /try plan\.txt again/i }));
    await screen.findByText(/uploaded/i);
    fireEvent.click(screen.getByRole('button', { name: /remove plan\.txt/i }));
    expect(secondCancel).toHaveBeenCalled();
    expect(screen.queryByText('plan.txt')).toBeNull();
  });

  it('opens available options when @ is typed and posts the selected canonical member id', async () => {
    const onPost = vi.fn().mockResolvedValue(undefined);
    render(
      <ChannelScreen
        {...base}
        page={page([])}
        onPost={onPost}
        mentionOptions={[
          { id: 'member-noor', kind: 'member', display: 'Noor' },
          { id: 'team-forge', kind: 'team_member', display: 'Forge' },
        ]}
      />,
    );
    const textarea = screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '@', selectionStart: 1 } });
    expect(screen.getByRole('listbox', { name: /available @tag options/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /noor/i }));
    expect(textarea.value).toBe('@Noor ');
    fireEvent.change(textarea, { target: { value: `${textarea.value.trimEnd()} please review` } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(onPost).toHaveBeenCalledWith({
      anchorIds: [ANCHOR],
      body: '@Noor please review',
      parentMessageId: null,
      mentionIds: ['member-noor'],
    }));
  });

  it('filters the @ list by what was typed as a PREFIX, not a substring', () => {
    render(
      <ChannelScreen
        {...base}
        page={page([])}
        onPost={vi.fn()}
        mentionOptions={[
          { id: 'member-noor', kind: 'member', display: 'Noor' },
          { id: 'team-forge', kind: 'team_member', display: 'Forge' },
          // Shares the letters "or" with Noor and Forge but starts with
          // neither — a substring filter would wrongly keep all three.
          { id: 'team-scout', kind: 'team_member', display: 'Scout Orion' },
        ]}
      />,
    );
    const textarea = screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '@no', selectionStart: 3 } });

    const names = screen.getAllByRole('option').map((option) => option.textContent);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/Noor/);

    // A later word is still a legal starting point, so a surname or the second
    // word of a session title reaches its row.
    fireEvent.change(textarea, { target: { value: '@ori', selectionStart: 4 } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toHaveLength(1);
    expect(screen.getByRole('option').textContent).toMatch(/Scout Orion/);
  });

  it('walks the @ list with the arrow keys and commits the highlighted row with Enter', () => {
    const onPost = vi.fn().mockResolvedValue(undefined);
    render(
      <ChannelScreen
        {...base}
        page={page([])}
        onPost={onPost}
        mentionOptions={[
          { id: 'member-noor', kind: 'member', display: 'Noor' },
          { id: 'member-alex', kind: 'member', display: 'Alex' },
          { id: 'member-remy', kind: 'member', display: 'Remy' },
        ]}
      />,
    );
    const textarea = screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '@', selectionStart: 1 } });

    const active = (): string | null =>
      screen.getAllByRole('option').find((o) => o.getAttribute('data-active') === 'true')?.textContent ?? null;

    expect(active()).toMatch(/Noor/);
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(active()).toMatch(/Alex/);
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(active()).toMatch(/Noor/);
    // Wraps rather than dead-ending at the first row.
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(active()).toMatch(/Remy/);

    // Enter takes the highlighted target; it must NOT send the message while
    // the picker owns the key.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onPost).not.toHaveBeenCalled();
    expect(textarea.value).toBe('@Remy ');
    expect(screen.queryByRole('listbox', { name: /available @tag options/i })).toBeNull();
  });

  it('emits a work-session @Tag as a Channel routing target, not an invalid mention', async () => {
    const onPost = vi.fn().mockResolvedValue(undefined);
    render(
      <ChannelScreen
        {...base}
        page={page([])}
        onPost={onPost}
        mentionOptions={[{
          id: 'session-review',
          kind: 'work_session',
          display: 'Review session',
          group: 'Work sessions',
          meta: 'Live · message this session',
          route: { kind: 'existing-session', sessionId: 'session-review' },
        }]}
      />,
    );
    const textarea = screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '@', selectionStart: 1 } });
    fireEvent.click(screen.getByRole('option', { name: /review session/i }));
    fireEvent.change(textarea, { target: { value: '@Review session please inspect' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => expect(onPost).toHaveBeenCalledWith({
      anchorIds: [ANCHOR],
      body: '@Review session please inspect',
      parentMessageId: null,
      tagTargetIds: ['session-review'],
    }));
  });

  it('attaches a task as a message anchor and a person as a mention, from the workspace picker', async () => {
    const onPost = vi.fn().mockResolvedValue(undefined);
    render(
      <ChannelScreen
        {...base}
        page={page([])}
        onPost={onPost}
        attachEntityOptions={[
          { id: 'task-114', kind: 'task', display: 'Align the rail', group: 'Tasks', attach: 'anchor' },
          { id: 'member-noor', kind: 'member', display: 'Noor', group: 'People' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /attach from workspace/i }));
    fireEvent.click(screen.getByRole('option', { name: /align the rail/i }));
    fireEvent.click(screen.getByRole('button', { name: /attach from workspace/i }));
    fireEvent.click(screen.getByRole('option', { name: /noor/i }));

    const staged = screen.getByRole('list', { name: /attached workspace entities/i });
    expect(within(staged).getByText('Align the rail')).toBeTruthy();

    const ta = screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'Please review against the spec.' } });
    // Attaching never edits the draft — the words stay the user's own.
    expect(ta.value).toBe('Please review against the spec.');
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(onPost).toHaveBeenCalledWith({
      anchorIds: [ANCHOR, 'task-114'],
      body: 'Please review against the spec.',
      parentMessageId: null,
      mentionIds: ['member-noor'],
    }));
  });

  it('refuses to attach a workspace entity on a REPLY, keeping the draft', async () => {
    const onPost = vi.fn().mockResolvedValue(undefined);
    render(
      <ChannelScreen
        {...base}
        page={page([messageItem()])}
        onPost={onPost}
        attachEntityOptions={[
          { id: 'task-114', kind: 'task', display: 'Align the rail', group: 'Tasks', attach: 'anchor' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /attach from workspace/i }));
    fireEvent.click(screen.getByRole('option', { name: /align the rail/i }));
    fireEvent.click(screen.getByRole('button', { name: /reply to alex/i }));
    const ta = screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'reply with a task attached' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/top-level/i);
    expect(onPost).not.toHaveBeenCalled();
    expect(ta.value).toBe('reply with a task attached');
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

  it('renders the provenance line ABOVE the feed, at the paging boundary it describes', () => {
    // D2: the chat surface ends at the composer. S09's honesty line is kept —
    // relocated to the top of the feed beside "load earlier ↑", because it
    // states the paging boundary, and the boundary is where earlier pages load.
    render(
      <ChannelScreen
        {...base}
        page={page([messageItem()], { nextCursor: 'cur-1' as never })}
        onLoadEarlier={vi.fn()}
      />,
    );
    const provenance = screen.getByTestId('chs-provenance');
    const list = screen.getByRole('list', { name: 'Messages and activity' });
    expect(provenance.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const earlier = screen.getByRole('button', { name: /load earlier/i });
    expect(provenance.compareDocumentPosition(earlier) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it('preserves the visible scroll anchor when an older page is prepended', () => {
    const b = msg({ id: 'msg-b' });
    const c = msg({ id: 'msg-c' });
    const a = msg({ id: 'msg-a' });
    const view = render(<ChannelScreen {...base} page={page([
      messageItem({ itemId: 'feed-b' }, b),
      messageItem({ itemId: 'feed-c' }, c),
    ])} />);
    const region = screen.getByRole('region', { name: /chat history/i });
    let height = 1000;
    Object.defineProperty(region, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(region, 'clientHeight', { configurable: true, get: () => 200 });
    region.scrollTop = 300;
    fireEvent.scroll(region);
    height = 1200;
    view.rerender(<ChannelScreen {...base} page={page([
      messageItem({ itemId: 'feed-a' }, a),
      messageItem({ itemId: 'feed-b' }, b),
      messageItem({ itemId: 'feed-c' }, c),
    ])} />);
    expect(region.scrollTop).toBe(500);
  });

  it('auto-follows only near newest and otherwise offers a non-disruptive new-items control', () => {
    const a = msg({ id: 'msg-a' });
    const b = msg({ id: 'msg-b' });
    const c = msg({ id: 'msg-c' });
    const view = render(<ChannelScreen {...base} page={page([
      messageItem({ itemId: 'feed-a' }, a),
      messageItem({ itemId: 'feed-b' }, b),
    ])} />);
    const region = screen.getByRole('region', { name: /chat history/i });
    let height = 1000;
    Object.defineProperty(region, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(region, 'clientHeight', { configurable: true, get: () => 200 });
    region.scrollTop = 100;
    fireEvent.scroll(region);
    height = 1100;
    view.rerender(<ChannelScreen {...base} page={page([
      messageItem({ itemId: 'feed-a' }, a),
      messageItem({ itemId: 'feed-b' }, b),
      messageItem({ itemId: 'feed-c' }, c),
    ])} />);
    expect(region.scrollTop).toBe(100);
    const jump = screen.getByRole('button', { name: /1 new item/i });
    fireEvent.click(jump);
    expect(region.scrollTop).toBe(900);
  });

  it('enables measured content virtualization only at the long-feed threshold', () => {
    const observed: Element[] = [];
    const prior = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe(element: Element) { observed.push(element); }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const items = Array.from({ length: 100 }, (_, index) => {
        const message = msg({ id: `msg-${index}` });
        return messageItem({ itemId: `feed-${index}` }, message);
      });
      render(<ChannelScreen {...base} page={page(items)} />);
      const list = screen.getByRole('list', { name: /messages and activity/i });
      expect(list.getAttribute('data-virtualized')).toBe('true');
      expect(observed.length).toBe(100);
      expect(screen.getAllByRole('article')).toHaveLength(100);
    } finally {
      globalThis.ResizeObserver = prior;
    }
  });

  it('announces connection changes and supports Escape for picker and reply cancellation', () => {
    const view = render(
      <ChannelScreen
        {...base}
        page={page([messageItem()])}
        onPost={vi.fn()}
        connection={{ phase: 'offline', disconnectedSince: '2026-07-30T00:00:00.000Z' }}
        mentionOptions={[{ id: 'member-noor', kind: 'member', display: 'Noor' }]}
      />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/offline/i);
    // The picker has no field of its own: the toolbar `@` types the trigger
    // into the message and leaves focus there, so Escape is pressed on the
    // textarea — the same key the typed-`@` path answers to.
    fireEvent.click(screen.getByRole('button', { name: /mention someone/i }));
    expect(screen.getByRole('listbox', { name: /available @tag options/i })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('textbox', { name: /message/i }), { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: /available @tag options/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /reply to alex/i }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: /message/i }), { key: 'Escape' });
    expect(screen.queryByTestId('chs-replying')).toBeNull();
    view.rerender(
      <ChannelScreen {...base} page={page([messageItem()])} onPost={vi.fn()} connection={{ phase: 'live' }} />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/connected/i);
  });
});

/**
 * THE BLOCK SIGNAL, ON THE CHAT SIDE.
 *
 * The terminal has shown "needs you" since R8. Both surfaces are mounted at
 * once and only one is visible (WorkSessionContent keeps the terminal mounted
 * unconditionally and the chat mounted-once-then-kept), so a signal drawn only
 * in the terminal is invisible to precisely the reader this feature exists for:
 * someone watching chat who cannot see the PTY. That invisibility IS the
 * terminal/chat disagreement, in its smallest form.
 */
describe('the needs-you strip', () => {
  it('is absent by default — no strip without a measurement', () => {
    render(<ChannelScreen {...base} page={page([messageItem()])} />);
    expect(screen.queryByTestId('chs-needs-you')).toBeNull();
  });

  it('announces the block politely and states what was measured', () => {
    render(
      <ChannelScreen
        {...base}
        page={page([messageItem()])}
        needsAttention
        attentionDetail="no terminal output for a while — it may be waiting for you."
      />,
    );
    const strip = screen.getByTestId('chs-needs-you');
    expect(strip.getAttribute('aria-live')).toBe('polite');
    expect(strip.textContent).toMatch(/needs you/i);
    // The DETAIL is the host's sentence, rendered verbatim. The component must
    // not compose its own claim about what the agent wants: the detector behind
    // this knows only that bytes stopped, and a component that phrased it as a
    // question would be inventing one.
    expect(strip.textContent).toMatch(/no terminal output for a while/i);
  });

  it('offers the terminal as the way to answer, because chat cannot yet', () => {
    const onSwitchToTerminal = vi.fn();
    render(
      <ChannelScreen
        {...base}
        page={page([messageItem()])}
        needsAttention
        onSwitchToTerminal={onSwitchToTerminal}
      />,
    );
    fireEvent.click(
      within(screen.getByTestId('chs-needs-you')).getByRole('button', { name: /terminal/i }),
    );
    expect(onSwitchToTerminal).toHaveBeenCalledTimes(1);
  });

  it('renders with no detail and no terminal switch rather than inventing either', () => {
    // A channel anchor has no terminal, and a host that measured a block but has
    // no sentence for it still has something true to say. Neither absence may
    // become a fabricated string or a dead button (R7/L6).
    render(<ChannelScreen {...base} page={page([messageItem()])} needsAttention />);
    const strip = screen.getByTestId('chs-needs-you');
    expect(strip.textContent).toMatch(/needs you/i);
    expect(within(strip).queryByRole('button')).toBeNull();
  });
});
