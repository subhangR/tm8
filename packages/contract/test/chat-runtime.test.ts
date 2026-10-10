import { describe, expect, it } from 'vitest';
import {
  ChatCredentialIntentSchema, ChatRuntimeStateSchema, MessagePartSchema,
  SetChatCredentialsInputSchema, SetChatModelInputSchema,
  chatCredentialChoice, chatCredentialProviderForModel, withChatCredentialChoice,
  type ChatCredentialIntent,
} from '../src/index.js';

const PIN_A = '10000000-0000-4000-8000-000000000001';
const PIN_B = '10000000-0000-4000-8000-000000000002';

describe('chat configuration and public runtime boundaries', () => {
  it('remembers provider pins across a model switch without replacing the default', () => {
    const initial: ChatCredentialIntent = { defaultChoice: { source: 'member' }, byProvider: {} };
    const claude = withChatCredentialChoice(initial, 'anthropic', { source: 'space', credentialId: PIN_A });
    const codex = withChatCredentialChoice(claude, 'openai', { source: 'space', credentialId: PIN_B });
    expect(chatCredentialChoice(codex, 'anthropic')).toEqual({ source: 'space', credentialId: PIN_A });
    expect(chatCredentialChoice(codex, 'openai')).toEqual({ source: 'space', credentialId: PIN_B });
    expect(chatCredentialChoice(codex, 'groq')).toEqual({ source: 'member' });
    expect(initial.byProvider).toEqual({});
    expect(ChatCredentialIntentSchema.parse(codex)).toEqual(codex);
  });

  it('remembers an unpinned provider choice and updates only the default for unseen providers', () => {
    const intent: ChatCredentialIntent = {
      defaultChoice: { source: 'auto' },
      byProvider: { anthropic: { source: 'space', credentialId: PIN_A } },
    };
    const next = withChatCredentialChoice(intent, 'openai', { source: 'node' });
    expect(chatCredentialChoice(next, 'openai')).toEqual({ source: 'node' });
    expect(chatCredentialChoice(next, 'groq')).toEqual({ source: 'node' });
    expect(chatCredentialChoice(next, 'anthropic')).toEqual(intent.byProvider.anthropic);
    expect(next.defaultChoice).toEqual({ source: 'node' });
  });

  it('derives credential providers from catalog models and never accepts a client provider override', () => {
    expect(chatCredentialProviderForModel('gpt-6.1-sol')).toBe('openai');
    expect(chatCredentialProviderForModel('unknown-model')).toBeNull();
    const update = {
      model: 'gpt-6.1-sol', reasoningEffort: 'xhigh',
      credentialSelection: { source: 'space', credentialId: PIN_B },
      expectedConfigRevision: 3, clientMutationId: 'switch-1',
    };
    expect(SetChatModelInputSchema.parse(update)).toEqual(update);
    expect(SetChatModelInputSchema.safeParse({ ...update, provider: 'anthropic' }).success).toBe(false);
    expect(SetChatModelInputSchema.safeParse({ ...update, reasoningEffort: 'invented' }).success).toBe(false);
    expect(SetChatModelInputSchema.safeParse({ ...update, expectedConfigRevision: 0 }).success).toBe(false);
    expect(SetChatCredentialsInputSchema.safeParse({ credentialSelection: { source: 'node', credentialId: PIN_B } }).success).toBe(false);
  });

  it('accepts corrected text snapshots with item attribution without changing legacy text parts', () => {
    const base = { seq: 1, kind: 'text', createdAt: '2026-10-10T00:00:00.000Z' };
    expect(MessagePartSchema.parse({ ...base, payload: { text: 'legacy' } }).payload).toEqual({ text: 'legacy' });
    const corrected = { text: 'final text', itemId: 'item-1', operation: 'replace', revision: 2, phase: 'final' };
    expect(MessagePartSchema.parse({ ...base, payload: corrected }).payload).toEqual(corrected);
  });

  it('keeps current and desired configurations separate and refuses private launch evidence', () => {
    const state = {
      schemaVersion: 1, configRevision: 4, pendingForNextClaim: true,
      activeTurn: {
        turnId: PIN_A, configRevision: 3, generation: 2,
        model: 'gpt-6.1-sol', provider: 'openai', agentTool: 'codex',
        reasoningEffort: 'xhigh', status: 'running',
        credential: { provider: 'openai', source: 'member', resolutionReason: 'member' },
      },
      runtime: { generation: 2, phase: 'running', continuity: 'portable_verified', observedAt: null },
    };
    expect(ChatRuntimeStateSchema.parse(state)).toEqual(state);
    expect(ChatRuntimeStateSchema.safeParse({ ...state, nativeSessionId: 'thread-id' }).success).toBe(false);
    expect(ChatRuntimeStateSchema.safeParse({ ...state, activeTurn: { ...state.activeTurn, env: { OPENAI_API_KEY: 'secret' } } }).success).toBe(false);
    expect(ChatRuntimeStateSchema.safeParse({ ...state, runtime: { ...state.runtime, storagePath: '/private/home' } }).success).toBe(false);
  });
});
