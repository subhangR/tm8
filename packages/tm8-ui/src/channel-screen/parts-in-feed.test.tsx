// @vitest-environment jsdom
/**
 * PARTS RENDER ON THE SHARED SURFACE — the capability the feed was being
 * handed and throwing away.
 *
 * `MessageView.parts` is on the ordinary message type and the shared loader
 * attaches it, so `entities.feed` has always delivered parts to this surface.
 * Until now `MessageBody` rendered `content.body` and nothing else, which is
 * why `turnInFlight`'s own docblock ("parts-aware surfaces should draw the
 * streaming parts and suppress the body") described a surface that did not
 * exist.
 *
 * These tests pin the discriminator and the two honesty rules around it.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedItem, MessagePart, MessageView } from '@tm8/contract';
import { ChannelScreen } from './ChannelScreen';

afterEach(cleanup);

const ANCHOR = '019f0000-0000-7000-8000-0000000000aa';

const ACTOR = {
  id: '019f0000-0000-7000-8000-0000000000cc',
  kind: 'team_member' as const,
  displayName: 'agent',
  isAgent: true,
};

/*
 * THE WIRE SHAPE, not the render shape — `{seq, createdAt, kind, payload}`
 * with the text nested. `wire.ts` exists precisely because the two were
 * written by different lanes and never met: reading a payload-wrapped part
 * through the flattened render type yields `undefined` in every field,
 * SILENTLY. A fixture that used the flattened shape would test the fixture
 * rather than the translation, so this builds what the server actually sends.
 */
function textPart(seq: number, text: string): MessagePart {
  return { seq, createdAt: '2026-08-18T11:00:00.000Z', kind: 'text', payload: { text } };
}

function message(overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: 'msg-1',
    kind: 'message',
    title: '',
    spaceId: 'sp-1',
    parentId: null,
    createdAt: '2026-08-18T11:00:00.000Z',
    updatedAt: '2026-08-18T11:00:00.000Z',
    deletedAt: null,
    version: 1,
    createdBy: ACTOR,
    state: {
      kind: 'message',
      anchorId: ANCHOR,
      rootMessageId: null,
      author: ACTOR,
      messageBatchId: null,
      editedAt: null,
    },
    content: { kind: 'message', body: 'the stored body', mentions: [], attachments: [] },
    counters: { messages: 0, children: 0, connections: 0 },
    ...overrides,
  } as unknown as MessageView;
}

function item(msg: MessageView): FeedItem {
  return {
    itemKind: 'message',
    itemId: msg.id,
    createdAt: msg.createdAt,
    sortId: `${msg.createdAt}#${msg.id}`,
    via: ['anchored'],
    actor: ACTOR,
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: null,
    message: msg,
    delivery: [],
  } as unknown as FeedItem;
}

function page(items: FeedItem[]) {
  return { resolvedScope: 'channel_threads_v1' as const, predicates: ['anchored' as const], items, nextCursor: null };
}

function mount(msg: MessageView) {
  return render(
    <ChannelScreen anchorId={ANCHOR as never} anchorNoun="this channel" page={page([item(msg)])} />,
  );
}

describe('a message with parts draws its parts, not its body', () => {
  it('renders the part text and SUPPRESSES the stored body', () => {
    const parts: MessagePart[] = [textPart(0, 'what the agent actually said')];
    mount(message({ parts }));

    expect(screen.getByText('what the agent actually said')).toBeTruthy();
    // The whole point: the body is NOT drawn alongside. Rendering both would
    // show the same turn twice, in two different renderings.
    expect(screen.queryByText('the stored body')).toBeNull();
  });

  it('falls back to the body when there are no parts — the ordinary case', () => {
    mount(message());
    expect(screen.getByText('the stored body')).toBeTruthy();
  });

  it('treats an EMPTY parts array as no parts, not as an empty turn', () => {
    // `[]` reaches here from a message the loader touched but that has no part
    // rows. Drawing an empty parts block would replace a real body with
    // nothing at all.
    mount(message({ parts: [] }));
    expect(screen.getByText('the stored body')).toBeTruthy();
  });
});

describe('an in-flight turn with no parts yet says so', () => {
  it('never draws the claim placeholder as prose', () => {
    // contract.ts:857-859 — while a turn is in flight the stored body is the
    // CLAIM PLACEHOLDER, not content. Drawing it puts words in the agent's
    // mouth, which is the one thing a transcript must not do.
    mount(message({ turnInFlight: true, content: {
      kind: 'message', body: 'Agent turn in progress.', mentions: [], attachments: [],
    } } as Partial<MessageView>));

    expect(screen.queryByText('Agent turn in progress.')).toBeNull();
    expect(screen.getByTestId('chs-turn-pending')).toBeTruthy();
  });

  it('once parts arrive they win over the pending line, even mid-flight', () => {
    const parts: MessagePart[] = [textPart(0, 'streaming so far')];
    mount(message({ turnInFlight: true, parts }));

    expect(screen.getByText('streaming so far')).toBeTruthy();
    expect(screen.queryByTestId('chs-turn-pending')).toBeNull();
  });
});
