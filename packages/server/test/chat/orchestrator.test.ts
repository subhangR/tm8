import { describe, expect, it } from 'vitest';
import type { ChatTurnFrame } from '@tm8/contract';
import { ChatOrchestrator } from '../../src/chat/orchestrator.js';
import { ChatTurnPublisher } from '../../src/chat/publisher.js';
import type {
  AgentRuntime,
  StartAgentThreadInput,
  TurnItem,
} from '../../src/chat/runtime.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { SubscriptionRegistry } from '../../src/events/subscriptions.js';
import type { EventSink } from '../../src/events/ws-connection.js';

const ROOT = '10000000-0000-4000-8000-000000000001';
const USER_MESSAGE = '10000000-0000-4000-8000-000000000002';
const AGENT_MESSAGE = '10000000-0000-4000-8000-000000000003';
const TURN = '10000000-0000-4000-8000-000000000004';
const SPACE = '10000000-0000-4000-8000-000000000005';
const ANCHOR = '10000000-0000-4000-8000-000000000006';
const TEAMMATE = '10000000-0000-4000-8000-000000000007';
const NATIVE = '10000000-0000-4000-8000-000000000008';
const IDENTITY = 'chat-human';

type RuntimeState = 'cold' | 'live' | 'stopped';

function claim(runtimeState: RuntimeState): Record<string, unknown> {
  return {
    turnId: TURN,
    rootMessageId: ROOT,
    userMessageId: USER_MESSAGE,
    agentMessageId: null,
    spaceId: SPACE,
    body: 'human prompt verbatim',
    anchorId: ANCHOR,
    requesterIdentityId: IDENTITY,
    teammateId: TEAMMATE,
    model: 'gpt-5.6-sol',
    provider: 'openai',
    agentTool: 'codex',
    nativeSessionId: NATIVE,
    cwd: '/tmp/tm8-chat-test',
    runtimeState,
    nextSeq: 0,
  };
}

class FakeSink implements EventSink {
  readonly id = 'sink';
  readonly identity = { kind: 'bearer' as const, identityId: IDENTITY };
  readonly isOpen = true;
  readonly frames: ChatTurnFrame[] = [];

  constructor(private readonly events: string[]) {}
  send(text: string): void {
    const frame = JSON.parse(text) as ChatTurnFrame;
    this.frames.push(frame);
    this.events.push(frame.type === 'chat.turn.delta' ? `delta:${frame.seq}` : 'done-frame');
  }
  close(): void {}
  onMessage(): void {}
  onClose(): void {}
}

class FakeDb implements Db {
  readonly completed: unknown[][] = [];
  readonly states: string[] = [];
  claimCalls = 0;
  private claimed = false;

  constructor(
    private readonly claimedTurn: Record<string, unknown> | null,
    private readonly events: string[],
    readonly configuredRoots: string[] = [],
  ) {}

  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    const q: Querier = {
      query: async () => [],
      rpc: async <R>(name: string, args: readonly unknown[] = []): Promise<R> => {
        if (name === 'w2_post_message_batch') {
          this.events.push('agent-message');
          return { messageIds: [AGENT_MESSAGE] } as R;
        }
        if (name === 'bind_chat_agent_message') {
          this.events.push('bind-agent-message');
          return undefined as R;
        }
        throw new Error(`unexpected tx rpc ${name} ${JSON.stringify(args)}`);
      },
    };
    return fn(q);
  }

  async rpc<T>(_claims: DbClaims, name: string, args: readonly unknown[] = []): Promise<T> {
    if (name === 'claim_next_chat_turn') {
      this.claimCalls += 1;
      if (this.claimed || !this.claimedTurn) return null as T;
      this.claimed = true;
      return this.claimedTurn as T;
    }
    if (name === 'append_chat_message_part') {
      const [, seq, kind, payload] = args;
      this.events.push(`persist:${String(seq)}`);
      return {
        seq,
        kind,
        payload,
        createdAt: '2026-08-13T00:00:00.000Z',
      } as T;
    }
    if (name === 'complete_chat_turn') {
      this.events.push('complete');
      this.completed.push([...args]);
      return undefined as T;
    }
    if (name === 'mark_chat_runtime_state') {
      this.states.push(String(args[1]));
      this.events.push(`state:${String(args[1])}`);
      return undefined as T;
    }
    throw new Error(`unexpected rpc ${name}`);
  }

  async query<R>(): Promise<R[]> {
    return this.configuredRoots.map((root_message_id) => ({ root_message_id }) as R);
  }
  async end(): Promise<void> {}
}

