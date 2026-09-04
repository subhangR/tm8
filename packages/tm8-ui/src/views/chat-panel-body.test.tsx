// @vitest-environment jsdom
/**
 * THE CHAT ENTITY'S PANEL BODY — the transcript, and nothing above it.
 *
 * Opening a chat from a list tile, from a chip, or from `/entity/{id}` must
 * show the CONVERSATION. Before Wave 2 it showed the generic fields list: a
 * kind with no content arm (`{ kind: 'chat' }` — contract R5) rendering an
 * empty section where the messages should be.
 *
 * THE THREE THINGS THIS PINS, and each has its own way of silently regressing:
 *
 *   1. the archetype resolves to the conversation arm — a `kind === 'chat'`
 *      literal in the panel would work and be a §15.2 build failure waiting to
 *      happen, so the answer lives on the registry row;
 *   2. the SURFACE the composer picks is the chat thread, not the session
 *      transcript the non-hub default would have given it; and
 *   3. the body owns its own bottom edge, so the panel mounts no attachment
 *      strip and no footer under a conversation that ends at its composer.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityDetail } from '@tm8/contract';
import { getKind } from '../domain';
import { fixtureDetails } from '../fixtures';
import {
  conversationSurfaceFor,
  defaultConversationSurfaceKind,
  type ConversationSurfaceHost,
} from './conversationSurface';

const chatDetail = (): EntityDetail => {
  const found = Object.values(fixtureDetails).find((d) => d.kind === 'chat');
  if (!found) throw new Error('the fixture set carries no chat detail');
  return found;
};

describe('the chat kind resolves the conversation body from REGISTRY DATA', () => {
  it('declares the conversation archetype and names its own surface', () => {
    const row = getKind('chat');
    expect(row.panel.archetype).toBe('conversation');
    // WHICH conversation, as data. Without this the composer's archetype
    // fallback answers 'transcript' — a chat would mount the session's
    // `execution.transcript` reader, which for a chat is a file that does not
    // exist. It would render an empty surface rather than an error, which is
    // exactly the kind of wrong that survives review.
    expect(row.panel.conversation).toBe('chat-thread');
  });

  it('picks the chat thread over the non-hub default', () => {
    expect(defaultConversationSurfaceKind(chatDetail())).toBe('chat-thread');
    // The default is unchanged for everything that does not name a surface:
    // a hub still gets its channel feed, everything else the transcript.
    const channel = Object.values(fixtureDetails).find((d) => d.kind === 'channel')!;
    const doc = Object.values(fixtureDetails).find((d) => d.kind === 'doc')!;
    expect(defaultConversationSurfaceKind(channel)).toBe('channel-feed');
    expect(defaultConversationSurfaceKind(doc)).toBe('transcript');
  });

  it('ends at its composer: no strip, no attention section, no footer', () => {
    // `composition` is what the panel's exclusion gate reads, and that gate
    // tests PRESENCE rather than the value — so this is the whole claim.
    expect(getKind('chat').panel.composition).toBe('chat');
    // A chat is FLAT (176 §1.3: every turn is a root message on the chat), so
    // the thread pane must not be offered. `panel.threads` absent is that.
    expect(getKind('chat').panel.threads).toBeUndefined();
  });
});

describe('the composed surface is the chat screen', () => {
  const host = (): ConversationSurfaceHost => ({
    seam: { fixtureControls: {} } as never,
    spaceId: 'space-fixture',
    connection: 'open' as never,
    livenessOf: () => 'unknown' as never,
    channelFeedPort: { seam: { messages: () => undefined } } as never,
    nodeKey: 'local',
    onOpenEntity: () => undefined,
    onSwitchToTerminal: () => undefined,
  });

  it('mounts a surface for a chat rather than returning nothing', async () => {
    const detail = chatDetail();
    const node = conversationSurfaceFor(detail, detail.id, host());
    expect(node).not.toBeUndefined();
    const view = render(<>{node}</>);
    /* The arm is behind a route boundary (`lazy`), exactly like the other
       three, so the first paint is its Suspense fallback. Asserting THAT is
       the honest synchronous claim: something mounted, and it is the chat
       chunk's loader rather than the panel's "unavailable in this view" alert
       — which is what a missing arm would have rendered. */
    expect(view.container.querySelector('.tch-load')).not.toBeNull();
    expect(view.container.querySelector('.pn-surface-host-missing')).toBeNull();
    view.unmount();
  });
});
