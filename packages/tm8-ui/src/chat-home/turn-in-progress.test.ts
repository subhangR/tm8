import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { deriveTurnInProgress, startTurnClock, type TurnClock } from './turn-in-progress';
import type { ChatThreadDetail, ChatTurn } from './types';

const CHAT = '019f0000-0000-7000-8000-000000000301' as EntityId;
const USER_MSG = '019f0000-0000-7000-8000-000000000302' as EntityId;
const AGENT_MSG = '019f0000-0000-7000-8000-000000000303' as EntityId;

function detail(turns: ChatTurn[]): ChatThreadDetail {
  return {
    summary: {
      rootId: CHAT,
      aboutId: null,
      title: 'Plan',
      preview: 'Plan',
      updatedAt: '2026-09-26T00:00:00.000Z',
      replyCount: 1,
      config: {
        teammateId: '019f0000-0000-7000-8000-000000000304' as EntityId,
        teammateLabel: 'Forge',
        model: 'claude-sonnet-4-5',
        modelLabel: 'claude-sonnet-4-5',
        mode: 'ask',
      },
      state: 'streaming',
    },
    turns,
  };
}

const userTurn: ChatTurn = {
  messageId: USER_MSG,
  role: 'user',
  author: null,
  createdAt: '2026-09-26T00:00:00.000Z',
  body: 'Go.',
  parts: [],
};

function agentTurn(parts: ChatTurn['parts'], extra: Partial<ChatTurn> = {}): ChatTurn {
  return {
    messageId: AGENT_MSG,
    role: 'assistant',
    author: null,
    createdAt: '2026-09-26T00:00:01.000Z',
    body: 'Agent turn in progress.',
    parts,
    ...extra,
  };
}

const clock = (patch: Partial<TurnClock> = {}): TurnClock => ({
  ...startTurnClock(CHAT, 1_000),
  ...patch,
});

describe('deriveTurnInProgress', () => {
  it('is null with no clock, and null once the composer is idle', () => {
    expect(deriveTurnInProgress({ phase: 'streaming', detail: detail([userTurn]), clock: null })).toBeNull();
    expect(deriveTurnInProgress({ phase: 'idle', detail: detail([userTurn]), clock: clock() })).toBeNull();
  });

  it('says sending while our own post is in flight, even for a chat not yet born', () => {
    expect(
      deriveTurnInProgress({ phase: 'posting-root', detail: null, clock: startTurnClock(null, 5) }),
    ).toEqual({ phase: 'sending', chatId: null, messageId: null, startedAt: 5, lastFrameAt: null });
  });

  it('waits until a part arrives, then streams', () => {
    expect(
      deriveTurnInProgress({ phase: 'streaming', detail: detail([userTurn]), clock: clock() })?.phase,
    ).toBe('waiting');

    const withTool = detail([
      userTurn,
      agentTurn([
        { seq: 0, kind: 'tool_call', toolCallId: 't1', name: 'Bash', args: {}, state: 'running' },
      ]),
    ]);
    expect(
      deriveTurnInProgress({
        phase: 'streaming',
        detail: withTool,
        clock: clock({ messageId: AGENT_MSG, lastFrameAt: 2_000 }),
      }),
    ).toEqual({ phase: 'streaming', chatId: CHAT, messageId: AGENT_MSG, startedAt: 1_000, lastFrameAt: 2_000 });
  });

  it('finds the claimed turn by the server marker when the clock names no message yet', () => {
    expect(
      deriveTurnInProgress({
        phase: 'streaming',
        detail: detail([userTurn, agentTurn([], { turnInFlight: true })]),
        clock: clock(),
      }),
    ).toMatchObject({ phase: 'waiting', messageId: AGENT_MSG });
  });

  it('distinguishes stopping, stopped and failed, and freezes the clock on the last two', () => {
    const d = detail([userTurn, agentTurn([{ seq: 0, kind: 'error', message: 'runtime died' }])]);
    expect(deriveTurnInProgress({ phase: 'streaming', detail: d, clock: clock({ stopping: true }) })?.phase)
      .toBe('stopping');
    expect(deriveTurnInProgress({ phase: 'stopped-continuable', detail: d, clock: clock({ endedAt: 9_000 }) }))
      .toMatchObject({ phase: 'stopped', endedAt: 9_000 });
    expect(
      deriveTurnInProgress({
        phase: 'idle',
        detail: d,
        clock: clock({ messageId: AGENT_MSG, error: 'runtime died', endedAt: 9_500 }),
      }),
    ).toMatchObject({ phase: 'failed', error: 'runtime died', endedAt: 9_500 });
  });

  it('never describes another conversation', () => {
    const other = clock({ chatId: '019f0000-0000-7000-8000-0000000003ff' as EntityId });
    expect(deriveTurnInProgress({ phase: 'streaming', detail: detail([userTurn]), clock: other })).toBeNull();
  });
});
