import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { CHAT_HOME_FIXTURE_THREAD } from './fixtures';
import { hasUsage, mergeChatTurnFrame, projectTurnParts } from './turn-model';

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

