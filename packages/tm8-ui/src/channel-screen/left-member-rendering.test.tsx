// @vitest-environment jsdom
/**
 * G6 W1-client — a left member's old content renders with "(left)".
 *
 * The server keeps the member row (tombstone, migration 232) and says the
 * membership ended on the actor itself: `ActorSummary.memberStatus` is
 * `left` or `removed`, absent while active, and a persona carries its
 * owner's status. Every byline and assignee label goes through `actorName`,
 * so these tests pin the surfaces a reader actually meets: a message byline,
 * a message's author name, an actor ref, and a task's assignees.
 */
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ActorSummary, EntitySummary, FeedItem, MessageView } from '@tm8/contract';
import { FeedRowGroup } from './FeedRow';
import { actorName, LEFT_SUFFIX } from '../domain';
import { ActorRef } from '../kit/ActorRef';
import { authorNameOf } from '../messages/messages-model';
import { MaestroTaskTile } from '../panels/list/MaestroTaskTile';

afterEach(cleanup);

const ANCHOR = 'ent-channel';
const LEFT: ActorSummary = { id: 'act-noor', kind: 'member', displayName: 'Noor', isAgent: false, memberStatus: 'left' };
const REMOVED: ActorSummary = { ...LEFT, memberStatus: 'removed' };
const ACTIVE: ActorSummary = { id: 'act-ada', kind: 'member', displayName: 'Ada', isAgent: false };
const PERSONA_OF_LEFT: ActorSummary = {
  id: 'act-scout', kind: 'team_member', displayName: 'scout', isAgent: true, memberStatus: 'left',
};

function msg(author: ActorSummary): MessageView {
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
    createdBy: author,
    state: { kind: 'message', anchorId: ANCHOR, author, messageBatchId: null },
    content: { kind: 'message', body: 'hello', mentions: [], attachments: [] },
    replyCount: 0,
  } as unknown as MessageView;
}

function renderRow(message: MessageView) {
  const item = {
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
  } as unknown as FeedItem;
  return render(
    <ul>
      <FeedRowGroup group={{ kind: 'single', item }} anchorId={ANCHOR} handlers={{}} />
    </ul>,
  );
}

describe('actorName', () => {
  it('adds "(left)" for left AND removed, and nothing while active', () => {
    expect(actorName(LEFT)).toBe(`Noor ${LEFT_SUFFIX}`);
    expect(actorName(REMOVED)).toBe('Noor (left)');
    expect(actorName(ACTIVE)).toBe('Ada');
  });
});

describe('a left member’s old messages', () => {
  it('the feed byline reads "Noor (left)"', () => {
    const { container } = renderRow(msg(LEFT));
    expect(container.querySelector('.chs-byline__who')?.textContent).toBe('Noor (left)');
  });

  it('an active author’s byline is unchanged', () => {
    const { container } = renderRow(msg(ACTIVE));
    expect(container.querySelector('.chs-byline__who')?.textContent).toBe('Ada');
  });

  it('a persona whose owner left carries the suffix too', () => {
    const { container } = renderRow(msg(PERSONA_OF_LEFT));
    expect(container.querySelector('.chs-byline__who')?.textContent).toBe('scout (left)');
  });

  it('the message list’s author name carries it', () => {
    expect(authorNameOf(msg(REMOVED) as unknown as EntitySummary)).toBe('Noor (left)');
    expect(authorNameOf(msg(ACTIVE) as unknown as EntitySummary)).toBe('Ada');
  });

  it('an actor ref carries it', () => {
    render(<ActorRef actor={LEFT} />);
    expect(screen.getByTestId('actor-ref').textContent).toContain('Noor (left)');
  });
});

describe('a left member’s assignments', () => {
  function tile(assignees: ActorSummary[], creator: ActorSummary | null = null) {
    return render(
      <MaestroTaskTile
        rootRef={createRef<HTMLDivElement>()}
        id="task-1"
        title="Ship it"
        depth={0}
        selected={false}
        attention={false}
        archived={false}
        childCount={0}
        childrenExpanded={false}
        status={{ label: 'open', tone: 'idle', hollow: true, streaming: false }}
        assignees={assignees}
        creator={creator}
        actions={null}
        detailsExpanded={false}
        flowOpen={false}
        onToggleDetails={() => undefined}
      />,
    );
  }

  it('the assignee group names "Noor (left)" beside an active assignee', () => {
    tile([LEFT, ACTIVE]);
    expect(screen.getByRole('img', { name: 'Assigned to Noor (left), Ada' })).toBeTruthy();
  });

  it('the creator fallback carries it too', () => {
    tile([], REMOVED);
    expect(screen.getByRole('img', { name: 'Created by Noor (left), unassigned' })).toBeTruthy();
  });
});
