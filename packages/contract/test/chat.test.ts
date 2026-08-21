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
      mode: 'ask',
      clientMutationId: 'start-1',
      workdirMode: 'scratch',
    })).not.toHaveProperty('nativeSessionId');
    expect(() => StartChatThreadInputSchema.parse({
      rootMessageId: ID,
      teammateId: '10000000-0000-4000-8000-000000000002',
      model: 'gpt-5.6-sol',
      mode: 'ask',
      clientMutationId: 'start-1',
      workdirMode: 'scratch',
      nativeSessionId: 'leak',
    })).toThrow();
  });

  it('refuses a workdir mode and project id that disagree', () => {
    // The pairing is enforced in SQL too (167) — that is the boundary, and it
    // is what a non-browser caller meets. This refinement exists so the
    // BROWSER's mistake comes back as a readable contract error instead of a
    // Postgres exception surfacing through a 500-shaped response.
    const base = {
      rootMessageId: ID,
      teammateId: '10000000-0000-4000-8000-000000000002',
      model: 'gpt-5.6-sol',
      mode: 'ask' as const,
      clientMutationId: 'start-pairing',
    };
    const PROJECT = '10000000-0000-4000-8000-000000000005';
    // project without an id: the directory could not be resolved.
    expect(() => StartChatThreadInputSchema.parse({ ...base, workdirMode: 'project' })).toThrow();
    // scratch WITH an id: claims a binding it does not have.
    expect(() => StartChatThreadInputSchema.parse({
      ...base, workdirMode: 'scratch', projectId: PROJECT,
    })).toThrow();
    // Both valid arms round-trip.
    expect(StartChatThreadInputSchema.parse({
      ...base, workdirMode: 'project', projectId: PROJECT,
    }).projectId).toBe(PROJECT);
    expect(StartChatThreadInputSchema.parse({
      ...base, workdirMode: 'scratch',
    }).workdirMode).toBe('scratch');
    // `worktree` is a work_sessions mode and NOT a chat one — the likeliest
    // wrong value precisely because the two vocabularies otherwise agree.
    expect(() => StartChatThreadInputSchema.parse({
      ...base, workdirMode: 'worktree', projectId: PROJECT,
    })).toThrow();
  });

  it('accepts Explain as a durable chat mode', () => {
    const input = StartChatThreadInputSchema.parse({
      rootMessageId: ID,
      teammateId: '10000000-0000-4000-8000-000000000002',
      model: 'gpt-5.6-sol',
      mode: 'explain',
      clientMutationId: 'start-explain',
      workdirMode: 'scratch',
    });
    expect(input.mode).toBe('explain');

    const summary = ChatThreadSummarySchema.parse({
      rootMessageId: ID,
      anchorId: '10000000-0000-4000-8000-000000000004',
      teammateId: '10000000-0000-4000-8000-000000000002',
      model: 'gpt-5.6-sol',
      mode: 'explain',
      createdAt: '2026-08-13T00:00:00.000Z',
      lastReplyAt: null,
      projectId: null,
      workdirMode: 'scratch',
    });
    expect(summary.mode).toBe('explain');
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
      mode: 'plan',
      createdAt: '2026-08-13T00:00:00.000Z',
      lastReplyAt: null,
      projectId: null,
      workdirMode: 'scratch',
    });
    expect(thread).not.toHaveProperty('nativeSessionId');
    expect(thread).not.toHaveProperty('cwd');
  });
});
