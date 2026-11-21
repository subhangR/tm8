import { generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryVaultStore } from '../../src/store/memory.js';
import { AuditCheckpointer } from '../../src/audit/checkpointer.js';
import { AUDIT_GENESIS_HASH, checkpointSigningInput } from '../../src/audit/chain.js';
import { VaultAuditGate, type AuditAnchorFailure, type AuditAnchorOptions } from '../../src/audit/gate.js';
import {
  CheckpointReadError, SYSTEM_ACTOR, type CheckpointSigner, type CheckpointSink, type CheckpointVerifier, type RetainedCheckpoint,
} from '../../src/core-types.js';
import { FixedClock, OWNER_ID, SPACE_A } from '../support/kit.js';

const scope = { kind: 'system', purpose: 'audit' } as const;
const body = (n: number) => ({ action: 'session.signed_in', actor: SYSTEM_ACTOR, itemId: null, subjectMemberId: OWNER_ID, spaceId: SPACE_A, params: { n } });
const append = (store: MemoryVaultStore, n: number) => store.transaction(scope, (tx) => tx.audit.append(body(n)));

/**
 * A retaining sink outside the database, and a synthetic Ed25519 anchor key
 * generated per test. `retained` is what the bucket holds; tests delete from
 * it only to model a sink that lost an object.
 */
