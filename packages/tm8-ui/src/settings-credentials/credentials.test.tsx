// @vitest-environment jsdom
/**
 * THE HONEST-DEGRADATION CONTRACT, one test per state it can be collapsed into.
 *
 * Every assertion here is about what the section RENDERS, which is a claim
 * jsdom can settle. There are deliberately NO width, scroll or layout
 * assertions: jsdom will happily pass a component that is visually trapped or
 * clipped, so a layout claim proven here would be worth nothing.
 *
 * The four states below are the ones a careless implementation collapses while
 * looking entirely correct, so each gets its own test rather than riding along
 * inside a happy-path render.
 */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  CredentialsDeleteResult,
  CredentialsStatusView,
  CredentialProviderName,
} from '@tm8/contract';
import { CredentialsSection } from './CredentialsSection';
import { CREDENTIAL_PROVIDER_PRESENTATIONS } from './provider-presentation';
import { disconnectVerdictOf, verdictOf, type CredentialsPort } from './port';

function connection(over: Partial<CredentialsStatusView['providers'][number]> & { provider: CredentialProviderName }) {
  return {
    connected: false,
    login: null,
    authMethod: null,
    status: null,
    connectedAt: null,
    lastVerifiedAt: null,
    ...over,
  };
}

function portWith(
  status: CredentialsStatusView,
  over: Partial<CredentialsPort> = {},
): CredentialsPort {
  return {
    load: async () => status,
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
      expiresAt: '2026-08-07T12:00:00.000Z',
      command: `${provider} login`,
    }),
    finishLogin: async (workSessionId) => ({
      workSessionId,
      provider: 'github' as const,
      connected: true,
      login: 'ada',
      authMethod: 'oauth',
      status: 'active' as const,
      stored: true,
      terminated: true,
    }),
    ...over,
  };
}

