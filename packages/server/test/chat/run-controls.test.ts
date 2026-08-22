/**
 * THE SERVER HALF OF THE TWO CHAT RUN CONTROLS.
 *
 * The composer half — a live model drop-up on a configured thread, a Stop that
 * reaches the port, and copy that never calls a stop a failure — is pinned in
 * `packages/tm8-ui/src/chat-home/run-controls.test.tsx`. What is pinned here is
 * everything downstream of the wire:
 *
 *   · a turn the person stopped is recorded as `stopped`, not as `error`;
 *   · a turn that names a different model RESTARTS the runtime on it, rather
 *     than being answered by the process already running the old one;
 *   · `interrupt` reaches the live runtime, and says so honestly when there is
 *     no live runtime to reach.
 */
import { describe, expect, it } from 'vitest';
import { ChatOrchestrator } from '../../src/chat/orchestrator.js';
import { ChatTurnPublisher } from '../../src/chat/publisher.js';
import type { AgentRuntime, StartAgentThreadInput, TurnItem } from '../../src/chat/runtime.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { SubscriptionRegistry } from '../../src/events/subscriptions.js';

const ROOT = '20000000-0000-4000-8000-000000000001';
const USER_MESSAGE = '20000000-0000-4000-8000-000000000002';
const AGENT_MESSAGE = '20000000-0000-4000-8000-000000000003';
const SPACE = '20000000-0000-4000-8000-000000000005';
const ANCHOR = '20000000-0000-4000-8000-000000000006';
const TEAMMATE = '20000000-0000-4000-8000-000000000007';
const NATIVE = '20000000-0000-4000-8000-000000000008';
const IDENTITY = 'chat-human';

type RuntimeState = 'cold' | 'live' | 'stopped';

interface ClaimOverrides {
  readonly turnId?: string;
  readonly model?: string;
  readonly runtimeState?: RuntimeState;
}

function claim(overrides: ClaimOverrides = {}): Record<string, unknown> {
  return {
    turnId: overrides.turnId ?? '20000000-0000-4000-8000-000000000004',
    rootMessageId: ROOT,
    userMessageId: USER_MESSAGE,
    agentMessageId: null,
    spaceId: SPACE,
    body: 'human prompt verbatim',
    anchorId: ANCHOR,
    requesterIdentityId: IDENTITY,
    requesterAuthKind: 'browser',
    teammateId: TEAMMATE,
    // The RESOLVED model: `claim_next_chat_turn` coalesces the turn's own
    // choice against the thread's default before it ever reaches the server.
    model: overrides.model ?? 'claude-opus-5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    chatMode: 'ask',
    nativeSessionId: NATIVE,
    cwd: '/tmp/tm8-chat-run-controls',
    runtimeState: overrides.runtimeState ?? 'cold',
    nextSeq: 0,
  };
}

class FakeDb implements Db {
  /** Every `complete_chat_turn` argument list, in order. */
  readonly completed: unknown[][] = [];
  readonly states: string[] = [];
  private nextClaim = 0;

  constructor(private readonly claimedTurns: readonly Record<string, unknown>[]) {}

  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    const q: Querier = {
      query: async () => [],
      rpc: async <R>(name: string): Promise<R> => {
        if (name === 'w2_post_message_batch') return { messageIds: [AGENT_MESSAGE] } as R;
        if (name === 'bind_chat_agent_message') return undefined as R;
        throw new Error(`unexpected tx rpc ${name}`);
      },
    };
    return fn(q);
  }

  async rpc<T>(_claims: DbClaims, name: string, args: readonly unknown[] = []): Promise<T> {
    if (name === 'claim_next_chat_turn') {
      const claimed = this.claimedTurns[this.nextClaim];
      this.nextClaim += 1;
      return (claimed ?? null) as T;
    }
    if (name === 'append_chat_message_part') {
      // The real RPC answers the stored row, and the publisher reads it — a
      // fake that answered nothing would fail the drain before it ever reached
      // the completion this file is about.
      const [, seq, kind, payload] = args;
      return { seq, kind, payload, createdAt: '2026-08-22T00:00:00.000Z' } as T;
    }
    if (name === 'complete_chat_turn') {
      this.completed.push([...args]);
      return undefined as T;
    }
    if (name === 'mark_chat_runtime_state') {
      this.states.push(String(args[1]));
      return undefined as T;
    }
    throw new Error(`unexpected rpc ${name}`);
  }

  async query<R>(): Promise<R[]> { return []; }
  async end(): Promise<void> {}
}

