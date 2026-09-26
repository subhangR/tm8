import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { CHAT_HOME_FIXTURE_THREAD } from './fixtures';
import {
  appendOptimisticTurn,
  hasUsage,
  mergeChatTurnFrame,
  optimisticTurnId,
  projectTurnParts,
  reconcileDetails,
  settleOptimisticTurn,
} from './turn-model';
import type { ChatThreadDetail, ChatTurn } from './types';

describe('rich turn projection', () => {
  it('updates one tool card from later append-only state parts', () => {
    const assistant = CHAT_HOME_FIXTURE_THREAD.turns[1]!;
    const projected = projectTurnParts(assistant.parts);
    const tools = projected.filter((part) => part.kind === 'tool');

    /* Two calls in the fixture turn — the read (three append-only state
       parts folding to ONE card, the projection under test) and the spawn
       (call + result). Still one PROJECTED part per toolCallId. */
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      toolCallId: 'tool-1',
      state: 'completed',
      result: { tasks: 7, blocked: 1 },
    });
    expect(tools[1]).toMatchObject({ toolCallId: 'tool-2', state: 'completed' });
  });

  it('deduplicates a replayed delta by durable sequence', () => {
    const frame = {
      type: 'chat.turn.delta' as const,
      chatId: CHAT_HOME_FIXTURE_THREAD.summary.rootId,
      messageId: '019f0000-0000-7000-8000-000000000099' as EntityId,
      seq: 7,
      part: { kind: 'text' as const, text: 'streamed once' },
    };
    const once = mergeChatTurnFrame(CHAT_HOME_FIXTURE_THREAD, frame);
    const twice = mergeChatTurnFrame(once, frame);
    expect(twice.turns.at(-1)?.parts).toEqual([{ seq: 7, kind: 'text', text: 'streamed once' }]);
  });

  it('ignores a done frame for a message it has never seen', () => {
    expect(hasUsage({})).toBe(false);
    const next = mergeChatTurnFrame(CHAT_HOME_FIXTURE_THREAD, {
      type: 'chat.turn.done',
      chatId: CHAT_HOME_FIXTURE_THREAD.summary.rootId,
      messageId: '019f0000-0000-7000-8000-000000000099' as EntityId,
      usage: {},
    });
    // No fabricated empty assistant turn, no fabricated usage — unchanged.
    expect(next.turns).toEqual(CHAT_HOME_FIXTURE_THREAD.turns);
  });
});


describe('lane 1: a done settles its turn, and an echo retires exactly once', () => {
  const root = CHAT_HOME_FIXTURE_THREAD.summary.rootId;
  const agentId = '019f0000-0000-7000-8000-0000000000d1' as EntityId;
  const claimed: ChatTurn = {
    messageId: agentId,
    role: 'assistant',
    author: null,
    createdAt: '2026-09-26T00:00:00.000Z',
    body: 'Agent turn in progress.',
    parts: [],
    turnInFlight: true,
  };
  const base = (): ChatThreadDetail => ({ ...structuredClone(CHAT_HOME_FIXTURE_THREAD), turns: [claimed] });

  /* HINGES ON: the done arm's `turnInFlight` strip. Left set, the marker
     outlived the turn and hid the body of a turn that finished while it was
     watched. The placeholder body goes too — it described the claim. */
  it('clears the in-flight marker and the claim placeholder on done', () => {
    const settled = mergeChatTurnFrame(base(), { type: 'chat.turn.done', chatId: root, messageId: agentId, usage: {} });
    expect(settled.turns[0]!.turnInFlight).toBeUndefined();
    expect(settled.turns[0]!.body).toBe('');
  });

  const echo = (body: string, id = optimisticTurnId('m1')): ChatTurn => ({
    messageId: id, role: 'user', author: null, createdAt: '2026-09-26T00:00:00.000Z', body, parts: [], optimistic: true,
  });
  const stored = (id: string, body: string): ChatTurn => ({
    messageId: id as EntityId, role: 'user', author: null, createdAt: '2026-09-26T00:00:01.000Z', body, parts: [],
  });

  it('re-keys an echo to the acked id so the snapshot replaces it', () => {
    const painted = appendOptimisticTurn(base(), root, echo('Hi.'))!;
    const acked = settleOptimisticTurn(painted, optimisticTurnId('m1'), 'real-1' as EntityId)!;
    const next = reconcileDetails(acked, { ...base(), turns: [claimed, stored('real-1', 'Hi.')] });
    expect(next.turns.map((turn) => turn.messageId)).toEqual([agentId, 'real-1']);
    expect(next.turns[1]!.optimistic).toBeUndefined();
  });

  /* HINGES ON: the one-to-one `arrivals` match in `reconcileDetails`. A
     snapshot that beats the ack (or a port that names no id) must not leave
     the echo standing beside the stored copy. */
  it('retires an un-keyed echo against a NEW stored turn with its words, one for one', () => {
    const painted = appendOptimisticTurn(
      appendOptimisticTurn(base(), root, echo('yes', optimisticTurnId('a')))!,
      root,
      echo('yes', optimisticTurnId('b')),
    )!;
    const next = reconcileDetails(painted, { ...base(), turns: [claimed, stored('real-a', 'yes')] });
    // One stored "yes" retires ONE echo; the second is still in flight.
    expect(next.turns.map((turn) => turn.messageId)).toEqual([agentId, 'real-a', optimisticTurnId('b')]);
  });

  it('never paints an echo into another thread', () => {
    const other = '019f0000-0000-7000-8000-0000000000ff' as EntityId;
    const painted = appendOptimisticTurn(base(), other, echo('Hi.'));
    expect(painted!.turns).toHaveLength(1);
  });
});

