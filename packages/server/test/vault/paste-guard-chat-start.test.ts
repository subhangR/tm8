/**
 * chat.start under Secure Vault's paste guard, at the handler (src/chat/handlers.ts, src/vault/paste-guard.ts).
 *
 * A test node boots no chat runtime, so paste-guard.pg.test.ts cannot reach chat.start over HTTP. This
 * drives the registered handler itself and records what it hands the `start_chat` RPC, the one write that
 * stores the opening message and the title. Only the summary read after that write is stubbed.
 *
 * Every secret-shaped value is assembled at runtime, and no assertion prints one.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CollabError, getOperation, VAULT_PASTE_WARNING_CODE, type StartChatInput, type StartChatResult } from '@tm8/contract';

vi.mock('../../src/facade/entity-read.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/facade/entity-read.js')>()),
  loadEntitySummariesByIds: async (_q: unknown, ids: readonly string[]) => ids.map((id) => ({ id, kind: 'chat' })),
}));

import { registerChatHandlers, type ChatHandlerDeps } from '../../src/chat/handlers.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';
import { createPasteGuard, type PasteGuard } from '../../src/vault/paste-guard.js';

const github = () => 'gh' + 'p_' + 'C'.repeat(36);
const leaks = (text: unknown, value: string) => typeof text === 'string' && text.includes(value);

/** A facade and a chat runtime that record the start_chat arguments and answer as the RPC would. */
function fakes() {
  const calls: { name: string; args: unknown[] }[] = [];
  const q = {
    rpc: async (name: string, args: unknown[]) => {
      calls.push({ name, args });
      return name === 'start_chat' ? { chatId: randomUUID(), messageId: randomUUID() } : null;
    },
    query: async () => [],
  };
  const facade = {
    owner: async () => ({ identityId: 'owner-identity', isNodeAdmin: false }),
    db: { tx: async (_claims: unknown, fn: (querier: typeof q) => Promise<unknown>) => fn(q) },
  } as unknown as FacadeDeps;
  const chat = {
    orchestrator: { admitConfiguration: async () => undefined, validateCredentialSelection: async () => undefined, wake: async () => undefined },
    dataDir: '/nonexistent',
  } as unknown as ChatHandlerDeps;
  return { calls, facade, chat };
}

/** Deps that throw if reached: a refusal must come before anything is touched. */
const unreachable = new Proxy({}, { get() { throw new Error('a refused start must not touch its dependencies'); } });

function startHandler(facade: FacadeDeps, chat: ChatHandlerDeps, guard?: PasteGuard) {
  const registry = new HandlerRegistry();
  registerChatHandlers(registry, facade, chat, guard);
  const handler = registry.get('chat.start');
  if (!handler) throw new Error('chat.start is not registered');
  return (body: Partial<StartChatInput>) => {
    const op = getOperation('chat.start');
    const ctx: RequestContext = {
      op, opName: 'chat.start', params: {}, query: new URLSearchParams(), requestId: 'paste-guard-chat-start',
      identity: { kind: 'bearer', identityId: 'person-identity', authKind: 'browser' },
      headers: {}, method: op.method, path: op.path,
      body: {
        spaceId: randomUUID(), teammateId: randomUUID(), model: 'claude-opus-5-5', mode: 'ask', workdirMode: 'project',
        projectId: randomUUID(), body: 'hello', clientMutationId: randomUUID(), ...body,
      },
    } as RequestContext;
    return handler(ctx) as Promise<StartChatResult>;
  };
}

const startArgs = (calls: { name: string; args: unknown[] }[]) => {
  const call = calls.find((c) => c.name === 'start_chat');
  if (!call) throw new Error('start_chat was not called');
  return { title: call.args[11], body: call.args[12] };
};

describe('chat.start with the paste guard on', () => {
  const guard = createPasteGuard({ vaultAvailable: true });

  it('hands start_chat the redacted opening message and title, and answers the paste warning', async () => {
    const { calls, facade, chat } = fakes();
    const body = `deploy with ${github()}`, title = `key ${github()}`;
    const result = await startHandler(facade, chat, guard)({ body, title });
    const stored = startArgs(calls);
    expect(stored.body).toBe(guard.redact(body).text);
    expect(stored.title).toBe(guard.redact(title).text);
    expect(leaks(stored.body, github()) || leaks(stored.title, github())).toBe(false);
    expect(String(stored.body).includes('[redacted:github_token]')).toBe(true);
    expect(result.warnings?.[0]?.code).toBe(VAULT_PASTE_WARNING_CODE);
    expect(leaks(JSON.stringify(result), github())).toBe(false);
  });

  it('a clean start is passed through unchanged and warns nobody', async () => {
    const { calls, facade, chat } = fakes();
    const result = await startHandler(facade, chat, guard)({ body: 'plan the release', title: 'Release' });
    expect(startArgs(calls)).toEqual({ title: 'Release', body: 'plan the release' });
    expect(result.warnings).toBeUndefined();
  });

  it('refuses an opening message that cannot fit once redacted, before it touches anything', async () => {
    const start = startHandler(unreachable as FacadeDeps, unreachable as ChatHandlerDeps, guard);
    const error = await start({ body: 'password=ab12 '.repeat(600) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CollabError);
    expect((error as CollabError).code).toBe('invalid_input');
    expect((error as CollabError).details).toMatchObject({ reason: VAULT_PASTE_WARNING_CODE, kinds: ['password_assignment'] });
  });
});

describe('chat.start with the paste guard off (the default)', () => {
  it('hands start_chat the text as sent and answers no warning', async () => {
    const { calls, facade, chat } = fakes();
    const result = await startHandler(facade, chat)({ body: `deploy with ${github()}` });
    expect(leaks(startArgs(calls).body, github())).toBe(true);
    expect(result.warnings).toBeUndefined();
  });
});