function anchorKit() {
  const pair = generateKeyPairSync('ed25519');
  const keyId = 'test-only:anchor-key';
  const retained: RetainedCheckpoint[] = [];
  const failures: AuditAnchorFailure[] = [];
  const faults: { latest: Error | null; verify: Error | null; beforeLatest: (() => Promise<void>) | null } = { latest: null, verify: null, beforeLatest: null };
  const latestCalls: number[] = [];
  const sink: CheckpointSink = {
    kind: 'gcs',
    health: async () => ({ ok: true, retention: 'locked' }),
    put: async (checkpoint) => {
      const location = `test-only://${checkpoint.seq}`;
      retained.push({ ...checkpoint, location });
      return { anchored: true, location };
    },
    latest: async (from = 0) => {
      latestCalls.push(from);
      const hook = faults.beforeLatest;
      faults.beforeLatest = null;
      if (hook) await hook();
      if (faults.latest) throw faults.latest;
      let best: RetainedCheckpoint | null = null;
      for (const checkpoint of retained) if (checkpoint.seq >= from && (!best || checkpoint.seq > best.seq)) best = checkpoint;
      return best ? { ...best } : null;
    },
  };
  const signer: CheckpointSigner = { keyId, sign: async (input) => sign(null, input, pair.privateKey) };
  const verifier: CheckpointVerifier = {
    verify: async (id, input, signature) => {
      if (faults.verify) throw faults.verify;
      return id === keyId && verify(null, input, pair.publicKey, signature);
    },
  };
  return {
    keyId, retained, failures, faults, latestCalls, sink,
    anchor: (budgetMs = 60_000): AuditAnchorOptions => ({ sink, verifier, budgetMs, onFailure: (reason) => { failures.push(reason); } }),
    checkpointer: (store: MemoryVaultStore, clock?: FixedClock) => new AuditCheckpointer({ store, signer, sink, ...(clock ? { clock } : {}) }),
    /** A checkpoint the sink retains but the database never recorded, signed by `key` (the anchor key by default). */
    plant(checkpoint: { seq: number; headHash: string; at: string; keyId?: string }, key: KeyObject = pair.privateKey): RetainedCheckpoint {
      const unsigned = { seq: checkpoint.seq, headHash: checkpoint.headHash, at: checkpoint.at, keyId: checkpoint.keyId ?? keyId };
      const planted = { ...unsigned, signature: sign(null, checkpointSigningInput(unsigned), key).toString('base64url'), location: `test-only://${unsigned.seq}` };
      retained.push(planted);
      return planted;
    },
  };
}

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
  it('finds a changed boundary or a restored head', async () => {
    for (const attack of ['boundary', 'restore']) {
      const store = new MemoryVaultStore(); const backup = store.testing.snapshot();
      for (let n = 0; n < 3; n++) await append(store, n);
      const gate = new VaultAuditGate({ store, pageSize: 2 });
      await gate.verifyAll();
      if (attack === 'boundary') await store.testing.tamperAuditEvent(3, { entryHash: 'a'.repeat(64) });
      if (attack === 'restore') await store.testing.restore(backup);
      expect((await gate.verifyIncremental()).status).toBe('broken');
    }
  });
  it('review F01, the tail probe inverted: a fresh gate finds a deleted tail against the retained anchor', async () => {
    // The database alone cannot tell a deleted tail from a valid shorter chain; the anchor's signed head can.
    const kit = anchorKit(); const store = new MemoryVaultStore();
    for (let n = 0; n < 3; n++) await append(store, n);
    await kit.checkpointer(store).checkpoint();
    await store.testing.deleteAuditEvent(3);
    const gate = new VaultAuditGate({ store, pageSize: 2, anchor: kit.anchor() });
    expect(await gate.verifyAll()).toMatchObject({ status: 'broken', firstBrokenSeq: 3 });
    expect(kit.failures).toEqual(['anchor_rollback']);
    expect(await gate.verifyIncremental()).toMatchObject({ status: 'broken', firstBrokenSeq: 3 });
    expect(() => gate.assertHealthy()).toThrow('audit_unavailable');
    expect(kit.failures).toEqual(['anchor_rollback']);
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

describe('VaultAuditGate with a retained anchor (review F01)', () => {
  it('a database restored to before the newest checkpoint is a rollback, though its own receipts agree', async () => {
    const kit = anchorKit(); const store = new MemoryVaultStore();
    for (let n = 0; n < 2; n++) await append(store, n);
    await kit.checkpointer(store).checkpoint();
    const backup = store.testing.snapshot();
    await append(store, 2);
    await kit.checkpointer(store).checkpoint();
    await store.testing.restore(backup);
    // The restored database is self-consistent: two events and a receipt for seq 2. Only the sink knows seq 3.
    const gate = new VaultAuditGate({ store, anchor: kit.anchor() });
    expect(await gate.verifyAll()).toMatchObject({ status: 'broken', firstBrokenSeq: 3 });
    expect(kit.failures).toEqual(['anchor_rollback']);
    // Sticky: the gate does not read the sink again and does not clear.
    const reads = kit.latestCalls.length;
    expect((await gate.verifyIncremental()).status).toBe('broken');
    expect(kit.latestCalls).toHaveLength(reads);
    expect(gate.status()).toBe('unavailable');
  });

  it.each([1, 3])('a chain that forks from the retained signed head is a conflict (%s rewritten events)', async (rewritten) => {
    const kit = anchorKit(); const store = new MemoryVaultStore();
    for (let n = 0; n < 2; n++) await append(store, n);
    const backup = store.testing.snapshot();
    await append(store, 2);
    await kit.checkpointer(store).checkpoint();
    await store.testing.restore(backup);
    // A valid chain of its own, hashes recomputed: it only disagrees with the anchor.
    for (let n = 0; n < rewritten; n++) await append(store, 100 + n);
    const gate = new VaultAuditGate({ store, anchor: kit.anchor() });
    expect(await gate.verifyAll()).toMatchObject({ status: 'broken', firstBrokenSeq: 3 });
    expect(kit.failures).toEqual(['anchor_conflict']);
  });

  it('a retained genesis head must be the genesis hash', async () => {
    const kit = anchorKit(); const store = new MemoryVaultStore();
    await kit.checkpointer(store).checkpoint();
    expect(kit.retained[0]).toMatchObject({ seq: 0, headHash: AUDIT_GENESIS_HASH });
    expect((await new VaultAuditGate({ store, anchor: kit.anchor() }).verifyAll()).status).toBe('verified');
    const forged = anchorKit();
    forged.plant({ seq: 0, headHash: 'c'.repeat(64), at: new FixedClock().iso() });
    expect(await new VaultAuditGate({ store, anchor: forged.anchor() }).verifyAll()).toMatchObject({ status: 'broken', firstBrokenSeq: 1 });
    expect(forged.failures).toEqual(['anchor_conflict']);
  });

  it('a checkpoint the database recorded as anchored must still be retained', async () => {
    const kit = anchorKit(); const store = new MemoryVaultStore();
    await append(store, 0);
    await kit.checkpointer(store).checkpoint();
    kit.retained.splice(0);
    const gate = new VaultAuditGate({ store, anchor: kit.anchor() });
    expect(await gate.verifyAll()).toMatchObject({ status: 'broken', firstBrokenSeq: 1 });
    expect(kit.failures).toEqual(['anchor_missing']);
    expect(kit.latestCalls).toEqual([1]);
  });

  it('a head this gate saw retained must stay retained, even after the database loses its receipt', async () => {
    const kit = anchorKit(); const store = new MemoryVaultStore();
    await append(store, 0);
    const backup = store.testing.snapshot();
    await kit.checkpointer(store).checkpoint();
    const gate = new VaultAuditGate({ store, anchor: kit.anchor() });
    expect((await gate.verifyIncremental()).status).toBe('verified');
    await store.testing.restore(backup);
    kit.retained.splice(0);
    expect(await gate.verifyIncremental()).toMatchObject({ status: 'broken', firstBrokenSeq: 1 });
    expect(kit.failures).toEqual(['anchor_missing']);
  });

  it('a receipt from another sink kind, or one that was never anchored, is no hint', async () => {
    const kit = anchorKit(); const store = new MemoryVaultStore();
    const event = await append(store, 0);
    for (const receipt of [{ sink: 'file' as const, anchored: true, location: '/test-only/1' }, { sink: 'off' as const, anchored: false, location: null }]) {
      await store.transaction(scope, (tx) => tx.audit.recordCheckpoint({ seq: 1, headHash: event.entryHash, at: event.at, keyId: kit.keyId, signature: 'AA', ...receipt }));
      expect((await new VaultAuditGate({ store, anchor: kit.anchor() }).verifyAll()).status).toBe('verified');
    }
    expect(kit.latestCalls).toEqual([0, 0]);
    expect(kit.failures).toEqual([]);
  });

  it('a retained checkpoint whose signature does not verify is invalid evidence', async () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    const cases: { name: string; plant: (kit: ReturnType<typeof anchorKit>, event: { entryHash: string; at: string }) => void }[] = [
      { name: 'another key under the anchor key id', plant: (kit, event) => { kit.plant({ seq: 1, headHash: event.entryHash, at: event.at }, other); } },
      { name: 'a key id the verifier does not vouch for', plant: (kit, event) => { kit.plant({ seq: 1, headHash: event.entryHash, at: event.at, keyId: 'test-only:other-key' }, other); } },
      { name: 'a signature over other bytes', plant: (kit, event) => { kit.plant({ seq: 1, headHash: event.entryHash, at: event.at }).at = new FixedClock().iso(60_000); } },
      { name: 'an unsignable body', plant: (kit, event) => { kit.retained.push({ seq: 1, headHash: 'Z'.repeat(64), at: event.at, keyId: kit.keyId, signature: 'AA', location: 'test-only://1' }); } },
    ];
    for (const { name, plant } of cases) {
      const kit = anchorKit(); const store = new MemoryVaultStore({ clock: new FixedClock() });
      plant(kit, await append(store, 0));
      const gate = new VaultAuditGate({ store, anchor: kit.anchor() });
      expect(await gate.verifyAll(), name).toMatchObject({ status: 'broken', firstBrokenSeq: 1 });
      expect(kit.failures, name).toEqual(['anchor_invalid']);
      expect((await gate.verifyAll()).status, name).toBe('broken');
    }
  });

  it.each([['conflict', 'anchor_conflict'], ['invalid', 'anchor_invalid']] as const)('a sink reporting %s trips the gate for good', async (code, reason) => {
    const kit = anchorKit(); const store = new MemoryVaultStore();
    await append(store, 0);
    kit.faults.latest = new CheckpointReadError(code);
    const gate = new VaultAuditGate({ store, anchor: kit.anchor() });
    expect(await gate.verifyIncremental()).toMatchObject({ status: 'broken', firstBrokenSeq: 1 });
    kit.faults.latest = null;
    expect((await gate.verifyAll()).status).toBe('broken');
    expect(kit.failures).toEqual([reason]);
  });

  it('an anchor outage is transient, has no cooldown, and fails closed only past the budget', async () => {
    const clock = new FixedClock(); const store = new MemoryVaultStore({ clock }); const kit = anchorKit();
    const gate = new VaultAuditGate({ store, clock, anchor: kit.anchor(1_000) });
    // Before any anchored verification nothing is served, so an outage at startup refuses to start.
    expect(gate.status()).toBe('unavailable');
    kit.faults.latest = new CheckpointReadError('unavailable');
    expect((await gate.verifyAll()).status).toBe('unverified');
    expect(gate.status()).toBe('unavailable');
    expect(kit.failures).toEqual(['anchor_unavailable', 'anchor_stale']);
    kit.faults.latest = null;
    await append(store, 0);
    await kit.checkpointer(store, clock).checkpoint();
    expect((await gate.verifyAll()).status).toBe('verified');
    expect(gate.status()).toBe('ok');
    kit.failures.splice(0);
    for (const [where, fault] of [
      ['latest', new CheckpointReadError('unavailable')], ['latest', new Error('test-only outage')], ['verify', new CheckpointReadError('unavailable')],
    ] as const) {
      kit.faults[where] = fault;
      expect((await gate.verifyIncremental()).status).toBe('unverified');
      // Not an append failure: no cooldown, and audited actions continue within the budget.
      expect(gate.status()).toBe('ok');
      kit.faults[where] = null;
    }
    expect(kit.failures).toEqual(['anchor_unavailable', 'anchor_unavailable', 'anchor_unavailable']);
    kit.failures.splice(0);
    kit.faults.latest = new CheckpointReadError('unavailable');
    clock.advance(1_000);
    expect(gate.status()).toBe('ok');
    clock.advance(1);
    expect(gate.status()).toBe('unavailable');
    expect(() => gate.assertHealthy()).toThrow('audit_unavailable');
    expect((await gate.verifyIncremental()).status).toBe('unverified');
    expect(kit.failures).toEqual(['anchor_unavailable', 'anchor_stale']);
    kit.faults.latest = null;
    expect((await gate.verifyIncremental()).status).toBe('verified');
    expect(gate.status()).toBe('ok');
  });

  it('an event left unanchored past the budget fails closed until a checkpoint covers it', async () => {
    const clock = new FixedClock(); const store = new MemoryVaultStore({ clock }); const kit = anchorKit();
    const gate = new VaultAuditGate({ store, clock, anchor: kit.anchor(1_000) });
    expect((await gate.verifyAll()).status).toBe('verified');
    await append(store, 0);
    clock.advance(600);
    expect((await gate.verifyIncremental()).status).toBe('verified');
    expect(gate.status()).toBe('ok');
    // The event is now 1,001 ms old, the last anchored check only 401 ms.
    clock.advance(401);
    expect(gate.status()).toBe('unavailable');
    expect(() => gate.assertHealthy()).toThrow('audit_unavailable');
    // The chain itself is intact, so it still verifies; the stale anchor is reported, not hidden.
    expect((await gate.verifyIncremental()).status).toBe('verified');
    expect(gate.status()).toBe('unavailable');
    expect(kit.failures).toEqual(['anchor_stale']);
    await kit.checkpointer(store, clock).checkpoint();
    expect((await gate.verifyIncremental()).status).toBe('verified');
    expect(gate.status()).toBe('ok');
    expect(kit.failures).toEqual(['anchor_stale']);
  });

  it('no anchored verification for longer than the budget fails closed until the next one', async () => {
    const clock = new FixedClock(); const store = new MemoryVaultStore({ clock }); const kit = anchorKit();
    const gate = new VaultAuditGate({ store, clock, anchor: kit.anchor(1_000) });
    expect((await gate.verifyAll()).status).toBe('verified');
    clock.advance(1_000);
    expect(gate.status()).toBe('ok');
    clock.advance(1);
    expect(gate.status()).toBe('unavailable');
    expect((await gate.verifyIncremental()).status).toBe('verified');
    expect(gate.status()).toBe('ok');
    expect(kit.failures).toEqual([]);
  });

  it('a checkpoint that lands while the gate reads the anchor is never a rollback', async () => {
    const kit = anchorKit(); const store = new MemoryVaultStore();
    await append(store, 0);
    await kit.checkpointer(store).checkpoint();
    kit.faults.beforeLatest = async () => { await append(store, 1); await kit.checkpointer(store).checkpoint(); };
    const gate = new VaultAuditGate({ store, anchor: kit.anchor() });
    expect(await gate.verifyAll()).toMatchObject({ status: 'verified', checkedThroughSeq: 2 });
    expect(kit.retained.map((checkpoint) => checkpoint.seq)).toEqual([1, 2]);
    expect(kit.failures).toEqual([]);
  });

  it('review addendum 2, C2: a flood of requests waits behind at most one walk of each kind, each begun after it was asked', async () => {
    const kit = anchorKit(); const store = new MemoryVaultStore();
    for (let n = 0; n < 3; n += 1) await append(store, n);
    await kit.checkpointer(store).checkpoint();
    const gate = new VaultAuditGate({ store, anchor: kit.anchor() });
    let release!: () => void;
    kit.faults.beforeLatest = () => new Promise<void>((resolve) => { release = resolve; });
    const first = gate.verifyIncremental();
    while (kit.latestCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    // The first walk has started, so nothing that asks from now on may share it.
    const flood = [
      ...Array.from({ length: 10 }, () => gate.verifyIncremental()),
      ...Array.from({ length: 10 }, () => gate.verifyAll()),
      ...Array.from({ length: 10 }, () => gate.verifyIncremental()),
    ];
    // The next walk to start appends an event before it reads the chain.
    kit.faults.beforeLatest = async () => { await append(store, 3); };
    release();
    const [head, ...rest] = await Promise.all([first, ...flood]);
    expect(head).toMatchObject({ status: 'verified', checkedThroughSeq: 3 });
    for (const verification of rest) expect(verification).toMatchObject({ status: 'verified', checkedThroughSeq: 4 });
    // One incremental and one full walk served all thirty, and each caller has its own result.
    expect(kit.latestCalls).toHaveLength(3);
    expect(new Set(rest).size).toBe(rest.length);
    // Nothing stays queued: the next request walks again.
    expect(await gate.verifyIncremental()).toMatchObject({ status: 'verified', checkedThroughSeq: 4 });
    expect(kit.latestCalls).toHaveLength(4);
    expect(kit.failures).toEqual([]);
  });

  it('refuses an anchor budget that is not a positive integer; a failing log cannot change an outcome', async () => {
    const kit = anchorKit(); const store = new MemoryVaultStore();
    for (const budgetMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new VaultAuditGate({ store, anchor: { ...kit.anchor(), budgetMs } })).toThrow('vault audit: invalid configuration');
    }
    const event = await append(store, 0);
    kit.plant({ seq: 2, headHash: 'b'.repeat(64), at: event.at });
    const gate = new VaultAuditGate({ store, anchor: { ...kit.anchor(), onFailure: () => { throw new Error('test-only log failure'); } } });
    expect(await gate.verifyAll()).toMatchObject({ status: 'broken', firstBrokenSeq: 2 });
    expect(gate.status()).toBe('unavailable');
  });
});
