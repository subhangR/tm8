// @vitest-environment jsdom
/**
 * HomePage — Home IS the chat view (R4, 2026-08-15; formerly the merged
 * single home of task 01a0027d).
 *
 * What these pin, each against a failure mode the program has shipped once:
 *   - the chat slot fills the canvas (the host's surface renders, untouched);
 *   - a quiet space renders NO needs-you strip (an inbox-zero canvas is
 *     quiet, not an empty amber box).
 *   - sign-ins cost the page ONE LINE: the control is closed on arrival and no
 *     credential card is mounted until it is opened. The page used to stack two
 *     credential sections here (>=425px measured); this pins that they are gone
 *     and do not come back;
 *   - opening reaches the SHARED block Settings mounts, with all six providers;
 *   - connected, disconnected, unavailable and unknown remain four distinct
 *     provider states; and
 *   - the retired glance rails and presence/footer framing stay retired.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
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

  it('spends one line on sign-ins and mounts no credential card until asked', async () => {
    const { findByTestId, getByTestId, queryByTestId } = renderPage({});
    const row = await findByTestId('home-credentials');
    const corner = within(row).getByTestId('credentials-corner');

    // Closed on arrival: none of the block exists yet.
    expect(queryByTestId('credentials-corner-panel')).toBeNull();
    expect(queryByTestId('credentials-provider-block')).toBeNull();
    expect(queryByTestId('credential-card-cursor')).toBeNull();

    // The two stacked sections are gone for good.
    expect(queryByTestId('home-provider-rail')).toBeNull();
    const page = getByTestId('home-page');
    expect(page.querySelector('.hp-provider-signins')).toBeNull();
    expect(page.querySelector('.hp-credentials')).toBeNull();

    // The conversation follows the line directly.
    const chatSurface = getByTestId('sessions-content').closest('.hp-chat');
    expect(chatSurface).toBeTruthy();
    expect(row.nextElementSibling).toBe(chatSurface);
    expect(corner).toBeTruthy();
  });

  it('states the exception on the closed line, not the tally', async () => {
    const { findByTestId } = renderPage({});
    const trigger = await findByTestId('credentials-corner-trigger');
    // The fixture has hermes unavailable and gemini unmeasured while three are
    // connected. The exception is what would stop a launched agent.
    await within(await findByTestId('home-credentials')).findByLabelText(
      'Agent sign-ins \u2014 1 unavailable',
    );
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('data-tone')).toBe('attention');
  });

  it('opens the shared block from the line and closes it again', async () => {
    const { findByTestId, getByTestId, queryByTestId } = renderPage({});
    const trigger = await findByTestId('credentials-corner-trigger');

    fireEvent.click(trigger);
    const panel = await findByTestId('credentials-corner-panel');

    expect(within(panel).getByTestId('credentials-provider-block')).toBeTruthy();
    await within(panel).findByTestId('credential-card-cursor');
    expect(within(panel).getAllByTestId(/^credential-card-/)).toHaveLength(6);
    for (const name of ['Claude Code', 'Codex', 'GitHub', 'Gemini', 'Hermes', 'Cursor']) {
      expect(within(panel).getByText(name)).toBeTruthy();
    }
    expect(within(panel).getByTestId('credential-verdict-cursor').textContent).toBe(
      'Connected \u2014 inference access',
    );
    // Home keeps Settings' unavailable semantics: no action the server has
    // already measured as impossible.
    expect(within(panel).queryByTestId('credential-connect-hermes')).toBeNull();
    expect(within(panel).getByTestId('credential-install-hermes').textContent).toContain(
      'Install hermes',
    );

    fireEvent.click(getByTestId('credentials-corner-close'));
    expect(queryByTestId('credentials-corner-panel')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
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
