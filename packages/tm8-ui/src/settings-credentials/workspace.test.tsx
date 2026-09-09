// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CredentialsPort } from './port';
import { CredentialsProviderBlock } from './CredentialsProviderBlock';
import { CredentialsSetupDialog } from './CredentialsSetupDialog';
vi.mock('../workspaces/PrivateTerminal', () => ({ PrivateTerminal: (props: { socketPath: string; serverBaseUrl: string }) => <div data-testid="private-login" data-socket={props.socketPath} data-server={props.serverBaseUrl} /> }));
afterEach(cleanup);
it.each(['anthropic', 'openai'] as const)('connects %s through the private terminal and refreshes measured status on finish', async provider => {
  let connected = false;
  const port: CredentialsPort = {
    load: vi.fn(async () => ({ gitCredentialStore: 'present', providers: [{ provider, connected, login: null, authMethod: null, status: connected ? 'active' : 'revoked', connectedAt: null, lastVerifiedAt: null }] })),
    startLogin: vi.fn(async () => ({ provider, spaceId: 'space', workSessionId: 'login', command: provider === 'openai' ? 'codex login --device-auth' : 'claude auth login', expiresAt: new Date().toISOString(), socketPath: '/v2/workspaces/terminals/login/ws' })),
    finishLogin: vi.fn(async () => { connected = true; return { provider, workSessionId: 'login', connected, login: null, authMethod: null, status: 'active', stored: true, terminated: true }; }),
    disconnect: vi.fn(),
  };
  render(<CredentialsProviderBlock port={port} serverBaseUrl="/r/test-node" />);
  fireEvent.click(await screen.findByTestId(`credential-connect-${provider}`));
  const terminal = await screen.findByTestId('private-login');
  expect(terminal.getAttribute('data-socket')).toBe('/v2/workspaces/terminals/login/ws');
  expect(terminal.getAttribute('data-server')).toBe('/r/test-node');
  fireEvent.click(screen.getByTestId('credential-finish-login'));
  await waitFor(() => expect(screen.queryByTestId('private-login')).toBeNull());
  await screen.findByText('Connected — inference access');
  expect(port.finishLogin).toHaveBeenCalledWith('login');
});
it('the guided setup shows a private terminal immediately and cancels the server login', async () => {
  const port: CredentialsPort = {
    load: vi.fn(async () => ({ gitCredentialStore: 'present', providers: [{ provider: 'openai', connected: false, login: null, authMethod: null, status: 'revoked', connectedAt: null, lastVerifiedAt: null }] })),
    startLogin: vi.fn(async () => ({ provider: 'openai', spaceId: 'space', workSessionId: 'login', command: 'codex login --device-auth', expiresAt: new Date().toISOString(), socketPath: '/v2/workspaces/terminals/login/ws' })),
    finishLogin: vi.fn(async () => ({ provider: 'openai', workSessionId: 'login', connected: false, login: null, authMethod: null, status: 'revoked', stored: false, terminated: true })),
    disconnect: vi.fn(),
  };
  render(<CredentialsSetupDialog open port={port} onClose={() => {}} onDismiss={() => {}} />);
  fireEvent.click(await screen.findByTestId('cset-start'));
  fireEvent.click(await screen.findByTestId('cset-connect-openai'));
  await screen.findByTestId('private-login');
  expect(screen.getByTestId('cset-terminal-body').hidden).toBe(false);
  fireEvent.click(screen.getByTestId('cset-cancel'));
  await waitFor(() => expect(port.finishLogin).toHaveBeenCalledWith('login'));
  await waitFor(() => expect(screen.queryByTestId('private-login')).toBeNull());
});
