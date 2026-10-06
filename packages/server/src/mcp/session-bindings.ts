import { CollabError, McpSelectionsSchema, isHumanAuthKind, type McpSelection } from '@tm8/contract';
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
    if (!claims.identityId) throw new CollabError('forbidden', 'MCP launch unavailable');
    if (claims.viaLinkId) {
      // A session started through a space link (W7b) launches with NO MCP
      // servers: `authorize` refuses every link-bound caller anyway, so
      // nothing is bound and nothing is lent. Asking for one is refused;
      // asking for none must not refuse the spawn itself (it did, for every
      // link spawn, local and remote alike).
      if (input.mcpSelections?.length) {
        throw new CollabError('forbidden', 'MCP servers are not available to a session started through a space link');
      }
      return [];
    }
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
          if (!isHumanAuthKind(binding.launcherAuthKind)) throw new CollabError('forbidden', 'MCP launcher unavailable');
          launcher = { identityId: binding.launcherIdentityId, authKind: binding.launcherAuthKind, sessionSpaceId: input.spaceId };
        } catch { sourceUnavailable = true; }
      } else sourceUnavailable = true;
    }
    return this.db.tx(launcher, async q => {
      const stored = input.resume
        ? await q.rpc<unknown>('read_mcp_launch_selections', [input.sessionId]) : null;
      const picks = stored == null ? input.mcpSelections : McpSelectionsSchema.parse(stored);
      let targetIds = input.targetIds;
      if (picks === undefined && targetIds === undefined && runtime.runtimeChatId === input.sessionId) {
        // A chat may be about a task. Use only currently readable, same-space
        // attachment targets, under this launcher's claims; arbitrary readers
        // never lend the chat creator's credential authority.
        const about = await q.query<{ id: string }>(`select distinct e.dst_id as id from public.edges e
          join public.entities t on t.id=e.dst_id
          where e.src_id=$1 and e.type='about' and e.space_id=$2 and t.deleted_at is null
            and t.kind in ('task','team_member','work_session') order by e.dst_id limit 33`, [input.sessionId, input.spaceId]);
        targetIds = about.map(row => row.id);
      }
      const resolved = await resolveMcpSelections(q, {
        spaceId: input.spaceId, teamMemberId: input.teamMemberId,
        ...(targetIds ? { targetIds } : {}),
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
