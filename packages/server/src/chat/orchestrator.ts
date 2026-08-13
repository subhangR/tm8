import {
  MessagePartSchema,
  type ChatTurnUsage,
  type MessagePart,
  type MessageView,
} from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../db/types.js';
import type { ChatTurnPublisher } from './publisher.js';
import type {
  AgentRuntime,
  ResolveChatLaunchConfig,
  StartAgentThreadInput,
  TurnItem,
} from './runtime.js';

interface ClaimedTurn {
  readonly turnId: string;
  readonly rootMessageId: string;
  readonly userMessageId: string;
  readonly agentMessageId: string | null;
  readonly spaceId: string;
  readonly body: string;
  readonly anchorId: string;
  readonly requesterIdentityId: string;
  /** R9: server-resolved auth kind recorded at the human-gated thread start; null on pre-106 rows. */
  readonly requesterAuthKind?: string | null;
  readonly teammateId: string;
  readonly model: string;
  readonly provider: string;
  readonly agentTool: string;
  readonly nativeSessionId: string;
  readonly cwd: string;
  readonly runtimeState: 'cold' | 'live' | 'stopped';
  readonly nextSeq: number;
}

interface BatchRpcResult {
  readonly messageIds: string[];
}

export interface ChatOrchestratorOptions {
  readonly db: Db;
  readonly runtime: AgentRuntime;
  readonly publisher: ChatTurnPublisher;
  readonly resolveLaunchConfig: ResolveChatLaunchConfig;
  readonly onError?: (error: unknown) => void;
}

function claims(identityId: string): DbClaims {
  return { identityId };
}

