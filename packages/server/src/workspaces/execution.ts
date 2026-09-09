import { randomUUID } from 'node:crypto';
import { CollabError, ExecutionSpawnInputSchema, ExecutionStreamsAttachInputSchema, ExecutionTerminateInputSchema,
  launchModel, type OperationName, type SessionLaunchRecord } from '@tm8/contract';
import { composeManifest, resolveLaunchConfig, type SpawnRequest } from '@tm8/execution';
import { DbGraphPort, assembleCommandResult, resolveAssignmentAnchors, resolveSessionCap, toCollabError } from '../facade/execution-handlers.js';
import { requireUuidParam } from '../facade/context.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { requireHumanSession } from '../facade/handlers/w2/credentials.js';
import { issuePtyGrantToken } from '../pty/grant-token.js';
import { PgDurableSeqSource } from '../events/seq.js';
import type { DbClaims } from '../db/types.js';
import { json, type RequestContext, type OperationHandler } from '../http/types.js';
import type { WorkspaceService } from './service.js';

export const WORKSPACE_EXECUTION_OPERATIONS: readonly OperationName[] = [
  'execution.spawn', 'execution.terminate', 'execution.streams.attach', 'execution.liveness', 'execution.launch', 'execution.journal',
];
interface RunStatus {
  sessionId: string; workspaceId: string; accountId: string; identityId: string;
  spaceId: string; exited: boolean; exitCode: number | null; reason: string | null;
  missing?: boolean; cwd?: string; branch?: string | null;
}
const terminalStatus = (status: string) => ['exited', 'failed'].includes(status);

/** Graph authorization and task/session mutations stay in the existing RPCs.
 * All filesystem, provider credentials and processes stay in the user's runner. */
