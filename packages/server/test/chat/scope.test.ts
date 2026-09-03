/**
 * B10 — the `agent_runtime` bearer is scoped to the chat it runs.
 *
 * The design doc's blocker reads: "the `agent_runtime` token is unscoped
 * server-side; `runtimeThreadRootId` is resolved into the request but never
 * enforced". These tests are the enforcement, and — as much of the point — they
 * pin the three principals that must NOT be affected. A guard on the wrong
 * principal here would break the CLI, the browser, and every worker session in
 * one move, and would do it silently: `runtimeChatId` is simply absent on all
 * three, so a guard reading it carelessly refuses or admits them by accident.
 */
import { describe, expect, it } from 'vitest';
import { getOperation, type OperationName } from '@tm8/contract';

import {
  CHAT_OPERATIONS_CLOSED_TO_RUNTIME,
  isChatRuntimeBearer,
  refuseChatRuntimeBearer,
  requireOwnChat,
  resolveSpawnParentId,
  runtimeChatIdOf,
} from '../../src/chat/scope.js';
import type { RequestContext } from '../../src/http/types.js';

const OWN_CHAT = '019f0000-0000-7000-8000-0000000005a1';
const OTHER_CHAT = '019f0000-0000-7000-8000-0000000005a2';

function ctx(
  identity: RequestContext['identity'],
  operation: OperationName = 'execution.spawn',
): RequestContext {
  const op = getOperation(operation);
  return {
    op,
    opName: operation,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    requestId: 'scope-test',
    identity,
    headers: {},
    method: op.method,
    path: op.path,
  };
}

/** The chat runtime's own MCP credential. */
const chatRuntime = (chatId: string | null = OWN_CHAT): RequestContext['identity'] => ({
  kind: 'bearer',
  identityId: 'identity-a',
  authKind: 'agent_runtime',
  ...(chatId ? { runtimeChatId: chatId } : {}),
});

/** A worker session's credential — a bearer, and NOT a chat runtime. */
const workerSession: RequestContext['identity'] = {
  kind: 'bearer',
  identityId: 'identity-a',
  authKind: 'agent',
  workSessionId: '019f0000-0000-7000-8000-0000000005b1',
};

const cliHuman: RequestContext['identity'] = {
  kind: 'bearer', identityId: 'identity-a', authKind: 'cli',
};

const browserHuman: RequestContext['identity'] = {
  kind: 'auto-owner', identityId: 'identity-a', authKind: 'browser',
};

describe('B10 — recognising a chat runtime credential', () => {
  it('is the auth KIND, never the presence of a chat id', () => {
    expect(isChatRuntimeBearer(ctx(chatRuntime()))).toBe(true);
    // A runtime whose binding is missing is STILL a runtime. Reading the id to
    // decide the kind would let a pre-176 credential — the exact rows this
    // enforcement exists for — walk straight past the guard.
    expect(isChatRuntimeBearer(ctx(chatRuntime(null)))).toBe(true);
    expect(isChatRuntimeBearer(ctx(workerSession))).toBe(false);
    expect(isChatRuntimeBearer(ctx(cliHuman))).toBe(false);
    expect(isChatRuntimeBearer(ctx(browserHuman))).toBe(false);
  });

  it('reports the bound chat for a runtime and null for everyone else', () => {
    expect(runtimeChatIdOf(ctx(chatRuntime()))).toBe(OWN_CHAT);
    expect(runtimeChatIdOf(ctx(chatRuntime(null)))).toBeNull();
    expect(runtimeChatIdOf(ctx(workerSession))).toBeNull();
    expect(runtimeChatIdOf(ctx(browserHuman))).toBeNull();
  });
});

describe('B10 — chat.start is closed to a chat runtime', () => {
  it('refuses the runtime bearer and admits every human principal', () => {
    expect(() => refuseChatRuntimeBearer(ctx(chatRuntime(), 'chat.start')))
      .toThrowError(/requires a human session/);
    // Refused whether or not it is bound: an unbound runtime is not MORE
    // trusted than a bound one.
    expect(() => refuseChatRuntimeBearer(ctx(chatRuntime(null), 'chat.start')))
      .toThrowError(/requires a human session/);
    // A worker session is an agent too, and is NOT refused here. `start_chat`'s
    // own `require_human_auth_kind` is what stops it in SQL; this layer is
    // about the credential minted BY a chat, and widening it to every agent
    // would be a different rule wearing this one's name.
    expect(() => refuseChatRuntimeBearer(ctx(workerSession, 'chat.start'))).not.toThrow();
    expect(() => refuseChatRuntimeBearer(ctx(cliHuman, 'chat.start'))).not.toThrow();
    expect(() => refuseChatRuntimeBearer(ctx(browserHuman, 'chat.start'))).not.toThrow();
  });

  it('names the operation it refused, so the refusal is actionable', () => {
    expect(() => refuseChatRuntimeBearer(ctx(chatRuntime(), 'chat.start')))
      .toThrowError(/chat\.start/);
  });

  it('lists chat.start as closed, and every listed name is a real operation', () => {
    expect([...CHAT_OPERATIONS_CLOSED_TO_RUNTIME]).toEqual(['chat.start']);
    for (const name of CHAT_OPERATIONS_CLOSED_TO_RUNTIME) {
      expect(getOperation(name).name).toBe(name);
    }
  });
});

