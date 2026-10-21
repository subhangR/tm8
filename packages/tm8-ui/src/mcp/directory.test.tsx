// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { McpServerDefinitionSchema } from '@tm8/contract';
import { McpProvider } from './context';
import { McpSettings } from './McpSettings';
import { MCP_DIRECTORY } from './directory';
import { definitionFor } from './adapter';
import type { McpCatalog, McpPort } from './port';
afterEach(cleanup);
function fixture(data: McpCatalog): McpPort {
  return { catalog: vi.fn(async () => data), register: vi.fn(async () => undefined), update: vi.fn(), remove: vi.fn(), importConfig: vi.fn(), attach: vi.fn(), detach: vi.fn(),
    test: vi.fn(), createKey: vi.fn(), rotateKey: vi.fn(), startOAuth: vi.fn(), share: vi.fn(), revoke: vi.fn(), members: vi.fn(async () => []) } as unknown as McpPort;
}
const empty = (): McpCatalog => ({ canRegister: true, canAttach: true, defaults: [], servers: [] });

describe('MCP connector directory', () => {
  it('ships contract-valid definitions once an administrator supplies what the provider requires', () => {
    for (const entry of MCP_DIRECTORY) {
      const auth = entry.definition.auth;
      // A preregistered secret is only meaningful with the provider-issued client id the administrator enters.
      const completed = auth.type === 'oauth2' && auth.clientSecretEnv ? { ...entry.definition, auth: { ...auth, clientId: 'issued-id' } } : entry.definition;
      expect(() => McpServerDefinitionSchema.parse(completed), entry.id).not.toThrow();
      expect(entry.definition.approved).toBe(false);
    }
    const slack = MCP_DIRECTORY.find(e => e.id === 'slack')!.definition;
    expect(() => McpServerDefinitionSchema.parse(slack)).toThrow('client secret requires a client id');
  });
  it('prefills Slack from the directory and registers the client secret by variable name only', async () => {
    const port = fixture(empty());
    render(<McpProvider port={port}><McpSettings /></McpProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Browse directory' }));
    expect(screen.getByText(/TM8_MCP_CLIENT_SECRET_SLACK and restart tm8/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Slack' }));
    expect((screen.getByLabelText('Server URL') as HTMLInputElement).value).toBe('https://mcp.slack.com/mcp');
    const clientId = screen.getByLabelText('Client ID') as HTMLInputElement;
    expect(clientId.required).toBe(true);
    fireEvent.change(clientId, { target: { value: '123.456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register connector' }));
    await waitFor(() => expect(port.register).toHaveBeenCalledTimes(1));
    const input = vi.mocked(port.register).mock.calls[0]![0];
    const definition = definitionFor(input);
    expect(definition).toMatchObject({ name: 'slack', url: 'https://mcp.slack.com/mcp', approved: false,
      auth: { type: 'oauth2', issuer: 'https://mcp.slack.com', clientId: '123.456', clientSecretEnv: 'TM8_MCP_CLIENT_SECRET_SLACK' } });
    expect((definition.auth as { scopes?: string[] }).scopes).toContain('search:read.public');
  });
  it('marks a directory entry already in the catalog', async () => {
    const data = empty();
    data.servers.push({ id: 's', version: 1, title: 'notion', description: '', transport: 'http', url: 'https://mcp.notion.com/mcp', auth: 'oauth', approved: true, enabled: true, canManage: true, canAttach: true, accounts: [] });
    render(<McpProvider port={fixture(data)}><McpSettings /></McpProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Browse directory' }));
    expect((screen.getByRole('button', { name: 'Already added' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Add Figma' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('clears a removed client secret variable instead of keeping the previous one', () => {
    const previous = definitionFor({ title: 'x', description: '', transport: 'http', url: 'https://x.example/mcp', auth: 'oauth', clientId: 'id', clientSecretEnv: 'TM8_MCP_CLIENT_SECRET_X' });
    expect(previous.auth).toMatchObject({ clientSecretEnv: 'TM8_MCP_CLIENT_SECRET_X' });
    const edited = definitionFor({ title: 'x', description: '', transport: 'http', url: 'https://x.example/mcp', auth: 'oauth', clientId: 'id', clientSecretEnv: '' }, previous);
    expect(edited.auth).not.toHaveProperty('clientSecretEnv');
  });
});
