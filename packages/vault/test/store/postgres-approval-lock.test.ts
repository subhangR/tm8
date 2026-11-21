import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeSecret, newApproval, newLogin, scopeOf, testCaller } from '../support/kit.js';
import { PG_ENABLED, PG_REASON, pgHarness, type PgHarness } from './pg-harness.js';

if (!PG_ENABLED) describe('Postgres approval discovery locks', () => { it('requires a scratch Postgres', (ctx) => ctx.skip(PG_REASON)); });
else describe('Postgres approval discovery locks', () => {
  let h: PgHarness;
  beforeEach(async () => { h = await pgHarness(); });
  afterEach(async () => { await h?.dispose(); });

  it('the second connection blocks at item discovery and reuses the first pending approval', async () => {
    const item = await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.create(newLogin(), fakeSecret()));
    let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const firstDraft = newApproval(item.id, testCaller, h.clock, { kind: 'new_origin', boundParams: { itemId: item.id, origin: 'https://test.example', expiresAt: h.clock.iso(10_000) } });
    const first = h.store.transaction(scopeOf(testCaller), async (tx) => {
      expect((await tx.approvals.list({ itemId: item.id })).rows).toEqual([]);
      expect(await tx.approvals.findPending(item.id, firstDraft.kind, firstDraft.intentHash)).toBeNull();
      const created = await tx.approvals.create(firstDraft);
      entered(); await hold;
      return created;
    });
    await ready;
    // Different expiry binds a different hash; discovery must still reuse the
    // committed first row, rather than fanning out based only on that hash.
    const secondDraft = newApproval(item.id, testCaller, h.clock, { id: randomUUID(), kind: 'new_origin', boundParams: { itemId: item.id, origin: 'https://test.example', expiresAt: h.clock.iso(20_000) } });
    expect(secondDraft.intentHash).not.toBe(firstDraft.intentHash);
    const second = h.store.transaction(scopeOf(testCaller), async (tx) => {
      const rows = (await tx.approvals.list({ itemId: item.id })).rows;
      const matchingHash = await tx.approvals.findPending(item.id, secondDraft.kind, secondDraft.intentHash);
      return { rows, approval: rows.find((row) => row.state === 'pending') ?? matchingHash ?? await tx.approvals.create(secondDraft) };
    });
    try {
      expect(await Promise.race([second.then(() => 'finished'), new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 200))])).toBe('pending');
    } finally { release(); await first; }
    const result = await second;
    expect(result.rows.map((row) => row.id)).toEqual([firstDraft.id]);
    expect(result.approval.id).toBe(firstDraft.id);
    expect(await h.store.transaction(scopeOf(testCaller), (tx) => tx.approvals.countPending(item.id))).toBe(1);
  });
});
