import { describe, expect, it } from 'vitest';

import { PromptSettlementWaiter } from '../src/pty/PromptSettlementWaiter.js';

describe('PromptSettlementWaiter', () => {
  it('resolves an awaitOutcome registered before resolve() fires', async () => {
    const waiter = new PromptSettlementWaiter();
    const promise = waiter.awaitOutcome('d1');
    waiter.resolve('session-1', 'd1', 'delivered');
    await expect(promise).resolves.toEqual({ outcome: 'delivered', reason: undefined });
  });

  it('carries the reason through for an unknown outcome', async () => {
    const waiter = new PromptSettlementWaiter();
    const promise = waiter.awaitOutcome('d2');
    waiter.resolve('session-1', 'd2', 'unknown', 'submit_unverified');
    await expect(promise).resolves.toEqual({ outcome: 'unknown', reason: 'submit_unverified' });
  });

  it('is safe against a same-tick resolve that fires before the promise executor even runs a microtask — registering first is what makes this safe', async () => {
    const waiter = new PromptSettlementWaiter();
    // Simulates the documented pathological ordering hazard: resolve() called
    // SYNCHRONOUSLY, in the same call stack as registration, exactly as the
    // pure-control-chars edge case in writePromptToEntry can.
    const promise = waiter.awaitOutcome('d3');
    waiter.resolve('session-1', 'd3', 'delivered');
    await expect(promise).resolves.toEqual({ outcome: 'delivered', reason: undefined });
  });

  it('never resolves a wait that was never registered — resolve() is a silent no-op', () => {
    const waiter = new PromptSettlementWaiter();
    // No awaitOutcome call for 'ghost' — must not throw.
    expect(() => waiter.resolve('session-1', 'ghost', 'delivered')).not.toThrow();
  });

  it('cancel() lets a rejected-admission wait be abandoned without leaking', async () => {
    const waiter = new PromptSettlementWaiter();
    const promise = waiter.awaitOutcome('d4');
    waiter.cancel('d4');
    // A late resolve() for a cancelled id is a no-op (not an error, not a
    // resurrection of the promise).
    waiter.resolve('session-1', 'd4', 'delivered');
    // The promise itself is simply never settled — assert that by racing it
    // against a resolved sentinel; if `resolve` had resurrected it, the
    // awaited value would be the delivered outcome instead of the sentinel.
    const race = await Promise.race([promise, Promise.resolve('SENTINEL_STILL_PENDING' as const)]);
    expect(race).toBe('SENTINEL_STILL_PENDING');
  });

  it('cancel() after an already-resolved wait is a harmless no-op', async () => {
    const waiter = new PromptSettlementWaiter();
    const promise = waiter.awaitOutcome('d5');
    waiter.resolve('session-1', 'd5', 'delivered');
    expect(() => waiter.cancel('d5')).not.toThrow();
    await expect(promise).resolves.toEqual({ outcome: 'delivered', reason: undefined });
  });

  it('keeps concurrent deliveryIds fully independent', async () => {
    const waiter = new PromptSettlementWaiter();
    const pA = waiter.awaitOutcome('a');
    const pB = waiter.awaitOutcome('b');
    waiter.resolve('session-1', 'b', 'unknown', 'session_replaced_or_exited');
    waiter.resolve('session-1', 'a', 'delivered');
    await expect(pA).resolves.toEqual({ outcome: 'delivered', reason: undefined });
    await expect(pB).resolves.toEqual({ outcome: 'unknown', reason: 'session_replaced_or_exited' });
  });

  it('resolving the same deliveryId twice only honors the first (second is a no-op)', async () => {
    const waiter = new PromptSettlementWaiter();
    const promise = waiter.awaitOutcome('d6');
    waiter.resolve('session-1', 'd6', 'unknown', 'submit_unverified');
    expect(() => waiter.resolve('session-1', 'd6', 'delivered')).not.toThrow();
    await expect(promise).resolves.toEqual({ outcome: 'unknown', reason: 'submit_unverified' });
  });
});
