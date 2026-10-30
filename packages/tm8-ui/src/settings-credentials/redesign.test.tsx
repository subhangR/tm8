// @vitest-environment jsdom
/**
 * The 2026-10-31 redesign: one status badge per card, one filled action only
 * where something needs doing, and a login panel that owns its own waiting /
 * expired / error states. Wording and verdict honesty stay with
 * `credentials.test.tsx` and `layout.test.tsx`; this file holds what the
 * redesign added.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialProviderName, CredentialsStatusView } from '@tm8/contract';
import { CredentialsSection } from './CredentialsSection';
import { credentialBadgeOf } from './credential-status';
import type { CredentialsPort } from './port';

function connection(
  over: Partial<CredentialsStatusView['providers'][number]> & { provider: CredentialProviderName },
) {
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

function portWith(status: CredentialsStatusView, over: Partial<CredentialsPort> = {}): CredentialsPort {
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
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
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

afterEach(() => {
  vi.useRealTimers();
});

describe('the status badge', () => {
  it('maps every state to one word and one kit tone', () => {
    const word = (over: Parameters<typeof connection>[0], store: 'present' | 'absent' = 'present') => {
      const badge = credentialBadgeOf(connection(over), store);
      return `${badge.word}/${badge.tone}`;
    };
    expect(word({ provider: 'anthropic', connected: true, status: 'active' })).toBe('Connected/run');
    expect(word({ provider: 'anthropic', connected: true, status: 'stale' })).toBe('Expired/wait');
    expect(word({ provider: 'anthropic', connected: true, status: 'revoked' })).toBe('Expired/wait');
    expect(word({ provider: 'openai' })).toBe('Not connected/idle');
    expect(word({ provider: 'github' }, 'absent')).toBe('Unknown/info');
    expect(word({ provider: 'cursor', status: 'unavailable' })).toBe('Unavailable/block');
  });
});

describe('one primary action per card, only where something needs doing', () => {
  it('fills Connect and Reconnect-when-expired, and leaves a healthy Reconnect secondary', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [
            connection({ provider: 'anthropic', connected: true, status: 'active' }),
            connection({ provider: 'openai' }),
            connection({ provider: 'github', connected: true, login: 'ada', status: 'stale' }),
          ],
          gitCredentialStore: 'present',
        })}
      />,
    );

    const healthy = await screen.findByTestId('credential-connect-anthropic');
    expect(healthy.className).not.toContain('cred-action--primary');
    expect(screen.getByTestId('credential-connect-openai').className).toContain('cred-action--primary');
    expect(screen.getByTestId('credential-connect-github').className).toContain('cred-action--primary');

    for (const provider of ['anthropic', 'openai', 'github']) {
      const card = screen.getByTestId(`credential-card-${provider}`);
      expect(card.querySelectorAll('.cred-action--primary').length).toBeLessThanOrEqual(1);
    }
  });

  it('shows when a connection was made, as a time element rather than a raw ISO string', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [
            connection({
              provider: 'anthropic',
              connected: true,
              status: 'active',
              connectedAt: '2026-08-01T00:00:00.000Z',
            }),
          ],
          gitCredentialStore: 'present',
        })}
      />,
    );
    const card = await screen.findByTestId('credential-card-anthropic');
    const time = card.querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe('2026-08-01T00:00:00.000Z');
    expect(card.textContent).not.toContain('2026-08-01T00:00:00.000Z');
  });

  it('tallies the cards and names the ones that need attention', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [
            connection({ provider: 'anthropic', connected: true, status: 'active' }),
            connection({ provider: 'openai', connected: true, status: 'stale' }),
            connection({ provider: 'github' }),
          ],
          gitCredentialStore: 'absent',
        })}
      />,
    );
    const tally = await screen.findByTestId('credentials-tally');
    expect(tally.textContent).toBe('1 of 3 connected · Codex, GitHub need attention');
  });
});

describe('the login panel owns its states', () => {
  const single = { providers: [connection({ provider: 'openai' as const })], gitCredentialStore: 'present' as const };

  it('starts waiting, with steps and a countdown, and Cancel closes it', async () => {
    render(<CredentialsSection port={portWith(single)} />);
    fireEvent.click(await screen.findByTestId('credential-connect-openai'));
    const panel = await screen.findByTestId('credential-login-terminal');

    expect(panel.getAttribute('data-login-state')).toBe('waiting');
    expect(panel.querySelectorAll('.cred-terminal__steps li')).toHaveLength(3);
    expect(within(panel).getByTestId('credential-login-expiry').querySelector('time')).not.toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('credential-login-terminal')).toBeNull();
  });

  it('turns expired when the countdown runs out, offering Start again and still allowing a check', async () => {
    let starts = 0;
    const port = portWith(single, {
      startLogin: async (provider) => {
        starts += 1;
        return {
          workSessionId: `ws-login-${starts}`,
          spaceId: 'space-1',
          provider,
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          command: `${provider} login`,
        };
      },
    });
    render(<CredentialsSection port={port} />);
    fireEvent.click(await screen.findByTestId('credential-connect-openai'));
    const panel = await screen.findByTestId('credential-login-terminal');

    expect(panel.getAttribute('data-login-state')).toBe('expired');
    expect(screen.getByTestId('credential-login-expired')).toBeTruthy();
    expect(screen.getByTestId('credential-finish-login')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('credential-restart-login'));
    });
    expect(starts).toBe(2);
  });

  it('shows a failed check inside the panel, not above the grid', async () => {
    const port = portWith(single, {
      finishLogin: async () => {
        throw new Error('login session expired or closed');
      },
    });
    render(<CredentialsSection port={port} />);
    fireEvent.click(await screen.findByTestId('credential-connect-openai'));
    fireEvent.click(await screen.findByTestId('credential-finish-login'));

    const error = await screen.findByTestId('credential-outcome-error');
    const panel = screen.getByTestId('credential-login-terminal');
    expect(panel.getAttribute('data-login-state')).toBe('error');
    expect(panel.contains(error)).toBe(true);
    expect(error.textContent).toContain('expired or closed');
    expect(screen.getAllByTestId('credential-outcome-error')).toHaveLength(1);
    expect(within(panel).getByTestId('credential-restart-login')).toBeTruthy();
  });
});

describe('outcome notices', () => {
  it('can be dismissed', async () => {
    render(
      <CredentialsSection
        port={portWith({
          providers: [connection({ provider: 'anthropic', connected: true, status: 'active' })],
          gitCredentialStore: 'present',
        })}
      />,
    );
    fireEvent.click(await screen.findByTestId('credential-disconnect-anthropic'));
    const notice = await screen.findByTestId('credential-outcome-disconnect-clean');
    expect(notice.className).toContain('cred-notice--ok');
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('credential-outcome-disconnect-clean')).toBeNull();
  });
});
