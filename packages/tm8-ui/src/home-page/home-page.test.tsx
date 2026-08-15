// @vitest-environment jsdom
/**
 * HomePage — Home IS the chat view (R4, 2026-08-15; formerly the merged
 * single home of task 01a0027d).
 *
 * What these pin, each against a failure mode the program has shipped once:
 *   - the chat slot fills the canvas (the host's surface renders, untouched);
 *   - a quiet space renders NO needs-you strip (an inbox-zero canvas is
 *     quiet, not an empty amber box).
 *
 * The glance rails, the presence row and the per-kind counts strip retired to
 * the Work tab — their tests went with them.
 */
import { describe, expect, it } from 'vitest';
import { render, within } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { Seam, SessionLiveness } from '../data/seam';
import { FIXTURE_SPACE_ID } from '../fixtures/entities';
import type { HomeScreenData } from '../home';
import { HomePage } from './HomePage';

const seam: Pick<Seam, 'identity' | 'inbox' | 'onEvent'> = {
  identity: async () => ({
    identityId: 'idn-ada',
    accountId: 'acct-ada',
    username: 'ada',
    displayName: 'Ada',
    avatar: null,
    email: null,
    globalId: null,
    isNodeAdmin: true,
    isOwner: true,
    status: 'active',
    actingAs: null,
    memberships: [],
  }),
  inbox: async () => ({ items: [], nextCursor: null }),
  onEvent: () => () => undefined,
};

function makeData(rows: Record<string, readonly EntitySummary[]>): HomeScreenData {
  return {
    spaceId: FIXTURE_SPACE_ID,
    seam,
    liveIds: [],
    livenessOf: (): SessionLiveness => 'unknown',
    rowsFor: (kind) => (filter) => (filter === undefined ? rows[kind] ?? [] : []),
    activity: {},
  };
}

function renderPage(
  rows: Record<string, readonly EntitySummary[]>,
  handlers: Partial<React.ComponentProps<typeof HomePage>> = {},
) {
  return render(
    <div className="cv2-root">
      <HomePage
        data={makeData(rows)}
        chat={<div data-testid="chat-slot">the chat hero</div>}
        onOpenEntity={() => undefined}
        onOpenWorkspace={() => undefined}
        {...handlers}
      />
    </div>,
  );
}

describe('the home chat canvas', () => {
  it('renders the chat slot as the canvas', () => {
    const { getByTestId } = renderPage({});
    expect(within(getByTestId('home-page')).getByTestId('chat-slot')).toBeTruthy();
  });

  it('a quiet space renders NO needs-you strip', () => {
    const { queryByTestId } = renderPage({});
    expect(queryByTestId('hp-needs-you')).toBeNull();
  });
});

/**
 * THE DEFECT (user report, 2026-08-16): opening an entity from the transcript
 * navigated to the Workspace, so the conversation you were still having went
 * off screen to show you the thing it had just mentioned.
 */
describe('the detail column Home opens BESIDE itself', () => {
  it('draws no column at all when the host opened nothing', () => {
    // An empty column is a promise of a panel; absent is the honest state.
    const { getByTestId } = renderPage({});
    expect(getByTestId('home-page').getAttribute('data-aside')).toBeNull();
  });

  it('keeps the conversation mounted while the column shows the entity', () => {
    const { getByTestId } = renderPage(
      {},
      { aside: <div data-testid="aside-slot">the entity</div> },
    );
    const page = getByTestId('home-page');
    expect(page.getAttribute('data-aside')).toBe('open');
    expect(within(page).getByTestId('aside-slot')).toBeTruthy();
    // The whole point: the chat did not go anywhere.
    expect(within(page).getByTestId('chat-slot')).toBeTruthy();
  });
});
