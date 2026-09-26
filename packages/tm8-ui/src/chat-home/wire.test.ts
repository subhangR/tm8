import { describe, expect, it } from 'vitest';
import type { MessagePart } from '@tm8/contract';
import { chatTurnFrameFromWire, turnPartFromMessagePart } from './wire';

/**
 * THE TERMINAL DONE PART KEEPS ITS REASON ACROSS THE WIRE.
 *
 * HINGES ON: `turnItemFromMessagePart`'s `done` arm carrying `payload.reason`.
 * `turnFailureOf` decides a failed turn from that reason. The screen tests
 * inject frames that are already render-shaped, so dropping it here would
 * leave them green while every live turn fell back to error-part detection.
 */
describe('turnItemFromMessagePart: the done reason', () => {
  const done = (reason: 'success' | 'error'): MessagePart => ({
    seq: 3,
    kind: 'done',
    payload: { reason },
    createdAt: '2026-09-26T08:00:00.000Z',
  });

  it('survives the live frame path', () => {
    const frame = chatTurnFrameFromWire({
      type: 'chat.turn.delta',
      chatId: 'chat',
      messageId: 'message',
      seq: 3,
      part: done('error'),
    });
    expect(frame).toMatchObject({ type: 'chat.turn.delta', part: { kind: 'done', reason: 'error' } });
  });

  it('survives the read path', () => {
    expect(turnPartFromMessagePart(done('success'))).toEqual({ kind: 'done', reason: 'success', seq: 3 });
  });
});
