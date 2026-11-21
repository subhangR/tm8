import { describe, expect, it } from 'vitest';
import { MemoryVaultStore, type MemoryStoreSnapshot } from '../../src/index.js';
import { FixedClock, T0, fakeSecret, newLogin, scopeOf, testCaller } from '../support/kit.js';
import { describeStoreConformance, type StoreHarness } from '../support/store-conformance.js';

function memoryHarness(): StoreHarness {
  const clock = new FixedClock(T0);
  const store = new MemoryVaultStore({ clock });
  return {
    store,
    clock,
    hooks: {
      setUnavailable: (on) => { store.faults.unavailable = on; },
      setAuditAppendFailure: (on) => { store.faults.auditAppend = on; },
      tamperAuditEvent: (seq, patch) => store.testing.tamperAuditEvent(seq, patch),
      deleteAuditEvent: (seq) => store.testing.deleteAuditEvent(seq),
      snapshot: async () => store.testing.snapshot(),
      restore: (snapshot) => store.testing.restore(snapshot as MemoryStoreSnapshot),
      secretVersionCount: async (itemId) => store.testing.secretVersionCount(itemId),
    },
    dispose: () => store.close(),
  };
}

describeStoreConformance('memory', async () => memoryHarness());

describe('MemoryVaultStore only', () => {
  it('refuses a nested transaction instead of deadlocking on its own mutex', async () => {
    const { store } = memoryHarness();
    await expect(store.transaction(scopeOf(testCaller), () => store.transaction(scopeOf(testCaller), async () => 1)))
      .rejects.toThrow('nested transaction');
  });

  it('a repo handle used after its transaction settled throws', async () => {
    const { store } = memoryHarness();
    const leaked = await store.transaction(scopeOf(testCaller), async (tx) => tx);
    await expect(leaked.items.create(newLogin(), fakeSecret())).rejects.toThrow('the transaction has ended');
  });

  it('transactions run one at a time, in arrival order', async () => {
    const { store } = memoryHarness();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = store.transaction(scopeOf(testCaller), async () => { order.push('first:start'); await gate; order.push('first:end'); });
    const second = store.transaction(scopeOf(testCaller), async () => { order.push('second'); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['first:start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('a closed store is unhealthy and refuses new transactions', async () => {
    const { store } = memoryHarness();
    await store.close();
    expect(await store.health()).toEqual({ ok: false });
    await expect(store.transaction(scopeOf(testCaller), async () => 1)).rejects.toMatchObject({ name: 'StoreUnavailableError' });
  });
});
