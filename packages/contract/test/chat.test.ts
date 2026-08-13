import { describe, expect, it } from 'vitest';
import {
  ChatThreadSummarySchema,
  ChatTurnFrameSchema,
  MessagePartSchema,
  StartChatThreadInputSchema,
  getOperation,
} from '../src/index.js';

const ID = '10000000-0000-4000-8000-000000000001';

describe('TM8 Chat v1 contract', () => {
  it('spends exactly the catalog operation on configuring an existing root', () => {
    expect(getOperation('chat.threads.start')).toEqual({
      name: 'chat.threads.start',
      method: 'POST',
      path: '/v2/chat/threads',
      kind: 'command',
      status: 'v1',
    });
    expect(StartChatThreadInputSchema.parse({
      rootMessageId: ID,
      teammateId: '10000000-0000-4000-8000-000000000002',
      model: 'gpt-5.6-sol',
      clientMutationId: 'start-1',
    })).not.toHaveProperty('nativeSessionId');
    expect(() => StartChatThreadInputSchema.parse({
      rootMessageId: ID,
      teammateId: '10000000-0000-4000-8000-000000000002',
      model: 'gpt-5.6-sol',
      clientMutationId: 'start-1',
      nativeSessionId: 'leak',
    })).toThrow();
  });

  it('accepts exactly the seven ordered C1 message-part kinds', () => {
    const base = { seq: 0, createdAt: '2026-08-13T00:00:00.000Z' };
    const parts = [
      { ...base, kind: 'thinking', payload: { text: 'reason' } },
      { ...base, kind: 'text', payload: { text: 'answer' } },
      { ...base, kind: 'tool_call', payload: { id: '1', name: 'read', args: {}, state: 'running' } },
      { ...base, kind: 'tool_result', payload: { tool_call_id: '1', content: [], is_error: false } },
      { ...base, kind: 'usage', payload: { input_tokens: 1 } },
      { ...base, kind: 'error', payload: { code: 'aborted', message: 'stopped' } },
      { ...base, kind: 'done', payload: { reason: 'interrupted' } },
    ];
    expect(parts.map((part) => MessagePartSchema.parse(part).kind)).toEqual([
      'thinking', 'text', 'tool_call', 'tool_result', 'usage', 'error', 'done',
    ]);
    expect(() => MessagePartSchema.parse({ ...base, kind: 'debug', payload: {} })).toThrow();
  });

  it('keeps absent cost absent and runtime identifiers out of list reads', () => {
    const done = ChatTurnFrameSchema.parse({
      type: 'chat.turn.done',
      threadRootId: ID,
      messageId: '10000000-0000-4000-8000-000000000003',
      usage: { input_tokens: 3 },
    });
    expect(done.usage).not.toHaveProperty('total_cost_usd');
    const thread = ChatThreadSummarySchema.parse({
      rootMessageId: ID,
      anchorId: '10000000-0000-4000-8000-000000000004',
      teammateId: '10000000-0000-4000-8000-000000000002',
      model: 'gpt-5.6-sol',
      createdAt: '2026-08-13T00:00:00.000Z',
      lastReplyAt: null,
    });
    expect(thread).not.toHaveProperty('nativeSessionId');
    expect(thread).not.toHaveProperty('cwd');
  });
});