describe('six providers and four honest states', () => {
  it('renders all six product names with currentColor inline marks, binaries, and a connected Cursor', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [
            connection({ provider: 'anthropic', connected: true, status: 'active' }),
            connection({ provider: 'openai' }),
            connection({ provider: 'github', connected: true, login: 'ada', status: 'active' }),
            connection({ provider: 'gemini', status: 'stale' }),
            connection({ provider: 'hermes', status: 'unavailable' }),
            connection({ provider: 'cursor', connected: true, status: 'active' }),
          ],
          gitCredentialStore: 'present',
        })}
      />,
    );

    await screen.findByTestId('credential-provider-grid');
    expect(screen.getAllByTestId(/^credential-card-/)).toHaveLength(6);
    expect(Object.values(CREDENTIAL_PROVIDER_PRESENTATIONS).map(({ name, binary }) => [name, binary])).toEqual([
      ['Claude Code', 'claude'],
      ['Codex', 'codex'],
      ['GitHub', 'gh'],
      ['Gemini', 'gemini'],
      ['Hermes', 'hermes'],
      ['Cursor', 'cursor-agent'],
    ]);

    for (const [id, provider] of Object.entries(CREDENTIAL_PROVIDER_PRESENTATIONS)) {
      const card = screen.getByTestId(`credential-card-${id}`);
      expect(within(card).getByText(provider.name)).toBeTruthy();
      expect(card.querySelector('.cred-card__binary')?.textContent).toBe(provider.binary);
      const mark = card.querySelector('svg');
      expect(mark?.getAttribute('aria-hidden')).toBe('true');
      expect(mark?.innerHTML).toContain('currentColor');
    }

    const cursor = screen.getByTestId('credential-card-cursor');
    expect(cursor.getAttribute('data-credential-state')).toBe('connected');
    expect(screen.getByTestId('credential-verdict-cursor').textContent).toBe(
      'Connected — inference access',
    );
    expect(screen.getByTestId('credential-connect-cursor').textContent).toBe('Reconnect');
    expect(screen.getByTestId('credential-disconnect-cursor')).toBeTruthy();
  });

  it('renders an unavailable Cursor differently from disconnected and never offers a doomed Connect', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [
            connection({ provider: 'openai', status: null }),
            connection({ provider: 'cursor', status: 'unavailable' }),
          ],
          gitCredentialStore: 'present',
        })}
      />,
    );

    const unavailable = await screen.findByTestId('credential-card-cursor');
    const disconnected = screen.getByTestId('credential-card-openai');
    expect(unavailable.getAttribute('data-credential-state')).toBe('unavailable');
    expect(disconnected.getAttribute('data-credential-state')).toBe('disconnected');
    expect(screen.getByTestId('credential-verdict-cursor').textContent).toContain(
      'cursor-agent is not installed on this node',
    );
    expect(screen.getByTestId('credential-install-cursor').textContent).toContain(
      'Install cursor-agent',
    );
    expect(screen.queryByTestId('credential-connect-cursor')).toBeNull();
    expect(within(unavailable).queryByRole('button')).toBeNull();
    expect(screen.getByTestId('credential-connect-openai').textContent).toBe('Connect');
  });

  /**
   * STATE 1. `gitCredentialStore: 'absent'` does not mean "not connected". It
   * means the github entry's `connected` is UNKNOWN, never measured — 079
   * ships on the deployed staging line and is reachable from no local git
   * object. A user told "Not connected" will go and connect something that may
   * already be connected, which is why the words are asserted and not just the
   * branch.
   */
  it('renders an ABSENT git credential store as UNKNOWN, never as "Not connected"', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [connection({ provider: 'github', connected: false })],
          gitCredentialStore: 'absent',
        })}
      />,
    );

    const verdict = await screen.findByTestId('credential-verdict-github');
    expect(verdict.textContent).toContain('Could not be measured');
    // THE ASSERTION THAT MATTERS: the confident negative is absent.
    expect(verdict.textContent).not.toContain('Not connected');
    // And it says WHY it cannot tell, so "unknown" is not itself a shrug.
    expect(screen.getByTestId('credential-unknown-why').textContent).toContain('may already be signed in');
  });

  /**
   * The control for state 1. With the store PRESENT the same `connected:
   * false` is a real measurement and must read as the confident negative —
   * otherwise "unknown" would just be a synonym and the distinction would be
   * decorative.
   */
  it('renders a PRESENT store with connected:false as a real "Not connected"', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [connection({ provider: 'github', connected: false })],
          gitCredentialStore: 'present',
        })}
      />,
    );

    const verdict = await screen.findByTestId('credential-verdict-github');
    expect(verdict.textContent).toContain('Not connected');
    expect(verdict.textContent).not.toContain('Could not be measured');
  });

  /**
   * STATE 2. anthropic's `login` is null FOREVER with `connected: true` — it is
   * nullable-never-absent precisely so a UI cannot draw two different cards for
   * one permanent fact. So: no empty username field, no spinner, no "unknown
   * user". The connection renders WITHOUT a login line at all.
   */
  it('renders a permanently-null login as a connection with NO username field', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [connection({ provider: 'anthropic', connected: true, login: null, authMethod: 'oauth' })],
          gitCredentialStore: 'present',
        })}
      />,
    );

    const verdict = await screen.findByTestId('credential-verdict-anthropic');
    expect(verdict.textContent).toBe('Connected — inference access');
    // The row simply does not exist — not present-and-empty, not a placeholder.
    expect(screen.queryByTestId('credential-login-anthropic')).toBeNull();
    // And none of the words that would imply a name is still coming.
    expect(verdict.textContent).not.toContain('unknown user');
    expect(verdict.textContent).not.toMatch(/null|pending|loading|…/i);
    expect(document.body.textContent).not.toMatch(/connected as null/i);
  });

  /** The control for state 2: a provider that HAS a name still shows it. */
  it('renders a real login name when there is one', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [connection({ provider: 'github', connected: true, login: 'ada' })],
          gitCredentialStore: 'present',
        })}
      />,
    );

    expect((await screen.findByTestId('credential-login-github')).textContent).toBe('ada');
  });

  /**
   * STATE 3. `stored: false` with `connected: true` is a CORRECT and expected
   * answer, not an error: a verified GitHub login has nowhere to be written on
   * this line. It must say so plainly, and must not be dressed as a failure.
   */
  it('renders connected-but-not-stored as a correct outcome, not an error', async () => {
    render(
      <CredentialsSection
        port={portWith(
          { providers: [connection({ provider: 'github' })], gitCredentialStore: 'present' },
          {
            finishLogin: async (workSessionId) => ({
              workSessionId,
              provider: 'github' as const,
              connected: true,
              login: 'ada',
              authMethod: 'oauth',
              status: 'active' as const,
              stored: false,
              terminated: true,
            }),
          },
        )}
      />,
    );

    fireEvent.click(await screen.findByTestId('credential-connect-github'));
    fireEvent.click(await screen.findByTestId('credential-finish-login'));

    const notice = await screen.findByTestId('credential-outcome-finish');
    expect(notice.textContent).toContain('signed in');
    const why = screen.getByTestId('credential-verified-not-stored');
    expect(why.textContent).toContain('correct result, not an error');
    // It must NOT be reported through the error channel.
    expect(screen.queryByTestId('credential-outcome-error')).toBeNull();
  });
});

