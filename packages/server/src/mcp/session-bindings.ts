import { CollabError, McpSelectionsSchema, type McpSelection } from '@tm8/contract';
import type { Db, DbClaims } from '../db/types.js';
import { resolveBearerIdentity } from '../identity/pg-auth.js';
import { hashToken, parseToken } from '../identity/crypto.js';
import { resolveMcpSelections } from './definitions.js';

export interface McpBindInput {
  sessionId: string; spaceId: string; teamMemberId: string; targetIds?: string[];
  mcpSelections?: McpSelection[]; agentToken: string; resume?: boolean;
}
export interface McpBindingClaims extends DbClaims {
  authSessionId?: string;
  /** Verified source bearer provenance; supplied by server execution handlers. */
  mcpSource?: { authSessionId?: string; sessionId?: string };
}
export interface DurableMcpGrant {
  sessionId: string; spaceId: string; identityId: string; serverId: string;
  credentialId?: string; launcherIdentityId: string; launcherAuthKind: string;
}
interface Binding extends Omit<DurableMcpGrant, 'serverId' | 'credentialId'> { selections: McpSelection[] }

/** The only writer of runtime grants. Graph metadata is never an authority source. */
export class McpSessionBindings {
  constructor(private readonly db: Db) {}

  async bind(claims: McpBindingClaims, input: McpBindInput): Promise<McpSelection[]> {
    if (!claims.identityId || claims.viaLinkId) throw new CollabError('forbidden', 'MCP launch unavailable');
    const runtime = await resolveBearerIdentity(this.db, input.agentToken);
    if (runtime.viaLinkId || runtime.spaceId !== input.spaceId ||
        (runtime.workSessionId !== input.sessionId && runtime.runtimeChatId !== input.sessionId)) {
      throw new CollabError('forbidden', 'MCP runtime unavailable');
    }
    const parsed = parseToken(input.agentToken);
    if (!parsed) throw new CollabError('forbidden', 'MCP runtime unavailable');
    let launcher: DbClaims = claims;
    let sourceUnavailable = false;
    if (['agent', 'agent_runtime'].includes(claims.authKind ?? '')) {
      const source = claims.mcpSource;
      if (source?.sessionId && source.authSessionId) {
        try {
          const binding = await this.db.rpc<Binding>(claims, 'read_mcp_session_binding', [source.sessionId, source.authSessionId]);
          launcher = { identityId: binding.launcherIdentityId, authKind: binding.launcherAuthKind, sessionSpaceId: input.spaceId };
        } catch { sourceUnavailable = true; }
      } else sourceUnavailable = true;
    }
    return this.db.tx(launcher, async q => {
      const stored = input.resume
        ? await q.rpc<unknown>('read_mcp_launch_selections', [input.sessionId]) : null;
      const picks = stored == null ? input.mcpSelections : McpSelectionsSchema.parse(stored);
      const resolved = await resolveMcpSelections(q, {
        spaceId: input.spaceId, teamMemberId: input.teamMemberId,
        ...(input.targetIds ? { targetIds: input.targetIds } : {}),
        ...(picks !== undefined ? { mcpSelections: picks } : {}),
      }, async (selection, server) => {
        await q.rpc('read_mcp_credential', [server.spaceId, server.id, selection.credentialId]);
        return 'ready';
      });
      if (!resolved.ready) throw new CollabError('forbidden', `MCP launch unavailable: ${resolved.selections.find(s => !s.ready)?.reason}`);
      if (sourceUnavailable && resolved.selections.length) throw new CollabError('forbidden', 'MCP delegated launch requires a live launcher binding');
      const selections = resolved.selections.map(s => ({ serverId: s.server.id,
        ...(s.credentialId ? { credentialId: s.credentialId } : {}) }));
      await q.rpc('bind_mcp_session', [input.sessionId, hashToken(parsed.secret), JSON.stringify(selections)]);
      return selections;
    });
  }

  async authorize(claims: McpBindingClaims, sessionId: string, serverId: string): Promise<DurableMcpGrant> {
    if (!claims.authSessionId || !claims.identityId || claims.viaLinkId ||
        !['agent', 'agent_runtime'].includes(claims.authKind ?? '')) {
      throw new CollabError('forbidden', 'MCP runtime unavailable');
    }
    const binding = await this.db.rpc<Binding>(claims, 'read_mcp_session_binding', [sessionId, claims.authSessionId]);
    const selected = McpSelectionsSchema.parse(binding.selections).find(s => s.serverId === serverId);
    if (!selected || binding.identityId !== claims.identityId) throw new CollabError('forbidden', 'MCP connector is not selected');
    const launcher: DbClaims = { identityId: binding.launcherIdentityId, authKind: binding.launcherAuthKind,
      sessionSpaceId: binding.spaceId };
    // Resolution is repeated per proxy operation; no approval or sharing snapshot.
    const resolved = await this.db.tx(launcher, q => resolveMcpSelections(q, {
      spaceId: binding.spaceId, mcpSelections: [selected],
    }, async (selection, server) => {
      await q.rpc('read_mcp_credential', [server.spaceId, server.id, selection.credentialId]);
      return 'ready';
    }));
    if (!resolved.ready) throw new CollabError('forbidden', 'MCP connector access has changed');
    return { sessionId, spaceId: binding.spaceId, identityId: binding.identityId, serverId,
      launcherIdentityId: binding.launcherIdentityId, launcherAuthKind: binding.launcherAuthKind,
      ...(selected.credentialId ? { credentialId: selected.credentialId } : {}) };
  }
}
