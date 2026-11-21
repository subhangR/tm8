import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreUnavailableError, actorOf } from '../../src/core-types.js';
import { PgVaultStore } from '../../src/store/pg.js';
import { fakeSecret, newLogin, otherCaller, scopeOf, testCaller } from '../support/kit.js';
import { PG_ENABLED, PG_REASON, pgHarness, type PgHarness } from './pg-harness.js';

if (!PG_ENABLED) describe('Postgres transaction failure handling', () => { it('requires a scratch Postgres', (ctx) => ctx.skip(PG_REASON)); });
else describe('Postgres transaction failure handling', () => {
  let h: PgHarness;
  beforeEach(async () => { h = await pgHarness(); });
  afterEach(async () => { await h?.dispose(); });
  const event = () => ({ action: 'session.signed_in', actor: actorOf(testCaller), itemId: null, subjectMemberId: testCaller.memberId, spaceId: testCaller.spaceId, params: {} });

  it('maps 40P01 and 40001 during audit to StoreUnavailableError, with nothing committed', async () => {
    for (const code of ['40P01', '40001']) {
      await h.admin.query(`create or replace function vault.test_abort() returns trigger language plpgsql as $body$ begin raise exception 'test transaction abort' using errcode = '${code}'; end $body$`);
      await h.admin.query('create trigger audit_test_abort before insert on vault.audit_events for each row execute function vault.test_abort()');
      const draft = newLogin();
      try {
        await expect(h.store.transaction(scopeOf(testCaller), async (tx) => {
          await tx.items.create(draft, fakeSecret());
          await expect(tx.audit.append(event())).rejects.toBeInstanceOf(StoreUnavailableError);
          await expect(tx.items.get(draft.id)).rejects.toBeInstanceOf(StoreUnavailableError);
          return 'caught';
        })).rejects.toBeInstanceOf(StoreUnavailableError);
      } finally { await h.admin.query('drop trigger audit_test_abort on vault.audit_events'); }
      expect(await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.get(draft.id))).toBeNull();
    }
  });

  it('permits held locks and read-only lookups after append, and refuses new advisory keys', async () => {
    await h.store.transaction(scopeOf(testCaller), async (tx) => {
      await tx.passkeys.countActive();
      const item = await tx.items.create(newLogin(), fakeSecret());
      await tx.audit.append(event());
      expect(await tx.passkeys.countActive()).toBe(0);
      expect((await tx.items.get(item.id))?.id).toBe(item.id);
    });
    const draft = newLogin();
    await expect(h.store.transaction(scopeOf(testCaller), async (tx) => {
      await tx.items.create(draft, fakeSecret());
      await tx.audit.append(event());
      await expect(tx.passkeys.countActive()).rejects.toBeInstanceOf(StoreUnavailableError);
      return 'caught';
    })).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.get(draft.id))).toBeNull();
  });

  it('enforces the broker role by default even with a migration login, and validates a bad clock before SQL', async () => {
    const item = await h.store.transaction(scopeOf(testCaller), (tx) => tx.items.create(newLogin(), fakeSecret()));
    const store = new PgVaultStore({ connectionString: h.url, clock: h.clock });
    try { expect(await store.transaction(scopeOf(otherCaller), (tx) => tx.items.get(item.id))).toBeNull(); }
    finally { await store.close(); }
    const badClock = new PgVaultStore({ connectionString: h.url, clock: { now: () => new Date(Number.NaN) } });
    try { await expect(badClock.transaction(scopeOf(testCaller), async () => true)).rejects.toBeInstanceOf(TypeError); }
    finally { await badClock.close(); }
  });
});
