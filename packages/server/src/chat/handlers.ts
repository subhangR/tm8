import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve as pathResolve } from 'node:path';
import {
  CollabError,
  launchModel,
  type EntitySummary,
  type OperationName,
  type StartChatInput,
  type StartChatResult,
} from '@tm8/contract';
import type { HandlerRegistry } from '../facade/registry.js';
import type { FacadeDeps } from '../facade/deps.js';
import { claimsFor } from '../facade/context.js';
import { loadEntitySummariesByIds } from '../facade/entity-read.js';
import type { OperationHandler } from '../http/types.js';
import type { ChatOrchestrator } from './orchestrator.js';
import { refuseChatRuntimeBearer } from './scope.js';

export interface ChatHandlerDeps {
  readonly orchestrator: ChatOrchestrator;
  readonly dataDir: string;
}

interface StartRpcResult {
  readonly chatId: string;
  readonly messageId: string;
  readonly _requestHash?: string;
}

function startChat(facade: FacadeDeps, chat?: ChatHandlerDeps): OperationHandler {
  return async (ctx) => {
    const input = ctx.body as StartChatInput;
    const model = launchModel(input.model);
    if (!model) throw new CollabError('invalid_input', `unsupported chat model: ${input.model}`);
    // Refuse a non-claude-code model HERE, at the human-gated start, rather
    // than letting the chat commit and fail only on its first turn (the
    // resolver's identical guard at createChatLaunchConfigResolver). chat v1
    // runs claude-code models only.
    if (model.agentTool !== 'claude-code') {
      throw new CollabError(
        'invalid_input',
        `chat v1 runs claude-code models only; '${input.model}' launches via ${model.agentTool}`,
      );
    }
    const owner = await facade.owner();
    const requestClaims = claimsFor(owner, ctx);
    const requesterIdentityId = requestClaims.identityId;
    if (!requesterIdentityId) throw new CollabError('unauthenticated', 'authentication is required');
    if (!chat) {
      throw new CollabError('upstream_unavailable', 'chat runtime is unavailable on this node');
    }

    // D8/C6: both values are server-owned and pinned before the write commits.
    // A replay may mint throwaway candidates, but the ledger returns the
    // original result and never overwrites them.
    const nativeSessionId = randomUUID();
    // THE CHAT ID IS MINTED HERE, and that is why `start_chat` takes one.
    // A scratch chat's working directory is named after the chat, and a
    // directory named after an id the RPC has not returned yet cannot be
    // created without a second write and a window in which the chat exists
    // with no directory. The RPC owns the row; this owns the id and the
    // filesystem, which are the two things SQL cannot do.
    const chatId = randomUUID();
    // Only a scratch chat gets a server-built directory, and only a scratch
    // chat sends one. For `project` the RPC reads `projects.working_dir` itself
    // and ignores anything passed here — creating a directory for that case
    // would mkdir a path we are about to discard, and (worse) would make this
    // handler look like the authority on a path it does not choose.
    const scratchCwd = input.workdirMode === 'scratch'
      ? pathResolve(chat.dataDir, 'chat-threads', chatId)
      : null;
    if (scratchCwd) await mkdir(scratchCwd, { recursive: true, mode: 0o700 });

    const summary = await facade.db.tx(requestClaims, async (q) => {
      const stored = await q.rpc<StartRpcResult>('start_chat', [
        chatId,
        input.spaceId,
        input.teammateId,
        input.model,
        model.provider,
        model.agentTool,
        input.mode,
        input.workdirMode,
        input.projectId ?? null,
        nativeSessionId,
        scratchCwd,
        input.title ?? null,
        input.body,
        input.attachmentIds ?? [],
        input.aboutId ?? null,
        input.clientMutationId,
      ]);
      // The RPC returns IDS. An `EntitySummary` is assembled here, from the
      // same read path `entities.get` uses, so a chat looks identical whether
      // the client just created it or listed it a minute later — the exact
      // divergence a hand-built summary in SQL would have introduced. It also
      // means a REPLAY returns the chat as it is now rather than as it was.
      const [chatSummary] = await loadEntitySummariesByIds(
        q, [stored.chatId], requesterIdentityId,
      );
      if (!chatSummary) {
        throw new CollabError('upstream_unavailable', 'the created chat could not be read back');
      }
      return { chat: chatSummary as EntitySummary, messageId: stored.messageId, id: stored.chatId };
    });

    const result: StartChatResult = { chat: summary.chat, messageId: summary.messageId };
    queueMicrotask(() => {
      void chat.orchestrator.wake(summary.id, requesterIdentityId);
    });
    return result;
  };
}

/**
 * Every chat operation is human-only, and the guard is a property of the GROUP.
 *
 * `credentials.ts` states the reasoning at length and it holds identically
 * here: four copies of a check are four places to be correct, and the failure
 * that actually happens is a FIFTH operation added later, born unguarded and
 * looking exactly like its guarded neighbours. Mapping the wrapper over the
 * record means a new entry cannot be registered without passing through it.
 *
 * This is layer 1 of two. Layer 2 is `internal.require_human_auth_kind()`
 * inside `start_chat`, reading the `tm8.auth_kind` claim. Either alone would
 * refuse the call; both are here because this one is the readable one and that
 * one is the one a future caller reaching the RPC another way cannot bypass.
 */
const CHAT_HANDLERS_ARE_HUMAN_ONLY = true;

export function registerChatHandlers(
  registry: HandlerRegistry,
  facade: FacadeDeps,
  chat?: ChatHandlerDeps,
): void {
  const handlers: Partial<Record<OperationName, OperationHandler>> = {
    'chat.start': startChat(facade, chat),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    registry.register(name as OperationName, async (ctx) => {
      if (CHAT_HANDLERS_ARE_HUMAN_ONLY) refuseChatRuntimeBearer(ctx);
      return handler(ctx);
    });
  }
}
