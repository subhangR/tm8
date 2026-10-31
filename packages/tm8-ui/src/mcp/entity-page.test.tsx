// @vitest-environment jsdom
/**
 * The `mcp_server` entity page and the form hints that came with it:
 *  - the page draws the connector itself (status in words, tools with their
 *    parameters, details, used-by, recent calls), not a door to Settings;
 *  - a localhost URL is kept exactly as typed, and the form warns when it is
 *    https or when private networks are off;
 *  - a failed write is worded from its code, never from upstream text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CollabError, type EntityDetail } from '@tm8/contract';
import { McpProvider } from './context';
import { ConnectorEntityBlock } from './ConnectorEntityBlock';
import { ConnectorForm } from './ConnectorForm';
import { isPrivateHost } from './private-host';
import { failureCopy } from './useConnectorRun';
import type { McpCatalog, McpPort, McpServer } from './port';

afterEach(cleanup);

const ID = '0a18de50-0000-4000-8000-000000000001';
const local: McpServer = {
  id: ID, version: 1, title: 'test-mcp', description: '', transport: 'http', url: 'https://127.0.0.1:8787/mcp', auth: 'none',
  approved: true, enabled: true, canManage: true, canAttach: true, accounts: [],
  source: { name: 'test-mcp', transport: 'http', url: 'https://127.0.0.1:8787/mcp', envKeys: [], headerKeys: [], auth: { type: 'none' }, approved: true, allowPrivateNetwork: true },
  health: { ready: false, reason: 'server_unavailable', checkedAt: new Date().toISOString(), tools: [
    { name: 'search_issues', description: 'Search issues.', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'Free text.' } } } },
  ] },
};

function port(over: Partial<McpPort> = {}): McpPort {
  const catalog: McpCatalog = { servers: [local], defaults: [], canRegister: true, canAttach: true };
  return {
    catalog: vi.fn(async () => catalog), catalogEntries: vi.fn(async () => []), addFromCatalog: vi.fn(),
    request: vi.fn(), patch: vi.fn(), register: vi.fn(), update: vi.fn(), remove: vi.fn(),
    importConfig: vi.fn(), importMany: vi.fn(), attach: vi.fn(), detach: vi.fn(),
    test: vi.fn(async () => ({ ok: true, message: 'ready', tools: [] })),
    createKey: vi.fn(), rotateKey: vi.fn(), startOAuth: vi.fn(), share: vi.fn(), revoke: vi.fn(), members: vi.fn(async () => []),
    audit: vi.fn(async () => ({ scope: 'space' as const, nextCursor: null, items: [{
      id: 'a', spaceId: 's', sessionId: null, chatId: null, serverId: ID, credentialId: null, credentialScope: null, method: 'tools/call' as const,
      tool: 'search_issues', outcome: 'failed' as const, denyReason: null, rootMemberId: null, chain: [], via: 'session' as const, mcpTokenId: null,
      latencyMs: 31, requestBytes: null, responseBytes: null, occurredAt: new Date().toISOString(),
    }] })),
    ...over,
  };
}

const detail = {
  id: ID, kind: 'mcp_server', title: 'test-mcp', createdAt: '2026-10-30T17:02:00Z', createdBy: { id: 'm', displayName: 'Ada' },
  connections: { outgoing: [], incoming: [{ type: 'equips', edges: [{ id: 'e', type: 'equips', source: { id: 't', kind: 'task', title: 'Triage bugs' } }] }] },
} as unknown as EntityDetail;

describe('the mcp_server entity page', () => {
  it('draws the connector: status in words, tools with parameters, details, used by and recent calls', async () => {
    const p = port();
    render(<McpProvider port={p}><ConnectorEntityBlock detail={detail} onOpenEntity={() => {}} /></McpProvider>);
    expect(await screen.findByText(/Can't reach https:\/\/127\.0\.0\.1:8787\/mcp/)).toBeTruthy();
    expect(screen.getByText(/local address over https/)).toBeTruthy();
    const tools = screen.getByRole('region', { name: 'Tools' });
    expect(within(tools).getByText('search_issues')).toBeTruthy();
    expect(within(tools).getByText('query')).toBeTruthy();
    expect(within(tools).getByText('required')).toBeTruthy();
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).getByText(/^mcp__test.mcp__$/)).toBeTruthy();
    expect(within(details).getByText(/by Ada/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Used by' })).getByText('Triage bugs')).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Recent calls' })).getByText('Failed')).toBeTruthy());
    expect(p.audit).toHaveBeenCalledWith(ID, 15);
    // The door to Settings is a small link now, not the page.
    expect(screen.getByTestId('settings-home-link').textContent).toBe('Manage connectors →');
  });
});

describe('the connector form, for a local server', () => {
  it('keeps http exactly as typed and warns about https and private networks', async () => {
    const onSave = vi.fn(async () => {});
    render(<ConnectorForm busy={false} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'local' } });
    const url = screen.getByLabelText('Server URL') as HTMLInputElement;
    expect(url.placeholder).toContain('http://127.0.0.1');
    fireEvent.change(url, { target: { value: 'https://127.0.0.1:8787/mcp' } });
    expect(screen.getByText(/local address over/)).toBeTruthy();
    expect(screen.getByText(/refuses localhost and LAN addresses/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use http://127.0.0.1:8787/mcp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow private networks' }));
    expect(url.value).toBe('http://127.0.0.1:8787/mcp');
    expect(screen.queryByText(/local address over/)).toBeNull();
    expect(screen.queryByText(/refuses localhost and LAN addresses/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add connector' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ url: 'http://127.0.0.1:8787/mcp', allowPrivateNetwork: true });
  });

  it('knows which hosts are private', () => {
    for (const url of ['http://localhost:3000/mcp', 'http://127.0.0.1/mcp', 'http://192.168.1.4/mcp', 'http://10.0.0.2/mcp', 'http://172.20.0.1/mcp', 'http://[::1]:8080/mcp'])
      expect(isPrivateHost(url)).toBe(true);
    for (const url of ['https://mcp.notion.com/mcp', 'https://172.32.0.1/mcp', 'not a url', undefined])
      expect(isPrivateHost(url)).toBe(false);
  });
});

describe('failure copy', () => {
  it('words a failure from its code, never from upstream text', () => {
    expect(failureCopy(new CollabError('forbidden', 'secret upstream detail'))).toBe('You don’t have permission to change this connector.');
    expect(failureCopy(new CollabError('version_conflict', 'x'))).toMatch(/Someone else changed/);
    expect(failureCopy(new TypeError('Failed to fetch'))).toMatch(/Couldn’t reach tm8/);
    expect(failureCopy(new Error('secret upstream detail'))).not.toContain('secret');
  });
});
