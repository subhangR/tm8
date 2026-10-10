import { describe, expect, it, vi } from 'vitest';
import { getOperation, type SetChatModelInput } from '@tm8/contract';
import { SpawnError } from '@tm8/execution';
import { registerChatHandlers } from '../../src/chat/handlers.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { ChatOrchestrator } from '../../src/chat/orchestrator.js';
import type { RequestContext } from '../../src/http/types.js';

const CHAT = '10000000-0000-4000-8000-000000000001';
const PIN_A = '10000000-0000-4000-8000-000000000002';
const PIN_B = '10000000-0000-4000-8000-000000000003';
function rig({ refused = false, conflict = false } = {}) {
  const row = {
    space_id: 'space', teammate_id: 'teammate', model: 'claude-opus-5', provider: 'anthropic',
    agent_tool: 'claude-code', chat_mode: 'ask', cwd: '/tmp/chat', reasoning_effort: 'high',
    config_revision: 7, credential_selection: { source: 'space', credentialId: PIN_A },
    credential_intent: { defaultChoice: { source: 'member' }, byProvider: {
      anthropic: { source: 'space', credentialId: PIN_A }, openai: { source: 'space', credentialId: PIN_B },
    } },
  };
  const query = vi.fn(async () => [row]);
  const validate = vi.fn(async () => { if (refused) throw new SpawnError('Selected credential unavailable', 'forbidden'); });
  const admit = vi.fn(async () => undefined);
  const rpc = vi.fn(async (name: string, args: unknown[]) => {
    if (conflict) throw Object.assign(new Error('Configuration changed'), { code: 'version_conflict' });
    const target = JSON.parse(args[2] as string);
    expect(name).toBe('set_chat_configuration');
    return { ...target, chatId: CHAT, configRevision: 8, appliesAt: 'next_claim', _requestHash: 'private-ledger-hash' };
  });
  const registry = new HandlerRegistry();
  registerChatHandlers(registry, {
    owner: async () => ({ identityId: 'human', isNodeAdmin: true }),
    db: { tx: async (_claims: unknown, fn: (q: unknown) => Promise<unknown>) => fn({ query, rpc }) },
  } as unknown as FacadeDeps, {
    dataDir: '/tmp/chat', orchestrator: { validateCredentialSelection: validate, admitConfiguration: admit } as unknown as ChatOrchestrator,
  });
  const op = getOperation('chat.setModel');
  const run = (body: SetChatModelInput) => registry.get(op.name)!({
    op, opName: op.name, params: { id: CHAT }, query: new URLSearchParams(), body,
    identity: { kind: 'auto-owner', identityId: 'human', authKind: 'browser' },
    headers: {}, method: op.method, path: op.path, requestId: 'test',
  } as RequestContext);
  return { run, query, rpc, validate, row };
}

describe('atomic chat configuration handler', () => {
  it('switches harness and effort using the target provider remembered pin, without resetting the current runtime', async () => {
    const test = rig();
    const result = await test.run({ model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', expectedConfigRevision: 7, clientMutationId: 'switch' });
    expect(result).toMatchObject({ chatId: CHAT, model: 'gpt-6.1-sol', provider: 'openai', agentTool: 'codex',
      reasoningEffort: 'xhigh', credentialSelection: { source: 'space', credentialId: PIN_B },
      configRevision: 8, appliesAt: 'next_claim' });
    expect(result).not.toHaveProperty('_requestHash');
    expect(test.validate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6.1-sol', agentTool: 'codex',
      credentialSelection: { source: 'space', credentialId: PIN_B } }));
    expect(test.rpc).toHaveBeenCalledTimes(1);
    expect(test.rpc.mock.calls[0]![1][1]).toBe(7);
    const target = JSON.parse(test.rpc.mock.calls[0]![1][2] as string);
    expect(target.credentialIntent.byProvider.anthropic).toEqual({ source: 'space', credentialId: PIN_A });
    expect(test.row.model).toBe('claude-opus-5');
  });

  it('replaces the target credential atomically and retains the other provider pin', async () => {
    const test = rig();
    const result = await test.run({ model: 'gpt-6.1-sol', reasoningEffort: null, credentialSelection: { source: 'node' } });
    expect(result).toMatchObject({ reasoningEffort: null, credentialSelection: { source: 'node' }, credentialIntent: {
      defaultChoice: { source: 'node' }, byProvider: { anthropic: { source: 'space', credentialId: PIN_A }, openai: { source: 'node' } },
    } });
  });

  it('refuses an unavailable explicit credential before any settings write', async () => {
    const test = rig({ refused: true });
    await expect(test.run({ model: 'gpt-6.1-sol', credentialSelection: { source: 'space', credentialId: PIN_A } }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(test.rpc).not.toHaveBeenCalled();
    expect(test.row.config_revision).toBe(7);
  });

  it('rejects an unsupported effort before reading credentials or writing settings', async () => {
    const test = rig();
    await expect(test.run({ model: 'gpt-6.1-sol', reasoningEffort: 'ultra' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(test.query).not.toHaveBeenCalled();
    expect(test.validate).not.toHaveBeenCalled();
    expect(test.rpc).not.toHaveBeenCalled();
  });

  it('preserves the caller revision and exposes a conflict rather than a partial update', async () => {
    const test = rig({ conflict: true });
    await expect(test.run({ model: 'gpt-6.1-sol', expectedConfigRevision: 5, clientMutationId: 'same-mutation' }))
      .rejects.toMatchObject({ code: 'version_conflict' });
    expect(test.rpc.mock.calls[0]![1][1]).toBe(5);
    expect(test.rpc.mock.calls[0]![1][3]).toBe('same-mutation');
    expect(test.row.model).toBe('claude-opus-5');
  });
});
