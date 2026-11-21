import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryVaultStore } from '../../src/store/memory.js';
import { VaultAuditGate } from '../../src/audit/gate.js';
import { SYSTEM_ACTOR } from '../../src/core-types.js';
import { FixedClock, OWNER_ID, SPACE_A } from '../support/kit.js';

const scope = { kind: 'system', purpose: 'audit' } as const;
const body = (n: number) => ({ action: 'session.signed_in', actor: SYSTEM_ACTOR, itemId: null, subjectMemberId: OWNER_ID, spaceId: SPACE_A, params: { n } });

describe('VaultAuditGate', () => {
  it('walks pages, verifies suffixes, and pins an empty or nonempty head', async () => {
    const store = new MemoryVaultStore();
    const gate = new VaultAuditGate({ store, pageSize: 2 });
    expect(await gate.verifyAll()).toMatchObject({ status: 'verified', checkedThroughSeq: 0 });
    for (let n = 0; n < 5; n++) await store.transaction(scope, (tx) => tx.audit.append(body(n)));
    expect(await gate.verifyAll()).toMatchObject({ status: 'verified', checkedThroughSeq: 5 });
    await store.transaction(scope, (tx) => tx.audit.append(body(6)));
    expect(await gate.verifyIncremental()).toMatchObject({ status: 'verified', checkedThroughSeq: 6 });
    expect(gate.status()).toBe('ok');
  });
  it('an append outage has a clocked cooldown; a chain break never clears', async () => {
    const clock = new FixedClock(); const store = new MemoryVaultStore({ clock });
    const gate = new VaultAuditGate({ store, clock, cooldownMs: 100 });
    gate.reportAppendFailure();
    expect(() => gate.assertHealthy()).toThrow('audit_unavailable');
    clock.advance(99); expect(gate.status()).toBe('unavailable');
    clock.advance(1); expect(() => gate.assertHealthy()).not.toThrow();
    for (let n = 0; n < 4; n++) await store.transaction(scope, (tx) => tx.audit.append(body(n)));
    await store.testing.tamperAuditEvent(3, { params: { n: 9 } });
    expect(await gate.verifyAll()).toMatchObject({ status: 'broken', firstBrokenSeq: 3, checkedThroughSeq: 2 });
    clock.advance(1_000_000);
    expect(await gate.verifyIncremental()).toMatchObject({ status: 'broken', firstBrokenSeq: 3 });
    expect(() => gate.assertHealthy()).toThrow('audit_unavailable');
  });
  it('finds a missing tail, changed boundary, or restored head', async () => {
    for (const attack of ['tail','boundary','restore']) {
      const store = new MemoryVaultStore(); const backup = store.testing.snapshot();
      for (let n = 0; n < 3; n++) await store.transaction(scope, (tx) => tx.audit.append(body(n)));
      const gate = new VaultAuditGate({ store, pageSize: 2 });
      if (attack !== 'tail') await gate.verifyAll();
      if (attack === 'tail') await store.testing.deleteAuditEvent(3);
      if (attack === 'boundary') await store.testing.tamperAuditEvent(3, { entryHash: 'a'.repeat(64) });
      if (attack === 'restore') await store.testing.restore(backup);
      // Memory's head is the last remaining event; a tail deletion needs an
      // external checkpoint to distinguish it from a valid shorter chain.
      if (attack === 'tail') {
        const gate2 = new VaultAuditGate({ store });
        expect((await gate2.verifyAll()).status).toBe('verified');
      } else expect((await gate.verifyIncremental()).status).toBe('broken');
    }
  });
  it('reports unverified on database failure and disables explicitly', async () => {
    const store = new MemoryVaultStore(); const gate = new VaultAuditGate({ store });
    store.faults.unavailable = true;
    expect((await gate.verifyAll()).status).toBe('unverified');
    expect(gate.status()).toBe('unavailable');
    const disabled = new VaultAuditGate({ store, enabled: false });
    expect(disabled.status()).toBe('disabled');
    expect(() => disabled.assertHealthy()).toThrow('audit_unavailable');
    expect((await disabled.verifyAll()).status).toBe('unverified');
  });
  it('detects an anchored checkpoint from before a database restore', async () => {
    const store = new MemoryVaultStore();
    const event = await store.transaction(scope, (tx) => tx.audit.append(body(1)));
    await store.transaction(scope, (tx) => tx.audit.recordCheckpoint({ seq: event.seq, headHash: event.entryHash, at: event.at, sink: 'file', anchored: true, location: '/test/' + randomUUID(), keyId: 'local-dev:test', signature: 'AA' }));
    await store.testing.tamperAuditEvent(1, { entryHash: 'f'.repeat(64) });
    expect(await new VaultAuditGate({ store }).verifyAll()).toMatchObject({ status: 'broken', firstBrokenSeq: 1 });
  });
});
