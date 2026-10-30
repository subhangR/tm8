import React from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityDetail, McpCallAuditRow } from '@tm8/contract';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './shell/shell.css';
import './panels/panels.css';
import './settings-space/settings.css';
import { getKind } from './domain';
import { GenericBody } from './panels/bodies/GenericBody';
import { McpProvider } from './mcp/context';
import { ConnectorsSection } from './mcp/ConnectorsTable';
import type { McpCatalog, McpPort, McpServer } from './mcp/port';

/**
 * CONNECTORS SCRATCH HARNESS — the `settings-dev` pattern for the MCP
 * connector surfaces, which jsdom cannot judge: the Connectors settings page,
 * its row drawer, and the `mcp_server` entity page. A fake port stands in for
 * the server, so every state is drawn without a node.
 *
 * Usage: /connectors-dev.html            settings page
 *        /connectors-dev.html?open=1     settings page with test-mcp's drawer open
 *        /connectors-dev.html?entity=1   the mcp_server entity page
 *        &theme=dark                     dark tokens
 */
const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const now = new Date('2026-10-30T22:36:10Z').toISOString();

const servers: McpServer[] = [
  {
    id: '0a18de50-0000-4000-8000-000000000001', version: 3, title: 'test-mcp', description: '',
    transport: 'http', url: 'https://127.0.0.1:8787/mcp', auth: 'api_key', approved: true, enabled: true,
    canManage: true, canAttach: true, canApprove: true,
    source: {
      name: 'test-mcp', transport: 'http', url: 'https://127.0.0.1:8787/mcp', envKeys: [], headerKeys: ['Authorization'],
      auth: { type: 'api_key', headerName: 'Authorization', prefix: 'Bearer' }, approved: true, enabled: true, allowPrivateNetwork: true,
    },
    health: { ready: false, reason: 'server_unavailable', tools: [
      { name: 'search_issues', description: 'Search issues by text, label or assignee.', inputSchema: { type: 'object', required: ['query'], properties: {
        query: { type: 'string', description: 'Free text, or label:/assignee: filters.' }, limit: { type: 'integer', description: 'At most this many results (default 20).' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] } } } },
      { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', required: ['repo', 'title'], properties: {
        repo: { type: 'string', description: 'owner/name' }, title: { type: 'string' }, body: { type: 'string', description: 'Markdown body.' } } } },
      { name: 'add_comment', description: 'Comment on an issue or pull request.', inputSchema: { type: 'object', properties: {} } },
    ], checkedAt: now },
    accounts: [{ id: 'acc-1', label: 'subhang', canUse: true, canManage: true, status: 'connected', sharing: 'private', scope: 'member', lastUsedAt: now, authType: 'api_key' }],
  },
  {
    id: '0a18de50-0000-4000-8000-000000000002', version: 1, title: 'Notion', description: 'Pages and databases.',
    transport: 'http', url: 'https://mcp.notion.com/mcp', auth: 'oauth', approved: true, enabled: true, canManage: true, canAttach: true,
    source: { name: 'Notion', catalogId: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp', envKeys: [], headerKeys: [], auth: { type: 'oauth2', scopes: [] }, approved: true, defaultOn: true },
    health: { ready: true, reason: 'ready', tools: [{ name: 'search', description: 'Search the workspace.', inputSchema: {} }], checkedAt: now },
    accounts: [{ id: 'acc-2', label: 'Notion', accountLabel: 'subhang@example.com', canUse: true, canManage: true, status: 'connected', sharing: 'space', scope: 'member', lastUsedAt: now }],
  },
  {
    id: '0a18de50-0000-4000-8000-000000000003', version: 1, title: 'yo-mcp', description: '',
    transport: 'http', url: 'https://yo.example/mcp', auth: 'api_key', approved: true, enabled: true, canManage: true, canAttach: true,
    source: { name: 'yo-mcp', transport: 'http', url: 'https://yo.example/mcp', envKeys: [], headerKeys: ['Authorization'], auth: { type: 'api_key', headerName: 'Authorization', prefix: 'Bearer' }, approved: true },
    accounts: [],
  },
  {
    id: '0a18de50-0000-4000-8000-000000000004', version: 1, title: 'local-files', description: '',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], auth: 'none', approved: true, enabled: false, canManage: true, canAttach: true,
    source: { name: 'local-files', transport: 'stdio', command: 'npx', args: [], envKeys: [], headerKeys: [], auth: { type: 'none' }, approved: true, enabled: false, stdioTrusted: true },
    accounts: [],
  },
];

