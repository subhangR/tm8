import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SpawnError } from '@tm8/execution';
import { resolve as pathResolve } from 'node:path';
import {
  CollabError,
  isHumanAuthKind,
  launchModel,
  chatCredentialProviderForModel,
  chatCredentialChoice,
  withChatCredentialChoice,
  type ChatCredentialIntent,
  type ChatCredentialSelection,
  type LaunchModelEffort,
  type EntityId,
  type EntitySummary,
  type SetChatModelInput,
  type SetChatModelResult,
  type SetChatCredentialsInput,
  type SetChatCredentialsResult,
  type StartChatInput,
  type StartChatResult,
} from '@tm8/contract';
import type { HandlerRegistry } from '../facade/registry.js';
import type { FacadeDeps } from '../facade/deps.js';
import { claimsFor, requireUuidParam } from '../facade/context.js';
import { loadEntitySummariesByIds } from '../facade/entity-read.js';
import type { OperationHandler } from '../http/types.js';
import type { ChatOrchestrator } from './orchestrator.js';
import { refuseChatRuntimeBearer } from './scope.js';
import type { DbClaims } from '../db/types.js';

export interface ChatHandlerDeps {
  readonly orchestrator: ChatOrchestrator;
  readonly dataDir: string;
}

interface StartRpcResult {
  readonly chatId: string;
  readonly messageId: string;
  readonly _requestHash?: string;
}

interface ChatDesiredRow {
  space_id: string; teammate_id: string; model: string; provider: string;
  agent_tool: string; chat_mode: import('@tm8/contract').ChatMode; cwd: string;
  credential_selection: ChatCredentialSelection | null;
  credential_intent: ChatCredentialIntent | null;
  reasoning_effort: LaunchModelEffort | null;
  config_revision: string | number;
}

function admittedModel(id: string, effort?: LaunchModelEffort | null) {
  const model = launchModel(id);
  if (!model || !['claude-code', 'codex'].includes(model.agentTool)) {
    throw new CollabError('invalid_input', `unsupported chat model: ${id}`);
  }
  if (effort != null && !model.efforts.includes(effort)) {
    throw new CollabError('invalid_input', `Model ${id} does not support reasoning effort ${effort}`);
  }
  return model;
}

async function readDesired(facade: FacadeDeps, auth: DbClaims, chatId: string): Promise<ChatDesiredRow> {
  const [row] = await facade.db.tx(auth, q => q.query<ChatDesiredRow>(
    `select c.space_id,c.teammate_id,c.model,c.provider,c.agent_tool,c.chat_mode,c.cwd,
      c.credential_selection,c.credential_intent,c.reasoning_effort,c.config_revision
     from public.chats c join public.entities e on e.id=c.entity_id
     where c.entity_id=$1 and c.configured_by_identity_id=$2 and e.deleted_at is null`,
    [chatId, auth.identityId]));
  if (!row) throw new CollabError('not_found', 'chat not found for this identity');
  return row;
}

function intentOf(row: ChatDesiredRow): ChatCredentialIntent {
  if (row.credential_intent) return row.credential_intent;
  const selection = row.credential_selection ?? { source: 'auto' as const };
  const provider = chatCredentialProviderForModel(row.model);
  return {
    defaultChoice: { source: selection.credentialId ? 'auto' : selection.source },
    byProvider: provider ? { [provider]: selection } : {},
  };
}

function configurationResult(stored: SetChatModelResult): SetChatModelResult {
  return {
    chatId: stored.chatId, model: stored.model, provider: stored.provider,
    agentTool: stored.agentTool, reasoningEffort: stored.reasoningEffort,
    credentialSelection: stored.credentialSelection, credentialIntent: stored.credentialIntent,
    configRevision: stored.configRevision, appliesAt: stored.appliesAt,
  };
}

