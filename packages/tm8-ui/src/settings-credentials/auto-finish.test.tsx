// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CredentialProviderName, CredentialsStatusView } from '@tm8/contract';

vi.mock('../terminal', () => ({
  isLiveTerminalEnabled: () => true,
  TerminalHost: () => <div data-testid="terminal-host" />,
  LiveTerminal: ({
    sessionId,
    onExit,
  }: {
    sessionId: string;
    onExit?: (sessionId: string, exitCode?: number | null) => void;
  }) => (
    <button
      type="button"
      data-testid="fake-terminal-exit"
      onClick={() => onExit?.(sessionId, 0)}
    >
      exit
    </button>
  ),
}));

import { CredentialsSection } from './CredentialsSection';
import type { CredentialsPort } from './port';

function statusFor(
  provider: CredentialProviderName,
  connected: boolean,
): CredentialsStatusView {
  return {
    providers: [{
      provider,
      connected,
      login: connected ? `${provider}-member` : null,
      authMethod: connected ? 'oauth' : null,
      status: connected ? 'active' : null,
      connectedAt: null,
      lastVerifiedAt: null,
    }],
    gitCredentialStore: 'present',
  };
}

describe('credential login terminal completion', () => {
  it.each(['anthropic', 'openai', 'github'] as const)(
    'automatically verifies and reloads %s when its login command exits',
    async (provider) => {
      let connected = false;
      const finishLogin = vi.fn(async (workSessionId: string) => {
        connected = true;
        return {
          workSessionId,
          provider,
          connected: true,
          login: `${provider}-member`,
          authMethod: 'oauth',
          status: 'active' as const,
          stored: true,
          // A natural CLI exit is already gone when the server harvests it.
          terminated: false,
        };
      });
      const port: CredentialsPort = {
        load: async () => statusFor(provider, connected),
        disconnect: async () => ({
          provider,
          revoked: true,
          terminatedCredentialSessionIds: [],
          terminatedAgentSessionIds: [],
          failures: [],
        }),
        startLogin: async () => ({
          workSessionId: `login-${provider}`,
          spaceId: 'space-1',
          provider,
          expiresAt: '2026-08-10T10:00:00.000Z',
          command: `${provider} login`,
        }),
        finishLogin,
      };

      render(<CredentialsSection port={port} />);
      fireEvent.click(await screen.findByTestId(`credential-connect-${provider}`));
      fireEvent.click(await screen.findByTestId('fake-terminal-exit'));

      await waitFor(() => expect(finishLogin).toHaveBeenCalledTimes(1));
      expect(finishLogin).toHaveBeenCalledWith(`login-${provider}`);
      await waitFor(() => {
        expect(screen.getByTestId(`credential-verdict-${provider}`).textContent)
          .toContain(`Connected as ${provider}-member`);
      });
      expect(screen.queryByTestId('credential-login-terminal')).toBeNull();
    },
  );

  it('deduplicates a terminal exit racing the manual verify fallback', async () => {
    let release: ((value: Awaited<ReturnType<CredentialsPort['finishLogin']>>) => void) | null = null;
    const finishLogin = vi.fn((workSessionId: string) => new Promise<
      Awaited<ReturnType<CredentialsPort['finishLogin']>>
    >((resolve) => {
      release = resolve;
    }));
    const provider = 'github' as const;
    const port: CredentialsPort = {
      load: async () => statusFor(provider, false),
      disconnect: async () => ({
        provider,
        revoked: true,
        terminatedCredentialSessionIds: [],
        terminatedAgentSessionIds: [],
        failures: [],
      }),
      startLogin: async () => ({
        workSessionId: 'login-github',
        spaceId: 'space-1',
        provider,
        expiresAt: '2026-08-10T10:00:00.000Z',
        command: 'github login',
      }),
      finishLogin,
    };

    render(<CredentialsSection port={port} />);
    fireEvent.click(await screen.findByTestId('credential-connect-github'));
    fireEvent.click(await screen.findByTestId('fake-terminal-exit'));
    fireEvent.click(screen.getByTestId('credential-finish-login'));

    expect(finishLogin).toHaveBeenCalledTimes(1);
    release?.({
      workSessionId: 'login-github',
      provider,
      connected: true,
      login: 'github-member',
      authMethod: 'oauth',
      status: 'active',
      stored: true,
      terminated: false,
    });
  });
});
