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

  it('mounts the compact provider rail above Sessions and keeps the detailed shared block', async () => {
    const { findByTestId, getByTestId } = renderPage({});
    const section = await findByTestId('home-credentials');
    expect(within(section).getByTestId('credentials-provider-block')).toBeTruthy();
    await within(section).findByTestId('credential-card-cursor');
    expect(within(section).getAllByTestId(/^credential-card-/)).toHaveLength(6);
    for (const name of ['Claude Code', 'Codex', 'GitHub', 'Gemini', 'Hermes', 'Cursor']) {
      expect(within(section).getByText(name)).toBeTruthy();
    }
    const compact = await findByTestId('home-provider-rail');
    await within(compact).findByLabelText('Claude Code — connected');

    const expectedStates = {
      anthropic: ['connected', '✓'],
      openai: ['disconnected', '○'],
      hermes: ['unavailable', '×'],
      gemini: ['unknown', '?'],
    } as const;
    for (const [provider, [state, mark]] of Object.entries(expectedStates)) {
      expect(
        within(section).getByTestId(`credential-card-${provider}`).getAttribute(
          'data-credential-state',
        ),
      ).toBe(state);
      const chip = within(compact).getByTestId(`provider-rail-chip-${provider}`);
      expect(chip.getAttribute('data-provider-state')).toBe(state);
      expect(chip.querySelector('.provider-rail__badge')?.textContent).toBe(mark);
    }

    expect(within(section).getByTestId('credential-verdict-cursor').textContent).toBe(
      'Connected — inference access',
    );
    // Home receives the same unavailable semantics as Settings: no action that
    // the server has already measured will fail.
    expect(within(section).queryByTestId('credential-connect-hermes')).toBeNull();
    expect(within(section).getByTestId('credential-install-hermes').textContent).toContain(
      'Install hermes',
    );

    expect(within(compact).getAllByTestId(/^provider-rail-chip-/)).toHaveLength(6);
    expect(within(compact).getByLabelText('Hermes — unavailable').tagName).toBe('SPAN');

    // Main moved Sessions into the merged chat/list surface. The compact rail
    // therefore precedes that surface directly instead of restoring the old
    // `hp-rail-sessions` glance rail.
    const sessions = getByTestId('sessions-content');
    const chatSurface = sessions.closest('.hp-chat');
    expect(chatSurface).toBeTruthy();
    expect(compact.nextElementSibling).toBe(chatSurface);
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