function startChat(facade: FacadeDeps, chat?: ChatHandlerDeps): OperationHandler {
  return async (ctx) => {
    const input = ctx.body as StartChatInput;
    const model = admittedModel(input.model, input.reasoningEffort);
    const owner = await facade.owner();
    const requestClaims = claimsFor(owner, ctx);
    const requesterIdentityId = requestClaims.identityId;
    if (!requesterIdentityId) throw new CollabError('unauthenticated', 'authentication is required');
    if (!chat) {
      throw new CollabError('upstream_unavailable', 'chat runtime is unavailable on this node');
    }
    await chat.orchestrator.admitConfiguration({ model: input.model, reasoningEffort: input.reasoningEffort ?? null });

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
    if (input.credentialSelection !== undefined && !isHumanAuthKind(requestClaims.authKind)) {
      throw new CollabError('forbidden', 'Chat credential selection requires a human session');
    }
    const selection = input.credentialSelection ?? { source: 'auto' as const };
    await chat.orchestrator.validateCredentialSelection({
      chatId, spaceId: input.spaceId, teammateId: input.teammateId,
      requesterIdentityId, requesterAuthKind: requestClaims.authKind ?? null,
      ...(requestClaims.authSessionId ? { requesterAuthSessionId: requestClaims.authSessionId } : {}),
      model: input.model, provider: model.provider, agentTool: model.agentTool,
      chatMode: input.mode, cwd: '', mode: 'new', credentialSelection: selection,
    }).catch(rethrowCredentialError);
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
      if (input.mcpSelections !== undefined) {
        await q.rpc('save_chat_mcp_selections', [stored.chatId, JSON.stringify(input.mcpSelections)]);
      }
      if (stored.chatId === chatId) {
        const provider = chatCredentialProviderForModel(input.model)!;
        const credentialIntent = withChatCredentialChoice({ defaultChoice: { source: 'auto' }, byProvider: {} }, provider, selection);
        await q.rpc('set_chat_configuration', [stored.chatId, 1, JSON.stringify({
          model: input.model, provider: model.provider, agentTool: model.agentTool,
          reasoningEffort: input.reasoningEffort ?? null, credentialIntent, credentialSelection: selection,
        }), `start-config:${input.clientMutationId}`]);
      }
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

function rethrowCredentialError(error: unknown): never {
  if (error instanceof SpawnError) {
    throw new CollabError(error.code === 'internal' ? 'upstream_unavailable' : error.code, error.message, error.detail);
  }
  throw error;
}

function setChatCredentials(facade: FacadeDeps, chat?: ChatHandlerDeps): OperationHandler {
  return async ctx => {
    if (!chat) throw new CollabError('upstream_unavailable', 'chat runtime is unavailable on this node');
    const chatId = requireUuidParam(ctx, 'id') as EntityId;
    const input = ctx.body as SetChatCredentialsInput;
    const auth = claimsFor(await facade.owner(), ctx);
    if (!isHumanAuthKind(auth.authKind)) throw new CollabError('forbidden', 'Chat credential selection requires a human session');
    const config = await readDesired(facade, auth, chatId);
    const provider = chatCredentialProviderForModel(config.model);
    if (!provider) throw new CollabError('invalid_input', 'The chat model is no longer supported');
    await chat.orchestrator.validateCredentialSelection({
      chatId, requesterIdentityId: auth.identityId!, requesterAuthKind: auth.authKind ?? null,
      ...(auth.authSessionId ? { requesterAuthSessionId: auth.authSessionId } : {}),
      spaceId: config.space_id, teammateId: config.teammate_id,
      model: config.model, provider: config.provider, agentTool: config.agent_tool,
      chatMode: config.chat_mode, cwd: config.cwd, mode: 'new', credentialSelection: input.credentialSelection,
    }).catch(rethrowCredentialError);
    // Persist only. The in-flight turn keeps its claim snapshot and process.
    const credentialIntent = withChatCredentialChoice(intentOf(config), provider, input.credentialSelection);
    const stored = await facade.db.tx(auth, q => q.rpc<SetChatCredentialsResult>('set_chat_configuration', [
      chatId, input.expectedConfigRevision ?? Number(config.config_revision), JSON.stringify({
        model: config.model, provider: config.provider, agentTool: config.agent_tool,
        reasoningEffort: config.reasoning_effort ?? null,
        credentialIntent, credentialSelection: input.credentialSelection,
      }), input.clientMutationId ?? randomUUID(),
    ]));
    return { chatId: stored.chatId, credentialSelection: stored.credentialSelection,
      credentialIntent: stored.credentialIntent, configRevision: stored.configRevision, appliesAt: stored.appliesAt };
  };
}

/**
 * Resolve model, effort and remembered provider credentials before one atomic
 * revision-checked write. The next claim applies it; the active turn keeps its
 * immutable configuration and runtime generation.
 */
function setChatModel(facade: FacadeDeps, chat?: ChatHandlerDeps): OperationHandler {
  return async (ctx) => {
    const chatId = requireUuidParam(ctx, 'id') as EntityId;
    const input = ctx.body as SetChatModelInput;
    const model = admittedModel(input.model, input.reasoningEffort);
    const owner = await facade.owner();
    const requestClaims = claimsFor(owner, ctx);
    if (!requestClaims.identityId) {
      throw new CollabError('unauthenticated', 'authentication is required');
    }
    if (!chat) {
      throw new CollabError('upstream_unavailable', 'chat runtime is unavailable on this node');
    }
    const config = await readDesired(facade, requestClaims, chatId);
    const provider = chatCredentialProviderForModel(input.model)!;
    const priorIntent = intentOf(config);
    const credentialIntent = input.credentialSelection
      ? withChatCredentialChoice(priorIntent, provider, input.credentialSelection) : priorIntent;
    const selection = chatCredentialChoice(credentialIntent, provider);
    const reasoningEffort = input.reasoningEffort !== undefined ? input.reasoningEffort
      : config.reasoning_effort && model.efforts.includes(config.reasoning_effort) ? config.reasoning_effort : null;
    await chat.orchestrator.admitConfiguration({ model: input.model, reasoningEffort });
    await chat.orchestrator.validateCredentialSelection({
      chatId, requesterIdentityId: requestClaims.identityId, requesterAuthKind: requestClaims.authKind ?? null,
      ...(requestClaims.authSessionId ? { requesterAuthSessionId: requestClaims.authSessionId } : {}),
      spaceId: config.space_id, teammateId: config.teammate_id,
      model: input.model, provider: model.provider, agentTool: model.agentTool,
      chatMode: config.chat_mode, cwd: config.cwd, mode: 'new', credentialSelection: selection,
    }).catch(rethrowCredentialError);
    const stored = await facade.db.tx(requestClaims, q => q.rpc<SetChatModelResult>('set_chat_configuration', [
      chatId, input.expectedConfigRevision ?? Number(config.config_revision), JSON.stringify({
        model: input.model, provider: model.provider, agentTool: model.agentTool,
        reasoningEffort, credentialIntent, credentialSelection: selection,
      }), input.clientMutationId ?? randomUUID(),
    ]));
    return configurationResult(stored);
  };
}

/**
 * Every chat operation is human-only.
 *
 * `credentials.ts` states the reasoning at length and it holds identically
 * here: N copies of a check are N places to be correct, and the failure that
 * actually happens is an operation added later, born unguarded and looking
 * exactly like its guarded neighbours.
 *
 * This is layer 1 of two. Layer 2 is `internal.require_human_auth_kind()`
 * inside `start_chat`, reading the `tm8.auth_kind` claim. Either alone would
 * refuse the call; both are here because this one is the readable one and that
 * one is the one a future caller reaching the RPC another way cannot bypass.
 */
function humanOnly(handler: OperationHandler): OperationHandler {
  return async (ctx) => {
    refuseChatRuntimeBearer(ctx);
    return handler(ctx);
  };
}

/**
 * `registerAll` WITH AN OBJECT LITERAL, and neither half is a style choice.
 *
 * `tools/conformance`'s source inventory parses this file and requires every
 * registration to name its operation as a string literal — `register` with a
 * literal, or `registerAll` with a literal object whose keys are literal. The
 * first shape of this function mapped a wrapper over a record and called
 * `registry.register(name as OperationName, …)`, which the inventory rightly
 * refused: a computed name makes the registered surface unauditable, so
 * `chat.start` would have vanished from the very census that exists to say what
 * this node mounts.
 *
 * So the wrapper is applied per entry rather than over the record. That trades
 * away the by-construction guarantee — a new entry here CAN forget `humanOnly`
 * — and `test/chat/handlers-human-only.test.ts` buys it back where it belongs:
 * it walks every operation this function registers and asserts each one refuses
 * a chat-runtime credential, so a future unguarded entry fails a test rather
 * than shipping.
 */
export function registerChatHandlers(
  registry: HandlerRegistry,
  facade: FacadeDeps,
  chat?: ChatHandlerDeps,
): void {
  registry.registerAll({
    'chat.start': humanOnly(startChat(facade, chat)),
    'chat.setModel': humanOnly(setChatModel(facade, chat)),
    'chat.setCredentials': humanOnly(setChatCredentials(facade, chat)),
  });
}
