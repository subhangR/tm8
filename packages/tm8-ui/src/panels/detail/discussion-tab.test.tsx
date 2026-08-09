// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { MessageView } from '@tm8/contract';
import { DiscussionTab } from './tabs';

function message(
  id: string,
  body: string,
  options: {
    rootId?: string | null;
    parentId?: string | null;
    agent?: boolean;
    replyCount?: number;
    replies?: MessageView[];
  } = {},
): MessageView {
  const author = {
    id: options.agent ? 'agent-1' : 'member-1',
    displayName: options.agent ? 'forge' : 'alex',
    isAgent: options.agent ?? false,
  };
  return {
    id,
    kind: 'message',
    title: '',
    spaceId: 'space-1',
    parentId: options.parentId ?? options.rootId ?? null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: '2026-08-03T00:00:00.000Z',
    createdAt: id === 'reply-1' ? '2026-08-03T00:01:00.000Z' : '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    deletedAt: null,
    createdBy: author,
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    badges: {},
    state: {
      kind: 'message',
      anchorId: 'task-1',
      rootMessageId: options.rootId ?? null,
      author,
      messageBatchId: null,
    },
    content: { kind: 'message', body, mentions: [], attachments: [] },
    replyCount: options.replyCount ?? 0,
    ...(options.replies ? { replies: { items: options.replies, nextCursor: null } } : {}),
  } as MessageView;
}

describe('DiscussionTab reply context', () => {
  it('renders an embedded agent response under its parent with explicit reply wording', () => {
    const reply = message('reply-1', 'I handled the requested change.', { rootId: 'root-1', agent: true });
    const root = message('root-1', 'Please update the channel message UI.', {
      replyCount: 1,
      replies: [reply],
    });

    render(
      <DiscussionTab
        messages={[root]}
        provenanceHollowReason="Not recorded"
      />,
    );

    const replies = screen.getByRole('list', { name: /replies to alex/i });
    expect(within(replies).getByText('forge')).toBeTruthy();
    const context = within(replies).getByTestId('pn-msg-reply-context');
    expect(context.textContent).toContain('in reply to');
    expect(context.textContent).toContain('alex');
    expect(context.textContent).toContain('Please update the channel message UI.');
    expect(within(replies).getByText('I handled the requested change.')).toBeTruthy();
  });

  it('keeps reply context visible when the bounded page does not contain its parent', () => {
    const reply = message('reply-1', 'Orphaned page reply.', { rootId: 'root-outside-page', agent: true });
    render(<DiscussionTab messages={[reply]} provenanceHollowReason="Not recorded" />);
    expect(screen.getByTestId('pn-msg-reply-context').textContent).toContain('root-outside-page');
  });

  it('quotes the direct parent of a nested response', () => {
    const first = message('reply-1', 'First response.', { rootId: 'root-1', agent: true });
    const nested = message('reply-2', 'Nested response.', {
      rootId: 'root-1',
      parentId: 'reply-1',
      agent: true,
    });
    const root = message('root-1', 'Root request.', { replyCount: 2, replies: [first, nested] });
    render(<DiscussionTab messages={[root]} provenanceHollowReason="Not recorded" />);
    const nestedRow = document.querySelector('[data-message-id="reply-2"]')!;
    const context = within(nestedRow as HTMLElement).getByTestId('pn-msg-reply-context');
    expect(context.textContent).toContain('First response.');
    expect(context.textContent).not.toContain('Root request.');
  });
});

/**
 * THE DISCUSSION TAB DRAWS THE SAME BODY THE CHANNEL DOES — the defect these pin.
 *
 * A message body is markdown, and the channel feed learned to render it while
 * this tab kept drawing one flat `<p>`. The same message therefore read as a
 * heading in a channel and as a literal `##` in the panel beside it.
 */
