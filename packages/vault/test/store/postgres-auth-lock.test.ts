import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scopeOf, testCaller, otherCaller } from '../support/kit.js';
import { PG_ENABLED, PG_REASON, pgHarness, type PgHarness } from './pg-harness.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const key = () => ({ id: randomUUID(), credentialId: randomBytes(32).toString('base64url'), publicKey: randomBytes(64).toString('base64url'), counter: 0, transports: [], backedUp: false, deviceType: 'singleDevice' as const, aaguid: null, name: 'Test key' });
const pendingAfter200ms = (promise: Promise<unknown>): Promise<boolean> => Promise.race([
  promise.then(() => false, () => false),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 200)),
]);

if (!PG_ENABLED) describe('Postgres member-auth transaction locks', () => { it('requires a scratch Postgres', (ctx) => ctx.skip(PG_REASON)); });
else describe('Postgres member-auth transaction locks', () => {
  let h: PgHarness;
  beforeEach(async () => { h = await pgHarness(); });
  afterEach(async () => { await h?.dispose(); });

  it('a second real connection blocks on countActive until a different passkey revocation commits', async () => {
    const a = key(); const b = key();
    await h.store.transaction(scopeOf(testCaller), async (tx) => { await tx.passkeys.create(a); await tx.passkeys.create(b); });
    const entered = deferred(); const release = deferred();
    const first = h.store.transaction(scopeOf(testCaller), async (tx) => {
      expect(await tx.passkeys.countActive()).toBe(2);
      await tx.passkeys.revoke(a.id);
      entered.resolve(); await release.promise;
    });
    await entered.promise;
    const second = h.store.transaction(scopeOf(testCaller), async (tx) => {
      const count = await tx.passkeys.countActive();
      if (count > 1) await tx.passkeys.revoke(b.id);
      return count;
    });
    try {
      expect(await pendingAfter200ms(second)).toBe(true);
      // A different member is independent of the held lock.
      expect(await h.store.transaction(scopeOf(otherCaller), (tx) => tx.passkeys.countActive())).toBe(0);
    } finally { release.resolve(); await first; }
    expect(await second).toBe(1);
    expect(await h.store.transaction(scopeOf(testCaller), (tx) => tx.passkeys.countActive())).toBe(1);
  });

  it('two concurrent first-passkey enrollments serialize the count and create in one transaction', async () => {
    const entered = deferred(); const release = deferred();
    const first = h.store.transaction(scopeOf(testCaller), async (tx) => {
      expect(await tx.passkeys.countActive()).toBe(0);
      await tx.passkeys.create(key());
      entered.resolve(); await release.promise;
    });
    await entered.promise;
    const second = h.store.transaction(scopeOf(testCaller), async (tx) => {
      const count = await tx.passkeys.countActive();
      if (count === 0) await tx.passkeys.create(key());
      return count;
    });
    try { expect(await pendingAfter200ms(second)).toBe(true); }
    finally { release.resolve(); await first; }
    expect(await second).toBe(1);
    expect(await h.store.transaction(scopeOf(testCaller), (tx) => tx.passkeys.countActive())).toBe(1);
  });
});
