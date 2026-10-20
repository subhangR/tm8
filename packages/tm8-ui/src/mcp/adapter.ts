import { rememberMcpOAuth } from './oauth-callback';
import { McpUiError } from './errors';
import { detectMcpImportFormat, McpImportError, McpServerDefinitionSchema, translateMcpConfigText, type McpCredentialView, type McpResolveResult, type McpServerDefinition, type McpServerListResult, type McpServerView, type McpTestResult, type Cursor } from '@tm8/contract';
import type { HttpClient } from '../data/real/http';
import type { Seam } from '../data/seam';
import type { McpDefinition, McpPort, McpServer } from './port';

export function definitionFor(input: McpDefinition, previous?: McpServerDefinition): McpServerDefinition {
  const priorAuth = previous?.auth;
  const oauth = priorAuth?.type === 'oauth2' ? priorAuth : undefined;
  const issuer = input.issuer ?? oauth?.issuer;
  const authorizationUrl = input.authorizationUrl ?? oauth?.authorizationUrl;
  const tokenUrl = input.tokenUrl ?? oauth?.tokenUrl;
  const clientId = input.clientId ?? oauth?.clientId;
  const clientSecretEnv = input.clientSecretEnv ?? oauth?.clientSecretEnv;
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
      : { type: 'oauth2', ...(issuer ? { issuer } : {}), ...(authorizationUrl ? { authorizationUrl } : {}), ...(tokenUrl ? { tokenUrl } : {}), ...(clientId ? { clientId } : {}), ...(clientSecretEnv ? { clientSecretEnv } : {}), scopes: input.scopes ?? oauth?.scopes ?? [] },
  };
  return McpServerDefinitionSchema.parse(definition);
}
export function viewOf(server: McpServerView, accounts: McpCredentialView[]): McpServer {
  const d = server.definition;
  return { id: server.id, version: server.version, title: d.name, description: d.provenance ?? '', source: d,
    transport: d.transport, url: d.url, command: d.command, args: d.args, auth: d.auth.type === 'oauth2' ? 'oauth' : d.auth.type,
    approved: d.approved, enabled: d.enabled !== false, canApprove: server.allowed.approve,
    canManage: server.allowed.manage, canAttach: server.allowed.attach, health: server.health,
    accounts: accounts.map(a => ({ id: a.id, label: a.label, ownerId: a.ownerId, ownerLabel: "ownerLabel" in a && typeof a.ownerLabel === "string" ? a.ownerLabel : a.manageable ? "You" : "Another member", canUse: a.usable, canManage: a.manageable,
      status: a.revoked ? 'revoked' : a.usable && a.reason === 'ready' ? 'connected' : a.reason,
      sharing: a.visibility === 'selected' ? 'members' : a.visibility, memberIds: a.sharedMemberIds })),
  };
}
/**
 * Accept a member's REAL harness configuration — `~/.claude.json`, a project
 * `.mcp.json`, `~/.codex/config.toml` — and keep only metadata.
 *
 * This used to refuse any config carrying `type`, `headers` or `env`, which is
 * every config anyone actually has: the box only accepted a hand-written tm8
 * shape. The shared translator (`@tm8/contract`) now reads the real formats
 * and turns a literal header or env token into a DECLARED SLOT. The value it
 * extracts is deliberately dropped here rather than sent anywhere: the member
 * adds their own credential per connector, so no token is ever carried into
 * the Space by an import.
 */
