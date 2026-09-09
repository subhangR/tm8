import { CollabError, CredentialProviderNameSchema, CredentialsLoginSessionStartInputSchema, type CredentialsStatusView, type OperationName } from '@tm8/contract';
import type { HandlerRegistry } from '../facade/registry.js';
import { requireUuidParam } from '../facade/context.js';
import { requireHumanSession } from '../facade/handlers/w2/credentials.js';
import type { OperationHandler, RequestContext } from '../http/types.js';
import type { WorkspaceService } from './service.js';

export const WORKSPACE_CREDENTIAL_OPERATIONS: readonly OperationName[] = [
  'credentials.status', 'credentials.delete', 'credentials.loginSessions.start', 'credentials.loginSessions.finish',
];
export function registerWorkspaceCredentials(registry: HandlerRegistry, service: WorkspaceService): void {
  const request = async <T>(ctx: RequestContext, input: Record<string, unknown>): Promise<T> => {
    const workspace = await service.requireReady(ctx);
    return service.broker.request('/credentials', { ...input, workspaceId: workspace.id, accountId: workspace.accountId });
  };
  const handlers: Partial<Record<OperationName, OperationHandler>> = {
    'credentials.status': async ctx => ({ ...await request<CredentialsStatusView>(ctx, { action: 'status' }), runtime: 'workspace' }),
    'credentials.delete': ctx => {
      const provider = CredentialProviderNameSchema.safeParse(ctx.params.provider);
      if (!provider.success) throw new CollabError('invalid_input', 'Unknown credential provider');
      return request(ctx, { action: 'disconnect', provider: provider.data });
    },
    'credentials.loginSessions.start': async ctx => {
      const parsed = CredentialsLoginSessionStartInputSchema.safeParse(ctx.body);
      if (!parsed.success) throw new CollabError('invalid_input', 'Choose a provider and space');
      const { spaceId, provider } = parsed.data;
      const rows = await service.deps.db.query<{ allowed: boolean }>(await service.claims(ctx), 'select internal.is_space_member($1::uuid) as allowed', [spaceId]);
      if (!rows[0]?.allowed) throw new CollabError('forbidden', 'Join this space before connecting a provider');
      const started = await request<{ workSessionId: string }>(ctx, { action: 'start', provider });
      return { ...started, spaceId, socketPath: `/v2/workspaces/terminals/${started.workSessionId}/ws` };
    },
    'credentials.loginSessions.finish': ctx => request(ctx, { action: 'finish', sessionId: requireUuidParam(ctx, 'id') }),
  };
  for (const name of WORKSPACE_CREDENTIAL_OPERATIONS) {
    const handler = requireHumanSession(handlers[name]!);
    if (registry.has(name)) registry.decorate(name, () => handler);
    else registry.register(name, handler);
  }
}
