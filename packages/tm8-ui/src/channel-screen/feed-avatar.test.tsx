// @vitest-environment jsdom
/**
 * Message-author avatars in the feed gutter (identity display, 067).
 *
 * The contract's `ActorSummary` has carried `avatar` all along; the gutter
 * simply never passed it. These tests pin both directions: a URL reaches the
 * img, and the ABSENT avatar — every author today — still renders the
 * monogram gutter it always did, because empty is the normal state.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { FeedItem, MessageView } from '@tm8/contract';
import { FeedRowGroup } from './FeedRow';

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
    content: { kind: 'message', body: 'hello', mentions: [], attachments: [] },
    replyCount: 0,
    ...over,
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

function renderRow(message: MessageView) {
  return render(
    <ul>
      <FeedRowGroup
        group={{ kind: 'single', item: item(message) }}
        anchorId={ANCHOR}
        handlers={{}}
      />
    </ul>,
  );
}

describe('feed gutter author avatars', () => {
  it('no avatar on the author — the monogram, no img (every author today)', () => {
    const { container } = renderRow(msg());
    expect(container.querySelector('.chs-gutter .kit-avatar')).not.toBeNull();
    expect(container.querySelector('.chs-gutter .kit-avatar__img')).toBeNull();
  });

  it('an author avatar URL reaches the gutter img', () => {
    const withAvatar = msg({
      state: {
        kind: 'message',
        anchorId: ANCHOR,
        author: {
          id: 'act-1',
          displayName: 'alex',
          isAgent: false,
          avatar: 'https://example.test/alex.png',
        },
        messageBatchId: null,
      },
    } as Partial<MessageView>);
    const { container } = renderRow(withAvatar);
    expect(
      container.querySelector('.chs-gutter .kit-avatar__img')?.getAttribute('src'),
    ).toBe('https://example.test/alex.png');
    // The byline name is still the text carrier — never the image alone.
    expect(container.querySelector('.chs-byline__who')?.textContent).toBe('alex');
  });
});
