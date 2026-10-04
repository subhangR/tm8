import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../data/real/http';
import { createMcpPort, definitionFor, importDefinitions } from './adapter';
import type { Seam } from '../data/seam';
import type { McpServerDefinition } from '@tm8/contract';
const definition: McpServerDefinition = { name: 'calendar', transport: 'http', url: 'https://fixture.example/mcp', auth: { type: 'api_key', headerName: 'X-API-Key', prefix: 'none' }, envKeys: [], headerKeys: ['X-API-Key'], approved: true, enabled: true };
const server = { id: 'server', spaceId: 'space', version: 2, definition, allowed: { register: true, manage: true, approve: true, attach: true } };
function harness() {
  const calls: { url: string; body: Record<string, unknown> | undefined }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body });
    const data = url.includes('/resolve') ? { ready: false, selections: [{ server, ready: false, reason: 'credential_required' }] }
      : url.endsWith('/credentials') && init?.method === 'GET' ? [{ id: 'account', serverId: 'server', label: 'Work account', authType: 'api_key', visibility: 'private', ownerId: 'owner', sharedMemberIds: [], usable: true, manageable: false, revoked: false, reason: 'ready' }]
      : init?.method === 'GET' ? { items: [server], nextCursor: null, allowed: { register: true, attach: true } } : {};
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const seam = { query: vi.fn(async () => ({ page: { items: [], nextCursor: null } })), connections: vi.fn(async () => ({ items: [{ id: 'edge', type: 'equips', source: { id: 'task' }, target: { id: 'server' } }], nextCursor: null })), commands: { createEdge: vi.fn(), deleteEdge: vi.fn() } };
  const port = createMcpPort(createHttpClient({ fetch }), seam as unknown as Seam, 'space');
  return { port, calls, seam };
}
describe('MCP real operation adapter', () => {
  it('joins only server metadata and never invents a default account', async () => {
    const { port, calls } = harness(); const catalog = await port.catalog('task', 'teammate');
    expect(catalog.defaults).toEqual([{ serverId: 'server' }]);
    expect(catalog.servers[0]?.accounts[0]).toMatchObject({ id: 'account', canUse: true, canManage: false, sharing: 'private' });
    expect(calls.find(c => c.url.includes('/resolve'))?.body).toEqual({ spaceId: 'space', targetIds: ['task'], teamMemberId: 'teammate' });
    expect(calls[0]?.url).toContain('targetId=task');
  });
  it('writes equips edges in the correct direction and deletes only matching edges', async () => {
    const { port, seam } = harness(); await port.attach('task', 'server'); await port.detach('task', 'server');
    expect(seam.commands.createEdge).toHaveBeenCalledWith(expect.objectContaining({ srcId: 'task', dstId: 'server', type: 'equips', props: {} }));
    expect(seam.commands.deleteEdge).toHaveBeenCalledWith('edge', expect.any(Object));
  });
  it('sends key material only in the human-only request body', async () => {
    const { port, calls } = harness(); await port.createKey('server', 'Private', 'fixture-secret'); await port.rotateKey('server', 'account', 'new-secret');
    expect(calls[0]?.body).toMatchObject({ serverId: 'server', label: 'Private', secret: 'fixture-secret' });
    expect(calls[1]?.url).toContain('/credentials/account/rotate'); expect(calls[1]?.body).toMatchObject({ credentialId: 'account', secret: 'new-secret' });
    expect(calls.some(c => c.url.includes('secret'))).toBe(false);
  });
  it('preserves custom authentication settings when changing approval or enabled state', () => {
    expect(definitionFor({ title: 'calendar', description: '', transport: 'http', url: definition.url, auth: 'api_key', approved: false }, definition).auth).toEqual(definition.auth);
  });
  it('supports OAuth discovery without requiring endpoint knowledge', () => {
    const result = definitionFor({ title: 'calendar', description: '', transport: 'http', url: definition.url, auth: 'oauth' });
    expect(result.auth).toEqual({ type: 'oauth2', scopes: [] });
  });
  it('rejects imported secrets and untrusted local commands', () => {
    expect(() => importDefinitions(JSON.stringify({ mcpServers: { fixture: { command: 'fixture', env: { TOKEN: 'secret' } } } }), true)).toThrow();
    expect(() => importDefinitions(JSON.stringify({ mcpServers: { fixture: { command: 'fixture' } } }), false)).toThrow();
    expect(importDefinitions(JSON.stringify({ mcpServers: { fixture: { url: 'https://fixture.example/mcp' } } }), false)[0]).toMatchObject({ approved: false, transport: 'http' });
  });
});

it('preserves the OAuth issuer trust binding during unrelated configuration updates', () => {
  const prior: McpServerDefinition = { ...definition, headerKeys: [], auth: { type: 'oauth2', issuer: 'https://identity.example', clientId: 'fixture-client', scopes: ['read'] } };
  const next = definitionFor({ title: 'calendar', description: '', transport: 'http', url: definition.url, auth: 'oauth', approved: false }, prior);
  expect(next.auth).toEqual(prior.auth);
});
