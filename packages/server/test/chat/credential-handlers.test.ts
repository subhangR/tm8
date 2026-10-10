import { describe, expect, it, vi } from 'vitest';
import { getOperation } from '@tm8/contract';
import { SpawnError } from '@tm8/execution';
import { registerChatHandlers } from '../../src/chat/handlers.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { ChatOrchestrator } from '../../src/chat/orchestrator.js';
import type { RequestContext } from '../../src/http/types.js';

const CHAT = '10000000-0000-4000-8000-000000000001';
function rig({ refused = false, found = true } = {}) {
  const validate = vi.fn(async () => { if (refused) throw new SpawnError('Node credential forbidden', 'forbidden'); });
  const rpc = vi.fn(async () => ({ chatId: CHAT, credentialSelection: { source: 'node' } }));
  const query = vi.fn(async () => found ? [{ space_id: 'space', teammate_id: 'teammate', model: 'claude-opus-5',
    provider: 'anthropic', agent_tool: 'claude-code', chat_mode: 'ask', cwd: '/tmp/chat',
    config_revision: 1, reasoning_effort: null, credential_selection: { source: 'auto' }, credential_intent: null }] : []);
  const registry = new HandlerRegistry();
  registerChatHandlers(registry, {
    owner: async () => ({ identityId: 'human', isNodeAdmin: true }),
    db: { tx: async (_auth: unknown, fn: (q: unknown) => Promise<unknown>) => fn({ query, rpc }) },
  } as unknown as FacadeDeps, {
    dataDir: '/tmp/chat', orchestrator: { validateCredentialSelection: validate } as unknown as ChatOrchestrator,
  });
  const op = getOperation('chat.setCredentials');
  const ctx: RequestContext = { op, opName: op.name, params: { id: CHAT }, query: new URLSearchParams(),
    body: { credentialSelection: { source: 'node' } }, identity: { kind: 'auto-owner', identityId: 'human', authKind: 'browser' },
    headers: {}, method: op.method, path: op.path, requestId: 'test' };
  return { run: () => registry.get(op.name)!(ctx), rpc, validate };
}
describe('chat credential selection handler', () => {
  it('validates selection using server-owned chat configuration before persisting', async () => {
    const test = rig();
    expect(await test.run()).toMatchObject({ credentialSelection: { source: 'node' } });
    expect(test.validate).toHaveBeenCalledWith(expect.objectContaining({ chatId: CHAT, requesterIdentityId: 'human',
      model: 'claude-opus-5', agentTool: 'claude-code', credentialSelection: { source: 'node' } }));
    expect(test.rpc).toHaveBeenCalledWith('set_chat_configuration', [CHAT, 1, expect.any(String), expect.any(String)]);
    expect(JSON.parse(test.rpc.mock.calls[0]![1][2] as string)).toMatchObject({
      model: 'claude-opus-5', agentTool: 'claude-code', reasoningEffort: null,
      credentialSelection: { source: 'node' },
      credentialIntent: { defaultChoice: { source: 'node' }, byProvider: { anthropic: { source: 'node' } } },
    });
    expect(test.validate.mock.invocationCallOrder[0]).toBeLessThan(test.rpc.mock.invocationCallOrder[0]!);
  });
  it('returns a policy refusal without writing the selection', async () => {
    const test = rig({ refused: true });
    await expect(test.run()).rejects.toMatchObject({ code: 'forbidden', message: 'Node credential forbidden' });
    expect(test.rpc).not.toHaveBeenCalled();
  });
  it('does not resolve credentials for a chat the configuring human cannot read', async () => {
    const test = rig({ found: false });
    await expect(test.run()).rejects.toMatchObject({ code: 'not_found' });
    expect(test.validate).not.toHaveBeenCalled();
    expect(test.rpc).not.toHaveBeenCalled();
  });
});