describe('B10 — a named chat must be the runtime\'s own', () => {
  it('admits its own chat and refuses any other', () => {
    expect(() => requireOwnChat(ctx(chatRuntime()), OWN_CHAT)).not.toThrow();
    expect(() => requireOwnChat(ctx(chatRuntime()), OTHER_CHAT))
      .toThrowError(/may only name the chat this runtime credential runs/);
    // The refusal names the chat the credential DOES run, because the caller is
    // an agent that has to be able to correct itself.
    expect(() => requireOwnChat(ctx(chatRuntime()), OTHER_CHAT)).toThrowError(new RegExp(OWN_CHAT));
  });

  it('refuses an unbound runtime outright rather than treating null as a wildcard', () => {
    // FAILS CLOSED. `null !== candidate` would also have refused here, but by
    // accident: a later refactor that made the comparison lenient (`own == null
    // || own === candidate`) reads as a reasonable "no binding, no opinion" and
    // is exactly the pre-176 hole.
    expect(() => requireOwnChat(ctx(chatRuntime(null)), OWN_CHAT))
      .toThrowError(/runtime credential that is not bound to one/);
  });

  it('does not constrain a human or a worker session naming any chat', () => {
    // The guard is the RUNTIME's. A person driving execution.spawn through the
    // CLI may legitimately parent a worker on any chat they can read; RLS, not
    // this function, is what decides which.
    expect(() => requireOwnChat(ctx(cliHuman), OTHER_CHAT)).not.toThrow();
    expect(() => requireOwnChat(ctx(browserHuman), OTHER_CHAT)).not.toThrow();
    expect(() => requireOwnChat(ctx(workerSession), OTHER_CHAT)).not.toThrow();
  });
});

/**
 * `execution.spawn`'s parent, for every principal that reaches it.
 *
 * These exist because a negative control found the hole: disabling the guard at
 * its CALL SITE left every test green. `requireOwnChat` was covered; the
 * decision that uses it was not, and a guard nothing calls is not a guard.
 */
describe('B10 — execution.spawn\'s parent', () => {
  const SOME_SESSION = '019f0000-0000-7000-8000-0000000005c1';

  it('gives a chat runtime ITSELF when it names nothing', () => {
    // The fix 176 shipped, and the reason a chat's workers stopped being born
    // orphans with a `<reply_address>` pointing at nothing.
    expect(resolveSpawnParentId(ctx(chatRuntime()), null)).toBe(OWN_CHAT);
    expect(resolveSpawnParentId(ctx(chatRuntime()), undefined)).toBe(OWN_CHAT);
  });

  it('lets a chat runtime name its own chat, and refuses every other id', () => {
    expect(resolveSpawnParentId(ctx(chatRuntime()), OWN_CHAT)).toBe(OWN_CHAT);
    expect(() => resolveSpawnParentId(ctx(chatRuntime()), OTHER_CHAT)).toThrowError(/may only name/);
    // BLIND TO KIND. A work session is refused too — and that is the point:
    // allowing it because it "is not a chat" is precisely how a leaked token
    // reaches any session tree in the Space.
    expect(() => resolveSpawnParentId(ctx(chatRuntime()), SOME_SESSION)).toThrowError(/may only name/);
  });

  it('leaves a human and a worker session exactly as they asked', () => {
    for (const identity of [cliHuman, browserHuman, workerSession]) {
      expect(resolveSpawnParentId(ctx(identity), OTHER_CHAT)).toBe(OTHER_CHAT);
      expect(resolveSpawnParentId(ctx(identity), SOME_SESSION)).toBe(SOME_SESSION);
      // Nothing asked for, nothing invented. A worker session carries no
      // runtimeChatId, so it must not pick one up here.
      expect(resolveSpawnParentId(ctx(identity), null)).toBeNull();
      expect(resolveSpawnParentId(ctx(identity), undefined)).toBeNull();
    }
  });

  it('refuses an unbound chat runtime rather than spawning a parentless worker', () => {
    // A pre-176 credential naming nothing gets null — there is no chat to
    // parent on and inventing one would be a lie. Naming something is refused,
    // because an unbound token is not a MORE trusted token.
    expect(resolveSpawnParentId(ctx(chatRuntime(null)), null)).toBeNull();
    expect(() => resolveSpawnParentId(ctx(chatRuntime(null)), OWN_CHAT))
      .toThrowError(/not bound to one/);
  });
});
