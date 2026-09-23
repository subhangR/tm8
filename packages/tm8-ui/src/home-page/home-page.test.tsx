// @vitest-environment jsdom
/**
 * HomePage — Home IS the chat view (R4, 2026-08-15; formerly the merged
 * single home of task 01a0027d).
 *
 * What these pin, each against a failure mode the program has shipped once:
 *   - the chat slot fills the canvas (the host's surface renders, untouched);
 *   - a quiet space renders NO needs-you strip (an inbox-zero canvas is
 *     quiet, not an empty amber box).
 *   - the compact six-provider rail sits immediately above the merged surface
 *     that owns Sessions, while the detailed sign-in block remains the shared
 *     component Settings mounts;
 *   - connected, disconnected, unavailable and unknown remain four distinct
 *     provider states; and
 *   - the retired glance rails and presence/footer framing stay retired.
 */
import { describe, expect, it } from 'vitest';
import { render, within } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { Seam, SessionLiveness } from '../data/seam';
import { FIXTURE_SPACE_ID } from '../fixtures/entities';
import { HomePage, type HomePageData } from './HomePage';

const seam: Pick<Seam, 'identity' | 'inbox' | 'onEvent' | 'credentials'> = {
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
  credentials: {
    status: async () => ({
      providers: [
        { provider: 'anthropic', connected: true, login: null, authMethod: 'oauth', status: 'active', connectedAt: null, lastVerifiedAt: null },
        { provider: 'openai', connected: false, login: null, authMethod: null, status: null, connectedAt: null, lastVerifiedAt: null },
        { provider: 'github', connected: true, login: 'ada', authMethod: 'oauth', status: 'active', connectedAt: null, lastVerifiedAt: null },
        { provider: 'gemini', connected: false, login: null, authMethod: null, status: 'stale', connectedAt: null, lastVerifiedAt: null },
        { provider: 'hermes', connected: false, login: null, authMethod: null, status: 'unavailable', connectedAt: null, lastVerifiedAt: null },
        { provider: 'cursor', connected: true, login: null, authMethod: null, status: 'active', connectedAt: null, lastVerifiedAt: null },
      ],
      gitCredentialStore: 'present',
    }),
    disconnect: async (provider) => ({
      provider,
      revoked: true,
      terminatedCredentialSessionIds: [],
      terminatedAgentSessionIds: [],
      failures: [],
    }),
    startLogin: async (spaceId, provider) => ({
      workSessionId: 'ws-home-login',
      spaceId,
      provider,
      expiresAt: '2026-09-04T12:10:00.000Z',
      command: `${provider} login`,
    }),
    finishLogin: async (workSessionId) => ({
      workSessionId,
      provider: 'github',
      connected: true,
      login: 'ada',
      authMethod: 'oauth',
      status: 'active',
      stored: true,
      terminated: true,
    }),
  },
};

function makeData(rows: Record<string, readonly EntitySummary[]>): HomePageData {
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
        chat={(
          <div data-testid="chat-slot">
            the chat hero
            <div data-testid="sessions-content">Sessions content</div>
          </div>
        )}
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

  /* THE REMOVAL, ASSERTED (Subhang, 2026-09-05). Home used to stack the full
     credential block and the compact provider rail above the chat. Both are
     gone: the flow they belonged to is `CredentialsSetupDialog`, and the
     management surface is Settings.

     This test names the four testids the old sections carried rather than
     just checking a count, because a count is satisfied by a section that
     moved somewhere else on this page. It also asserts the chat is the FIRST
     thing under the page column, which is the structural half of the fix —
     the overlap happened because two unshrinkable siblings sat above it. */
  it('renders NO credential surface, and seats the chat directly in the page column', () => {
    const { getByTestId, queryByTestId } = renderPage({});

    for (const testid of [
      'home-credentials',
      'home-provider-rail',
      'credentials-provider-block',
      'provider-rail',
    ]) {
      expect(queryByTestId(testid), `${testid} still mounts on Home`).toBeNull();
    }

    const sessions = getByTestId('sessions-content');
    const chatSurface = sessions.closest('.hp-chat');
    expect(chatSurface).toBeTruthy();
    const page = chatSurface!.parentElement;
    expect(page?.classList.contains('hp-page')).toBe(true);
    // A quiet space has no NEEDS YOU strip, so the chat is the only child.
    expect(page!.children).toHaveLength(1);
  });

  it('a quiet space renders NO needs-you strip', () => {
    const { queryByTestId } = renderPage({});
    expect(queryByTestId('hp-needs-you')).toBeNull();
  });

  it('keeps the retired glance rails, presence row and workspace footer out of Home', () => {
    const { container, queryByTestId, queryByText } = renderPage({});
    expect(queryByTestId('hp-rail-tasks')).toBeNull();
    expect(queryByTestId('hp-rail-sessions')).toBeNull();
    expect(queryByTestId('hp-rail-docs')).toBeNull();
    expect(queryByTestId('hp-presence')).toBeNull();
    expect(queryByText('Open full workspace ⌗')).toBeNull();
    expect(container.querySelector('.hp-card')).toBeNull();
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
