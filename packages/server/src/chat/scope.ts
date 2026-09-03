/**
 * B10 — the `agent_runtime` bearer is scoped to the ONE chat it runs.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES
 * ---------------------------------------------------------------------------
 *
 * `issue_agent_runtime_session` has always bound its token to a conversation:
 * `runtime_thread_root_id` before 176, `runtime_chat_id` after it. The resolver
 * has always read that binding into the request (`http/identity-resolver.ts`).
 * Nothing has ever ENFORCED it. The design doc records that as blocker B10:
 *
 *   "The `agent_runtime` token is unscoped server-side. `runtimeThreadRootId`
 *    is resolved into the request but never enforced. Once a chat can be woken
 *    by any agent, the token's blast radius matters more."
 *
 * While a chat was a message thread the blast radius was small because there
 * was nothing chat-shaped to aim at — a chat had no entity id, so no request
 * could name one. 176 gives every chat an id, 178 lets a chat be a spawn
 * parent, and the wake path now fires for agent authors. That is exactly the
 * moment the unenforced binding starts to matter: a leaked per-chat MCP config
 * (mode 0600, but readable by the node's own OS user, and `Bash` in a chat
 * runtime is not path-confined) now names a token that could act on chats other
 * than its own.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACTUALLY REACHABLE, ENUMERATED RATHER THAN ASSUMED
 * ---------------------------------------------------------------------------
 *
 * "Every chat-keyed operation it can reach" is a small, closed set, and it is
 * worth writing down which operations are in it and — more usefully — why the
 * ones that look like members are not:
 *
 *  1. `chat.start` — IN, and refused outright rather than scoped. A runtime
 *     token carries its configuring human's claims (R-C), so a chat that could
 *     open chats could spend that human's authority on conversations they never
 *     asked for, each with a fresh 24h credential of its own. `start_chat`'s
 *     `require_human_auth_kind` already refuses it in SQL; this is the readable
 *     layer, exactly as `credentials.ts` is layer 1 to that RPC's layer 2.
 *
 *  2. `execution.spawn`'s `parentSessionId` — IN, and scoped. The handler
 *     defaults it to the bearer's own `runtimeChatId`, which is a server fact.
 *     An EXPLICIT value still wins for a human credential, and must: a person
 *     driving spawn may legitimately parent a worker elsewhere. For a runtime
 *     bearer it must not, or the token can hang a worker — and therefore that
 *     worker's report, and its `<coordination>` return address — off a chat the
 *     token does not run.
 *
 *  3. `messages.post` anchored on ANOTHER chat — deliberately NOT scoped, and
 *     this is the one that must not be "tightened" later by someone reading
 *     this file. Chat A messaging chat B is the feature; a chat reaching a
 *     worker session is the feature. What must not be forgeable is the CLAIM
 *     about who sent it, and that is already unforgeable: `p_source_chat_id`
 *     comes off the bearer's session row (`facade/index.ts`), never from the
 *     request body, so a token can address any chat but can only ever speak AS
 *     its own.
 *
 *  4. Ordinary entity operations that happen to name a chat (`entities.get`,
 *     `entities.patch`, …) — NOT scoped here. They are kind-agnostic and
 *     governed by `internal.entity_readable` under RLS, the same predicate that
 *     governs every other kind. Adding a chat-shaped guard on top of them would
 *     put a second, weaker authorization model beside the one that already
 *     holds, which is how the two disagree later.
 *
 * A future chat-keyed operation belongs in `CHAT_SCOPED_OPERATIONS` below, and
 * the test that walks the catalog for chat-shaped operations is what makes
 * forgetting it loud rather than silent.
 */
import { CollabError } from '@tm8/contract';

import type { RequestContext } from '../http/types.js';

/**
 * Operations an `agent_runtime` bearer may not reach at all.
 *
 * A refusal, not a scope check: there is no chat id on the request to compare
 * against, because the operation's whole purpose is to create one.
 */
export const CHAT_OPERATIONS_CLOSED_TO_RUNTIME = ['chat.start'] as const;

/** The chat an `agent_runtime` bearer runs, or null for every other principal. */
export function runtimeChatIdOf(ctx: RequestContext): string | null {
  if (ctx.identity.kind !== 'bearer') return null;
  if (ctx.identity.authKind !== 'agent_runtime') return null;
  return ctx.identity.runtimeChatId ?? null;
}

/** True when this request arrives on a chat runtime's own MCP credential. */
export function isChatRuntimeBearer(ctx: RequestContext): boolean {
  return ctx.identity.kind === 'bearer' && ctx.identity.authKind === 'agent_runtime';
}

/**
 * Refuse an `agent_runtime` bearer outright.
 *
 * Applied by wrapping the REGISTRATION rather than by a line inside each
 * handler, for the reason `credentials.ts` spells out: a guard the call site
 * has to remember is a guard the next call site forgets.
 */
export function refuseChatRuntimeBearer(ctx: RequestContext): void {
  if (!isChatRuntimeBearer(ctx)) return;
  throw new CollabError(
    'forbidden',
    `${ctx.opName} requires a human session; a chat runtime credential may not open a chat`,
  );
}

/**
 * Scope a chat id named by request INPUT to the bearer's own chat.
 *
 * Fails closed in both directions:
 *  - a runtime bearer whose session row carries no chat id (a pre-176 row, or a
 *    revoked binding) may not name a chat at all;
 *  - a runtime bearer naming any chat but its own is refused.
 *
 * `candidateIsChat` is passed in rather than resolved here because only the
 * caller knows whether the id it holds is a chat — `parentSessionId` is a work
 * session far more often than it is a chat, and refusing a legitimate session
 * parent would break every worker a chat dispatches.
 */
export function requireOwnChat(
  ctx: RequestContext,
  candidateChatId: string,
): void {
  const own = runtimeChatIdOf(ctx);
  if (!isChatRuntimeBearer(ctx)) return;
  if (!own) {
    throw new CollabError(
      'forbidden',
      `${ctx.opName} may not name a chat on a runtime credential that is not bound to one`,
    );
  }
  if (own !== candidateChatId) {
    throw new CollabError(
      'forbidden',
      `${ctx.opName} may only name the chat this runtime credential runs (${own})`,
    );
  }
}
