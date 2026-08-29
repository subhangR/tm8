// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { EntityDetail, MessageView } from '@tm8/contract';
import {
  FIXTURE_NOW,
  FIXTURE_SPACE_ID,
  channelDesign,
  collectionInbox,
  fixtureDetails,
  forge,
  messageAgentNullProvenance,
  taskGuideLines,
} from '../../fixtures';
import type { ContentBlockRef } from '../../domain';
import { HubBody } from './HubBody';

/**
 * THE HUB ARCHETYPE — T0-4 frame 2, the `channel` region (oracle lines
 * 248–271 of `T0-4 Entity Detail Panels Hi-Fi.dc.html`).
 *
 * WHAT THESE TESTS ARE FOR. Two things the suite could not see before:
 *
 *  1. THE ANATOMY IS A MEASUREMENT, NOT A MEMORY. Description → pinned chips →
 *     hub-tab pills → latest-message card → redirect note, in that order. A
 *     region that silently stops rendering (an absent content member, a
 *     renamed block param) breaks a test here rather than passing quietly over
 *     a shorter panel.
 *
 *  2. IT IS AN ARCHETYPE, NOT A KIND. §15.2 fails the build on `kind ===`, but
 *     a green build proves only that the LITERAL is absent — not that the
 *     component would actually render for a second kind. So the last block
 *     renders a `collection` detail through the same component and asserts the
 *     same anatomy. That is the assertion the guard cannot make.
 *
 * The two honest-absence cases (no messages read vs. a read that returned
 * none) are asserted separately on purpose: they are different facts, and
 * collapsing them is the lie the hollow-value law exists to forbid.
 */

/** The oracle's own sentence (line 270), carried as registry DATA, never in the component. */
const REDIRECT =
  'The live feed renders in the channel hub — ⤢ Open hub. Content is the front door, never the feed.';

/** What the channel registry row is expected to declare (see the handover). */
const HUB_BLOCKS: readonly ContentBlockRef[] = [
  { block: 'items', label: 'PINNED', params: { source: 'pinned' } },
  { block: 'notice', params: { text: REDIRECT } },
];

function channelDetail(): EntityDetail {
  const d = fixtureDetails[channelDesign.id];
  if (!d) throw new Error('fixtures must supply a channel detail');
  return d;
}

function collectionDetail(): EntityDetail {
  const d = fixtureDetails[collectionInbox.id];
  if (!d) throw new Error('fixtures must supply a collection detail');
  return d;
}

/**
 * A contract-typed `MessageView`, built from a fixture summary rather than
 * authored from memory: `state` and `content` are the contract's own message
 * arms, so a contract change breaks this file at tsc rather than at runtime.
 * 11:48 against FIXTURE_NOW (12:00) is the oracle's "12m ago", exactly.
 */
const latest: MessageView = {
  ...messageAgentNullProvenance,
  createdAt: '2026-07-28T11:48:00.000Z',
  state: {
    kind: 'message',
    anchorId: taskGuideLines.id,
    rootMessageId: null,
    author: forge,
    messageBatchId: null,
  },
  content: {
    kind: 'message',
    body: 'pushed the offset map — review?',
    mentions: [],
    attachments: [],
  },
  replyCount: 0,
};

const earlier: MessageView = {
  ...latest,
  id: 'msg-earlier',
  createdAt: '2026-07-28T09:00:00.000Z',
  content: { kind: 'message', body: 'starting on the offsets', mentions: [], attachments: [] },
};

function renderBody(over: Partial<React.ComponentProps<typeof HubBody>> = {}) {
  return render(
    <HubBody detail={channelDetail()} blocks={HUB_BLOCKS} now={FIXTURE_NOW} {...over} />,
  );
}

describe('the hub body draws the oracle anatomy', () => {
  it('leads with the description, read STRUCTURALLY off the content', () => {
    const { getByTestId } = renderBody();
    expect(getByTestId('hub-description').textContent).toBe('tm8-ui build');
  });

  it('renders the five regions in the oracle order', () => {
    const { getByTestId } = renderBody({ messages: [latest] });
    const order = [...getByTestId('hub-body').children].map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'hub-description',
      'hub-pinned',
      'hub-tabs',
      'hub-latest',
      'hub-redirect',
    ]);
  });
});

describe('PINNED — entity chips off the block-named content member', () => {
  it('counts the pins in the eyebrow, one chip each', () => {
    const { getByTestId } = renderBody();
    const pinned = getByTestId('hub-pinned');
    const pins = channelDetail().content as unknown as { pinned: { title: string }[] };
    expect(within(pinned).getByText(`PINNED · ${pins.pinned.length}`)).toBeTruthy();
    expect(within(pinned).getByText('Layout spec')).toBeTruthy();
  });

  it('opens the pinned entity when an opener is wired', () => {
    const opened: string[] = [];
    const { getByTestId } = renderBody({ onOpenEntity: (id) => opened.push(id) });
    fireEvent.click(within(getByTestId('hub-pinned')).getByText('Layout spec'));
    expect(opened).toEqual(['doc-layout-spec']);
  });

  it('renders the chip DISABLED-WITH-REASON when no opener is wired (R5 #9)', () => {
    // The enabled-inert class: a chip that looks live and does nothing is
    // indistinguishable from a broken app. Structural check — it cannot drift
    // from what is actually dispatched.
    const { getByTestId } = renderBody({ onOpenEntity: undefined });
    const pinned = getByTestId('hub-pinned');
    expect(within(pinned).getAllByTestId('disabled-with-reason').length).toBe(1);
    expect(within(pinned).queryByRole('button', { name: 'Layout spec' })).toBeTruthy();
  });
});

