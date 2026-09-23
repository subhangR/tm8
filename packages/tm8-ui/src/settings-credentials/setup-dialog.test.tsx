// @vitest-environment jsdom
/**
 * THE GUIDED FLOW, tested at the two things that actually make it a flow: what
 * it says while a login is running, and what it does with the answer.
 *
 * There are deliberately NO layout assertions. jsdom loads no stylesheets, so
 * a claim about the dialog's height, scroll or overlap would be worth nothing
 * here — which is precisely how the surface this replaces shipped an overlap
 * nobody's vitest could see. The structural half of that fix is asserted in
 * `home-page.test.tsx` (the chat is the page column's only child) and the rest
 * is a stylesheet claim this suite cannot make honestly.
 */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  CredentialProviderName,
  CredentialsStatusView,
} from '@tm8/contract';
import { CredentialsSetupDialog } from './CredentialsSetupDialog';
import type { CredentialsPort } from './port';

function connection(
  provider: CredentialProviderName,
  over: Partial<CredentialsStatusView['providers'][number]> = {},
) {
  return {
    provider,
    connected: false,
    login: null,
    authMethod: null,
    status: null,
    connectedAt: null,
    lastVerifiedAt: null,
    ...over,
  };
}

const NOTHING_CONNECTED = {
  providers: [
    connection('anthropic'),
    connection('openai'),
    connection('hermes', { status: 'unavailable' }),
    connection('github'),
  ],
  gitCredentialStore: 'present',
} as CredentialsStatusView;

function portWith(
  status: CredentialsStatusView | CredentialsStatusView[],
  over: Partial<CredentialsPort> = {},
): CredentialsPort {
  // An ARRAY means the status CHANGES between reads — the only way to test
  // that finishing a login is followed by a re-read rather than an optimistic
  // local flip of the row.
  const queue = Array.isArray(status) ? [...status] : null;
  return {
    load: async () => (queue ? (queue.length > 1 ? queue.shift()! : queue[0]!) : (status as CredentialsStatusView)),
    disconnect: async (provider) => ({
      provider,
      revoked: true,
      terminatedCredentialSessionIds: [],
      terminatedAgentSessionIds: [],
      failures: [],
    }),
    startLogin: async (provider) => ({
      workSessionId: 'ws-login-1',
      spaceId: 'space-1',
      provider,
      expiresAt: '2026-09-05T12:00:00.000Z',
      command: `${provider} login`,
    }),
    finishLogin: async (workSessionId) => ({
      workSessionId,
      provider: 'anthropic' as const,
      connected: true,
      stored: true,
      login: 'someone@example.com',
    }),
    ...over,
  };
}

function mount(port: CredentialsPort, over: Partial<{ onDismiss(): void; onClose(): void }> = {}) {
  const onDismiss = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <div className="cv2-root">
      <CredentialsSetupDialog
        open
        port={port}
        onDismiss={over.onDismiss ?? onDismiss}
        onClose={over.onClose ?? onClose}
      />
    </div>,
  );
  return { ...view, onDismiss, onClose };
}

describe('the dialog only exists when the host opens it', () => {
  it('renders nothing at all when closed — and reads no credentials', async () => {
    const load = vi.fn(async () => NOTHING_CONNECTED);
    const { queryByTestId } = render(
      <div className="cv2-root">
        <CredentialsSetupDialog
          open={false}
          port={portWith(NOTHING_CONNECTED, { load })}
          onDismiss={() => undefined}
          onClose={() => undefined}
        />
      </div>,
    );
    expect(queryByTestId('credentials-setup-dialog')).toBeNull();
    // A human-only operation must not be called for a dialog nobody opened.
    expect(load).not.toHaveBeenCalled();
  });
});

