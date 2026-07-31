// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { expect, it, vi } from 'vitest';
import type { EntityFeedPage, FeedItem, MessageView } from '@tm8/contract';
import { ChannelScreen } from './ChannelScreen';

it('has no critical or serious automated accessibility findings in a rich Chat state', async () => {
  const message = {
    id: 'message-a11y',
    kind: 'message',
    title: '',
    spaceId: 'space-a11y',
    parentId: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    createdBy: { id: 'member-a11y', displayName: 'Ada', isAgent: false },
    state: {
      kind: 'message', anchorId: 'session-a11y', rootMessageId: null,
      author: { id: 'member-a11y', displayName: 'Ada', isAgent: false },
      messageBatchId: null, editedAt: null,
    },
    content: {
      kind: 'message', body: 'Review the attached plan.',
      mentions: [{ entityId: 'member-noor', kind: 'member', display: 'Noor' }],
      attachments: [{ fileEntityId: 'file-plan', name: 'plan.txt', mime: 'text/plain' }],
    },
    replyCount: 0,
  } as unknown as MessageView;
  const item = {
    itemId: 'feed-a11y',
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
  } as FeedItem;
  const page: EntityFeedPage = {
    resolvedScope: 'session_chat_v1', predicates: ['anchored'], items: [item], nextCursor: null,
  };
  const view = render(
    <main>
      <ChannelScreen
        anchorId="session-a11y"
        anchorNoun="this session"
        page={page}
        connection={{ phase: 'live' }}
        onPost={vi.fn()}
        onOpenEntity={vi.fn()}
        onStartAttachmentUpload={() => ({ cancel: vi.fn(), result: new Promise(() => undefined) })}
        mentionOptions={[{ id: 'member-noor', kind: 'member', display: 'Noor' }]}
      />
    </main>,
  );
  fireEvent.click(screen.getByRole('button', { name: /mention someone/i }));

  const results = await axe.run(view.container, {
    // jsdom cannot calculate rendered contrast; production colors remain
    // covered by the forced-colors/high-contrast stylesheet gate.
    rules: { 'color-contrast': { enabled: false } },
  });
  const blocking = results.violations.filter((violation) =>
    violation.impact === 'critical' || violation.impact === 'serious');
  expect(blocking, blocking.map((violation) => `${violation.id}: ${violation.help}`).join('\n')).toEqual([]);
});
