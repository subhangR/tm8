import { describe, expect, it, vi } from 'vitest';
import { getOperation, type StartChatInput } from '@tm8/contract';
import { registerChatHandlers } from '../../src/chat/handlers.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { ChatOrchestrator } from '../../src/chat/orchestrator.js';
import type { RequestContext } from '../../src/http/types.js';

vi.mock('../../src/facade/entity-read.js', () => ({
  loadEntitySummariesByIds: async (_q: unknown, ids: string[]) => [{ id: ids[0], kind: 'chat', title: 'Persisted title' }],
}));

function rig() {
  const rpc = vi.fn(async (name: string, args: unknown[]) => name === 'start_chat'
    ? { chatId: args[0], messageId: 'message' }
    : {});
  const wake = vi.fn(async () => {});
  const registry = new HandlerRegistry();
  registerChatHandlers(registry, {
    owner: async () => ({ identityId: 'human', isNodeAdmin: true }),
    db: { tx: async (_claims: unknown, fn: (q: unknown) => Promise<unknown>) => fn({ rpc }) },
  } as unknown as FacadeDeps, {
    dataDir: '/unused',
    orchestrator: {
      admitConfiguration: async () => {},
      validateCredentialSelection: async () => {},
      wake,
    } as unknown as ChatOrchestrator,
  });
  const op = getOperation('chat.start');
  const run = (input: Partial<StartChatInput> = {}) => registry.get(op.name)!({
    op, opName: op.name, params: {}, query: new URLSearchParams(),
    body: {
      spaceId: 'space', teammateId: 'teammate', model: 'gpt-6.1-sol',
      mode: 'build', workdirMode: 'project', projectId: 'project',
      body: 'Please fix the login bug in the new Safari version.\n\n  - retain every reproduction step',
      clientMutationId: 'same-chat-start', ...input,
    },
    identity: { kind: 'auto-owner', identityId: 'human', authKind: 'browser' },
    headers: {}, method: op.method, path: op.path, requestId: 'title-test',
  } as RequestContext);
  return { rpc, run, wake };
}

describe('chat.start title contract', () => {
  it.each([undefined, null, '   '])('derives the default for %j while persisting the complete body', async (title) => {
    const test = rig();
    await test.run({ title });
    const start = test.rpc.mock.calls.find(([name]) => name === 'start_chat')!;
    expect(start[1][11]).toBe('fix the login bug');
    expect(start[1][12]).toBe('Please fix the login bug in the new Safari version.\n\n  - retain every reproduction step');
    expect(test.rpc.mock.calls.map(([name]) => name)).toEqual(['start_chat', 'set_chat_configuration']);
    expect(test.wake).toHaveBeenCalledOnce();
  });

  it('preserves an explicit chosen name and does not schedule a later rename', async () => {
    const test = rig();
    const title = 'My deliberately chosen chat name with more than six words';
    await test.run({ title });
    expect(test.rpc.mock.calls.find(([name]) => name === 'start_chat')![1][11]).toBe(title);
    expect(test.rpc.mock.calls.map(([name]) => name)).toEqual(['start_chat', 'set_chat_configuration']);
  });
});