export function importPlan(text: string, trustedCode: boolean): { definitions: McpServerDefinition[]; summary: string } {
  let result;
  try {
    result = translateMcpConfigText(detectMcpImportFormat(text), text, { trustStdio: trustedCode });
  } catch (error) {
    throw new McpUiError(error instanceof McpImportError ? error.message : 'Enter a valid MCP configuration before importing.');
  }
  if (!trustedCode && result.candidates.some(candidate => candidate.requiresStdioTrust)) {
    throw new McpUiError('Local commands need explicit code trust.');
  }
  if (!result.candidates.length) {
    throw new McpUiError(`No connectors tm8 can register: ${result.problems.map(p => `${p.sourceName} — ${p.reason}`).join('; ')}`);
  }
  const definitions = result.candidates.map(candidate => McpServerDefinitionSchema.parse(candidate.definition));
  const needCredential = result.candidates.filter(candidate => candidate.definition.auth.type === 'api_key');
  const oauth = result.candidates.filter(candidate => candidate.definition.auth.type === 'oauth2');
  const summary = [
    `Imported ${definitions.length} connector${definitions.length === 1 ? '' : 's'}; an administrator approves them before any session can use one.`,
    needCredential.length ? `No token was taken from the configuration — add your own key to: ${needCredential.map(c => c.definition.name).join(', ')}.` : '',
    oauth.length ? `Connect in tm8: ${oauth.map(c => c.definition.name).join(', ')}.` : '',
    result.problems.length ? `Skipped ${result.problems.map(p => `${p.sourceName} (${p.reason})`).join('; ')}.` : '',
  ].filter(Boolean).join(' ');
  return { definitions, summary };
}
export function importDefinitions(text: string, trustedCode: boolean): McpServerDefinition[] {
  return importPlan(text, trustedCode).definitions;
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
    async importConfig(json, trustedCode) {
      const { definitions, summary } = importPlan(json, trustedCode);
      await http.call('mcp.servers.import', { params: { spaceId }, body: { ...command(), spaceId, definitions } });
      return summary;
    },
    async attach(targetId, serverId) { await seam.commands.createEdge({ ...command(), srcId: targetId, dstId: serverId, type: 'equips', props: {} }); },
    async detach(targetId, serverId) {
      const edges = await attachments(targetId);
      for (const edge of edges) if (edge.serverId === serverId) await seam.commands.deleteEdge(edge.id, command());
    },
    async test(selection) { const result = await http.call<McpTestResult>('mcp.servers.test', { params: { serverId: selection.serverId }, body: { ...command(), ...selection } }); return { ok: result.ready, message: result.reason, tools: result.tools }; },
    async createKey(serverId, label, secret) { await http.call('mcp.credentials.create', { params: { serverId }, body: { ...command(), serverId, label, secret } }); },
    async rotateKey(_serverId, credentialId, secret) { await http.call('mcp.credentials.rotate', { params: { credentialId }, body: { ...command(), credentialId, secret } }); },
    async startOAuth(serverId, label) {
      let result: {authorizationUrl:string};
      try {
        result = await http.call<{authorizationUrl:string}>('mcp.oauth.begin', { params: { serverId }, body: { ...command(), serverId, label } });
      } catch (error) {
        if (error instanceof Error && ['OAuth client registration failed', 'OAuth client registration rejected by provider'].includes(error.message)) {
          throw new McpUiError('This provider rejected tm8 as an OAuth client. Some providers only allow approved MCP clients; ask the provider to approve tm8, then retry.');
        }
        throw error;
      }
      rememberMcpOAuth(result.authorizationUrl, spaceId);
      return result;
    },
    async share(_serverId, credentialId, sharing, memberIds) { await http.call('mcp.credentials.share', { params: { credentialId }, body: { ...command(), credentialId, visibility: sharing === 'members' ? 'selected' : sharing, memberIds } }); },
    async revoke(_serverId, credentialId) { await http.call('mcp.credentials.revoke', { params: { credentialId }, body: { ...command(), credentialId } }); },
    async members() {
      const members: { id: string; label: string }[] = [];
      let cursor: Cursor | undefined;
      do { const result = await seam.query({ spaceId, kinds: ['member'], limit: 100, cursor }); members.push(...result.page.items.filter(m => m.state?.kind !== 'member' || !m.state.memberStatus).map(m => ({ id: m.id, label: m.title }))); cursor = result.page.nextCursor ?? undefined; } while (cursor);
      return members;
    },
  };
}
