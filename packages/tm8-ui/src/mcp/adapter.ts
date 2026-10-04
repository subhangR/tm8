import { McpServerDefinitionSchema, type McpCredentialView, type McpResolveResult, type McpServerDefinition, type McpServerListResult, type McpServerView, type McpTestResult, type Cursor } from '@tm8/contract';
import type { HttpClient } from '../data/real/http';
import type { Seam } from '../data/seam';
import type { McpDefinition, McpPort, McpServer } from './port';

export function definitionFor(input: McpDefinition, previous?: McpServerDefinition): McpServerDefinition {
  const priorAuth = previous?.auth;
  const oauth = priorAuth?.type === 'oauth2' ? priorAuth : undefined;
  const authorizationUrl = input.authorizationUrl ?? oauth?.authorizationUrl;
  const tokenUrl = input.tokenUrl ?? oauth?.tokenUrl;
  const clientId = input.clientId ?? oauth?.clientId;
  const slot = input.secretSlot ?? (priorAuth?.type === 'api_key' ? priorAuth.headerName ?? priorAuth.envKey : undefined) ?? (input.transport === 'http' ? 'Authorization' : 'API_KEY');
  const definition = {
    name: input.title, provenance: input.description || undefined, transport: input.transport,
    ...(input.transport === 'http' ? { url: input.url } : { command: input.command, args: input.args ?? [], stdioTrusted: input.trustedCode ?? previous?.stdioTrusted ?? false }),
    approved: input.approved ?? previous?.approved ?? false,
    allowPrivateNetwork: input.allowPrivateNetwork ?? previous?.allowPrivateNetwork ?? false,
    enabled: 'enabled' in input ? input.enabled : previous?.enabled ?? true,
    envKeys: input.auth === 'api_key' && input.transport === 'stdio' ? [slot] : [],
    headerKeys: input.auth === 'api_key' && input.transport === 'http' ? [slot] : [],
    auth: input.auth === 'none' ? { type: 'none' } : input.auth === 'api_key'
      ? { type: 'api_key', ...(input.transport === 'http' ? { headerName: slot, prefix: input.prefix ?? (priorAuth?.type === 'api_key' ? priorAuth.prefix : undefined) ?? 'Bearer' } : { envKey: slot }) }
      : { type: 'oauth2', ...(authorizationUrl ? { authorizationUrl } : {}), ...(tokenUrl ? { tokenUrl } : {}), ...(clientId ? { clientId } : {}), scopes: input.scopes ?? oauth?.scopes ?? [] },
  };
  return McpServerDefinitionSchema.parse(definition);
}
export function viewOf(server: McpServerView, accounts: McpCredentialView[]): McpServer {
  const d = server.definition;
  return { id: server.id, version: server.version, title: d.name, description: d.provenance ?? '', source: d,
    transport: d.transport, url: d.url, command: d.command, args: d.args, auth: d.auth.type === 'oauth2' ? 'oauth' : d.auth.type,
    approved: d.approved, enabled: d.enabled !== false, canApprove: server.allowed.approve,
    canManage: server.allowed.manage, canAttach: server.allowed.attach, health: server.health,
    accounts: accounts.map(a => ({ id: a.id, label: a.label, canUse: a.usable, canManage: a.manageable,
      status: a.revoked ? 'revoked' : a.usable && a.reason === 'ready' ? 'connected' : a.reason,
      sharing: a.visibility === 'selected' ? 'members' : a.visibility, memberIds: a.sharedMemberIds })),
  };
}
/** Import metadata only. Reject unknown secret-bearing env/header fields instead of silently importing them. */
export function importDefinitions(json: string, trustedCode: boolean): McpServerDefinition[] {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an MCP configuration object.');
  const config = parsed as Record<string, unknown>;
  const rows = config.mcpServers;
  if (!rows || typeof rows !== 'object' || Array.isArray(rows) || Object.keys(config).some(k => k !== 'mcpServers')) throw new Error('Expected mcpServers metadata.');
  return Object.entries(rows).map(([name, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid server metadata.');
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).some(key => !['url', 'command', 'args', 'transport', 'auth', 'envKeys', 'headerKeys', 'provenance'].includes(key))) throw new Error('Remove secrets and unsupported fields before importing.');
    const transport = r.transport ?? (r.url ? 'http' : 'stdio');
    if (transport === 'stdio' && !trustedCode) throw new Error('Local commands need explicit code trust.');
    return McpServerDefinitionSchema.parse({ ...r, name, transport, auth: r.auth ?? { type: 'none' }, envKeys: r.envKeys ?? [], headerKeys: r.headerKeys ?? [], approved: false, enabled: true, ...(transport === 'stdio' ? { stdioTrusted: true } : {}) });
  });
}
export function createMcpPort(http: HttpClient, seam: Pick<Seam, 'query' | 'connections' | 'commands'>, spaceId: string): McpPort {
  async function attachments(targetId: string) {
    const edges: { id: string; serverId: string }[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await seam.connections(targetId, { limit: 100, cursor });
      edges.push(...page.items.filter(edge => edge.type === 'equips' && edge.source.id === targetId).map(edge => ({ id: edge.id, serverId: edge.target.id })));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return edges;
  }
  const command = () => ({ clientMutationId: `mcp-${crypto.randomUUID()}` });
  return {
    async catalog(targetId, teamMemberId) {
      const items: McpServerView[] = [];
      let cursor: string | undefined;
      let allowed = { register: false, attach: false };
      do {
        const page = await http.call<McpServerListResult>('mcp.servers.list', { params: { spaceId }, query: { targetId: targetId ?? teamMemberId, limit: 100, cursor } });
        items.push(...page.items); allowed = page.allowed; cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const resolved = await http.call<McpResolveResult>('mcp.resolve', { params: { spaceId }, body: { spaceId, ...(targetId ? { targetIds: [targetId] } : {}), ...(teamMemberId ? { teamMemberId } : {}) } });
      const servers = await Promise.all(items.map(async server => {
        const accounts = server.definition.auth.type === 'none' ? [] : await http.call<McpCredentialView[]>('mcp.credentials.list', { params: { serverId: server.id } });
        return viewOf(server, accounts);
      }));
      return { servers, attachedServerIds: targetId ? (await attachments(targetId)).map(e => e.serverId) : [], defaults: resolved.selections.map(s => ({ serverId: s.server.id, ...(s.credentialId ? { credentialId: s.credentialId } : {}) })), canRegister: allowed.register, canAttach: allowed.attach };
    },
    async register(input) { await http.call('mcp.servers.create', { params: { spaceId }, body: { ...command(), spaceId, definition: definitionFor(input) } }); },
    async update(server, input) { await http.call('mcp.servers.update', { params: { serverId: server.id }, body: { ...command(), serverId: server.id, expectedVersion: server.version, definition: definitionFor(input, server.source) } }); },
    async remove(server) { await http.call('mcp.servers.delete', { params: { serverId: server.id }, body: { ...command(), serverId: server.id, expectedVersion: server.version } }); },
    async importConfig(json, trustedCode) { await http.call('mcp.servers.import', { params: { spaceId }, body: { ...command(), spaceId, definitions: importDefinitions(json, trustedCode) } }); },
    async attach(targetId, serverId) { await seam.commands.createEdge({ ...command(), srcId: targetId, dstId: serverId, type: 'equips', props: {} }); },
    async detach(targetId, serverId) {
      const edges = await attachments(targetId);
      for (const edge of edges) if (edge.serverId === serverId) await seam.commands.deleteEdge(edge.id, command());
    },
    async test(selection) { const result = await http.call<McpTestResult>('mcp.servers.test', { params: { serverId: selection.serverId }, body: { ...command(), ...selection } }); return { ok: result.ready, message: result.reason, tools: result.tools }; },
    async createKey(serverId, label, secret) { await http.call('mcp.credentials.create', { params: { serverId }, body: { ...command(), serverId, label, secret } }); },
    async rotateKey(_serverId, credentialId, secret) { await http.call('mcp.credentials.rotate', { params: { credentialId }, body: { ...command(), credentialId, secret } }); },
    startOAuth(serverId, label) { return http.call('mcp.oauth.begin', { params: { serverId }, body: { ...command(), serverId, label } }); },
    async share(_serverId, credentialId, sharing, memberIds) { await http.call('mcp.credentials.share', { params: { credentialId }, body: { ...command(), credentialId, visibility: sharing === 'members' ? 'selected' : sharing, memberIds } }); },
    async revoke(_serverId, credentialId) { await http.call('mcp.credentials.revoke', { params: { credentialId }, body: { ...command(), credentialId } }); },
    async members() {
      const members: { id: string; label: string }[] = [];
      let cursor: Cursor | undefined;
      do { const result = await seam.query({ spaceId, kinds: ['member'], limit: 100, cursor }); members.push(...result.page.items.map(m => ({ id: m.id, label: m.title }))); cursor = result.page.nextCursor ?? undefined; } while (cursor);
      return members;
    },
  };
}
