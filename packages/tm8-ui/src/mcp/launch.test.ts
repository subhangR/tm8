import { describe, expect, it, vi } from 'vitest';
import { ExecutionSpawnInputSchema } from '@tm8/contract';
import { buildSpawnInput, defaultConfigFor } from '../domain/launch';
import { createChatHomePortFromSeam } from '../chat-home/real-port';
import type { Seam } from '../data/seam';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const selections = [{ serverId: id(1), credentialId: id(2) }];
describe('MCP launch transport', () => {
  it.each([undefined, [], selections])('preserves %j exactly in execution spawn', mcpSelections => {
    const config = { ...defaultConfigFor({ id: id(3), agentTool: 'codex', model: 'gpt-5.5' }), mcpSelections };
    const input = buildSpawnInput({ clientMutationId: 'test', spaceId: id(4), config });
    expect(input.mcpSelections).toEqual(mcpSelections);
    expect(Object.hasOwn(input, 'mcpSelections')).toBe(mcpSelections !== undefined);
    expect(ExecutionSpawnInputSchema.parse(input).mcpSelections).toEqual(mcpSelections);
  });
  it.each([undefined, [], selections])('preserves %j through the real chat adapter', async mcpSelections => {
    const startChat = vi.fn(async () => ({ chat: { id: id(5), kind: 'chat', title: 'test', createdAt: '', state: { kind: 'chat', teammateId: id(3), model: 'gpt-5.5', mode: 'ask', workdirMode: 'scratch', runtimeState: 'cold', turnState: 'idle' } }, messageId: id(6) }));
    const port = createChatHomePortFromSeam({ commands: { startChat } } as unknown as Seam);
    await port.startThread.create({ spaceId: id(4), teammateId: id(3), body: 'hello', model: 'gpt-5.5', mode: 'ask', clientMutationId: 'test', mcpSelections });
    const input = startChat.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(input.mcpSelections).toEqual(mcpSelections);
    expect(Object.hasOwn(input, 'mcpSelections')).toBe(mcpSelections !== undefined);
  });
});
