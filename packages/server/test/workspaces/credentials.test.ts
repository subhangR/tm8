import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerWorkspaceCredentials, WORKSPACE_CREDENTIAL_OPERATIONS } from '../../src/workspaces/credentials.js';
import { createWorkspaceTerminal } from '../../src/workspaces/terminal.js';
import type { WorkspaceService } from '../../src/workspaces/service.js';
import type { RequestContext, RequestIdentity } from '../../src/http/types.js';
import { WorkspaceExecutionService, WORKSPACE_EXECUTION_OPERATIONS } from '../../src/workspaces/execution.js';

describe('private workspace provider credentials', () => {
  const accountId = randomUUID(), workspaceId = randomUUID(), sessionId = randomUUID(), spaceId = randomUUID();
  function fixture() {
    const request = vi.fn().mockResolvedValue({ workSessionId: sessionId });
    const query = vi.fn().mockResolvedValue([{ allowed: true }]);
    const service = { requireReady: vi.fn().mockResolvedValue({ id: workspaceId, accountId }), claims: vi.fn().mockResolvedValue({}), broker: { request }, deps: { db: { query } } } as unknown as WorkspaceService;
    const registry = new HandlerRegistry(); registerWorkspaceCredentials(registry, service);
    const ctx = { identity: { kind: 'bearer', accountId, authKind: 'browser' }, params: {}, body: {} } as RequestContext;
    return { registry, ctx, request, query };
  }
  it('every credential endpoint refuses agent identities before contacting the runner', async () => {
    const { registry, ctx, request } = fixture();
    for (const name of WORKSPACE_CREDENTIAL_OPERATIONS) for (const authKind of ['agent', 'agent_runtime', undefined]) {
      await expect(registry.get(name)!({ ...ctx, identity: { ...ctx.identity, authKind } } as RequestContext)).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('private task adapters refuse agent identities before accessing graph or runner state', async () => {
    const { ctx, query, request } = fixture();
    const service = { deps: { db: { query } }, broker: { request } } as unknown as WorkspaceService;
    const registry = new HandlerRegistry(); new WorkspaceExecutionService(service).register(registry);
    for (const name of WORKSPACE_EXECUTION_OPERATIONS) for (const authKind of ['agent', 'agent_runtime', undefined]) {
      await expect(registry.get(name)!({ ...ctx, identity: { ...ctx.identity, authKind } } as RequestContext)).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(query).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  it('validates membership and input then derives the account and socket from the server', async () => {
    const { registry, ctx, request, query } = fixture();
    const handler = registry.get('credentials.loginSessions.start')!;
    await expect(handler({ ...ctx, body: { spaceId, provider: 'openai', accountId: randomUUID() } })).rejects.toMatchObject({ code: 'invalid_input' });
    query.mockResolvedValueOnce([{ allowed: false }]);
    await expect(handler({ ...ctx, body: { spaceId, provider: 'openai' } })).rejects.toMatchObject({ code: 'forbidden' });
    expect(request).not.toHaveBeenCalled();
    const result = await handler({ ...ctx, body: { spaceId, provider: 'openai' } });
    expect(request).toHaveBeenCalledWith('/credentials', { action: 'start', provider: 'openai', accountId, workspaceId });
    expect(result).toMatchObject({ workSessionId: sessionId, spaceId, socketPath: `/v2/workspaces/terminals/${sessionId}/ws` });
  });
  it('refuses an agent websocket even when its account owns the credential terminal', async () => {
    const service = { workspaceForIdentity: vi.fn().mockResolvedValue({ id: workspaceId, account_id: accountId }), broker: { request: vi.fn().mockResolvedValue({ projectId: null, credentialProvider: 'openai' }) } } as unknown as WorkspaceService;
    const identity = { kind: 'bearer', accountId, authKind: 'agent' } as RequestIdentity;
    const terminal = createWorkspaceTerminal(service, async () => identity);
    const server = createServer(); server.on('upgrade', (req, socket, head) => void terminal.handleUpgrade(req, socket, head));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const response = await new Promise<number | undefined>((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${address.port}/v2/workspaces/terminals/${sessionId}/ws`);
        client.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); }); client.on('error', reject);
      });
      expect(response).toBe(403);
    } finally { terminal.closeAll?.(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
