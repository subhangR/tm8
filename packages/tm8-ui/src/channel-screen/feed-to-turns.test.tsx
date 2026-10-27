// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { EntityFeedPage, FeedItem, MessageView } from '@tm8/contract';
import { ChannelScreen } from './ChannelScreen';
import { chatTurnFromMessage } from './feed-to-turns';

/*
 * The channel view draws every message with chat's own `ChatTurn` (task
 * 01a14c1e). These pin the mapping and the three chat facts a reader sees:
 * a person's message is a bubble, an agent's is an answer, and the viewer's
 * own message sits on the right.
 */

const ANCHOR = 'ent-channel';
const ALEX = { id: 'act-alex', displayName: 'alex', isAgent: false };
const FORGE = { id: 'act-forge', displayName: 'Forge', isAgent: true };

function msg(over: Partial<MessageView> & { author?: typeof ALEX } = {}): MessageView {
  const { author = ALEX, ...rest } = over;
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
    content: { kind: 'message', body: 'Ship the **guide** first.', mentions: [], attachments: [] },
    replyCount: 0,
    ...rest,
  } as unknown as MessageView;
}

function page(messages: MessageView[]): EntityFeedPage {
  return {
    items: messages.map((message) => ({
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
    })) as FeedItem[],
    nextCursor: null,
    resolvedScope: 'direct_v1',
    predicates: ['anchored'],
  } as unknown as EntityFeedPage;
}

describe('chatTurnFromMessage', () => {
  it('maps a person’s message to a user turn carrying its body and files', () => {
    const turn = chatTurnFromMessage(msg());
    expect(turn).toMatchObject({ messageId: 'msg-1', role: 'user', body: 'Ship the **guide** first.', parts: [] });
    expect(turn.author?.id).toBe('act-alex');
  });

  it('maps an agent’s plain report to an answer — one text part, as chat draws it', () => {
    const turn = chatTurnFromMessage(msg({ author: FORGE as typeof ALEX }));
    expect(turn.role).toBe('assistant');
    expect(turn.parts).toEqual([{ seq: 0, kind: 'text', text: 'Ship the **guide** first.' }]);
  });

  it('leaves an in-flight agent turn with no parts empty — the body is only the claim placeholder', () => {
    const turn = chatTurnFromMessage(msg({ author: FORGE as typeof ALEX, turnInFlight: true } as Partial<MessageView>));
    expect(turn.parts).toEqual([]);
    expect(turn.turnInFlight).toBe(true);
  });
});

describe('the channel feed draws chat turns', () => {
  it('a person’s message is chat’s markdown bubble; an agent’s is an answer with no bubble', () => {
    render(
      <ChannelScreen
        anchorId={ANCHOR}
        anchorNoun="this channel"
        page={page([msg(), msg({ id: 'msg-2', author: FORGE as typeof ALEX, createdAt: '2026-07-29T11:25:00.000Z' })])}
      />,
    );
    const turns = screen.getAllByRole('article');
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => turn.classList.contains('tch-turn'))).toBe(true);
    expect(turns[0]!.querySelector('.tch-user-body strong')?.textContent).toBe('guide');
    expect(turns[1]!.getAttribute('data-role')).toBe('assistant');
    expect(turns[1]!.querySelector('.tch-user-body')).toBeNull();
  });

  it('puts the viewer’s own message on the right, and nobody’s without a viewer', () => {
    const { rerender } = render(
      <ChannelScreen anchorId={ANCHOR} anchorNoun="this channel" page={page([msg()])} viewerActorId="act-alex" />,
    );
    expect(screen.getByRole('article').getAttribute('data-self')).toBe('true');
    rerender(<ChannelScreen anchorId={ANCHOR} anchorNoun="this channel" page={page([msg()])} />);
    expect(screen.getByRole('article').getAttribute('data-self')).toBe('false');
  });
});
