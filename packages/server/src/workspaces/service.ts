import { CollabError, type UserWorkspace, type WorkspaceProjectCreate } from '@tm8/contract';
import type { Db, DbClaims } from '../db/types.js';
import type { RequestContext, RequestIdentity } from '../http/types.js';
import type { FacadeDeps } from '../facade/deps.js';
import { claimsFor, commandEnvelope } from '../facade/context.js';
import type { WorkspaceConfiguration } from './config.js';
import { WorkspaceBrokerClient } from './broker-client.js';
import { WorkspaceExecutionService } from './execution.js';

interface WorkspaceRow {
  id: string; account_id: string; machine_id: string; state: UserWorkspace['state']; operation_id: string;
  limits: UserWorkspace['limits']; failure_code: string | null; created_at: string; updated_at: string;
}
function resource(row: WorkspaceRow): UserWorkspace {
  return { id: row.id, accountId: row.account_id, machineId: row.machine_id, state: row.state,
    operationId: row.operation_id, homePath: '/home/user', limits: row.limits, failureCode: row.failure_code,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
export class WorkspaceService {
  readonly broker: WorkspaceBrokerClient;
  readonly execution: WorkspaceExecutionService;
  private readonly pending = new Map<string, Promise<UserWorkspace>>();
  constructor(readonly deps: FacadeDeps, readonly config: WorkspaceConfiguration) {
    this.broker = new WorkspaceBrokerClient(config.brokerSocket);
    this.execution = new WorkspaceExecutionService(this);
  }
  async claims(ctx: RequestContext): Promise<DbClaims> {
    if (!ctx.identity.accountId || !ctx.identity.identityId || ctx.identity.kind !== 'bearer') throw new CollabError('unauthenticated', 'Sign in to use your workspace');
    return claimsFor(await this.deps.owner(), ctx, commandEnvelope(ctx));
  }
  async me(ctx: RequestContext): Promise<UserWorkspace | null> {
    const rows = await this.deps.db.query<WorkspaceRow>(await this.claims(ctx), 'select * from public.user_workspaces where account_id=$1', [ctx.identity.accountId]);
    return rows[0] ? resource(rows[0]) : null;
  }
  async ensure(ctx: RequestContext): Promise<UserWorkspace> {
    const claims = await this.claims(ctx);
    const accountId = ctx.identity.accountId!;
    const existing = this.pending.get(accountId);
    if (existing) return existing;
    const operation = this.provision(claims, accountId);
    this.pending.set(accountId, operation);
    try { return await operation; } finally { this.pending.delete(accountId); }
  }
  private async provision(claims: DbClaims, accountId: string): Promise<UserWorkspace> {
    let row = await this.deps.db.rpc<WorkspaceRow>(claims, 'ensure_user_workspace');
    if (row.state === 'suspended') throw new CollabError('forbidden', 'Workspace suspended');
    const ready = row.state === 'ready';
    if (!ready) row = await this.deps.db.rpc<WorkspaceRow>(claims, 'transition_user_workspace', [row.operation_id, 'provisioning', null]);
    try {
      await this.broker.request('/provision', { workspaceId: row.id, accountId, limits: row.limits });
      if (!ready) row = await this.deps.db.rpc<WorkspaceRow>(claims, 'transition_user_workspace', [row.operation_id, 'ready', null]);
      return resource(row);
    } catch (error) {
      if (!ready) await this.deps.db.rpc(claims, 'transition_user_workspace', [row.operation_id, 'failed', 'runner_provisioning_failed']);
      throw error;
    }
  }
  async requireReady(ctx: RequestContext): Promise<UserWorkspace> {
    const workspace = await this.me(ctx);
    if (!workspace || workspace.state !== 'ready') throw new CollabError('conflict', 'Workspace is not ready', { details: { reason: 'workspace_not_ready' } });
    return workspace;
  }
  async createProject(ctx: RequestContext, input: WorkspaceProjectCreate): Promise<unknown> {
    const workspace = await this.requireReady(ctx);
    const claims = await this.claims(ctx);
    const record = await this.deps.db.rpc<{ project: { id: string; name: string }; repository: { state: string } }>(claims, 'create_workspace_project', [input.spaceId, input.name, JSON.stringify(input.source), input.clientMutationId]);
    if (record.repository.state !== 'ready') {
      try {
        await this.broker.request('/operation', { workspaceId: workspace.id, accountId: workspace.accountId, projectId: record.project.id, action: 'project-create', source: input.source });
        await this.deps.db.rpc(claims, 'finish_workspace_project', [record.project.id, true, null]);
      } catch (error) { await this.deps.db.rpc(claims, 'finish_workspace_project', [record.project.id, false, 'git_initialization_failed']); throw error; }
    }
    return { projectId: record.project.id, name: record.project.name, spaceId: input.spaceId, state: 'ready', relativePath: `projects/${record.project.id}` };
  }
  async checkout(ctx: RequestContext, projectId: string): Promise<UserWorkspace> {
    const workspace = await this.requireReady(ctx);
    const claims = await this.claims(ctx);
    // The RPC checks live space membership even when a private checkout exists.
    const checkout = await this.deps.db.rpc<{ state: string }>(claims, 'ensure_workspace_checkout', [projectId]);
    if (checkout.state !== 'ready') {
      await this.broker.request('/operation', { workspaceId: workspace.id, accountId: workspace.accountId, projectId, action: 'checkout-create' });
      await this.deps.db.rpc(claims, 'finish_workspace_checkout', [projectId]);
    }
    return workspace;
  }
  async operation(ctx: RequestContext, projectId: string, action: string, data: Record<string, unknown> = {}): Promise<unknown> {
    const workspace = await this.checkout(ctx, projectId);
    return this.broker.request('/operation', { ...data, projectId, action, workspaceId: workspace.id, accountId: workspace.accountId });
  }
  async terminal(ctx: RequestContext, input: { projectId?: string; command?: string }): Promise<unknown> {
    const workspace = input.projectId ? await this.checkout(ctx, input.projectId) : await this.requireReady(ctx);
    const result = await this.broker.request<{ sessionId: string }>('/terminal', { ...input, workspaceId: workspace.id, accountId: workspace.accountId });
    return { ...result, socketPath: `/v2/workspaces/terminals/${result.sessionId}/ws` };
  }
  async workspaceForIdentity(identity: RequestIdentity): Promise<WorkspaceRow> {
    if (!identity.identityId || !identity.accountId || identity.kind !== 'bearer') throw new CollabError('unauthenticated', 'Sign in required');
    const rows = await this.deps.db.query<WorkspaceRow>({ identityId: identity.identityId, authKind: identity.authKind },
      "select * from public.user_workspaces where account_id=$1 and state='ready'", [identity.accountId]);
    if (!rows[0]) throw new CollabError('forbidden', 'Workspace unavailable');
    return rows[0];
  }
}