describe('disconnect — a partial success is neither a green tick nor a red error', () => {
  const partial: CredentialsDeleteResult = {
    provider: 'anthropic',
    revoked: true,
    terminatedCredentialSessionIds: ['ws-login-1'],
    terminatedAgentSessionIds: ['ws-agent-1'],
    failures: [
      { step: 'agentSession', sessionId: 'ws-agent-2', reason: 'session did not acknowledge terminate' },
    ],
  };

  /**
   * `revoked: true` alongside a non-empty `failures[]` is the NORMAL case (R3),
   * not an exception: the credential can be revoked while a session it opened
   * refuses to die. Both truths have to survive the render.
   */
  it('renders revoked:true WITH failures as a partial success naming what did not settle', async () => {
    render(
      <CredentialsSection
        port={portWith(
          {
            providers: [connection({ provider: 'anthropic', connected: true })],
            gitCredentialStore: 'present',
          },
          { disconnect: async () => partial },
        )}
      />,
    );

    fireEvent.click(await screen.findByTestId('credential-disconnect-anthropic'));

    // Not the clean node, and not the failed node — its own third state.
    const notice = await screen.findByTestId('credential-outcome-disconnect-partial');
    expect(screen.queryByTestId('credential-outcome-disconnect-clean')).toBeNull();
    expect(screen.queryByTestId('credential-outcome-disconnect-failed')).toBeNull();

    // The revoke is reported as having HAPPENED...
    expect(notice.textContent).toContain('disconnected');
    expect(notice.textContent).toContain('revoked');
    // ...and the thing that did not settle is NAMED, not merely counted.
    const failures = screen.getByTestId('credential-disconnect-failures');
    expect(failures.textContent).toContain('ws-agent-2');
    expect(failures.textContent).toContain('did not acknowledge terminate');
    // R3's second required truth: a process that read the secret still has it.
    expect(notice.textContent).toContain('rotate the credential at the vendor');
  });

  it('renders a clean disconnect distinctly from a partial one', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [connection({ provider: 'anthropic', connected: true })],
          gitCredentialStore: 'present',
        })}
      />,
    );

    fireEvent.click(await screen.findByTestId('credential-disconnect-anthropic'));

    await screen.findByTestId('credential-outcome-disconnect-clean');
    expect(screen.queryByTestId('credential-disconnect-failures')).toBeNull();
  });

  it('renders revoked:false as an actual failure', async () => {
    render(
      <CredentialsSection
        port={portWith(
          {
            providers: [connection({ provider: 'anthropic', connected: true })],
            gitCredentialStore: 'present',
          },
          {
            disconnect: async (provider) => ({
              provider,
              revoked: false,
              terminatedCredentialSessionIds: [],
              terminatedAgentSessionIds: [],
              failures: [{ step: 'revoke' as const, reason: 'the index row could not be removed' }],
            }),
          },
        )}
      />,
    );

    fireEvent.click(await screen.findByTestId('credential-disconnect-anthropic'));

    const notice = await screen.findByTestId('credential-outcome-disconnect-failed');
    expect(notice.textContent).toContain('not disconnected');
    // A failed revoke must NOT claim the credential was revoked.
    expect(notice.textContent).not.toContain('was revoked');
  });
});

