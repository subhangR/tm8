import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve as pathResolve } from 'node:path';
import {
  ChatThreadSummarySchema,
  CollabError,
  launchModel,
  type EntityId,
  type InterruptChatThreadResult,
  type StartChatThreadInput,
  type StartChatThreadResult,
} from '@tm8/contract';
import type { HandlerRegistry } from '../facade/registry.js';
import type { FacadeDeps } from '../facade/deps.js';
import { claimsFor } from '../facade/context.js';
import type { OperationHandler } from '../http/types.js';
import type { ChatOrchestrator } from './orchestrator.js';

export interface ChatHandlerDeps {
  readonly orchestrator: ChatOrchestrator;
  readonly dataDir: string;
}

interface StartRpcResult {
  readonly thread: unknown;
  readonly _requestHash?: string;
}

function startChatThread(facade: FacadeDeps, chat?: ChatHandlerDeps): OperationHandler {
  return async (ctx) => {
    const input = ctx.body as StartChatThreadInput;
    const model = launchModel(input.model);
    if (!model) throw new CollabError('invalid_input', `unsupported chat model: ${input.model}`);
    // Refuse a non-claude-code model HERE, at the human-gated thread start,
    // rather than letting the thread commit and fail only on its first turn
    // (the resolver's identical guard at createChatLaunchConfigResolver). chat
    // v1 runs claude-code models only.
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

    // D8/C6: both values are server-owned and pinned before the write-once
    // binding commits. A replay may mint throwaway candidates, but the ledger
    // returns the original binding and never overwrites them.
    const nativeSessionId = randomUUID();
    // Only a scratch thread gets a server-built directory, and only a scratch
    // thread sends one. For `project` the RPC reads `projects.working_dir`
    // itself and ignores anything passed here — creating a directory for that
    // case would mkdir a path we are about to discard, and (worse) would make
    // this handler look like the authority on a path it does not choose.
    const scratchCwd = input.workdirMode === 'scratch'
      ? pathResolve(chat.dataDir, 'chat-threads', input.rootMessageId)
      : null;
    if (scratchCwd) await mkdir(scratchCwd, { recursive: true, mode: 0o700 });
    const stored = await facade.db.rpc<StartRpcResult>(requestClaims, 'start_chat_thread', [
      input.rootMessageId,
      input.teammateId,
      input.model,
      model.provider,
      model.agentTool,
      input.mode,
      nativeSessionId,
      scratchCwd,
      input.clientMutationId,
      input.projectId ?? null,
      input.workdirMode,
    ]);
    const result: StartChatThreadResult = {
      // Explicitly strip the ledger-only request hash and every native runtime
      // identifier. R5 keeps those facts server-side.
      thread: ChatThreadSummarySchema.parse(stored.thread),
    };
    queueMicrotask(() => {
      void chat.orchestrator.wake(input.rootMessageId, requesterIdentityId);
    });
    return result;
  };
}

/**
 * chat.threads.interrupt — stop the turn this thread is running.
 *
 * READ THEN ASK, in that order. The thread is read under the caller's own
 * claims first, so a caller who cannot see the thread is told it is not there
 * rather than being allowed to stop it, and a root id that is not a chat thread
 * at all fails as a not-found instead of quietly answering "nothing running".
 *
 * NOT LEDGERED, which is a deliberate difference from every other chat command.
 * The ledger replays a mutation to its stored result; an interrupt has no
 * stored result to replay, because what it does is signal a process. Replaying
 * `stopped: true` for a run that has since ended would be a fabricated answer
 * about the present. `clientMutationId` is still required and still travels, so
 * the request stays traceable.
 */
function interruptChatThread(facade: FacadeDeps, chat?: ChatHandlerDeps): OperationHandler {
  return async (ctx) => {
    const rootMessageId = ctx.params.rootMessageId as EntityId | undefined;
    if (!rootMessageId) throw new CollabError('invalid_input', 'rootMessageId is required');
    const owner = await facade.owner();
    const requestClaims = claimsFor(owner, ctx);
    if (!requestClaims.identityId) {
      throw new CollabError('unauthenticated', 'authentication is required');
    }
    if (!chat) {
      throw new CollabError('upstream_unavailable', 'chat runtime is unavailable on this node');
    }
    const rows = await facade.db.query<{ root_message_id: string }>(
      requestClaims,
      'select root_message_id from public.chat_threads where root_message_id = $1',
      [rootMessageId],
    );
    if (rows.length === 0) throw new CollabError('not_found', 'chat thread not found');
    const result: InterruptChatThreadResult = {
      rootMessageId,
      stopped: await chat.orchestrator.interrupt(rootMessageId),
    };
    return result;
  };
}

export function registerChatHandlers(
  registry: HandlerRegistry,
  facade: FacadeDeps,
  chat?: ChatHandlerDeps,
): void {
  registry.register('chat.threads.start', startChatThread(facade, chat));
  registry.register('chat.threads.interrupt', interruptChatThread(facade, chat));
}