export class WorkspaceExecutionService {
  readonly graph: DbGraphPort;
  readonly bootId = randomUUID();
  private readonly launching = new Map<string, Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private checking = false;
  constructor(readonly service: WorkspaceService) { this.graph = new DbGraphPort(service.deps.db); }
  start(): void {
    this.timer = setInterval(() => { void this.reconcilePending(); }, 2000);
    this.timer.unref();
  }
  close(): void { clearInterval(this.timer); }
  async reconcilePending(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const rows = await this.service.broker.request<RunStatus[]>('/execution', { action: 'pending' });
      for (const row of rows) {
        try { await this.settle({ identityId: row.identityId, authKind: 'browser' }, row); }
        catch { /* Keep the durable pending record for retry. No credentials in logs. */ }
      }
    } catch { /* A broker outage must not claim that any process has exited. */ }
    finally { this.checking = false; }
  }
  async settle(claims: DbClaims, run: RunStatus): Promise<void> {
    if (!run.exited) return;
    const rows = await this.service.deps.db.query<{ status: string }>(claims,
      'select status from public.work_sessions where entity_id=$1 and node_id=$2', [run.sessionId, `workspace:${run.workspaceId}`]);
    if (!rows[0]) throw new CollabError('not_found', 'Session unavailable');
    if (!terminalStatus(rows[0].status)) {
      const stopped = run.reason === 'stopped_by_operator';
      const interrupted = run.reason === 'broker_restart';
      await this.graph.transition(claims, { sessionId: run.sessionId, status: stopped || run.exitCode === 0 ? 'exited' : 'failed',
        exitCode: run.exitCode, endedKind: stopped ? 'stopped_by_operator' : interrupted ? 'server_restart' : run.exitCode === 0 ? 'completed' : 'crashed',
        endedReason: stopped ? 'You stopped this session.' : interrupted ? 'The workspace runner restarted.' : run.exitCode === 0 ? 'The agent session ended.' : 'The agent stopped with an error. Open its terminal for details.',
      });
    }
    await this.service.broker.request('/execution', { action: 'acknowledge', sessionId: run.sessionId, workspaceId: run.workspaceId, accountId: run.accountId });
  }
  private async ownedSession(ctx: RequestContext, id: string) {
    const workspace = await this.service.requireReady(ctx);
    const claims = await this.service.claims(ctx);
    const rows = await this.service.deps.db.query<{ id: string; space_id: string; status: string }>(claims,
      `select e.id,e.space_id,w.status from public.entities e join public.work_sessions w on w.entity_id=e.id
       where e.id=$1 and e.deleted_at is null and w.node_id=$2`, [id, `workspace:${workspace.id}`]);
    if (!rows[0]) throw new CollabError('not_found', 'Session not found in your workspace');
    return { workspace, claims, session: rows[0] };
  }
  async spawn(ctx: RequestContext): Promise<unknown> {
    const parsed = ExecutionSpawnInputSchema.safeParse(ctx.body);
    if (!parsed.success) throw new CollabError('invalid_input', parsed.error.issues[0]?.message ?? 'Invalid launch');
    const key = `${ctx.identity.accountId}:${parsed.data.clientMutationId}`;
    const existing = this.launching.get(key); if (existing) return existing;
    const promise = this.spawnOnce(ctx, parsed.data);
    this.launching.set(key, promise);
    try { return await promise; } finally { this.launching.delete(key); }
  }
  private async spawnOnce(ctx: RequestContext, input: import('@tm8/contract').ExecutionSpawnInput): Promise<unknown> {
    const claims = await this.service.claims(ctx);
    const workspace = await this.service.requireReady(ctx);
    const taskIds = await resolveAssignmentAnchors(this.service.deps.db, claims, input.spaceId, input.taskIds ?? [], input.forceNewTask);
    const request: SpawnRequest = { ...input, taskIds, projectId: input.projectId ?? null };
    const context = await this.graph.loadSpawnContext(claims, request);
    const launch = resolveLaunchConfig(request, context, {});
    if (launch.mode !== 'worker' || input.parentSessionId) throw new CollabError('conflict', 'Choose Worker mode for a private workspace task. Coordinated sessions are not available yet.');
    if (!['claude-code', 'codex'].includes(launch.agentTool)) throw new CollabError('invalid_input', 'Choose Claude Code or Codex');
    const known = launchModel(launch.model);
    if (known && (known.agentTool !== launch.agentTool || (launch.reasoningEffort && !(known.efforts as readonly string[]).includes(launch.reasoningEffort)))) throw new CollabError('invalid_input', 'The selected model does not support this tool or effort');
    if (!launch.model || !/^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]{0,150}$/.test(launch.model)) throw new CollabError('invalid_input', 'Choose a valid model');
    if (Object.values(launch.credentialSources).includes('node')) throw new CollabError('conflict', 'Private tasks use your connected account. Choose My credential and connect it in Settings.');
    const provider = launch.agentTool === 'claude-code' ? 'anthropic' : 'openai';
    const providers = await this.service.broker.request<{ providers: Array<{ provider: string; connected: boolean }> }>('/credentials', { action: 'status', workspaceId: workspace.id, accountId: workspace.accountId });
    if (!providers.providers.some(p => p.provider === provider && p.connected)) throw new CollabError('conflict', `Connect ${provider === 'anthropic' ? 'Claude Code' : 'Codex'} in Settings → Agent credentials before launching.`, { details: { reason: 'provider_not_connected', provider } });
    if (context.project) {
      if (context.project.trust !== 'trusted' && !input.confirmUntrusted) throw new CollabError('forbidden', 'Trust this project before launching an agent in it');
      await this.service.checkout(ctx, context.project.id);
      context.project.workingDir = `/home/user/projects/${context.project.id}`;
    }
    const mode = input.workdir?.mode ?? (context.project ? 'project' : 'scratch');
    if (!context.project && mode !== 'scratch') throw new CollabError('invalid_input', 'Choose Scratch or select a project');
    const workdirId = randomUUID();
    const workdir = { mode, path: mode === 'project' ? context.project!.workingDir : `/home/user/${mode === 'worktree' ? 'worktrees' : 'scratch'}/${workdirId}` };
    const profile = await this.graph.resolveInteractionProfile(claims, { spaceId: input.spaceId, teamMemberId: input.teamMemberId, ...(input.interactionProfileId ? { interactionProfileId: input.interactionProfileId } : {}) });
    await this.reconcilePending();
    const created = await this.graph.createWorkSession(claims, { spaceId: input.spaceId, teamMemberId: input.teamMemberId,
      parentSessionId: null, taskIds, projectId: context.project?.id ?? null, workdirMode: mode, workdirPath: workdir.path,
      baseRef: input.workdir?.mode === 'worktree' ? input.workdir.baseRef ?? null : null, mode: launch.mode, model: launch.model,
      agentTool: launch.agentTool, title: input.title ?? context.tasks[0]?.title ?? context.teamMember.name,
      nodeId: `workspace:${workspace.id}`, confirmUntrusted: input.confirmUntrusted === true, clientMutationId: input.clientMutationId });
    if (created.replayed) {
      await this.ownedSession(ctx, created.sessionId);
      return json(await assembleCommandResult(this.service.deps.db, claims, created.commandResult, ctx.identity.identityId!), { status: 201 });
    }
    let started = false;
    try {
      const pin = await this.graph.recordInteractionProfilePin(claims, created.sessionId, profile);
      const manifest = composeManifest({ sessionId: created.sessionId, request, context, launch, interactionProfile: pin,
        workdir, command: launch.agentTool === 'codex' ? '/usr/local/bin/codex' : '/usr/local/bin/claude', baseUrl: '',
        commandNetwork: { mode: 'operator-defined', commandNetworkAccess: launch.accessMode === 'plan' ? false : true,
          proxyEnabled: true, allowedHosts: ['public-http-and-https'], portScoped: true } });
      const system = `You are ${manifest.agent.name}, working in the signed-in user's private Ubuntu workspace.\nExecute the assigned work in ${workdir.path}. Follow the requested access mode (${launch.accessMode}) and report your results in this terminal. The tm8 graph API and tm8 CLI are not available in this runner; do not attempt to call them. Task completion is reviewed by the user in tm8.\nPersona and context:\n${JSON.stringify({ agent: manifest.agent, skills: manifest.skills, profile: manifest.interactionProfile.snapshot })}`;
      const task = JSON.stringify({ tasks: manifest.tasks, additionalInstructions: manifest.promptExtra });
      const prompt = `${system}\nAssignment:\n${task}`;
      if (prompt.length > 100000) throw new CollabError('invalid_input', 'The task context is too large; shorten its description or attached memories');
      await this.graph.recordManifest(claims, created.sessionId, manifest, [], { system, task }, launch.agentTool === 'codex' ? '/home/user/.codex' : '/home/user/.claude');
      const run = await this.service.broker.request<RunStatus>('/execution', { action: 'start', sessionId: created.sessionId,
        workspaceId: workspace.id, accountId: workspace.accountId, identityId: ctx.identity.identityId,
        spaceId: input.spaceId, projectId: context.project?.id ?? null, workdirMode: mode, workdirId,
        baseRef: input.workdir?.mode === 'worktree' ? input.workdir.baseRef : undefined,
        agentTool: launch.agentTool, model: launch.model, reasoningEffort: launch.reasoningEffort, accessMode: launch.accessMode,
        prompt, cols: input.cols, rows: input.rows });
      started = true;
      await this.graph.transition(claims, { sessionId: created.sessionId, status: 'running' });
      if (launch.agentTool === 'claude-code') await this.graph.recordNativeSessionId(claims, created.sessionId, created.sessionId);
      await this.graph.recordCheckoutBranch(claims, created.sessionId, run.branch ?? null);
      if (run.exited) await this.settle(claims, run);
    } catch (error) {
      if (started) await this.service.broker.request('/execution', { action: 'stop', sessionId: created.sessionId, workspaceId: workspace.id, accountId: workspace.accountId });
      await this.graph.transition(claims, { sessionId: created.sessionId, status: 'failed', error: 'Private workspace launch failed', endedKind: 'crashed', endedReason: 'The agent could not start. Check the launch error and your provider connection.' });
      throw toCollabError(error);
    }
    return json(await assembleCommandResult(this.service.deps.db, claims, created.commandResult, ctx.identity.identityId!), { status: 201 });
  }
  async attach(ctx: RequestContext): Promise<unknown> {
    const parsed = ExecutionStreamsAttachInputSchema.safeParse(ctx.body);
    if (!parsed.success) throw new CollabError('invalid_input', 'Choose view or drive');
    const id = requireUuidParam(ctx, 'id');
    const { workspace, claims } = await this.ownedSession(ctx, id);
    await this.service.broker.request('/terminal/info', { sessionId: id, workspaceId: workspace.id, accountId: workspace.accountId });
    const issued = issuePtyGrantToken();
    const result = await this.graph.grantStreamAttach(claims, id, parsed.data.mode, issued.tokenHash);
    const grant = result.grant as { expires_at: string };
    return json({ workSessionId: id, url: `/v2/workspaces/terminals/${id}/ws?mode=${parsed.data.mode}`, protocol: 'ws', mode: parsed.data.mode, token: issued.token, expiresAt: new Date(grant.expires_at).toISOString() }, { headers: { 'cache-control': 'no-store' } });
  }
  async terminate(ctx: RequestContext): Promise<unknown> {
    const parsed = ExecutionTerminateInputSchema.safeParse(ctx.body);
    if (!parsed.success) throw new CollabError('invalid_input', 'Invalid stop request');
    const id = requireUuidParam(ctx, 'id');
    const { workspace, claims } = await this.ownedSession(ctx, id);
    const result = await this.graph.recordCommand(claims, { sessionId: id, operation: 'execution.terminate', payload: { force: parsed.data.force ?? false }, clientMutationId: parsed.data.clientMutationId ?? null });
    const run = await this.service.broker.request<RunStatus>('/execution', { action: 'stop', sessionId: id, workspaceId: workspace.id, accountId: workspace.accountId });
    await this.settle(claims, run);
    return json(await assembleCommandResult(this.service.deps.db, claims, result, ctx.identity.identityId!));
  }
  async liveness(ctx: RequestContext): Promise<unknown> {
    const claims = await this.service.claims(ctx), id = requireUuidParam(ctx, 'spaceId');
    const spaces = await this.service.deps.db.query(claims, 'select id from public.spaces where id=$1', [id]);
    if (!spaces[0]) throw new CollabError('not_found', 'Space not found');
    await this.reconcilePending();
    const workspace = await this.service.me(ctx);
    const rows = workspace ? await this.service.deps.db.query<{ id: string; status: string }>(claims,
      `select e.id,w.status from public.entities e join public.work_sessions w on w.entity_id=e.id
       where e.space_id=$1 and e.deleted_at is null and w.node_id=$2 and w.status not in ('exited','failed')`, [id, `workspace:${workspace.id}`]) : [];
    const live: string[] = [];
    for (const row of rows) {
      const run = await this.service.broker.request<RunStatus>('/execution', { action: 'status', sessionId: row.id, workspaceId: workspace!.id, accountId: workspace!.accountId });
      if (run.missing) {
        // A spawn interrupted before the broker accepted it. Avoid racing an
        // in-flight HTTP launch while repairing the gap after an app restart.
        if (this.launching.size === 0) await this.graph.transition(claims, { sessionId: row.id, status: 'failed', endedKind: 'server_restart', endedReason: 'The server restarted before the agent could start.' });
      } else if (run.exited) await this.settle(claims, run);
      else live.push(row.id);
    }
    const capacity = await this.service.deps.db.query<{ used: string }>(claims, 'select internal.live_work_session_count(null) as used');
    return { liveEntityIds: live, nodeBootId: this.bootId, checkedAt: new Date().toISOString(), capacity: { used: Number(capacity[0]?.used ?? 0), total: resolveSessionCap() }, eventHwm: await this.service.deps.db.tx(claims, q => new PgDurableSeqSource(q).latest(id)) };
  }
  async launch(ctx: RequestContext): Promise<SessionLaunchRecord> {
    const id = requireUuidParam(ctx, 'workSessionId'), { claims } = await this.ownedSession(ctx, id);
    const rows = await this.service.deps.db.query<{ manifest: Record<string, unknown>; system_prompt: string | null; task_prompt: string | null; created_at: Date | string }>(claims,
      'select manifest,system_prompt,task_prompt,created_at from public.session_manifests where work_session_id=$1', [id]);
    const row = rows[0];
    return { sessionId: id, available: !!row, unavailableReason: row ? null : 'no_manifest_row', manifest: row?.manifest ?? null,
      envVarNames: [], prompts: { system: row?.system_prompt ?? null, task: row?.task_prompt ?? null, unavailableReason: row ? null : 'not_recorded' }, recordedAt: row ? new Date(row.created_at).toISOString() : null };
  }
  register(registry: HandlerRegistry): void {
    const handlers: Partial<Record<OperationName, OperationHandler>> = {
      'execution.spawn': ctx => this.spawn(ctx), 'execution.terminate': ctx => this.terminate(ctx),
      'execution.streams.attach': ctx => this.attach(ctx), 'execution.liveness': ctx => this.liveness(ctx), 'execution.launch': ctx => this.launch(ctx),
      'execution.journal': async ctx => { const id = requireUuidParam(ctx, 'workSessionId'); await this.ownedSession(ctx, id); return { sessionId: id, available: false, unavailableReason: 'no_journal_file', totals: { invocations: 0, failed: 0, agentToCliEst: 0, cliToAgentEst: 0, estimator: 'chars/4', malformed: 0 }, records: [], hasMore: false }; },
    };
    for (const name of WORKSPACE_EXECUTION_OPERATIONS) {
      const handler = requireHumanSession(async ctx => { try { return await handlers[name]!(ctx); } catch (error) { throw toCollabError(error); } });
      if (registry.has(name)) registry.decorate(name, () => handler); else registry.register(name, handler);
    }
  }
}