class FakeRuntime implements AgentRuntime {
  readonly starts: StartAgentThreadInput[] = [];
  readonly closes: string[] = [];
  readonly interrupts: string[] = [];
  /** What `interrupt` answers — the adapter says false when nothing is active. */
  interruptAnswer = true;

  constructor(private readonly itemsPerTurn: readonly (readonly TurnItem[])[]) {}

  async startThread(input: StartAgentThreadInput): Promise<{ threadId: string }> {
    this.starts.push(input);
    return { threadId: input.threadId };
  }

  async *sendTurn(): AsyncIterable<TurnItem> {
    const items = this.itemsPerTurn[this.starts.length - 1] ?? this.itemsPerTurn.at(-1) ?? [];
    for (const item of items) yield item;
  }

  async interrupt(threadId: string): Promise<boolean> {
    this.interrupts.push(threadId);
    return this.interruptAnswer;
  }

  async close(threadId: string): Promise<void> { this.closes.push(threadId); }
}

function rig(claims: readonly Record<string, unknown>[], itemsPerTurn: readonly (readonly TurnItem[])[]) {
  const db = new FakeDb(claims);
  const runtime = new FakeRuntime(itemsPerTurn);
  const orchestrator = new ChatOrchestrator({
    db,
    runtime,
    publisher: new ChatTurnPublisher(new SubscriptionRegistry()),
    resolveLaunchConfig: async () => ({
      systemPrompt: 'system',
      mcpConfigPath: '/tmp/mcp.json',
      availableTools: [],
      allowedTools: [],
    }),
  });
  return { db, orchestrator, runtime };
}

const DONE = (reason: 'success' | 'error' | 'interrupted' | 'closed'): TurnItem =>
  ({ kind: 'done', reason }) as TurnItem;

describe('a stopped turn is not a failed one', () => {
  /**
   * THE DEFECT. The completion state was `success || closed ? 'completed' :
   * 'error'`, which folded `interrupted` in with a crash — so the row recorded
   * a failure and the agent message was stamped 'Agent turn failed.' The person
   * who stopped their own run was told it broke, permanently, in the
   * transcript.
   */
  it('records `stopped` when the person stopped it', async () => {
    const { db, orchestrator } = rig([claim()], [[
      { kind: 'text', text: 'part of an answer' } as TurnItem,
      DONE('interrupted'),
    ]]);
    await orchestrator.wake(ROOT, IDENTITY);

    expect(db.completed[0]?.[1]).toBe('stopped');
    // No failure object: there is no failure to describe.
    expect(db.completed[0]?.[5]).toBeNull();
  });

  /** Whatever it had already said is kept — that is the useful record. */
  it('keeps the partial answer rather than replacing it', async () => {
    const { db, orchestrator } = rig([claim()], [[
      { kind: 'text', text: 'I got as far as here' } as TurnItem,
      DONE('interrupted'),
    ]]);
    await orchestrator.wake(ROOT, IDENTITY);
    expect(db.completed[0]?.[2]).toBe('I got as far as here');
  });

  /** The other three reasons are unchanged — this was one branch, not a rewrite. */
  it('still records completion and failure as themselves', async () => {
    for (const [reason, state] of [
      ['success', 'completed'],
      ['closed', 'completed'],
      ['error', 'error'],
    ] as const) {
      const { db, orchestrator } = rig([claim()], [[DONE(reason)]]);
      await orchestrator.wake(ROOT, IDENTITY);
      expect(db.completed[0]?.[1]).toBe(state);
    }
  });

  /**
   * The RUNTIME state is a separate fact and was already right: an interrupted
   * thread is marked stopped so the next turn takes the resume path, which is
   * what makes the conversation continuable rather than lost.
   */
  it('leaves the thread marked stopped so the next turn resumes it', async () => {
    const { db, orchestrator } = rig([claim()], [[DONE('interrupted')]]);
    await orchestrator.wake(ROOT, IDENTITY);
    expect(db.states).toEqual(['live', 'stopped']);
  });
});

