import { describe, expect, it } from 'vitest';

import {
  W2MessageDeliveryAdapter,
  type W2DeliveryAttempt,
  type W2DeliveryBinding,
  type W2DeliveryOutcome,
} from '../src/pty/w2-message-delivery.js';

const IDENTITY: W2DeliveryBinding = {
  deliveryId: 'delivery-1',
  requestId: 'request-1',
  messageId: '11111111-1111-4111-8111-111111111111',
  targetWorkSessionId: '22222222-2222-4222-8222-222222222222',
  reservationVersion: 3,
  expiresAt: '2026-07-26T12:15:00.000Z',
};

function attempt(overrides: Partial<W2DeliveryAttempt> = {}): W2DeliveryAttempt {
  return {
    ...IDENTITY,
    principal: Object.freeze({ opaque: 'minted-by-server' }),
    content: 'stored message body',
    mode: 'send',
    ...overrides,
  };
}

describe('W2.G04 pre-reserved PTY delivery adapter', () => {
  it('rejects ambient/member/teammate-shaped authority before claim or write', async () => {
    const calls: string[] = [];
    const adapter = new W2MessageDeliveryAdapter({
      authorize: () => false,
      claim: async () => {
        calls.push('claim');
        return { state: 'claimed' };
      },
      writeAttempt: async () => {
        calls.push('write');
        return { outcome: 'delivered' };
      },
      settle: async () => calls.push('settle'),
    });

    await expect(adapter.dispatch(attempt({
      principal: { actorId: 'member-1', kind: 'team_member' },
    }))).rejects.toThrow('system delivery principal');
    expect(calls).toEqual([]);
  });

  it('claims durably before the actual write attempt and settles its explicit outcome', async () => {
    const calls: string[] = [];
    const adapter = new W2MessageDeliveryAdapter({
      authorize: (_principal, binding) => {
        expect(binding).toEqual(IDENTITY);
        return true;
      },
      claim: async (binding) => {
        calls.push(`claim:${binding.deliveryId}`);
        return { state: 'claimed' };
      },
      writeAttempt: async (request) => {
        calls.push(`write:${request.targetWorkSessionId}:${request.content}`);
        return { outcome: 'delivered' };
      },
      settle: async (binding, result) => {
        calls.push(`settle:${binding.deliveryId}:${result.outcome}`);
      },
    });

    await expect(adapter.dispatch(attempt())).resolves.toEqual({ outcome: 'delivered' });
    expect(calls).toEqual([
      'claim:delivery-1',
      'write:22222222-2222-4222-8222-222222222222:stored message body',
      'settle:delivery-1:delivered',
    ]);
  });

  it('returns a durable terminal replay without writing or settling again', async () => {
    const terminal: W2DeliveryOutcome = { outcome: 'refused', reason: 'session_not_live' };
    const calls: string[] = [];
    const adapter = new W2MessageDeliveryAdapter({
      authorize: () => true,
      claim: async () => {
        calls.push('claim');
        return { state: 'settled', result: terminal };
      },
      writeAttempt: async () => {
        calls.push('write');
        return { outcome: 'delivered' };
      },
      settle: async () => calls.push('settle'),
    });

    await expect(adapter.dispatch(attempt())).resolves.toEqual(terminal);
    expect(calls).toEqual(['claim']);
  });

  it('joins a concurrent duplicate, performs one write, and rejects changed stable identity', async () => {
    let release!: (value: W2DeliveryOutcome) => void;
    const actualWrite = new Promise<W2DeliveryOutcome>((resolve) => {
      release = resolve;
    });
    let claims = 0;
    let writes = 0;
    let settlements = 0;
    const adapter = new W2MessageDeliveryAdapter({
      authorize: () => true,
      claim: async () => {
        claims += 1;
        return { state: 'claimed' };
      },
      writeAttempt: async () => {
        writes += 1;
        return actualWrite;
      },
      settle: async () => {
        settlements += 1;
      },
    });

    const first = adapter.dispatch(attempt());
    const replay = adapter.dispatch(attempt());
    for (const changed of [
      { requestId: 'changed-request' },
      { messageId: 'changed-message' },
      { targetWorkSessionId: 'changed-target' },
      { reservationVersion: 4 },
      { expiresAt: '2026-07-26T12:16:00.000Z' },
      { content: 'changed-content' },
      { mode: 'paste' as const },
    ]) {
      await expect(adapter.dispatch(attempt(changed)))
        .rejects.toThrow('delivery identity mismatch');
    }
    release({ outcome: 'delivered' });

    await expect(Promise.all([first, replay])).resolves.toEqual([
      { outcome: 'delivered' },
      { outcome: 'delivered' },
    ]);
    expect({ claims, writes, settlements }).toEqual({ claims: 1, writes: 1, settlements: 1 });
  });

  it('settles unknown when the writer throws after claim and never reports false delivery', async () => {
    const settled: W2DeliveryOutcome[] = [];
    const adapter = new W2MessageDeliveryAdapter({
      authorize: () => true,
      claim: async () => ({ state: 'claimed' }),
      writeAttempt: async () => {
        throw new Error('PTY write acknowledgement lost');
      },
      settle: async (_binding, outcome) => {
        settled.push(outcome);
      },
    });

    await expect(adapter.dispatch(attempt())).resolves.toEqual({
      outcome: 'unknown',
      reason: 'write_attempt_failed',
    });
    expect(settled).toEqual([{ outcome: 'unknown', reason: 'write_attempt_failed' }]);
  });
});
