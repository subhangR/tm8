import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../data/real/http';
import { createMcpPort, definitionFor, importDefinitions, importPlan, previewMcpConfig } from './adapter';
import { McpUiError } from './errors';
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
      : url.includes('/oauth/begin') ? { authorizationUrl: 'https://fixture.example/authorize?state=one', expiresAt: '2026-10-21T00:00:00.000Z' }
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
  it('asks for the defaults and the attachments while the connector list is still in flight', async () => {
    const { seam } = harness();
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/mcp/servers?')) await held;
      const data = url.includes('/resolve') ? { ready: true, selections: [] }
        : url.endsWith('/credentials') ? []
        : { items: [server], nextCursor: null, allowed: { register: true, attach: true } };
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const reading = createMcpPort(createHttpClient({ fetch }), seam as unknown as Seam, 'space').catalog('task', 'teammate');
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/resolve'))).toBe(true));
    expect(seam.connections).toHaveBeenCalledWith('task', expect.anything());
    release();
    expect((await reading).attachedServerIds).toEqual(['server']);
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
  // §10.2: `startOAuth` is TRANSPORT. It used to match two exact server strings
  // here to word the DCR refusal, and both had already changed shape (#1296
  // appends the cause to every message). The wording moved to
  // `errors.ts#connectFailure`, where `connect.test.tsx` asserts it; what is
  // left to pin here is that the scope and the §10.2 `returnTo` reach the wire,
  // because the pending row is the only thing that survives the redirect.
  it('sends the connection scope and the same-tab returnTo to oauth.begin', async () => {
    const { port, calls } = harness();
    await port.startOAuth('server', 'Work', 'space', '/#/s/space/settings/connectors');
    const begin = calls.find(call => call.url.includes('/oauth/begin'));
    expect(begin?.body).toMatchObject({ serverId: 'server', label: 'Work', scope: 'space', returnTo: '/#/s/space/settings/connectors' });
  });

  it('omits scope and returnTo rather than sending empty ones', async () => {
    const { port, calls } = harness();
    await port.startOAuth('server', 'Work');
    const begin = calls.find(call => call.url.includes('/oauth/begin'));
    expect(Object.keys(begin!.body!).sort()).toEqual(['clientMutationId', 'label', 'serverId']);
  });
  it('imports a real Claude configuration as metadata and drops the token it carried', () => {
    const imported = importDefinitions(JSON.stringify({ mcpServers: { fixture: { command: 'fixture', env: { TOKEN: 'fixture-secret' } } } }), true);
    expect(imported[0]).toMatchObject({ transport: 'stdio', command: 'fixture', envKeys: ['TOKEN'], auth: { type: 'api_key', envKey: 'TOKEN' }, approved: false, stdioTrusted: true });
    expect(JSON.stringify(imported)).not.toContain('fixture-secret');
  });
  it('still needs explicit code trust for a local command, and rejects what it cannot register', () => {
    expect(() => importDefinitions(JSON.stringify({ mcpServers: { fixture: { command: 'fixture' } } }), false)).toThrow(McpUiError);
    expect(() => importDefinitions(JSON.stringify({ mcpServers: { fixture: { command: 'npx', args: ['--api-key', 'sk-fixture-abcdefghijklmnop'] } } }), true)).toThrow(/args carry a literal credential/);
    expect(() => importDefinitions('not json', false)).toThrow(McpUiError);
    expect(() => importDefinitions(JSON.stringify({ mcpServers: { fixture: { url: 'https://fixture.example/mcp?token=abc' } } }), false)).toThrow(/query string/);
    expect(importDefinitions(JSON.stringify({ mcpServers: { fixture: { url: 'https://fixture.example/mcp' } } }), false)[0]).toMatchObject({ approved: false, transport: 'http' });
  });
  it('accepts a Codex config.toml pasted into the same box', () => {
    const { definitions, summary } = importPlan('[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n', false);
    expect(definitions[0]).toMatchObject({ name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp', auth: { type: 'oauth2', scopes: [] } });
    expect(summary).toContain('Connect in tm8: linear');
  });
  it('skips an untrusted local command and still imports the rest, matching the CLI', () => {
    const { definitions, summary } = importPlan(JSON.stringify({
      mcpServers: { local: { command: 'npx', args: ['-y', '@acme/server'] }, remote: { type: 'http', url: 'https://api.acme.test/mcp' } },
    }), false);
    expect(definitions.map(d => d.name)).toEqual(['remote']);
    expect(summary).toContain('Skipped local (runs a local command');
  });
  it('dedupes and renames against the connectors the Space already has', () => {
    const existingServers = [
      { id: 'dup', definition: { ...definition, name: 'calendar', url: 'https://fixture.example/mcp' } },
      { id: 'named', definition: { ...definition, name: 'Remote', url: 'https://other.example/mcp' } },
    ];
    const { definitions, summary } = importPlan(JSON.stringify({
      mcpServers: { remote: { type: 'http', url: 'https://api.acme.test/mcp' }, again: { type: 'http', url: 'https://fixture.example/mcp' } },
    }), false, existingServers);
    expect(definitions.map(d => d.name)).toEqual(['remote-2']);
    expect(summary).toContain('Skipped again (already registered as calendar (dup))');
  });
  it('reads the Space\u2019s connectors before importing so a name clash cannot refuse the batch', async () => {
    const { port, calls } = harness();
    await port.importConfig(JSON.stringify({ mcpServers: { calendar: { type: 'http', url: 'https://api.acme.test/mcp' } } }), false);
    const imported = calls.find(c => c.url.includes('/mcp/servers/import'));
    expect(calls.findIndex(c => c.url.includes('/mcp/servers?')) ).toBeLessThan(calls.indexOf(imported!));
    expect((imported?.body?.definitions as Array<{ name: string }>).map(d => d.name)).toEqual(['calendar-2']);
  });
  it('tells the member what the import left for them to do', async () => {
    const { port } = harness();
    const summary = await port.importConfig(JSON.stringify({ mcpServers: { fixture: { url: 'https://other.example/mcp', headers: { 'X-Api-Key': 'fixture-secret' } } } }), false);
    expect(summary).toContain('No token was taken from the configuration');
    expect(summary).toContain('fixture');
  });
});

it('preserves the OAuth issuer trust binding during unrelated configuration updates', () => {
  const prior: McpServerDefinition = { ...definition, headerKeys: [], auth: { type: 'oauth2', issuer: 'https://identity.example', clientId: 'fixture-client', scopes: ['read'] } };
  const next = definitionFor({ title: 'calendar', description: '', transport: 'http', url: definition.url, auth: 'oauth', approved: false }, prior);
  expect(next.auth).toEqual(prior.auth);
});
describe('previewMcpConfig', () => {
  it('turns an entry whose kept args or URL path carry a literal credential into a red row, and keeps the rest importable', () => {
    const rows = previewMcpConfig(JSON.stringify({ mcpServers: {
      argv: { command: 'npx', args: ['server', '--api-key', 'sk-fixture-abcdefghijklmnop'] },
      path: { url: 'https://fixture.example/mcp/sk-fixture-abcdefghijklmnopqrstuv' },
      clean: { url: 'https://fixture.example/mcp' },
    } }));
    expect(rows.find(r => r.key === 'argv')).toMatchObject({ error: expect.stringMatching(/^Remove the credential first/) });
    expect(rows.find(r => r.key === 'argv')?.definition).toBeUndefined();
    expect(rows.find(r => r.key === 'path')).toMatchObject({ error: expect.stringMatching(/^Remove the credential first/) });
    expect(rows.find(r => r.key === 'clean')?.definition).toMatchObject({ transport: 'http', approved: false });
    expect(JSON.stringify(rows)).not.toContain('sk-fixture');
  });
});