const catalog: McpCatalog = { servers, defaults: [], canRegister: true, canAttach: true };
const ok = async () => undefined;
const port: McpPort = {
  catalog: async () => catalog, catalogEntries: async () => [], addFromCatalog: async () => ({ serverId: servers[0]!.id, adopted: false }),
  request: ok, patch: ok, register: ok, update: ok, remove: ok, importConfig: async () => '', importMany: ok, attach: ok, detach: ok,
  test: async () => ({ ok: true, message: 'ready', tools: servers[0]!.health!.tools }),
  createKey: ok, rotateKey: ok, startOAuth: async () => ({ authorizationUrl: 'https://id.example/a' }),
  share: ok, revoke: ok, members: async () => [],
  audit: async (serverId: string) => ({ scope: 'space', nextCursor: null, items: [
    { outcome: 'failed', tool: 'search_issues', via: 'session', latencyMs: 31, occurredAt: new Date(Date.now() - 4 * 60_000).toISOString() },
    { outcome: 'succeeded', tool: 'search_issues', via: 'chat', latencyMs: 212, occurredAt: new Date(Date.now() - 52 * 60_000).toISOString() },
    { outcome: 'denied', tool: 'create_issue', via: 'session', latencyMs: null, denyReason: 'credential_required', occurredAt: new Date(Date.now() - 3 * 3600_000).toISOString() },
  ].map((row, i) => ({ id: `a${i}`, spaceId: 'space', sessionId: null, chatId: null, serverId, credentialId: null, credentialScope: null, method: 'tools/call' as const,
    rootMemberId: null, chain: [], mcpTokenId: null, requestBytes: null, responseBytes: null, denyReason: null, ...row })) as McpCallAuditRow[] }),
};

if (params.get('open') === '1') window.location.hash = `#/settings/connectors?connector=${servers[0]!.id}`;

const detail = {
  id: servers[0]!.id, kind: 'mcp_server', title: 'test-mcp', version: 3, spaceId: 'space',
  createdAt: '2026-10-30T17:02:00Z', updatedAt: now, createdBy: { id: 'm1', kind: 'team_member', displayName: 'subhang' },
  content: { kind: 'mcp_server', definition: servers[0]!.source }, connections: { outgoing: [], incoming: [{ type: 'equips', edges: [
    { id: 'e1', type: 'equips', source: { id: 't1', kind: 'task', title: 'Triage the inbound bug queue' } },
    { id: 'e2', type: 'equips', source: { id: 'm2', kind: 'team_member', title: 'Worker' } },
  ] }] },
} as unknown as EntityDetail;

function Harness() {
  return (
    <div className="cv2-root shell-scope" data-theme={theme} style={{ minHeight: '100vh', background: 'var(--pn-paper)', display: 'flow-root' }}>
      <McpProvider port={port}>
        {params.get('entity') === '1'
          ? <div style={{ maxWidth: 820, margin: '0 auto', padding: 16 }}><GenericBody detail={detail} blocks={getKind('mcp_server').panel.blocks ?? []} /></div>
          : <div className="set-root" style={{ height: '100vh' }}><div className="set-card"><div style={{ flex: 1, overflow: 'auto' }}><ConnectorsSection /></div></div></div>}
      </McpProvider>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>);
