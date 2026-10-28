import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CollabError, DEFAULT_TOOL_CAP, isHumanAuthKind, validateToolInputValue,
  type ToolJsonValue, type ToolRunInput, type ToolSecretBindInput, type ToolView,
} from '@tm8/contract';
import {
  ToolSessionLauncher, resolveToolInputs, confineToolPath,
  type PtyHostService, type ResolvedToolInputs, type SpawnService, type ToolExit,
} from '@tm8/execution';
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
/**
 * One loop firing of a tool (docs/features/tools/SCHEDULED-RUNS.md). Built by the
 * in-process loop executor from the loop row; never from wire input.
 */
export interface ScheduledToolRunRequest {
  toolId: string;
  /** Stored public values; a bound secret is used by leaving its slot out. */
  inputs: Record<string, ToolJsonValue>;
  /** Distinct per firing: two firings are two runs, a retry of one is a replay. */
  firingKey: string;
  triggeredByLoopId: string;
  /** The loop's runs-as teammate; required when the tool has tm8 API access. */
  runAsTeamMemberId?: string;
  /** The loop's title: printed in the run header, not applied to the session title (always the tool's name). */
  title?: string;
}
export interface ScheduledToolRun { sessionId: string; toolVersion: number; sourceSha256: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A firing runs under `claimsForLoop` (375) and nothing else: the firing member's
 * identity, no bearer, link, work session, actor or job claim, no node admin.
 */
function assertFiringClaims(claims: DbClaims): void {
  if (!claims.identityId || claims.nodeAdmin || claims.authKind || claims.authSessionId || claims.viaLinkId
    || claims.workSessionId || claims.sessionSpaceId || claims.actorId || claims.backgroundJob) {
    throw new CollabError('forbidden', 'Scheduled tool runs take the loop executor\'s firing claims, never a bearer');
  }
}
/** Every reason a firing's stored inputs no longer fit the CURRENT definition, so one error names them all. */
export function scheduledInputProblems(tool: ToolView, inputs: Record<string, ToolJsonValue>): string[] {
  const declared = new Map(tool.definition.inputs.map(input => [input.name, input]));
  const problems: string[] = [];
  for (const [name, value] of Object.entries(inputs)) {
    const input = declared.get(name);
    if (!input) problems.push(`${name} (not declared)`);
    else if (input.type === 'secret') problems.push(`${name} (secret values are never stored; bind the secret to the tool)`);
    else if (!validateToolInputValue(input, value)) problems.push(`${name} (invalid ${input.type})`);
  }
  for (const input of tool.definition.inputs) {
    if (!input.required || Object.hasOwn(inputs, input.name)) continue;
    const supplied = input.type === 'secret' ? tool.secretBindings.some(binding => binding.inputName === input.name)
      : Object.hasOwn(tool.config, input.name) || input.default !== undefined;
    if (!supplied) problems.push(`${input.name} (required${input.type === 'secret' ? ' secret is not bound' : ''})`);
  }
  return problems;
}
export class ToolRuntime {
  private readonly launcher: ToolSessionLauncher;
  constructor(private readonly options: ToolRuntimeOptions) {
    this.launcher = new ToolSessionLauncher({ pty: options.pty, dataDir: options.dataDir, baseUrl: options.baseUrl });
  }
  async createSecret(claims: DbClaims, input: ToolSecretBindInput & { toolId: string; value: string }): Promise<void> {
    const tool = await this.options.db.tx(claims, q => loadTool(q, input.toolId));
    const id = randomUUID();
    const sealed = sealSecret(await loadOrCreateCredentialKey(this.options.dataDir), input.value,
      { spaceId: tool.spaceId, credentialId: id, provider: 'tool' });
    await this.options.db.rpc(claims, 'create_tool_credential', [id, tool.spaceId, tool.id, input.inputName,
      input.label ?? `${tool.definition.name}: ${input.inputName}: ${id.slice(0, 8)}`, '••••', sealed.ciphertext, sealed.nonce,
      input.expectedVersion, input.actorId ?? null, input.clientMutationId]);
  }
  async run(claims: DbClaims, identity: RequestIdentity, input: ToolRunInput & { toolId: string }): Promise<{
    sessionId: string; toolId: string; toolVersion: number; sourceSha256: string; keepOpen: boolean; reused: boolean;
  }> {
    if (claims.viaLinkId || claims.authKind === 'link') throw new CollabError('forbidden', 'Tool runs are unavailable through space links');
    const tool = await this.options.db.tx(claims, q => loadTool(q, input.toolId));
    const access = tool.definition.tm8Access;
    // An agent's run token acts as its persona under its live bearer; a human's
    // (browser, CLI or the loopback owner) acts as the human's own account.
    const human = isHumanAuthKind(identity.authKind);
    if (access !== 'none' && !human && (identity.authKind !== 'agent' || !identity.actorId || !identity.sessionId || !claims.workSessionId)) {
      throw new CollabError('forbidden', 'Tools with tm8Access read or write require a human session or an invoking agent persona');
    }
    const caller = claims.workSessionId ? (await this.options.db.query<{ workdir_path: string | null }>(claims,
      'select workdir_path from public.work_sessions where entity_id=$1', [claims.workSessionId]))[0]?.workdir_path : null;
    const scratch = await this.scratchDir(claims, tool);
    const grants = await this.options.db.rpc<Array<{ rootPath: string }>>(claims, 'my_path_grants');
    const roots = [...(caller ? [caller] : []), scratch, ...grants.map(grant => grant.rootPath)];
    const cwd = input.cwd ? await confineToolPath(input.cwd, caller ?? scratch, roots) : await realpath(caller ?? scratch);
    const resolved = await resolveToolInputs(tool, input.inputs ?? {}, input.secrets ?? {}, {
      cwd, roots, readSecret: this.secretReader(claims, tool),
    });
    let started: { entity: { id: string }; __tm8_replayed?: boolean };
    try {
      started = await this.options.db.rpc(claims, 'start_tool_session', [tool.spaceId, tool.id, input.expectedVersion ?? tool.version,
        JSON.stringify(resolved.values), input.keepOpen, this.options.nodeId, cwd, DEFAULT_TOOL_CAP, input.actorId ?? null, input.clientMutationId]);
    } catch (error) { throw capMessage(error); }
    const sessionId = started.entity.id;
    const pin = await this.pins(claims, sessionId);
    const pinnedVersion = pin ? Number(pin.tool_version) : tool.version;
    const result = { sessionId, toolId: tool.id, toolVersion: pinnedVersion, sourceSha256: pin?.tool_source_sha256 ?? tool.sourceSha256,
      keepOpen: pin?.tool_keep_open ?? input.keepOpen, reused: this.options.pty.hasSession(sessionId) };
    if (started.__tm8_replayed) {
      // A transport retry never reruns code or remints its token.
      return result;
    }
    let token: string | undefined;
    try {
      if (access !== 'none') {
        const secret = generateSecret();
        const expires = new Date(Date.now() + (tool.definition.timeoutSeconds + 60) * 1000).toISOString();
        const scope = toolTokenScope(access, identity.apiScope);
        const row = human
          ? await this.options.db.rpc<{ id: string }>(claims, 'issue_tool_session_human_session',
            [sessionId, hashToken(secret), expires, scope, identity.sessionId ?? null])
          : await this.options.db.rpc<{ id: string }>(claims, 'issue_tool_session_agent_session',
            [sessionId, identity.actorId!, hashToken(secret), expires, scope, identity.sessionId!]);
        if (!row.id) throw new CollabError('upstream_unavailable', 'Tool token mint returned no session');
        token = formatToken(row.id, secret);
      }
      await this.launchPinned(claims, { sessionId, tool, toolVersion: pinnedVersion, inputs: resolved, cwd, keepOpen: input.keepOpen, token });
    } catch (error) {
      await this.abandon(claims, sessionId);
      throw new CollabError('upstream_unavailable', 'Tool launch failed');
    }
    return result;
  }
  /**
   * A loop firing (docs/features/tools/SCHEDULED-RUNS.md): the server-internal
   * entry point the loop executor calls with `claimsForLoop`, recorded like every
   * other run. It reads no loop row; the executor hands over the tool, inputs,
   * persona and loop id. Refusals before any row: invalid_input (stale inputs,
   * missing persona), forbidden (a bound secret the firing account may not use).
   * After the row: version_conflict and limit_exceeded from start_tool_session,
   * forbidden from the mint, upstream_unavailable 'Tool launch failed' — the
   * last two leave the run recorded as killed, with its edge and token revoked.
   */
  async runScheduled(claims: DbClaims, request: ScheduledToolRunRequest): Promise<ScheduledToolRun> {
    assertFiringClaims(claims);
    if (!UUID_RE.test(request.triggeredByLoopId)) throw new CollabError('invalid_input', 'triggeredByLoopId must be a loop id');
    if (!request.firingKey.trim()) throw new CollabError('invalid_input', 'firingKey must not be empty');
    const tool = await this.options.db.tx(claims, q => loadTool(q, request.toolId));
    const access = tool.definition.tm8Access;
    if (access !== 'none' && !request.runAsTeamMemberId) {
      throw new CollabError('invalid_input', `tool ${tool.definition.name} needs a runs-as persona for tm8 API access`);
    }
    const problems = scheduledInputProblems(tool, request.inputs);
    if (problems.length) {
      throw new CollabError('invalid_input', `Loop inputs do not fit tool ${tool.definition.name} v${tool.version}: ${problems.join('; ')}`);
    }
    // No caller session and no cwd override: the firing member's scratch dir.
    const scratch = await this.scratchDir(claims, tool);
    const grants = await this.options.db.rpc<Array<{ rootPath: string }>>(claims, 'my_path_grants');
    const roots = [scratch, ...grants.map(grant => grant.rootPath)];
    const cwd = await realpath(scratch);
    const resolved = await resolveToolInputs(tool, request.inputs, {}, { cwd, roots, readSecret: this.secretReader(claims, tool) });
    let started: { entity: { id: string }; __tm8_replayed?: boolean };
    try {
      // The version this firing validated, never null: null skips the stale check.
      started = await this.options.db.rpc(claims, 'start_tool_session', [tool.spaceId, tool.id, tool.version,
        JSON.stringify(resolved.values), false, this.options.nodeId, cwd, DEFAULT_TOOL_CAP, null,
        `tool-fire:${request.firingKey}`, request.triggeredByLoopId]);
    } catch (error) { throw capMessage(error); }
    const sessionId = started.entity.id;
    const pin = await this.pins(claims, sessionId);
    const result = { sessionId, toolVersion: pin ? Number(pin.tool_version) : tool.version,
      sourceSha256: pin?.tool_source_sha256 ?? tool.sourceSha256 };
    if (started.__tm8_replayed) return result;
    let token: string | undefined;
    if (access !== 'none') {
      try {
        const secret = generateSecret();
        const expires = new Date(Date.now() + (tool.definition.timeoutSeconds + 60) * 1000).toISOString();
        const row = await this.options.db.rpc<{ id: string }>(claims, 'issue_tool_session_loop_session',
          [sessionId, request.triggeredByLoopId, request.runAsTeamMemberId, hashToken(secret), expires, toolTokenScope(access, claims.apiScope)]);
        if (!row.id) throw new CollabError('upstream_unavailable', 'Tool token mint returned no session');
        token = formatToken(row.id, secret);
      } catch (error) {
        // The executor records the mint's own refusal, not a generic launch failure.
        await this.abandon(claims, sessionId);
        throw error;
      }
    }
    try {
      await this.launchPinned(claims, { sessionId, tool, toolVersion: result.toolVersion, inputs: resolved, cwd,
        keepOpen: false, token, origin: request.title?.trim() ? `loop: ${request.title.trim()}` : 'loop' });
    } catch {
      await this.abandon(claims, sessionId);
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
  private async scratchDir(claims: DbClaims, tool: ToolView): Promise<string> {
    const scratch = join(this.options.dataDir, 'tool-workspaces', claims.identityId!, tool.id);
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    return scratch;
  }
  /** Bound secrets open as the invoker's account; visibility refusals fail closed. */
  private secretReader(claims: DbClaims, tool: ToolView): (inputName: string, credentialId: string) => Promise<string> {
    return async (inputName, credentialId) => {
      const row = await this.options.db.rpc<{ credentialId: string; ciphertext: string; nonce: string }>(claims,
        'read_tool_credential', [tool.spaceId, tool.id, inputName, credentialId]);
      if (row.credentialId !== credentialId) throw new CollabError('forbidden', 'Tool credential is unavailable');
      try { return openSecret(await loadOrCreateCredentialKey(this.options.dataDir), {
        ciphertext: Buffer.from(row.ciphertext, 'base64'), nonce: Buffer.from(row.nonce, 'base64'),
      }, { spaceId: tool.spaceId, credentialId, provider: 'tool' }); }
      catch { throw new CollabError('forbidden', 'Tool credential is unavailable'); }
    };
  }
  private async pins(claims: DbClaims, sessionId: string) {
    const [pin] = await this.options.db.query<{ tool_version: number; tool_source_sha256: string; tool_keep_open: boolean }>(claims,
      'select tool_version,tool_source_sha256,tool_keep_open from public.work_sessions where entity_id=$1', [sessionId]);
    return pin;
  }
  private async revokeToken(claims: DbClaims, sessionId: string): Promise<void> {
    await this.options.db.rpc(claims, 'revoke_agent_auth_session', [sessionId]);
  }
  private async recordExit(claims: DbClaims, sessionId: string, exit: ToolExit): Promise<void> {
    await this.options.db.rpc(claims, 'record_tool_exit', [sessionId, exit.exitCode, exit.state, exit.outputTail]);
  }
  /** Mark running, then hand the run to the PTY; the launcher settles it and revokes its token. */
  private async launchPinned(claims: DbClaims, run: { sessionId: string; tool: ToolView; toolVersion: number;
    inputs: ResolvedToolInputs; cwd: string; keepOpen: boolean; token: string | undefined; origin?: string }): Promise<void> {
    const { sessionId } = run;
    // Mark running before spawn: a one-line tool can exit immediately and
    // its normal process exit must never race a later spawning->running write.
    await this.options.db.rpc(claims, 'work_session_transition', [sessionId, 'running']);
    await this.launcher.launch({ sessionId, toolId: run.tool.id, toolVersion: run.toolVersion, definition: run.tool.definition,
      inputs: run.inputs, cwd: run.cwd, keepOpen: run.keepOpen, ...(run.token ? { token: run.token } : {}),
      ...(run.origin ? { origin: run.origin } : {}),
      onReady: () => this.options.spawnService.adoptToolSession(claims, sessionId),
      recordExit: exit => this.recordExit(claims, sessionId, exit), revokeToken: () => this.revokeToken(claims, sessionId),
      closePty: async () => { await this.options.spawnService.terminate(claims, sessionId, {
        force: true, endedKind: 'exited_clean', endedReason: 'Tool execution ended.',
      }); } });
  }
  /**
   * A run that never launched: the same kill-and-record writer as explicit
   * cleanup, including retiring captured claims when spawn itself failed after
   * onReady; its token is revoked and the run recorded killed on every path.
   */
  private async abandon(claims: DbClaims, sessionId: string): Promise<void> {
    try { await this.options.spawnService.terminate(claims, sessionId, {
      force: true, terminalStatus: 'failed', reason: 'Tool launch failed',
      endedKind: 'crashed', endedReason: 'Tool could not start.',
    }); }
    finally { try { await this.revokeToken(claims, sessionId); }
      finally { await this.recordExit(claims, sessionId, { exitCode: null, state: 'killed', outputTail: '' }); } }
  }
}
function capMessage(error: unknown): unknown {
  return error instanceof CollabError && error.code === 'limit_exceeded'
    ? new CollabError('limit_exceeded', 'Tool session cap of 8 reached; idle keep-open shells count. Close an open tool tab and retry.')
    : error;
}