describe('HUB TABS — the auto-tab pills', () => {
  it('renders one pill per auto-tab, each carrying its count', () => {
    const { getByTestId } = renderBody();
    const labels = [...getByTestId('hub-tabs').querySelectorAll('.hub-tab')].map((el) => el.textContent);
    expect(labels).toEqual(['Feed · 148', 'Tasks · 4', 'Docs · 1']);
  });

  it('shows a measured ZERO rather than hiding it', () => {
    // Same law as the tab-strip count: 0 is an answer a read actually
    // produced, and suppressing it makes it indistinguishable from unmeasured.
    const detail: EntityDetail = {
      ...channelDetail(),
      content: {
        kind: 'channel',
        topic: 'tm8-ui build',
        pinned: [],
        autoTabs: [
          { key: 'files', label: 'Files', count: 0, query: { spaceId: FIXTURE_SPACE_ID, layout: 'list' } },
        ],
      },
    };
    const { getByTestId } = renderBody({ detail });
    expect(getByTestId('hub-tabs').textContent).toContain('Files · 0');
  });

  it('draws the pills as static text, not as controls', () => {
    // The oracle gives the pinned chips `cursor:pointer` and the hub pills
    // none. Switching a hub tab is the Z4 hub's job — which is exactly what
    // the redirect note says — so there is no verb here to leave unwired.
    const { getByTestId } = renderBody();
    expect(within(getByTestId('hub-tabs')).queryAllByRole('button')).toEqual([]);
  });
});

describe('the latest-message card, and the two ways it can be absent', () => {
  it('shows the most recent message, its author and its age', () => {
    const { getByTestId } = renderBody({ messages: [earlier, latest] });
    const card = getByTestId('hub-latest');
    expect(card.textContent).toContain('forge');
    expect(card.textContent).toContain('pushed the offset map — review?');
    expect(card.textContent).toContain('latest · 12m ago');
  });

  it('marks an agent author with the agent avatar shape', () => {
    const { getByTestId } = renderBody({ messages: [latest] });
    expect(within(getByTestId('hub-latest')).getByRole('img', { name: 'forge' }).className).toContain(
      'kit-avatar--agent',
    );
  });

  it('renders HOLLOW when no message read has run — a dash, not a zero', () => {
    const { getByTestId, queryByTestId } = renderBody({ messages: undefined });
    expect(queryByTestId('hub-latest')).toBeNull();
    expect(within(getByTestId('hub-latest-hollow')).getByTestId('hollow-inline')).toBeTruthy();
  });

  it('renders a MEASURED EMPTY when the read returned no messages', () => {
    const { getByTestId, queryByTestId } = renderBody({ messages: [] });
    expect(queryByTestId('hub-latest-hollow')).toBeNull();
    expect(getByTestId('hub-latest-empty').textContent).toContain('No messages yet');
  });
});

describe('the redirect note is registry DATA', () => {
  it('renders the sentence the notice block carries', () => {
    const { getByTestId } = renderBody();
    expect(getByTestId('hub-redirect').textContent).toBe(REDIRECT);
  });

  it('renders NO note when the registry row declares none', () => {
    // The sentence names a specific surface. A component that invented one
    // would be carrying kind knowledge the registry is supposed to hold.
    const { queryByTestId } = renderBody({ blocks: [] });
    expect(queryByTestId('hub-redirect')).toBeNull();
  });

  it('still draws the rest of the anatomy with no blocks at all', () => {
    const { getByTestId } = renderBody({ blocks: [] });
    expect(getByTestId('hub-description')).toBeTruthy();
    expect(getByTestId('hub-pinned')).toBeTruthy();
    expect(getByTestId('hub-tabs')).toBeTruthy();
  });
});

describe('it is an ARCHETYPE, not a kind', () => {
  /**
   * The assertion §15.2 cannot make. The guard proves no `kind ===` literal is
   * present; this proves the component actually RENDERS for a second kind
   * whose content members are named differently — description off
   * `description` instead of `topic`, pins off the block's `source: 'items'`.
   */
  it('renders a collection through the same component and the same anatomy', () => {
    const { getByTestId, queryByTestId } = renderBody({
      detail: collectionDetail(),
      blocks: [{ block: 'items', label: 'ITEMS', params: { source: 'items' } }],
      messages: [],
    });
    expect(getByTestId('hub-description').textContent).toBeTruthy();
    expect(within(getByTestId('hub-pinned')).getByText(/^ITEMS · [1-9]/)).toBeTruthy();
    // No auto-tabs on this kind's content — the region is absent, not empty.
    expect(queryByTestId('hub-tabs')).toBeNull();
  });
});