describe('the verdict function — four meanings are four values', () => {
  it('separates unknown from disconnected on the store, not on `connected`', () => {
    const github = { provider: 'github' as const, connected: false, login: null };
    expect(verdictOf(github, 'absent')).toBe('unknown');
    expect(verdictOf(github, 'present')).toBe('disconnected');
  });

  it('does not downgrade a POSITIVE answer to unknown under an absent store', () => {
    // A `connected: true` can only have come from somewhere real; inventing a
    // doubt about it would be its own dishonesty.
    expect(verdictOf({ provider: 'github', connected: true, login: 'ada' }, 'absent')).toBe('connected-named');
  });

  it('maps every real Cursor probe outcome without a provider-specific UI branch', () => {
    const base = { provider: 'cursor' as const, connected: false, login: null };
    expect(verdictOf({ ...base, connected: true, status: 'active' }, 'present')).toBe(
      'connected-unnamed',
    );
    expect(verdictOf({ ...base, status: 'unavailable' }, 'present')).toBe('unavailable');
    expect(verdictOf({ ...base, status: 'stale' }, 'present')).toBe('unknown');
    expect(verdictOf({ ...base, status: null }, 'present')).toBe('disconnected');
  });

  it('separates a permanently-null login from a named one', () => {
    expect(verdictOf({ provider: 'anthropic', connected: true, login: null }, 'present')).toBe('connected-unnamed');
    expect(verdictOf({ provider: 'openai', connected: true, login: 'ada' }, 'present')).toBe('connected-named');
  });

  it('reads revoked+failures as partial, and never as clean or failed', () => {
    const base = {
      provider: 'anthropic' as const,
      terminatedCredentialSessionIds: [],
      terminatedAgentSessionIds: [],
    };
    expect(disconnectVerdictOf({ ...base, revoked: true, failures: [] })).toBe('clean');
    expect(disconnectVerdictOf({
      ...base,
      revoked: true,
      failures: [{ step: 'agentSession', reason: 'x' }],
    })).toBe('partial');
    expect(disconnectVerdictOf({ ...base, revoked: false, failures: [] })).toBe('failed');
  });
});

describe('the section is honest about what it could not read', () => {
  it('says the read failed instead of drawing an empty, confident screen', async () => {
    render(
      <CredentialsSection
        port={portWith({ providers: [], gitCredentialStore: 'present' }, {
          load: async () => { throw new Error('forbidden'); },
        })}
      />,
    );

    const err = await screen.findByTestId('credentials-load-error');
    expect(err.textContent).toContain('forbidden');
    // No provider card may be drawn from nothing.
    expect(screen.queryByTestId('credential-card-github')).toBeNull();
  });

  it('hosts the login terminal through the terminal module, and says so when it is off', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [connection({ provider: 'anthropic' })],
          gitCredentialStore: 'present',
        })}
      />,
    );

    fireEvent.click(await screen.findByTestId('credential-connect-anthropic'));
    const panel = await screen.findByTestId('credential-login-terminal');
    // The command and the expiry are the two facts a user needs to trust it.
    expect(screen.getByTestId('credential-login-expiry').textContent).toContain('anthropic login');
    // Under test the live terminal is off by default (liveTerminalFlag). It
    // must SAY so rather than draw a black box implying bytes can arrive — the
    // host box is present AND carries the reason it is empty.
    await waitFor(() => expect(screen.getByTestId('terminal-host')).toBeTruthy());
    expect(screen.getByTestId('terminal-host-placeholder').textContent).toContain('disabled in this build');
    expect(panel).toBeTruthy();
  });
});

/**
 * ONE DERIVATION, TWO READERS (review finding, 2026-09-05).
 *
 * The account menu carries a setup nudge computed from the same status this
 * section reads. It was refreshed only by the setup DIALOG, so connecting a
 * provider HERE left the menu asserting the opposite until a reload — and
 * `GateApp` is keyed on the server id, so nothing else cleared it.
 */
describe('Settings tells the other reader when the status changed', () => {
  // CONNECTED on purpose: the block hides Disconnect on a measured
  // disconnection, so a disconnected fixture has no write to trigger.
  const status = {
    providers: [connection({ provider: 'github', connected: true, login: 'octocat' })],
    gitCredentialStore: 'present' as const,
  };

  it('reports every read, including the one after a write', async () => {
    const onStatusRead = vi.fn();
    render(<CredentialsSection port={portWith(status)} onStatusRead={onStatusRead} />);

    // The initial read.
    await waitFor(() => expect(onStatusRead).toHaveBeenCalledTimes(1));
    /* IT HANDS OVER THE VALUE. `credentials.status` shells out on the node
       once per provider, so a callback that only signalled "changed" would
       make the other reader pay for a second one on every write. */
    expect(onStatusRead.mock.calls[0]![0]).toEqual(status);

    // A disconnect reloads, and that reload must be reported too — every
    // write in this section is followed by one, which is why the hook sits on
    // the read rather than on three separate write wrappers.
    fireEvent.click(await screen.findByTestId('credential-disconnect-github'));
    await waitFor(() => expect(onStatusRead).toHaveBeenCalledTimes(2));
  });

  it('is optional — a host that passes none still renders', async () => {
    render(<CredentialsSection port={portWith(status)} />);
    expect(await screen.findByTestId('credential-card-github')).toBeTruthy();
  });
});
