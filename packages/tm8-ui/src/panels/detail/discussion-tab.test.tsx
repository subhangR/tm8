// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
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
