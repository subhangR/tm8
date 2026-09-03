import { describe, expect, it } from 'vitest';
import type { OperationName } from '../src/index.js';
import {
  ChatTurnFrameSchema,
  EntityStateSchema,
  MessagePartSchema,
  StartChatInputSchema,
  getOperation,
} from '../src/index.js';

const ID = '10000000-0000-4000-8000-000000000001';
const SPACE = '10000000-0000-4000-8000-000000000009';
const TEAMMATE = '10000000-0000-4000-8000-000000000002';

describe('TM8 Chat v1 contract', () => {
  it('spends exactly one catalog operation on creating a chat and its first turn', () => {
    // 176 replaced `chat.threads.start`. The old op CONFIGURED an already-posted
    // root message, which is why it took one; this one creates the chat entity
    // and posts its opening turn together, so a chat can never exist without
    // the turn that started it.
    expect(getOperation('chat.start')).toEqual({
      name: 'chat.start',
      method: 'POST',
      path: '/v2/chats',
      kind: 'command',
      status: 'v1',
    });
    // The old op is GONE, not deprecated: `getOperation` throws on a name the
    // catalog does not carry, which is what makes a stale caller loud.
    expect(() => getOperation('chat.threads.start' as OperationName)).toThrow();

    const parsed = StartChatInputSchema.parse({
      spaceId: SPACE,
      teammateId: TEAMMATE,
      model: 'gpt-5.6-sol',
      mode: 'ask',
      workdirMode: 'scratch',
      body: 'first turn',
      clientMutationId: 'start-1',
    });
    // R5: the native runtime identifiers and the working directory are
    // server-owned and a caller may not name them.
    expect(parsed).not.toHaveProperty('nativeSessionId');
    expect(() => StartChatInputSchema.parse({
      spaceId: SPACE,
      teammateId: TEAMMATE,
      model: 'gpt-5.6-sol',
      mode: 'ask',
      workdirMode: 'scratch',
      body: 'first turn',
      clientMutationId: 'start-1',
      nativeSessionId: 'leak',
    })).toThrow();
    expect(() => StartChatInputSchema.parse({
      spaceId: SPACE,
      teammateId: TEAMMATE,
      model: 'gpt-5.6-sol',
      mode: 'ask',
      workdirMode: 'scratch',
      body: 'first turn',
      clientMutationId: 'start-1',
      cwd: '/tmp/leak',
    })).toThrow();
  });

  it('will not create a chat with no opening turn', () => {
    // A chat is never empty: the body IS turn one, and `w2_post_message_batch`
    // queues it inside the same transaction that creates the entity.
    const base = {
      spaceId: SPACE,
      teammateId: TEAMMATE,
      model: 'gpt-5.6-sol',
      mode: 'ask' as const,
      workdirMode: 'scratch' as const,
      clientMutationId: 'start-empty',
    };
    expect(() => StartChatInputSchema.parse(base)).toThrow();
    expect(() => StartChatInputSchema.parse({ ...base, body: '' })).toThrow();
  });

  it('refuses a workdir mode and project id that disagree', () => {
    // The pairing is enforced in SQL too (167, carried into 176) — that is the
    // boundary, and it is what a non-browser caller meets. This refinement
    // exists so the BROWSER's mistake comes back as a readable contract error
    // instead of a Postgres exception surfacing through a 500-shaped response.
    const base = {
      spaceId: SPACE,
      teammateId: TEAMMATE,
      model: 'gpt-5.6-sol',
      mode: 'ask' as const,
      body: 'first turn',
      clientMutationId: 'start-pairing',
    };
    const PROJECT = '10000000-0000-4000-8000-000000000005';
    // project without an id: the directory could not be resolved.
    expect(() => StartChatInputSchema.parse({ ...base, workdirMode: 'project' })).toThrow();
    // scratch WITH an id: claims a binding it does not have.
    expect(() => StartChatInputSchema.parse({
      ...base, workdirMode: 'scratch', projectId: PROJECT,
    })).toThrow();
    // Both valid arms round-trip.
    expect(StartChatInputSchema.parse({
      ...base, workdirMode: 'project', projectId: PROJECT,
    }).projectId).toBe(PROJECT);
    expect(StartChatInputSchema.parse({
      ...base, workdirMode: 'scratch',
    }).workdirMode).toBe('scratch');
    // `worktree` is a work_sessions mode and NOT a chat one — the likeliest
    // wrong value precisely because the two vocabularies otherwise agree.
    expect(() => StartChatInputSchema.parse({
      ...base, workdirMode: 'worktree', projectId: PROJECT,
    })).toThrow();
  });

  it('accepts Explain as a durable chat mode, on the input and on the row', () => {
    const input = StartChatInputSchema.parse({
      spaceId: SPACE,
      teammateId: TEAMMATE,
      model: 'gpt-5.6-sol',
      mode: 'explain',
      workdirMode: 'scratch',
      body: 'explain this',
      clientMutationId: 'start-explain',
    });
    expect(input.mode).toBe('explain');

    const state = EntityStateSchema.parse({
      kind: 'chat',
      teammateId: TEAMMATE,
      model: 'gpt-5.6-sol',
      provider: 'anthropic',
      agentTool: 'claude-code',
      mode: 'explain',
      workdirMode: 'scratch',
      projectId: null,
      runtimeState: 'cold',
      turnState: 'idle',
      turnCount: 0,
      lastTurnAt: null,
    });
    expect(state.kind === 'chat' && state.mode).toBe('explain');
  });

  it('carries the runtime and the queue as INDEPENDENT axes', () => {
    // The pair "stopped runtime, queued turn" is the honest description of a
    // node that restarted with work still waiting, and neither field can say it
    // alone. A schema that folded them would make that state unrepresentable.
    const state = EntityStateSchema.parse({
      kind: 'chat',
      teammateId: TEAMMATE,
      model: 'gpt-5.6-sol',
      provider: 'anthropic',
      agentTool: 'claude-code',
      mode: 'build',
      workdirMode: 'scratch',
      projectId: null,
      runtimeState: 'stopped',
      turnState: 'queued',
      turnCount: 4,
      lastTurnAt: '2026-09-03T00:00:00.000Z',
    });
    expect(state).toMatchObject({ runtimeState: 'stopped', turnState: 'queued' });
    // R5 again, from the read side: neither identifier reaches a client.
    expect(state).not.toHaveProperty('cwd');
    expect(state).not.toHaveProperty('nativeSessionId');
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

  it('keys the turn frames on the CHAT, and keeps absent cost absent', () => {
    const done = ChatTurnFrameSchema.parse({
      type: 'chat.turn.done',
      chatId: ID,
      messageId: '10000000-0000-4000-8000-000000000003',
      usage: { input_tokens: 3 },
    });
    expect(done.usage).not.toHaveProperty('total_cost_usd');
    expect(done.type === 'chat.turn.done' && done.chatId).toBe(ID);
    // The old key is refused rather than ignored: a client still sending
    // `threadRootId` is a client whose subscription would silently match
    // nothing, and a strict schema is what turns that into an error.
    expect(() => ChatTurnFrameSchema.parse({
      type: 'chat.turn.done',
      threadRootId: ID,
      messageId: '10000000-0000-4000-8000-000000000003',
      usage: { input_tokens: 3 },
    })).toThrow();
  });
});
