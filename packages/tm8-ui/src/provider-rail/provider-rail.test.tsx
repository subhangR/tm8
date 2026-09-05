// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import type {
  CredentialConnectionView,
  CredentialProviderName,
  CredentialsStatusView,
} from '@tm8/contract';
import { CredentialsProviderBlock } from '../settings-credentials/CredentialsProviderBlock';
import { CREDENTIAL_PROVIDER_PRESENTATIONS } from '../settings-credentials/provider-presentation';
import type { CredentialsPort } from '../settings-credentials/port';
import { ProviderRail } from './ProviderRail';

function connection(
  provider: CredentialProviderName,
  over: Partial<CredentialConnectionView> = {},
): CredentialConnectionView {
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

const status: CredentialsStatusView = {
  providers: [
    connection('anthropic', { connected: true, status: 'active' }),
    connection('openai'),
    connection('github'),
    connection('gemini', { status: 'stale' }),
    connection('hermes', { status: 'unavailable' }),
    connection('cursor', { connected: true, status: 'active' }),
  ],
  gitCredentialStore: 'present',
};

function portWith(over: Partial<CredentialsPort> = {}): CredentialsPort {
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
      workSessionId: 'ws-provider-login',
      spaceId: 'space-1',
      provider,
      expiresAt: '2026-09-04T12:10:00.000Z',
      command: `${provider} login`,
    }),
    finishLogin: async (workSessionId) => ({
      workSessionId,
      provider: 'openai',
      connected: true,
      login: null,
      authMethod: 'oauth',
      status: 'active',
      stored: true,
      terminated: true,
    }),
    ...over,
  };
}

describe('compact provider rail', () => {
  it('renders all six providers and four state marks with accessible names', async () => {
    const { findByLabelText, getAllByTestId, getByTestId } = render(
      <ProviderRail port={portWith()} />,
    );

    await findByLabelText('Claude Code — connected');
    expect(getAllByTestId(/^provider-rail-chip-/)).toHaveLength(6);

    const expected = {
      anthropic: ['connected', '✓'],
      openai: ['disconnected', '○'],
      hermes: ['unavailable', '×'],
      gemini: ['unknown', '?'],
    } as const;
    for (const [provider, [stateName, mark]] of Object.entries(expected)) {
      const chip = getByTestId(`provider-rail-chip-${provider}`);
      expect(chip.getAttribute('data-provider-state')).toBe(stateName);
      expect(chip.querySelector('.provider-rail__badge')?.textContent).toBe(mark);
    }

    expect(await findByLabelText('Codex — disconnected')).toBeTruthy();
    expect(await findByLabelText('Hermes — unavailable')).toBeTruthy();
    expect(await findByLabelText('Gemini — unknown')).toBeTruthy();
  });

  it('uses verdictOf store completeness: absent GitHub storage is unknown', async () => {
    const port = portWith({
      load: async () => ({ ...status, gitCredentialStore: 'absent' }),
    });
    const { findByLabelText, getByTestId } = render(<ProviderRail port={port} />);

    await findByLabelText('GitHub — unknown');
    expect(getByTestId('provider-rail-chip-github').getAttribute('data-provider-state')).toBe(
      'unknown',
    );
  });

  it('never offers the measured-unavailable provider a failing action', async () => {
    const startLogin = vi.fn<CredentialsPort['startLogin']>();
    const { findByLabelText, getByTestId } = render(
      <ProviderRail port={portWith({ startLogin })} />,
    );

    const hermes = await findByLabelText('Hermes — unavailable');
    expect(hermes.tagName).toBe('SPAN');
    expect(hermes.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(getByTestId('provider-rail-chip-hermes'));
    expect(startLogin).not.toHaveBeenCalled();
  });

  it('starts and finishes a real login flow from a disconnected chip', async () => {
    const startLogin = vi.fn(portWith().startLogin);
    const finishLogin = vi.fn(portWith().finishLogin);
    const port = portWith({ startLogin, finishLogin });
    const { findByLabelText, findByTestId } = render(<ProviderRail port={port} />);

    fireEvent.click(await findByLabelText('Codex — disconnected'));
    await waitFor(() => expect(startLogin).toHaveBeenCalledWith('openai'));
    expect(await findByTestId('provider-rail-login')).toBeTruthy();

    fireEvent.click(await findByTestId('provider-rail-finish-login'));
    await waitFor(() => expect(finishLogin).toHaveBeenCalledWith('ws-provider-login'));
  });

  it('and the full card resolve a provider name from the same presentation table', async () => {
    const port = portWith();
    const { findByLabelText, findByTestId } = render(
      <div>
        <ProviderRail port={port} />
        <CredentialsProviderBlock port={port} />
      </div>,
    );
    const sharedName = CREDENTIAL_PROVIDER_PRESENTATIONS.anthropic.name;
    const chip = await findByLabelText(`${sharedName} — connected`);
    const card = await findByTestId('credential-card-anthropic');

    expect(chip.getAttribute('data-testid')).toBe('provider-rail-chip-anthropic');
    expect(within(card).getByText(sharedName)).toBeTruthy();
  });
});
