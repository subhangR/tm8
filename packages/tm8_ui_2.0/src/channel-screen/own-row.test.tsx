// @vitest-environment jsdom
/**
 * OWN-MESSAGE SIDEDNESS (user ruling 2026-08-18): the viewer's rows carry
 * `data-own` so the stylesheet can seat them right-in-a-bubble; everyone
 * else's rows — and every row on a surface that never learned the viewer —
 * carry nothing. Purely presentational: DOM order never changes.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { FeedItem, MessageView } from '@tm8/contract';
import { FeedRowGroup } from './FeedRow';

const ANCHOR = 'ent-channel';

function msg(authorId: string): MessageView {
  return {
    id: `msg-${authorId}`,
    kind: 'message',
    title: '',
    spaceId: 'sp-1',
    parentId: null,
    createdAt: '2026-08-18T11:24:00.000Z',
    updatedAt: '2026-08-18T11:24:00.000Z',
    deletedAt: null,
    version: 1,
    createdBy: { id: authorId, displayName: 'alex', isAgent: false },
    state: {
      kind: 'message',
      anchorId: ANCHOR,
      author: { id: authorId, displayName: 'alex', isAgent: false },
      messageBatchId: null,
    },
    content: { kind: 'message', body: 'hello', mentions: [], attachments: [] },
    replyCount: 0,
  } as unknown as MessageView;
}

function item(message: MessageView): FeedItem {
  return {
    itemId: `feed-${message.id}`,
    createdAt: message.createdAt,
    sortId: `${message.createdAt}#${message.id}`,
    via: ['anchored'],
    actor: message.state.kind === 'message' ? message.state.author : null,
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: null,
    itemKind: 'message',
    message,
    delivery: [],
  } as FeedItem;
}

function renderRow(message: MessageView, viewerActorId?: string) {
  return render(
    <ul>
      <FeedRowGroup
        group={{ kind: 'single', item: item(message) }}
        anchorId={ANCHOR as never}
        handlers={{}}
        viewerActorId={viewerActorId}
      />
    </ul>,
  );
}

describe('own-message rows', () => {
  it("the viewer's own message carries data-own", () => {
    const { container } = renderRow(msg('me'), 'me');
    expect(container.querySelector('.chs-row')?.hasAttribute('data-own')).toBe(true);
  });

  it("someone else's message does not", () => {
    const { container } = renderRow(msg('them'), 'me');
    expect(container.querySelector('.chs-row')?.hasAttribute('data-own')).toBe(false);
  });

  it('a surface that never learned the viewer marks nothing', () => {
    const { container } = renderRow(msg('me'));
    expect(container.querySelector('.chs-row')?.hasAttribute('data-own')).toBe(false);
  });
});