describe('the welcome states the two halves before asking for anything', () => {
  it('shows both steps, unticked, and offers Later', async () => {
    mount(portWith(NOTHING_CONNECTED));
    const checklist = await screen.findByTestId('cset-checklist');
    expect(within(checklist).getByTestId('cset-check-agent').getAttribute('data-done')).toBe('false');
    expect(within(checklist).getByTestId('cset-check-git').getAttribute('data-done')).toBe('false');
    expect(screen.getByTestId('cset-later')).toBeTruthy();
  });

  it('Later dismisses — a different answer from closing the window', async () => {
    const onDismiss = vi.fn();
    const onClose = vi.fn();
    mount(portWith(NOTHING_CONNECTED), { onDismiss, onClose });
    fireEvent.click(await screen.findByTestId('cset-later'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ticks the half that is already done', async () => {
    mount(portWith({
      providers: [connection('anthropic', { connected: true, login: 'me' }), connection('github')],
      gitCredentialStore: 'present',
    } as CredentialsStatusView));
    await waitFor(() =>
      expect(screen.getByTestId('cset-check-agent').getAttribute('data-done')).toBe('true'),
    );
    expect(screen.getByTestId('cset-check-git').getAttribute('data-done')).toBe('false');
  });
});

describe('the provider list keeps the four verdicts apart', () => {
  async function openList() {
    const view = mount(portWith(NOTHING_CONNECTED));
    fireEvent.click(await screen.findByTestId('cset-start'));
    await screen.findByTestId('cset-row-anthropic');
    return view;
  }

  it('offers no Connect for a provider whose binary is absent', async () => {
    await openList();
    expect(screen.queryByTestId('cset-connect-hermes')).toBeNull();
    expect(screen.getByTestId('cset-inert-hermes')).toBeTruthy();
    expect(screen.getByTestId('cset-state-hermes').textContent).toContain('not installed');
  });

  it('says an unmeasured provider may already be signed in, and does not claim it is not', async () => {
    const view = mount(portWith({
      providers: [connection('anthropic', { status: 'stale' }), connection('github')],
      gitCredentialStore: 'present',
    } as CredentialsStatusView));
    fireEvent.click(await screen.findByTestId('cset-start'));
    const state = await screen.findByTestId('cset-state-anthropic');
    expect(state.textContent).toContain('Could not be checked');
    expect(state.textContent).not.toContain('Not connected');
    // The action reflects the doubt rather than pretending it is a fresh login.
    expect(screen.getByTestId('cset-connect-anthropic').textContent).toBe('Sign in anyway');
    view.unmount();
  });

  it('Done stays refused until BOTH halves are connected', async () => {
    mount(portWith({
      providers: [connection('anthropic', { connected: true, login: 'me' }), connection('github')],
      gitCredentialStore: 'present',
    } as CredentialsStatusView));
    fireEvent.click(await screen.findByTestId('cset-start'));
    const done = await screen.findByTestId('cset-done');
    expect((done as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the connecting step demotes the terminal without unmounting it', () => {
  async function startAnthropic() {
    const view = mount(portWith(NOTHING_CONNECTED));
    fireEvent.click(await screen.findByTestId('cset-start'));
    fireEvent.click(await screen.findByTestId('cset-connect-anthropic'));
    await screen.findByTestId('cset-instruction');
    return view;
  }

  it('leads with a plain-English instruction, not the terminal', async () => {
    await startAnthropic();
    expect(screen.getByTestId('cset-instruction').textContent).toContain('browser tab');
    // Collapsed by default: the terminal is present but hidden.
    expect(screen.getByTestId('cset-terminal-body').hasAttribute('hidden')).toBe(true);
    expect(screen.getByTestId('cset-terminal-toggle').getAttribute('aria-expanded')).toBe('false');
  });

  /* THE POINT OF THE DISCLOSURE. A PTY that unmounts when the section is
     collapsed throws away the session the member is typing into, so the body
     must exist in the DOM in both states and only toggle `hidden`. */
  it('keeps the terminal mounted across a collapse', async () => {
    await startAnthropic();
    const body = screen.getByTestId('cset-terminal-body');
    fireEvent.click(screen.getByTestId('cset-terminal-toggle'));
    await waitFor(() => expect(body.hasAttribute('hidden')).toBe(false));
    fireEvent.click(screen.getByTestId('cset-terminal-toggle'));
    await waitFor(() => expect(body.hasAttribute('hidden')).toBe(true));
    // The SAME node throughout — never a remount.
    expect(screen.getByTestId('cset-terminal-body')).toBe(body);
  });

  it('names the command it runs and when it expires, once expanded', async () => {
    await startAnthropic();
    fireEvent.click(screen.getByTestId('cset-terminal-toggle'));
    const body = screen.getByTestId('cset-terminal-body');
    await waitFor(() => expect(body.hasAttribute('hidden')).toBe(false));
    expect(body.textContent).toContain('anthropic login');
    expect(body.textContent).toContain('2026-09-05T12:00:00.000Z');
  });

  /* Escape is the key a person presses AT a prompt. Closing the dialog on it
     would abandon a half-finished OAuth flow still running on the node. */
  it('Escape does not close the dialog while a login terminal is live', async () => {
    const onClose = vi.fn();
    const view = mount(portWith(NOTHING_CONNECTED), { onClose });
    fireEvent.click(await screen.findByTestId('cset-start'));
    // Escape closes from the picking step...
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByTestId('cset-connect-anthropic'));
    await screen.findByTestId('cset-instruction');
    // ...and refuses to from the connecting one.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

/**
 * CLOSING IS NOT DISMISSING (review finding, 2026-09-05). Both button-shaped
 * exits used to mean DISMISS — the permanent per-account write — so a member
 * who opened the flow from the account menu just to look and clicked the
 * obvious way out silently turned it off for good.
 */
describe('there is a way out that does not turn the flow off', () => {
  it('the × closes without dismissing', async () => {
    const onDismiss = vi.fn();
    const onClose = vi.fn();
    mount(portWith(NOTHING_CONNECTED), { onDismiss, onClose });
    fireEvent.click(await screen.findByTestId('cset-x'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('the backdrop closes without dismissing', async () => {
    const onDismiss = vi.fn();
    const onClose = vi.fn();
    mount(portWith(NOTHING_CONNECTED), { onDismiss, onClose });
    fireEvent.mouseDown(await screen.findByTestId('credentials-setup-dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  /* A drag that STARTS on the card and releases on the backdrop is not a
     backdrop click, and must not close the dialog — the target test in the
     handler is what makes that true. */
  it('a mousedown inside the card does not close it', async () => {
    const onClose = vi.fn();
    mount(portWith(NOTHING_CONNECTED), { onClose });
    const card = (await screen.findByTestId('cset-later')).closest('.cset-card')!;
    fireEvent.mouseDown(card);
    expect(onClose).not.toHaveBeenCalled();
  });

  /* Neither exit is offered while a login is live, for the same reason Escape
     is not: a stray click must not abandon a running OAuth flow. */
  it('offers neither × nor backdrop-close while a login terminal is live', async () => {
    const onClose = vi.fn();
    mount(portWith(NOTHING_CONNECTED), { onClose });
    fireEvent.click(await screen.findByTestId('cset-start'));
    fireEvent.click(await screen.findByTestId('cset-connect-anthropic'));
    await screen.findByTestId('cset-instruction');

    expect(screen.queryByTestId('cset-x')).toBeNull();
    fireEvent.mouseDown(screen.getByTestId('credentials-setup-dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('what the flow does with the answer', () => {
  it('re-reads the status after a login instead of flipping the row locally', async () => {
    const after = {
      providers: [
        connection('anthropic', { connected: true, login: 'someone@example.com' }),
        connection('openai'),
        connection('hermes', { status: 'unavailable' }),
        connection('github'),
      ],
      gitCredentialStore: 'present',
    } as CredentialsStatusView;

    mount(portWith([NOTHING_CONNECTED, after]));
    fireEvent.click(await screen.findByTestId('cset-start'));
    fireEvent.click(await screen.findByTestId('cset-connect-anthropic'));
    fireEvent.click(await screen.findByTestId('cset-finish'));

    // Back on the list, with the agent half now ticked from the SERVER's answer.
    await waitFor(() =>
      expect(screen.getByTestId('cset-check-agent').getAttribute('data-done')).toBe('true'),
    );
    expect(screen.getByTestId('cset-last-result').textContent).toContain(
      'Claude Code is connected as someone@example.com',
    );
  });

  /* THE MOST CONFUSING OUTCOME IN THE FLOW: the terminal ended, the member did
     everything right, and they are still not signed in. It has to be said. */
  it('states plainly when a finished terminal did NOT end connected', async () => {
    mount(portWith(NOTHING_CONNECTED, {
      finishLogin: async (workSessionId) => ({
        workSessionId,
        provider: 'anthropic' as const,
        connected: false,
        stored: false,
        login: null,
      }),
    }));
    fireEvent.click(await screen.findByTestId('cset-start'));
    fireEvent.click(await screen.findByTestId('cset-connect-anthropic'));
    fireEvent.click(await screen.findByTestId('cset-finish'));
    const notice = await screen.findByTestId('cset-last-result');
    expect(notice.textContent).toContain('did not end signed in');
  });

  /* `connected` and `stored` are separate answers and the difference is not
     cosmetic: a verified-but-unstored login will NOT be inherited by an agent. */
  it('distinguishes verified from saved', async () => {
    mount(portWith(NOTHING_CONNECTED, {
      finishLogin: async (workSessionId) => ({
        workSessionId,
        provider: 'anthropic' as const,
        connected: true,
        stored: false,
        login: 'me',
      }),
    }));
    fireEvent.click(await screen.findByTestId('cset-start'));
    fireEvent.click(await screen.findByTestId('cset-connect-anthropic'));
    fireEvent.click(await screen.findByTestId('cset-finish'));
    const notice = await screen.findByTestId('cset-last-result');
    expect(notice.textContent).toContain('not saved on this node');
  });

  it('reaches the done pane once both halves are connected', async () => {
    const done = {
      providers: [
        connection('anthropic', { connected: true, login: 'me' }),
        connection('github', { connected: true, login: 'octocat' }),
      ],
      gitCredentialStore: 'present',
    } as CredentialsStatusView;
    const before = {
      providers: [connection('anthropic', { connected: true, login: 'me' }), connection('github')],
      gitCredentialStore: 'present',
    } as CredentialsStatusView;

    mount(portWith([before, done], {
      finishLogin: async (workSessionId) => ({
        workSessionId,
        provider: 'github' as const,
        connected: true,
        stored: true,
        login: 'octocat',
      }),
    }));
    fireEvent.click(await screen.findByTestId('cset-start'));
    fireEvent.click(await screen.findByTestId('cset-connect-github'));
    fireEvent.click(await screen.findByTestId('cset-finish'));
    expect(await screen.findByTestId('cset-done-copy')).toBeTruthy();
  });

  it('states a refused status read rather than rendering an empty flow', async () => {
    mount(portWith(NOTHING_CONNECTED, {
      load: async () => { throw new Error('forbidden'); },
    }));
    expect((await screen.findByTestId('cset-load-error')).textContent).toContain('forbidden');
  });

  it('states a refused startLogin instead of hanging on a step that never began', async () => {
    mount(portWith(NOTHING_CONNECTED, {
      startLogin: async () => { throw new Error('no pty on this node'); },
    }));
    fireEvent.click(await screen.findByTestId('cset-start'));
    fireEvent.click(await screen.findByTestId('cset-connect-anthropic'));
    expect((await screen.findByTestId('cset-step-error')).textContent).toContain('no pty');
    // And it stays on the list, where the member can try something else.
    expect(screen.getByTestId('cset-row-anthropic')).toBeTruthy();
  });
});
