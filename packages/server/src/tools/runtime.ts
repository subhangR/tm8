import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { CollabError, DEFAULT_TOOL_CAP, type ToolRunInput, type ToolSecretBindInput } from '@tm8/contract';
import { ToolSessionLauncher, resolveToolInputs, confineToolPath, type PtyHostService, type SpawnService } from '@tm8/execution';
import type { Db, DbClaims } from '../db/types.js';
import type { RequestIdentity } from '../http/types.js';
import { loadTool } from './views.js';
import { formatToken, generateSecret, hashToken } from '../identity/crypto.js';
import { loadOrCreateCredentialKey } from '../credentials/credential-key.js';
import { openSecret, sealSecret } from '../credentials/secret-box.js';
import { randomUUID } from 'node:crypto';

export interface ToolRuntimeOptions {
  db: Db; pty: PtyHostService; spawnService: SpawnService; dataDir: string; baseUrl: string; nodeId: string;
}
export function toolTokenScope(access: 'read' | 'write', invokerScope: 'read' | 'write' | undefined): 'read' | 'write' {
  return access === 'read' || invokerScope === 'read' ? 'read' : 'write';
}
export class ToolRuntime {
  private readonly launcher: ToolSessionLauncher;
  constructor(private readonly options: ToolRuntimeOptions) {
    this.launcher = new ToolSessionLauncher({ pty: options.pty, dataDir: options.dataDir, baseUrl: options.baseUrl });
  }
  async createSecret(claims: DbClaims, input: ToolSecretBindInput & { value: string }): Promise<void> {
    const tool = await this.options.db.tx(claims, q => loadTool(q, input.toolId));
    const id = randomUUID();
    const sealed = sealSecret(await loadOrCreateCredentialKey(this.options.dataDir), input.value,
      { spaceId: tool.spaceId, credentialId: id, provider: 'tool' });
    await this.options.db.rpc(claims, 'create_tool_credential', [id, tool.spaceId, tool.id, input.inputName,
      input.label ?? `${tool.definition.name}: ${input.inputName}: ${id.slice(0, 8)}`, '••••', sealed.ciphertext, sealed.nonce,
      input.expectedVersion, input.actorId ?? null, input.clientMutationId]);
  }
  async run(claims: DbClaims, identity: RequestIdentity, input: ToolRunInput): Promise<{
    sessionId: string; toolId: string; toolVersion: number; sourceSha256: string; keepOpen: boolean; reused: boolean;
  }> {
    if (claims.viaLinkId || claims.authKind === 'link') throw new CollabError('forbidden', 'Tool runs are unavailable through space links');
    const tool = await this.options.db.tx(claims, q => loadTool(q, input.toolId));
    const access = tool.definition.tm8Access;
    if (access !== 'none' && (identity.authKind !== 'agent' || !identity.actorId || !identity.sessionId || !claims.workSessionId)) {
      throw new CollabError('forbidden', 'Tools with tm8Access read or write require an invoking agent persona in v1');
    }
    const caller = claims.workSessionId ? (await this.options.db.query<{ workdir_path: string | null }>(claims,
      'select workdir_path from public.work_sessions where entity_id=$1', [claims.workSessionId]))[0]?.workdir_path : null;
    const scratch = join(this.options.dataDir, 'tool-workspaces', claims.identityId!, tool.id);
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const grants = await this.options.db.rpc<Array<{ rootPath: string }>>(claims, 'my_path_grants');
    const roots = [...(caller ? [caller] : []), scratch, ...grants.map(grant => grant.rootPath)];
    const cwd = input.cwd ? await confineToolPath(input.cwd, caller ?? scratch, roots) : await realpath(caller ?? scratch);
    const resolved = await resolveToolInputs(tool, input.inputs ?? {}, input.secrets ?? {}, {
      cwd, roots,
      readSecret: async (inputName, credentialId) => {
        const row = await this.options.db.rpc<{ credentialId: string; ciphertext: string; nonce: string }>(claims,
          'read_tool_credential', [tool.spaceId, tool.id, inputName, credentialId]);
        if (row.credentialId !== credentialId) throw new CollabError('forbidden', 'Tool credential is unavailable');
        try { return openSecret(await loadOrCreateCredentialKey(this.options.dataDir), {
          ciphertext: Buffer.from(row.ciphertext, 'base64'), nonce: Buffer.from(row.nonce, 'base64'),
        }, { spaceId: tool.spaceId, credentialId, provider: 'tool' }); }
        catch { throw new CollabError('forbidden', 'Tool credential is unavailable'); }
      },
    });
    let started: { entity: { id: string }; __tm8_replayed?: boolean };
    try {
      started = await this.options.db.rpc(claims, 'start_tool_session', [tool.spaceId, tool.id, input.expectedVersion ?? tool.version,
        JSON.stringify(resolved.values), input.keepOpen, this.options.nodeId, cwd, DEFAULT_TOOL_CAP, input.actorId ?? null, input.clientMutationId]);
    } catch (error) {
      if (error instanceof CollabError && error.code === 'limit_exceeded') {
        throw new CollabError('limit_exceeded', 'Tool session cap of 8 reached; idle keep-open shells count. Close an open tool tab and retry.');
      }
      throw error;
    }
    const sessionId = started.entity.id;
    const [pin] = await this.options.db.query<{ tool_version: number; tool_source_sha256: string; tool_keep_open: boolean }>(claims,
      'select tool_version,tool_source_sha256,tool_keep_open from public.work_sessions where entity_id=$1', [sessionId]);
    const pinnedVersion = pin ? Number(pin.tool_version) : tool.version;
    const result = { sessionId, toolId: tool.id, toolVersion: pinnedVersion, sourceSha256: pin?.tool_source_sha256 ?? tool.sourceSha256,
      keepOpen: pin?.tool_keep_open ?? input.keepOpen, reused: this.options.pty.hasSession(sessionId) };
    if (started.__tm8_replayed) {
      // A transport retry never reruns code or remints its token.
      return result;
    }
    const revokeToken = async () => { await this.options.db.rpc(claims, 'revoke_agent_auth_session', [sessionId]); };
    const recordExit = async (exit: { exitCode: number | null; state: string; outputTail: string }) => {
      await this.options.db.rpc(claims, 'record_tool_exit', [sessionId, exit.exitCode, exit.state, exit.outputTail]);
    };
    let token: string | undefined;
    try {
      if (access !== 'none') {
        const secret = generateSecret();
        const row = await this.options.db.rpc<{ id: string }>(claims, 'issue_tool_session_agent_session',
          [sessionId, identity.actorId!, hashToken(secret), new Date(Date.now() + (tool.definition.timeoutSeconds + 60) * 1000).toISOString(), toolTokenScope(access, identity.apiScope), identity.sessionId!]);
        if (!row.id) throw new CollabError('upstream_unavailable', 'Tool token mint returned no session');
        token = formatToken(row.id, secret);
      }
      // Mark running before spawn: a one-line tool can exit immediately and
      // its normal process exit must never race a later spawning->running write.
      await this.options.db.rpc(claims, 'work_session_transition', [sessionId, 'running']);
      await this.launcher.launch({ sessionId, toolId: tool.id, toolVersion: pinnedVersion, definition: tool.definition,
        inputs: resolved, cwd, keepOpen: input.keepOpen, ...(token ? { token } : {}),
        onReady: () => this.options.spawnService.adoptToolSession(claims, sessionId), recordExit, revokeToken });
    } catch (error) {
      this.options.pty.kill(sessionId);
      await revokeToken(); await recordExit({ exitCode: null, state: 'killed', outputTail: '' });
      await this.options.db.rpc(claims, 'work_session_transition', [sessionId, 'failed', null, 'Tool launch failed']);
      throw new CollabError('upstream_unavailable', 'Tool launch failed');
    }
    return result;
  }
  /** Startup repair: no tool token may outlive a process lost in a server restart. */
  async reconcile(claims: DbClaims): Promise<void> {
    const rows = await this.options.db.query<{ entity_id: string }>(claims,
      `select w.entity_id from public.work_sessions w join public.entities e on e.id=w.entity_id
       where w.session_kind='tool' and w.tool_state='running' and w.node_id=$1 and e.deleted_at is null`, [this.options.nodeId]);
    for (const row of rows) {
      if (this.options.pty.hasSession(row.entity_id)) continue;
      await this.options.db.rpc(claims, 'revoke_agent_auth_session', [row.entity_id]);
      await this.options.db.rpc(claims, 'record_tool_exit', [row.entity_id, null, 'killed', '']);
    }
  }
}