describe('a discussion message body is markdown', () => {
  function bodyOf(markdown: string, mentions: MessageView['content']['mentions'] = []) {
    const root = message('root-1', markdown);
    (root.content as { mentions: unknown }).mentions = mentions;
    const { container } = render(
      <DiscussionTab messages={[root]} provenanceHollowReason="Not recorded" />,
    );
    return container;
  }

  it('a heading, bold and a list are DRAWN, not printed as their source', () => {
    const container = bodyOf('## Status\n\n**done** and:\n\n- one\n- two');
    expect(container.querySelector('.pn-msg__body h2')?.textContent).toBe('Status');
    expect(container.querySelector('.pn-msg__body strong')?.textContent).toBe('done');
    expect(container.querySelectorAll('.pn-msg__body li')).toHaveLength(2);
    expect(container.textContent).not.toContain('**done**');
  });

  it('a fenced block and a GFM table survive into the panel', () => {
    expect(bodyOf('```sql\nselect 1;\n```').querySelector('.pn-msg__body .md-fence')?.getAttribute('data-lang')).toBe('sql');
    expect(bodyOf('| a | b |\n| --- | --- |\n| 1 | 2 |').querySelectorAll('.pn-msg__body .md-table th')).toHaveLength(2);
  });

  it('RAW HTML IS NOT RENDERED — a body is untrusted text other members read', () => {
    const container = bodyOf('hi <img src=x onerror="alert(1)"> there');
    expect(container.querySelector('.pn-msg__body img')).toBeNull();
    expect(container.textContent).toContain('onerror');
  });

  it('a mention with NO handler is marked-up text — never a control that opens nothing', () => {
    const container = bodyOf('ping @Haiku 4.5 now', [
      { entityId: 'ent-haiku', kind: 'team_member', display: 'Haiku 4.5' },
    ]);
    expect(container.querySelector('.pn-msg__mention')?.textContent).toBe('@Haiku 4.5');
    // No button, and no dead anchor pointing at the mention's own href.
    expect(container.querySelector('.pn-msg__body button')).toBeNull();
    expect(container.querySelector('a[href^="#tm8-mention-"]')).toBeNull();
  });

  it('a mention WITH a handler opens the entity it names', () => {
    const onOpenEntity = vi.fn();
    const root = message('root-1', 'ping @Haiku 4.5 now');
    (root.content as { mentions: unknown }).mentions = [
      { entityId: 'ent-haiku', kind: 'team_member', display: 'Haiku 4.5' },
    ];
    render(
      <DiscussionTab
        messages={[root]}
        provenanceHollowReason="Not recorded"
        onOpenEntity={onOpenEntity}
      />,
    );
    const button = screen.getByRole('button', { name: 'Open mention Haiku 4.5' });
    button.click();
    expect(onOpenEntity).toHaveBeenCalledWith('ent-haiku');
  });

  it('an href NOBODY vouched for stays text — a look-alike is not a mention', () => {
    // The mention list is the authority; a body may contain a hand-written
    // `#tm8-mention-…` link, and it must never become a live control.
    const root = message('root-1', '[@ghost](#tm8-mention-ent-nobody)');
    const { container } = render(
      <DiscussionTab
        messages={[root]}
        provenanceHollowReason="Not recorded"
        onOpenEntity={vi.fn()}
      />,
    );
    expect(container.querySelector('.pn-msg__body button')).toBeNull();
    expect(container.querySelector('.pn-msg__mention')?.textContent).toBe('@ghost');
  });

  it('the reply-context excerpt stays FLAT — a body cut mid-fence would swallow the row', () => {
    const reply = message('reply-1', 'ack', { rootId: 'root-1', agent: true });
    const root = message('root-1', '## Heading\n\n```sh\nrun me', { replyCount: 1, replies: [reply] });
    render(<DiscussionTab messages={[root]} provenanceHollowReason="Not recorded" />);
    const context = screen.getByTestId('pn-msg-reply-context');
    expect(context.textContent).toContain('## Heading');
    expect(context.querySelector('.md-root')).toBeNull();
  });
});