describe('one usage part per turn (L3, #877)', () => {
  const root = CHAT_HOME_FIXTURE_THREAD.summary.rootId;
  const agentId = '019f0000-0000-7000-8000-0000000000d2' as EntityId;
  const withParts = (parts: ChatTurn['parts']): ChatThreadDetail => ({
    ...structuredClone(CHAT_HOME_FIXTURE_THREAD),
    turns: [{ messageId: agentId, role: 'assistant', author: null, createdAt: '2026-09-26T00:00:00.000Z', body: '', parts }],
  });
  const doneFrame = { type: 'chat.turn.done' as const, chatId: root, messageId: agentId, usage: { input_tokens: 5 } };
  const usageSeqs = (detail: ChatThreadDetail) =>
    detail.turns[0]!.parts.filter((part) => part.kind === 'usage').map((part) => part.seq);

  /* The reconnect gap L3 pinned at the render: the usage delta was missed,
     the done part was not, and the next snapshot brings the stored usage at
     its real seq. Held by BOTH guards below; breaking one alone stays green. */
  it('a reconnect gap that missed the usage delta still ends with ONE usage part', () => {
    const seen = mergeChatTurnFrame(
      withParts([{ seq: 0, kind: 'text', text: 'hi' }, { seq: 2, kind: 'done', reason: 'success' }]),
      doneFrame,
    );
    const snapshot = mergeChatTurnFrame(
      withParts([
        { seq: 0, kind: 'text', text: 'hi' },
        { seq: 1, kind: 'usage', usage: { input_tokens: 5 } },
        { seq: 2, kind: 'done', reason: 'success' },
      ]),
      doneFrame,
    );
    expect(usageSeqs(reconcileDetails(seen, snapshot))).toEqual([1]);
  });

  /* HINGES ON: `heldDone` in the done arm. The usage part is stored before
     the done part, so a turn holding its done part has a real one to read. */
  it('a done frame adds no stand-in usage once the turn holds its done part', () => {
    const seen = mergeChatTurnFrame(
      withParts([{ seq: 0, kind: 'text', text: 'hi' }, { seq: 2, kind: 'done', reason: 'success' }]),
      doneFrame,
    );
    expect(usageSeqs(seen)).toEqual([]);
  });

  /* HINGES ON: `reconcileDetails` dropping a synthetic usage when the store
     holds one — the invariant, whatever the seq layout. With no done part
     seen, the stand-in still draws the card until the stored one arrives. */
  it('a stand-in usage gives way to the stored one', () => {
    const seen = mergeChatTurnFrame(withParts([{ seq: 0, kind: 'text', text: 'hi' }]), doneFrame);
    expect(seen.turns[0]!.parts.find((part) => part.kind === 'usage')).toMatchObject({ seq: 1, synthetic: true });
    const snapshot = withParts([
      { seq: 0, kind: 'text', text: 'hi' },
      { seq: 5, kind: 'usage', usage: { input_tokens: 5 } },
      { seq: 6, kind: 'done', reason: 'success' },
    ]);
    expect(usageSeqs(reconcileDetails(seen, snapshot))).toEqual([5]);
  });
});