class FakeRuntime implements AgentRuntime {
  readonly starts: StartAgentThreadInput[] = [];
  constructor(private readonly items: readonly TurnItem[]) {}
  async startThread(input: StartAgentThreadInput): Promise<{ threadId: string }> {
    this.starts.push(input);
    return { threadId: input.threadId };
  }
  async *sendTurn(): AsyncIterable<TurnItem> {
    for (const item of this.items) yield item;
  }
  async interrupt(): Promise<boolean> { return true; }
  async close(): Promise<void> {}
}

function rig(runtimeState: RuntimeState, items: readonly TurnItem[]) {
  const events: string[] = [];
  const db = new FakeDb(claim(runtimeState), events);
  const runtime = new FakeRuntime(items);
  const registry = new SubscriptionRegistry();
  const sink = new FakeSink(events);
  registry.add(sink);
  registry.subscribe(sink.id, SPACE);
  const orchestrator = new ChatOrchestrator({
    db,
    runtime,
    publisher: new ChatTurnPublisher(registry, 'owner'),
    resolveLaunchConfig: async () => ({
      systemPrompt: 'system',
      mcpConfigPath: '/tmp/mcp.json',
      allowedTools: ['messages.post'],
    }),
  });
  return { db, events, orchestrator, runtime, sink };
}

describe('TM8 Chat durable orchestration', () => {
  it('commits every C1 part before its delta and completes before the done frame', async () => {
    const { db, events, orchestrator, sink } = rig('cold', [
      { kind: 'text', text: 'answer' },
      { kind: 'usage', input_tokens: 4, output_tokens: 2 },
      { kind: 'done', reason: 'success' },
    ]);
    await orchestrator.wake(ROOT, IDENTITY);

    expect(events).toEqual([
      'agent-message', 'bind-agent-message', 'state:live',
      'persist:0', 'delta:0', 'persist:1', 'delta:1', 'persist:2', 'delta:2',
      'complete', 'done-frame',
    ]);
    expect(db.completed[0]?.[2]).toBe('answer');
    expect(db.completed[0]?.[3]).toEqual({ input_tokens: 4, output_tokens: 2 });
    // Absent provider cost is NULL, never a counterfeit zero.
    expect(db.completed[0]?.[4]).toBeNull();
    expect(sink.frames.at(-1)).toMatchObject({ type: 'chat.turn.done', usage: { input_tokens: 4 } });
  });

  it('lazily resumes only a stopped thread and records interrupted modelUsage cost', async () => {
    const { db, orchestrator, runtime } = rig('stopped', [
      { kind: 'tool_result', tool_call_id: 'vendor', content: { aborted: true }, is_error: true },
      { kind: 'usage', input_tokens: 20, output_tokens: 1, total_cost_usd: 4.25 },
      { kind: 'done', reason: 'interrupted' },
    ]);
    await orchestrator.wake(ROOT, IDENTITY);

    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0]?.resume).toEqual({ nativeSessionId: NATIVE, cwd: '/tmp/tm8-chat-test' });
    expect(db.completed[0]?.[3]).toMatchObject({ input_tokens: 20, total_cost_usd: 4.25 });
    expect(db.completed[0]?.[4]).toBe(4.25);
    expect(db.states).toEqual(['live', 'stopped']);
  });

  it('does not wake a thread for a different human participant', async () => {
    const events: string[] = [];
    const db = new FakeDb(null, events, []);
    const orchestrator = new ChatOrchestrator({
      db,
      runtime: new FakeRuntime([]),
      publisher: new ChatTurnPublisher(new SubscriptionRegistry(), 'owner'),
      resolveLaunchConfig: async () => ({
        systemPrompt: '', mcpConfigPath: '/tmp/mcp.json', allowedTools: [],
      }),
    });
    await orchestrator.wakeForMessages('other-human', [{
      state: { rootMessageId: ROOT },
    } as never]);
    expect(db.claimCalls).toBe(0);
  });
});