describe('a turn that names a different model', () => {
  /**
   * THE HALF THAT MAKES THE PICKER REAL. A running agent process cannot change
   * model, so honouring a per-turn override means closing the runtime and
   * resuming the same conversation on the new one. Without this the override
   * would be stored on the turn, shown in the composer, and quietly answered by
   * the old model.
   */
  it('restarts the runtime on the new model, resuming the same conversation', async () => {
    const { orchestrator, runtime } = rig(
      [claim({ model: 'claude-opus-5' }), claim({
        turnId: '20000000-0000-4000-8000-00000000000b',
        model: 'claude-haiku-4-5-20251001',
      })],
      [[DONE('success')], [DONE('success')]],
    );

    await orchestrator.wake(ROOT, IDENTITY);
    await orchestrator.wake(ROOT, IDENTITY);

    expect(runtime.starts.map((start) => start.model)).toEqual([
      'claude-opus-5',
      'claude-haiku-4-5-20251001',
    ]);
    expect(runtime.closes).toEqual([ROOT]);
    // RESUMED, not started fresh: keeping the conversation is the entire reason
    // a person changes model mid-thread instead of opening a new one.
    expect(runtime.starts[1]?.resume)
      .toEqual({ nativeSessionId: NATIVE, cwd: '/tmp/tm8-chat-run-controls' });
  });

  it('reuses the live runtime when the model has not changed', async () => {
    const { orchestrator, runtime } = rig(
      [claim(), claim({ turnId: '20000000-0000-4000-8000-00000000000c' })],
      [[DONE('success')], [DONE('success')]],
    );

    await orchestrator.wake(ROOT, IDENTITY);
    await orchestrator.wake(ROOT, IDENTITY);

    expect(runtime.starts).toHaveLength(1);
    expect(runtime.closes).toEqual([]);
  });
});

describe('stopping reaches the runtime', () => {
  it('signals the live thread', async () => {
    const { orchestrator, runtime } = rig([claim()], [[DONE('success')]]);
    await orchestrator.wake(ROOT, IDENTITY);

    await expect(orchestrator.interrupt(ROOT)).resolves.toBe(true);
    expect(runtime.interrupts).toEqual([ROOT]);
  });

  /**
   * NOT AN ERROR WHEN NOTHING IS RUNNING. A turn can finish between the person
   * deciding to stop it and the request landing, and a thread on a restarted
   * node has no in-process runtime at all. Both are `false` — the request
   * succeeded, and there was nothing to stop.
   */
  it('answers false rather than raising when nothing is live', async () => {
    const { orchestrator, runtime } = rig([], []);
    await expect(orchestrator.interrupt(ROOT)).resolves.toBe(false);
    expect(runtime.interrupts).toEqual([]);
  });

  /** The runtime's own verdict is passed through, not overwritten with hope. */
  it('reports the runtime refusing the signal', async () => {
    const { orchestrator, runtime } = rig([claim()], [[DONE('success')]]);
    await orchestrator.wake(ROOT, IDENTITY);
    runtime.interruptAnswer = false;
    await expect(orchestrator.interrupt(ROOT)).resolves.toBe(false);
  });
});