function payloadOf(item: TurnItem): unknown {
  const { kind: _kind, ...payload } = item;
  return payload;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Durable ordered drain for one configured message root.
 *
 * Every delta follows a successful append_chat_message_part transaction. The
 * in-memory map is only a same-process coalescer; ordering authority remains
 * chat_turns `(queued_at,user_message_id)` plus the row lease in Postgres.
 */
export class ChatOrchestrator {
  private readonly drains = new Map<string, Promise<void>>();
  private readonly liveThreads = new Map<string, string>();

  constructor(private readonly options: ChatOrchestratorOptions) {}

  wake(rootMessageId: string, requesterIdentityId: string): Promise<void> {
    const running = this.drains.get(rootMessageId);
    if (running) return running;
    const drain = this.drain(rootMessageId, requesterIdentityId)
      .catch((error) => this.options.onError?.(error))
      .finally(() => this.drains.delete(rootMessageId));
    this.drains.set(rootMessageId, drain);
    return drain;
  }

  async wakeForMessages(requesterIdentityId: string, messages: readonly MessageView[]): Promise<void> {
    const roots = [...new Set(messages
      .map((message) => message.state.rootMessageId)
      .filter((root): root is string => root !== null))];
    if (roots.length === 0) return;
    const configured = await this.options.db.query<{ root_message_id: string }>(
      claims(requesterIdentityId),
      `select root_message_id
         from public.chat_threads
        where root_message_id = any($1::uuid[])
          and configured_by_identity_id = $2`,
      [roots, requesterIdentityId],
    );
    await Promise.all(configured.map((row) => this.wake(row.root_message_id, requesterIdentityId)));
  }

  private async drain(rootMessageId: string, requesterIdentityId: string): Promise<void> {
    for (;;) {
      const turn = await this.options.db.rpc<ClaimedTurn | null>(
        claims(requesterIdentityId),
        'claim_next_chat_turn',
        [rootMessageId],
      );
      if (!turn) return;
      await this.runTurn(turn);
    }
  }

  private async runTurn(turn: ClaimedTurn): Promise<void> {
    const agentMessageId = turn.agentMessageId ?? await this.createAgentMessage(turn);
    let seq = turn.agentMessageId ? Number(turn.nextSeq) : 0;
    let usage: ChatTurnUsage | null = null;
    let text = '';
    const terminal: {
      reason: 'success' | 'error' | 'interrupted' | 'closed' | null;
    } = { reason: null };

    const append = async (item: TurnItem): Promise<void> => {
      const stored = await this.options.db.rpc<unknown>(
        claims(turn.requesterIdentityId),
        'append_chat_message_part',
        [agentMessageId, seq, item.kind, payloadOf(item)],
      );
      const part = MessagePartSchema.parse(stored);
      this.options.publisher.publish(turn.spaceId, turn.requesterIdentityId, {
        type: 'chat.turn.delta',
        threadRootId: turn.rootMessageId,
        messageId: agentMessageId,
        seq,
        part,
      });
      seq += 1;
      if (item.kind === 'text') text += item.text;
      if (item.kind === 'usage') {
        const { kind: _kind, ...reported } = item;
        // D10/R8: this emitted C1 item is the only accounting source. In
        // particular, never inspect a runtime result's zeroed aborted usage.
        usage = reported;
      }
      if (item.kind === 'done') terminal.reason = item.reason;
    };

    try {
      const threadId = await this.ensureRuntime(turn);
      for await (const item of this.options.runtime.sendTurn(threadId, { text: turn.body })) {
        await append(item);
      }
      if (terminal.reason === null) {
        await append({ kind: 'error', code: 'runtime_stream_incomplete', message: 'runtime ended without done' });
        await append({ kind: 'done', reason: 'error' });
        terminal.reason = 'error';
      }
    } catch (error) {
      await append({ kind: 'error', code: 'runtime_error', message: errorMessage(error) });
      await append({ kind: 'done', reason: 'error' });
      terminal.reason = 'error';
    }

    const finalUsage = usage as ChatTurnUsage | null;
    const totalCost = finalUsage?.total_cost_usd ?? null;
    await this.options.db.rpc(
      claims(turn.requesterIdentityId),
      'complete_chat_turn',
      [
        turn.turnId,
        terminal.reason === 'success' || terminal.reason === 'closed' ? 'completed' : 'error',
        text,
        finalUsage,
        totalCost,
        terminal.reason === 'error' ? { code: 'runtime_error' } : null,
      ],
    );

    if (terminal.reason === 'interrupted') {
      this.liveThreads.delete(turn.rootMessageId);
      await this.options.db.rpc(
        claims(turn.requesterIdentityId),
        'mark_chat_runtime_state',
        [turn.rootMessageId, 'stopped'],
      );
    }

    this.options.publisher.publish(turn.spaceId, turn.requesterIdentityId, {
      type: 'chat.turn.done',
      threadRootId: turn.rootMessageId,
      messageId: agentMessageId,
      usage: finalUsage,
    });
  }

  private async createAgentMessage(turn: ClaimedTurn): Promise<string> {
    const result = await this.options.db.tx(claims(turn.requesterIdentityId), async (q: Querier) => {
      const posted = await q.rpc<BatchRpcResult>('w2_post_message_batch', [
        [turn.anchorId],
        'Agent turn in progress.',
        turn.userMessageId,
        [],
        [],
        null,
        turn.teammateId,
        `chat-turn:${turn.turnId}`,
      ]);
      const messageId = posted.messageIds[0];
      if (!messageId) throw new Error('agent message RPC returned no message id');
      await q.rpc('bind_chat_agent_message', [turn.turnId, messageId]);
      return messageId;
    });
    return result;
  }

  private async ensureRuntime(turn: ClaimedTurn): Promise<string> {
    const live = this.liveThreads.get(turn.rootMessageId);
    if (live) return live;
    const mode = turn.runtimeState === 'stopped' ? 'resume-after-interrupt' : 'new';
    const launch = await this.options.resolveLaunchConfig({
      rootMessageId: turn.rootMessageId,
      requesterIdentityId: turn.requesterIdentityId,
      requesterAuthKind: turn.requesterAuthKind ?? null,
      teammateId: turn.teammateId,
      model: turn.model,
      provider: turn.provider,
      agentTool: turn.agentTool,
      mode,
    });
    const input: StartAgentThreadInput = {
      threadId: turn.rootMessageId,
      nativeSessionId: turn.nativeSessionId,
      model: turn.model,
      cwd: turn.cwd,
      systemPrompt: launch.systemPrompt,
      mcpConfigPath: launch.mcpConfigPath,
      allowedTools: launch.allowedTools,
      ...(launch.env ? { env: launch.env } : {}),
      ...(mode === 'resume-after-interrupt'
        ? { resume: { nativeSessionId: turn.nativeSessionId, cwd: turn.cwd } }
        : {}),
    };
    const started = await this.options.runtime.startThread(input);
    this.liveThreads.set(turn.rootMessageId, started.threadId);
    await this.options.db.rpc(
      claims(turn.requesterIdentityId),
      'mark_chat_runtime_state',
      [turn.rootMessageId, 'live'],
    );
    return started.threadId;
  }
}
