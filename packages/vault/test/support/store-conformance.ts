/**
 * The VaultStore conformance suite: the rules in core-types.ts, as tests.
 * Every store runs ALL of it: `test/store/memory.test.ts` runs it against the
 * memory store, and the Postgres store (F) runs the same suite against a real
 * database. A rule the two stores disagree on is a bug in one of them.
 *
 * A harness may leave a hook out (a fault it cannot inject); the tests that
 * need it are then skipped, never weakened. The store must take the harness
 * clock: `tx.now`, lazy expiry and audit `at` all come from it.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import {
  AUDIT_GENESIS_HASH,
  AuditUnavailableError,
  SYSTEM_ACTOR,
  StoreDuplicateError,
  StoreNotFoundError,
  StoreScopeError,
  StoreUnavailableError,
  StoreVersionConflictError,
  actorOf,
  verifyAuditRun,
  type AuditBody,
  type AuditEventRecord,
  type GrantRecord,
  type ItemRecord,
  type VaultCaller,
  type VaultStore,
  type VaultTx,
} from '../../src/index.js';
import {
  FixedClock,
  MEMBER_ID,
  MINUTE,
  MemoryDeletionLedger,
  OWNER_ID,
  SPACE_A,
  SPACE_B,
  SYSTEM_SCOPES,
  agentOf,
  fakeArgon2idHash,
  fakeSecret,
  makeCaller,
  newApiKey,
  newApproval,
  newLogin,
  otherCaller,
  outsiderCaller,
  scopeOf,
  sha256hex,
  testCaller,
  tokenPair,
} from './kit.js';

export interface StoreHarness {
  readonly store: VaultStore;
  readonly clock: FixedClock;
  readonly hooks: {
    /** Every later call fails as if the database went away. */
    setUnavailable?(on: boolean): void;
    /** Every later audit append fails. */
    setAuditAppendFailure?(on: boolean): void;
    /** Edit a stored event behind the chain's back. */
    tamperAuditEvent?(seq: number, patch: Partial<AuditEventRecord>): Promise<void>;
    deleteAuditEvent?(seq: number): Promise<void>;
    /** A database backup and restore (test 17). */
    snapshot?(): Promise<unknown>;
    restore?(snapshot: unknown): Promise<void>;
    /** Stored secret versions for an item, whatever its state. */
    secretVersionCount?(itemId: string): Promise<number>;
  };
  dispose(): Promise<void>;
}

const OPEN_CONSTRAINTS = { origins: null, hosts: null, requireApprovalPerUse: false };
const notFound = StoreNotFoundError;
const state = (value: string) => ({ name: 'StoreStateError', state: value });

export function describeStoreConformance(name: string, makeHarness: () => Promise<StoreHarness>): void {
  describe(`VaultStore conformance: ${name}`, () => {
    let h: StoreHarness;
    beforeEach(async () => { h = await makeHarness(); });
    afterEach(async () => { await h.dispose(); });

    const as = <T>(caller: VaultCaller, fn: (tx: VaultTx) => Promise<T>): Promise<T> => h.store.transaction(scopeOf(caller), fn);
    const sys = <T>(purpose: keyof typeof SYSTEM_SCOPES, fn: (tx: VaultTx) => Promise<T>): Promise<T> =>
      h.store.transaction(SYSTEM_SCOPES[purpose], fn);
    const seed = (item = newLogin()): Promise<ItemRecord> => as(testCaller, (tx) => tx.items.create(item, fakeSecret()));
    const share = (itemId: string, kind: 'member' | 'space' = 'member', extra: Partial<{ expiresAt: string | null; granteeId: string }> = {}): Promise<GrantRecord> =>
      as(testCaller, (tx) => tx.grants.create({
        id: randomUUID(), itemId, granteeKind: kind, granteeId: extra.granteeId ?? (kind === 'member' ? MEMBER_ID : SPACE_A),
        constraints: OPEN_CONSTRAINTS, expiresAt: extra.expiresAt ?? null, createdBy: actorOf(testCaller),
      }));
    const event = (caller: VaultCaller, action: string, itemId: string | null = null, params: AuditBody['params'] = {}): AuditBody => ({
      action, actor: actorOf(caller), itemId, subjectMemberId: caller.memberId, spaceId: caller.spaceId, params,
    });
    const third = makeCaller({ memberId: randomUUID(), name: 'Third member', isSpaceAdmin: false });

    // -----------------------------------------------------------------------
    describe('scope and visibility', () => {
      it('shows an item to its owner only, and answers a stranger exactly as for a missing row', async () => {
        const item = await seed();
        expect((await as(testCaller, (tx) => tx.items.get(item.id)))?.id).toBe(item.id);
        for (const stranger of [otherCaller, outsiderCaller]) {
          expect(await as(stranger, (tx) => tx.items.get(item.id))).toBeNull();
          expect(await as(stranger, (tx) => tx.items.get(randomUUID()))).toBeNull();
          expect((await as(stranger, (tx) => tx.items.list({}))).rows).toEqual([]);
          expect(await as(stranger, (tx) => tx.items.currentSecret(item.id))).toBeNull();
          expect(await as(stranger, (tx) => tx.policies.get(item.id))).toBeNull();
          await expect(as(stranger, (tx) => tx.items.update(item.id, item.version, { name: 'x' }))).rejects.toBeInstanceOf(notFound);
          await expect(as(stranger, (tx) => tx.items.update(randomUUID(), 1, { name: 'x' }))).rejects.toBeInstanceOf(notFound);
          await expect(as(stranger, (tx) => tx.audit.listForItem(item.id, h.clock.iso(-MINUTE), 10))).rejects.toBeInstanceOf(notFound);
        }
      });

      it('a member grant shows the item to that member only, until it is revoked or expires', async () => {
        const item = await seed();
        const grant = await share(item.id);
        expect((await as(otherCaller, (tx) => tx.items.get(item.id)))?.id).toBe(item.id);
        expect((await as(otherCaller, (tx) => tx.items.list({ access: 'grant' }))).rows.map((row) => row.id)).toEqual([item.id]);
        expect((await as(otherCaller, (tx) => tx.items.list({ access: 'owner' }))).rows).toEqual([]);
        expect(await as(otherCaller, (tx) => tx.items.currentSecret(item.id))).not.toBeNull();
        expect((await as(otherCaller, (tx) => tx.grants.activeForCaller(item.id))).map((row) => row.id)).toEqual([grant.id]);
        expect(await as(third, (tx) => tx.items.get(item.id))).toBeNull();
        expect(await as(outsiderCaller, (tx) => tx.items.get(item.id))).toBeNull();

        // Revocation is visible to the very next read (test 12).
        await as(testCaller, (tx) => tx.grants.revoke(grant.id, actorOf(testCaller)));
        expect(await as(otherCaller, (tx) => tx.items.get(item.id))).toBeNull();
        expect(await as(otherCaller, (tx) => tx.grants.activeForCaller(item.id))).toEqual([]);

        const expiring = await share(item.id, 'member', { expiresAt: h.clock.iso(5 * MINUTE) });
        expect(await as(otherCaller, (tx) => tx.items.get(item.id))).not.toBeNull();
        h.clock.advance(5 * MINUTE);
        expect(await as(otherCaller, (tx) => tx.items.get(item.id))).toBeNull();
        expect(await as(testCaller, (tx) => tx.grants.countActive(item.id))).toBe(0);
        // Both rows stay listed for the owner; their createdAt ties, so compare as a set.
        expect((await as(testCaller, (tx) => tx.grants.listForItem(item.id))).map((row) => row.id).sort()).toEqual([expiring.id, grant.id].sort());
      });

      it('a space grant reaches every member of that space and nobody else; it cannot name another space or the owner', async () => {
        const item = await seed();
        await share(item.id, 'space');
        expect(await as(otherCaller, (tx) => tx.items.get(item.id))).not.toBeNull();
        expect(await as(third, (tx) => tx.items.get(item.id))).not.toBeNull();
        expect(await as(outsiderCaller, (tx) => tx.items.get(item.id))).toBeNull();
        await expect(share(item.id, 'space', { granteeId: SPACE_B })).rejects.toMatchObject(state('cross_space'));
        await expect(share(item.id, 'member', { granteeId: OWNER_ID })).rejects.toMatchObject(state('self_grant'));
      });

      it('scope is the (member, space) pair: the same member id in another space sees nothing', async () => {
        const item = await seed();
        await share(item.id);
        await share(item.id, 'space');
        for (const elsewhere of [makeCaller({ spaceId: SPACE_B }), makeCaller({ memberId: MEMBER_ID, spaceId: SPACE_B, isSpaceAdmin: false })]) {
          expect(await as(elsewhere, (tx) => tx.items.get(item.id))).toBeNull();
          expect((await as(elsewhere, (tx) => tx.items.list({}))).rows).toEqual([]);
          expect(await as(elsewhere, (tx) => tx.items.currentSecret(item.id))).toBeNull();
          expect(await as(elsewhere, (tx) => tx.grants.activeForCaller(item.id))).toEqual([]);
          await expect(as(elsewhere, (tx) => tx.items.update(item.id, item.version, { name: 'x' }))).rejects.toBeInstanceOf(notFound);
        }
      });

      it('a grantee can use an item but never change it', async () => {
        const item = await seed(newApiKey());
        await share(item.id);
        const writes: ((tx: VaultTx) => Promise<unknown>)[] = [
          (tx) => tx.items.update(item.id, item.version, { name: 'taken' }),
          (tx) => tx.items.setProperties(item.id, item.version, { devMode: true }),
          (tx) => tx.items.replaceSecret(item.id, item.version, fakeSecret(), {}),
          (tx) => tx.items.tombstone(item.id, item.version, actorOf(otherCaller)),
          (tx) => tx.grants.create({ id: randomUUID(), itemId: item.id, granteeKind: 'space', granteeId: SPACE_A, constraints: OPEN_CONSTRAINTS, expiresAt: null, createdBy: actorOf(otherCaller) }),
          (tx) => tx.grants.listForItem(item.id),
          (tx) => tx.policies.set(item.id, item.version, apiPolicy(), actorOf(otherCaller)),
        ];
        for (const write of writes) await expect(as(otherCaller, write)).rejects.toBeInstanceOf(notFound);
        expect((await as(testCaller, (tx) => tx.items.get(item.id)))?.version).toBe(item.version);
      });

      it('member-only and system-only methods refuse the other scope kind', async () => {
        await expect(sys('reconcile', (tx) => tx.items.create(newLogin(), fakeSecret()))).rejects.toBeInstanceOf(StoreScopeError);
        await expect(sys('reconcile', (tx) => tx.items.countOwned())).rejects.toBeInstanceOf(StoreScopeError);
        await expect(as(testCaller, (tx) => tx.approvals.expireDue())).rejects.toBeInstanceOf(StoreScopeError);
        await expect(as(testCaller, (tx) => tx.operations.markInProgressUnknown())).rejects.toBeInstanceOf(StoreScopeError);
        await expect(as(testCaller, (tx) => tx.audit.range(1, 10))).rejects.toBeInstanceOf(StoreScopeError);
        await expect(as(testCaller, (tx) => tx.deletionLedger.list())).rejects.toBeInstanceOf(StoreScopeError);
        await expect(as(testCaller, (tx) => tx.items.forceTombstone({ itemId: randomUUID(), spaceId: SPACE_A, ownerMemberId: OWNER_ID, tombstonedAt: h.clock.iso() })))
          .rejects.toBeInstanceOf(StoreScopeError);
        await expect(h.store.transaction({ kind: 'member', memberId: 'not-a-uuid', spaceId: SPACE_A }, async () => 1)).rejects.toBeInstanceOf(TypeError);
      });

      it('ids are UUIDs, stored lowercase; anything else is a TypeError', async () => {
        const id = randomUUID().toUpperCase();
        const item = await seed(newLogin(testCaller, { id }));
        expect(item.id).toBe(id.toLowerCase());
        expect((await as(testCaller, (tx) => tx.items.get(id)))?.id).toBe(id.toLowerCase());
        await expect(as(testCaller, (tx) => tx.items.get('item-1'))).rejects.toBeInstanceOf(TypeError);
        await expect(seed(newLogin(testCaller, { id: 'not-a-uuid' }))).rejects.toBeInstanceOf(TypeError);
      });
    });

    // -----------------------------------------------------------------------
    describe('items, compare-and-set and secrets', () => {
      it('checks visibility, then tombstone, then version, then its own rules', async () => {
        const item = await seed();
        await expect(as(testCaller, (tx) => tx.items.update(item.id, item.version + 1, { name: 'x' }))).rejects.toMatchObject({ name: 'StoreVersionConflictError', currentVersion: item.version });
        const renamed = await as(testCaller, (tx) => tx.items.update(item.id, item.version, { name: 'Renamed' }));
        expect(renamed).toMatchObject({ name: 'Renamed', version: item.version + 1 });
        await expect(as(testCaller, (tx) => tx.items.update(item.id, item.version, { name: 'x' }))).rejects.toBeInstanceOf(StoreVersionConflictError);
        const dead = await as(testCaller, (tx) => tx.items.tombstone(item.id, renamed.version, actorOf(testCaller)));
        // Tombstone comes before version: a stale and a current version get the same answer.
        for (const version of [item.version, dead.version, dead.version + 5]) {
          await expect(as(testCaller, (tx) => tx.items.update(item.id, version, { name: 'x' }))).rejects.toMatchObject(state('tombstoned'));
        }
        await expect(as(otherCaller, (tx) => tx.items.update(item.id, dead.version, { name: 'x' }))).rejects.toBeInstanceOf(notFound);
      });

      it('keeps origins sorted and unique, refuses origins on other item types, and binds an origin once', async () => {
        const login = await seed(newLogin(testCaller, { origins: ['https://b.example.test', 'https://a.example.test', 'https://b.example.test'] }));
        expect(login.origins).toEqual(['https://a.example.test', 'https://b.example.test']);
        const changed = await as(testCaller, (tx) => tx.items.setProperties(login.id, login.version, { addOrigins: ['https://c.example.test'], removeOrigins: ['https://a.example.test'] }));
        expect(changed.origins).toEqual(['https://b.example.test', 'https://c.example.test']);
        const same = await as(testCaller, (tx) => tx.items.addOrigin(login.id, 'https://c.example.test'));
        expect(same.version).toBe(changed.version);
        const added = await as(testCaller, (tx) => tx.items.addOrigin(login.id, 'https://d.example.test'));
        expect(added.version).toBe(changed.version + 1);

        const key = await seed(newApiKey());
        await expect(as(testCaller, (tx) => tx.items.setProperties(key.id, key.version, { addOrigins: ['https://a.example.test'] }))).rejects.toMatchObject(state('wrong_item_type'));
        await expect(as(testCaller, (tx) => tx.items.addOrigin(key.id, 'https://a.example.test'))).rejects.toMatchObject(state('wrong_item_type'));
        await expect(seed(newApiKey(testCaller, { origins: ['https://a.example.test'] }))).rejects.toMatchObject(state('wrong_item_type'));
      });

      it('rotation keeps exactly one secret version, clears blocked_until_rotated and returns copies', async () => {
        const item = await seed(newLogin(testCaller, { state: 'blocked_until_rotated' }));
        const first = await as(testCaller, (tx) => tx.items.currentSecret(item.id));
        expect(first?.version).toBe(1);
        const next = fakeSecret();
        h.clock.advance(MINUTE);
        const rotated = await as(testCaller, (tx) => tx.items.replaceSecret(item.id, item.version, next, { username: 'rotated-user' }));
        expect(rotated).toMatchObject({ secretVersion: 2, state: 'active', username: 'rotated-user', rotatedAt: h.clock.iso() });
        const live = await as(testCaller, (tx) => tx.items.currentSecret(item.id));
        expect(live?.version).toBe(2);
        expect(Buffer.compare(live!.ciphertext, next.ciphertext)).toBe(0);
        if (h.hooks.secretVersionCount) expect(await h.hooks.secretVersionCount(item.id)).toBe(1);

        // What the store hands out is a copy.
        live!.ciphertext.fill(0);
        rotated.origins.push('https://mutated.example.test');
        const again = await as(testCaller, (tx) => tx.items.currentSecret(item.id));
        expect(Buffer.compare(again!.ciphertext, next.ciphertext)).toBe(0);
        expect((await as(testCaller, (tx) => tx.items.get(item.id)))?.origins).toEqual(item.origins);
      });

      it('a call that throws changes nothing, and the transaction stays usable', async () => {
        const item = await seed();
        const result = await as(testCaller, async (tx) => {
          await expect(tx.items.replaceSecret(item.id, item.version, fakeSecret(), { fieldNames: 'not-a-list' as unknown as string[] })).rejects.toBeInstanceOf(TypeError);
          await expect(tx.items.update(item.id, item.version, { name: 'x'.repeat(501) })).rejects.toBeInstanceOf(TypeError);
          const unchanged = await tx.items.get(item.id);
          expect(unchanged).toMatchObject({ version: item.version, secretVersion: 1, name: item.name });
          return tx.items.update(item.id, item.version, { name: 'After the errors' });
        });
        expect(result.version).toBe(item.version + 1);
        expect((await as(testCaller, (tx) => tx.items.currentSecret(item.id)))?.version).toBe(1);
      });

      it('lists newest first in pages that never repeat or skip a row, and refuses a forged cursor', async () => {
        const ids: string[] = [];
        for (let index = 0; index < 5; index += 1) {
          ids.push((await seed()).id);
          if (index % 2 === 0) h.clock.advance(1000); // some rows share a createdAt
        }
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await as(testCaller, (tx) => tx.items.list({ limit: 2, ...(cursor ? { cursor } : {}) }));
          seen.push(...page.rows.map((row) => row.id));
          cursor = page.nextCursor ?? undefined;
          pages += 1;
        } while (cursor && pages < 10);
        expect(pages).toBe(3);
        expect(new Set(seen).size).toBe(5);
        expect(seen.sort()).toEqual(ids.slice().sort());
        const all = (await as(testCaller, (tx) => tx.items.list({}))).rows;
        for (let index = 1; index < all.length; index += 1) {
          expect(all[index - 1]!.createdAt >= all[index]!.createdAt).toBe(true);
        }
        const cursorOf = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        // Month 13 parses to an invalid Date, whose toISOString() throws a RangeError: it must still be invalid_cursor.
        for (const forged of ['not base64!', cursorOf([1, 2, 3]), cursorOf({ a: 1 }), cursorOf(['2026-13-01T00:00:00.000Z', randomUUID()]), cursorOf(['2026-11-20T12:00:00Z', randomUUID()])]) {
          await expect(as(testCaller, (tx) => tx.items.list({ cursor: forged }))).rejects.toMatchObject({ name: 'VaultError', code: 'invalid_cursor' });
        }
        expect((await as(testCaller, (tx) => tx.items.list({ limit: 0 }))).rows).toHaveLength(1);
      });

      it('policies belong to api_key items and bump both versions', async () => {
        const key = await seed(newApiKey());
        const first = await as(testCaller, (tx) => tx.policies.set(key.id, key.version, apiPolicy(), actorOf(testCaller)));
        expect(first.policy.version).toBe(1);
        expect(first.item.version).toBe(key.version + 1);
        const second = await as(testCaller, (tx) => tx.policies.set(key.id, first.item.version, apiPolicy(), actorOf(testCaller)));
        expect(second.policy.version).toBe(2);
        const login = await seed();
        await expect(as(testCaller, (tx) => tx.policies.set(login.id, login.version, apiPolicy(), actorOf(testCaller)))).rejects.toMatchObject(state('wrong_item_type'));
        await share(key.id);
        expect((await as(otherCaller, (tx) => tx.policies.get(key.id)))?.version).toBe(2);
      });

      it('counts owned live items for the pre_review cap', async () => {
        const one = await seed();
        await seed();
        await as(testCaller, (tx) => tx.items.tombstone(one.id, one.version, actorOf(testCaller)));
        expect(await as(testCaller, (tx) => tx.items.countOwned())).toBe(1);
        expect(await as(otherCaller, (tx) => tx.items.countOwned())).toBe(0);
      });
    });

    // -----------------------------------------------------------------------
    describe('tombstones and the deletion ledger', () => {
      it('a tombstone deletes the secret, revokes grants, expires open approvals and mirrors the ledger', async () => {
        const item = await seed();
        const grant = await share(item.id);
        const pending = await as(otherCaller, (tx) => tx.approvals.create(newApproval(item.id, otherCaller, h.clock)));
        const approved = await as(otherCaller, (tx) => tx.approvals.create(newApproval(item.id, otherCaller, h.clock, { boundParams: { itemId: item.id, origin: 'https://other.example.test' } })));
        const consumed = await as(otherCaller, (tx) => tx.approvals.create(newApproval(item.id, otherCaller, h.clock, { boundParams: { itemId: item.id, n: 3 } })));
        await as(testCaller, async (tx) => {
          await tx.approvals.decide(approved.id, { state: 'approved', decidedBy: actorOf(testCaller), standing: false });
          await tx.approvals.decide(consumed.id, { state: 'approved', decidedBy: actorOf(testCaller), standing: false });
        });
        await as(otherCaller, (tx) => tx.approvals.consume(consumed.id, randomUUID()));

        h.clock.advance(MINUTE);
        const dead = await as(testCaller, (tx) => tx.items.tombstone(item.id, item.version, actorOf(testCaller)));
        expect(dead).toMatchObject({ state: 'tombstoned', tombstonedAt: h.clock.iso(), version: item.version + 1 });
        expect(await as(testCaller, (tx) => tx.items.currentSecret(item.id))).toBeNull();
        if (h.hooks.secretVersionCount) expect(await h.hooks.secretVersionCount(item.id)).toBe(0);
        const grants = await as(testCaller, (tx) => tx.grants.listForItem(item.id));
        expect(grants.find((row) => row.id === grant.id)).toMatchObject({ revokedAt: h.clock.iso(), revokedBy: actorOf(testCaller) });
        expect(await as(otherCaller, (tx) => tx.items.get(item.id))).toBeNull();
        const states = await as(testCaller, async (tx) => Promise.all([pending, approved, consumed].map(async (row) => (await tx.approvals.get(row.id))?.state)));
        expect(states).toEqual(['expired', 'expired', 'consumed']);
        // The metadata stays for the audit trail.
        expect((await as(testCaller, (tx) => tx.items.get(item.id)))?.name).toBe(item.name);
        expect((await as(testCaller, (tx) => tx.items.list({}))).rows).toEqual([]);
        expect((await as(testCaller, (tx) => tx.items.list({ includeTombstoned: true }))).rows.map((row) => row.id)).toEqual([item.id]);
        expect(await sys('deletionLedger', (tx) => tx.deletionLedger.list())).toEqual([
          { itemId: item.id, spaceId: SPACE_A, ownerMemberId: OWNER_ID, tombstonedAt: h.clock.iso() },
        ]);
        await expect(as(testCaller, (tx) => tx.items.tombstone(item.id, dead.version, actorOf(testCaller)))).rejects.toMatchObject(state('tombstoned'));
        await expect(as(testCaller, (tx) => tx.approvals.create(newApproval(item.id, testCaller, h.clock)))).rejects.toMatchObject(state('tombstoned'));
        await expect(share(item.id)).rejects.toMatchObject(state('tombstoned'));
      });

      it('forceTombstone is idempotent and accepts an entry for an item the database never had', async () => {
        const entry = { itemId: randomUUID(), spaceId: SPACE_A, ownerMemberId: OWNER_ID, tombstonedAt: h.clock.iso() };
        expect(await sys('deletionLedger', (tx) => tx.items.forceTombstone(entry))).toBe(true);
        expect(await sys('deletionLedger', (tx) => tx.items.forceTombstone(entry))).toBe(false);
      });

      it('test 17: restoring a backup never revives a deleted item', async (ctx: TestContext) => {
        if (!h.hooks.snapshot || !h.hooks.restore) return ctx.skip();
        const ledger = new MemoryDeletionLedger();
        const item = await seed();
        const grant = await share(item.id);
        const backup = await h.hooks.snapshot();

        // The delete handler: the durable ledger first, then the transaction.
        h.clock.advance(MINUTE);
        const deletedAt = h.clock.iso();
        await ledger.append({ itemId: item.id, spaceId: item.spaceId, ownerMemberId: item.ownerMemberId, tombstonedAt: deletedAt });
        await as(testCaller, (tx) => tx.items.tombstone(item.id, item.version, actorOf(testCaller)));

        await h.hooks.restore(backup);
        expect((await as(testCaller, (tx) => tx.items.get(item.id)))?.state).toBe('active');
        expect(await as(otherCaller, (tx) => tx.items.currentSecret(item.id))).not.toBeNull();

        // Start-up replay, before the broker serves.
        h.clock.advance(MINUTE);
        const replay = async (): Promise<number> => {
          let changed = 0;
          for (const entry of await ledger.entries()) {
            await sys('deletionLedger', async (tx) => {
              if (!(await tx.items.forceTombstone(entry))) return;
              changed += 1;
              await tx.audit.append({ action: 'item.tombstone_replayed', actor: SYSTEM_ACTOR, itemId: entry.itemId, subjectMemberId: entry.ownerMemberId, spaceId: entry.spaceId, params: {} });
            });
          }
          return changed;
        };
        expect(await replay()).toBe(1);
        expect(await as(testCaller, (tx) => tx.items.get(item.id))).toMatchObject({ state: 'tombstoned', tombstonedAt: deletedAt });
        expect(await as(testCaller, (tx) => tx.items.currentSecret(item.id))).toBeNull();
        expect(await as(otherCaller, (tx) => tx.items.get(item.id))).toBeNull();
        expect((await as(testCaller, (tx) => tx.grants.get(grant.id)))?.revokedBy).toEqual(SYSTEM_ACTOR);
        if (h.hooks.secretVersionCount) expect(await h.hooks.secretVersionCount(item.id)).toBe(0);
        const events = (await as(testCaller, (tx) => tx.audit.list({ action: 'item.tombstone_replayed' }))).rows;
        expect(events.map((row) => row.itemId)).toEqual([item.id]);
        expect(await replay()).toBe(0);
      });
    });

    // -----------------------------------------------------------------------
    describe('approvals', () => {
      it('runs pending -> approved -> consumed for the requester, decided by the owner only', async () => {
        const item = await seed();
        await share(item.id);
        const draft = newApproval(item.id, otherCaller, h.clock);
        const approval = await as(otherCaller, (tx) => tx.approvals.create(draft));
        expect(approval).toMatchObject({ state: 'pending', ownerMemberId: OWNER_ID, requesterMemberId: MEMBER_ID, spaceId: SPACE_A });
        expect((await as(testCaller, (tx) => tx.approvals.get(approval.id)))?.id).toBe(approval.id);
        expect(await as(third, (tx) => tx.approvals.get(approval.id))).toBeNull();
        expect(await as(outsiderCaller, (tx) => tx.approvals.get(approval.id))).toBeNull();
        expect((await as(otherCaller, (tx) => tx.approvals.findPending(item.id, 'use', draft.intentHash)))?.id).toBe(approval.id);
        expect(await as(testCaller, (tx) => tx.approvals.findPending(item.id, 'use', draft.intentHash))).toBeNull();
        expect(await as(testCaller, (tx) => tx.approvals.countPending(item.id))).toBe(1);

        await expect(as(otherCaller, (tx) => tx.approvals.decide(approval.id, { state: 'approved', decidedBy: actorOf(otherCaller), standing: false }))).rejects.toBeInstanceOf(notFound);
        // Only the owner, as a member, decides: never an agent, even one acting for the owner.
        await expect(as(testCaller, (tx) => tx.approvals.decide(approval.id, { state: 'approved', decidedBy: actorOf(agentOf(testCaller)), standing: false }))).rejects.toBeInstanceOf(TypeError);
        const approved = await as(testCaller, (tx) => tx.approvals.decide(approval.id, { state: 'approved', decidedBy: actorOf(testCaller), standing: false }));
        expect(approved).toMatchObject({ state: 'approved', decidedAt: h.clock.iso(), decidedBy: actorOf(testCaller) });
        await expect(as(testCaller, (tx) => tx.approvals.decide(approval.id, { state: 'denied', decidedBy: actorOf(testCaller), standing: false }))).rejects.toMatchObject(state('approved'));

        expect((await as(otherCaller, (tx) => tx.approvals.findUsable(item.id, 'use', draft.intentHash)))?.id).toBe(approval.id);
        expect(await as(otherCaller, (tx) => tx.approvals.findUsable(item.id, 'use', sha256hex('another intent')))).toBeNull();
        await expect(as(testCaller, (tx) => tx.approvals.consume(approval.id, randomUUID()))).rejects.toBeInstanceOf(notFound);
        const operationId = randomUUID();
        const consumed = await as(otherCaller, (tx) => tx.approvals.consume(approval.id, operationId));
        expect(consumed).toMatchObject({ state: 'consumed', consumedByOperationId: operationId });
        await expect(as(otherCaller, (tx) => tx.approvals.consume(approval.id, randomUUID()))).rejects.toMatchObject(state('consumed'));
        expect(await as(otherCaller, (tx) => tx.approvals.findUsable(item.id, 'use', draft.intentHash))).toBeNull();
      });

      it('expiry is lazy: a lapsed approval reads as expired before the sweeper persists it', async () => {
        const item = await seed();
        const pending = await as(testCaller, (tx) => tx.approvals.create(newApproval(item.id, testCaller, h.clock)));
        const approved = await as(testCaller, (tx) => tx.approvals.create(newApproval(item.id, testCaller, h.clock, { boundParams: { itemId: item.id, n: 2 } })));
        await as(testCaller, (tx) => tx.approvals.decide(approved.id, { state: 'approved', decidedBy: actorOf(testCaller), standing: false }));
        h.clock.advance(15 * MINUTE);
        expect((await as(testCaller, (tx) => tx.approvals.get(pending.id)))?.state).toBe('expired');
        expect((await as(testCaller, (tx) => tx.approvals.list({ state: 'expired' }))).rows.map((row) => row.id).sort()).toEqual([pending.id, approved.id].sort());
        expect((await as(testCaller, (tx) => tx.approvals.list({ state: 'pending' }))).rows).toEqual([]);
        expect(await as(testCaller, (tx) => tx.approvals.findPending(item.id, 'use', pending.intentHash))).toBeNull();
        await expect(as(testCaller, (tx) => tx.approvals.decide(pending.id, { state: 'approved', decidedBy: actorOf(testCaller), standing: false }))).rejects.toMatchObject(state('expired'));
        await expect(as(testCaller, (tx) => tx.approvals.consume(approved.id, randomUUID()))).rejects.toMatchObject(state('expired'));
        const swept = await sys('expire', (tx) => tx.approvals.expireDue());
        expect(swept.map((row) => row.id).sort()).toEqual([pending.id, approved.id].sort());
        expect(swept.every((row) => row.state === 'expired')).toBe(true);
        expect(await sys('expire', (tx) => tx.approvals.expireDue())).toEqual([]);
      });

      it('standing is only for approving new_origin, and a standing approval is never consumed', async () => {
        const item = await seed();
        const use = await as(testCaller, (tx) => tx.approvals.create(newApproval(item.id, testCaller, h.clock)));
        await expect(as(testCaller, (tx) => tx.approvals.decide(use.id, { state: 'approved', decidedBy: actorOf(testCaller), standing: true }))).rejects.toMatchObject(state('standing_not_allowed'));
        const origin = await as(testCaller, (tx) => tx.approvals.create(newApproval(item.id, testCaller, h.clock, { kind: 'new_origin', boundParams: { itemId: item.id, origin: 'https://new.example.test' } })));
        await expect(as(testCaller, (tx) => tx.approvals.decide(origin.id, { state: 'denied', decidedBy: actorOf(testCaller), standing: true }))).rejects.toMatchObject(state('standing_not_allowed'));
        const standing = await as(testCaller, (tx) => tx.approvals.decide(origin.id, { state: 'approved', decidedBy: actorOf(testCaller), standing: true }));
        expect(standing).toMatchObject({ state: 'approved', standing: true, oneUse: false });
        await expect(as(testCaller, (tx) => tx.approvals.consume(origin.id, randomUUID()))).rejects.toMatchObject(state('not_one_use'));
        h.clock.advance(60 * MINUTE);
        expect((await as(testCaller, (tx) => tx.approvals.get(origin.id)))?.state).toBe('approved');
      });

      it('exactly one of two concurrent consumers wins', async () => {
        const item = await seed();
        const approval = await as(testCaller, (tx) => tx.approvals.create(newApproval(item.id, testCaller, h.clock)));
        await as(testCaller, (tx) => tx.approvals.decide(approval.id, { state: 'approved', decidedBy: actorOf(testCaller), standing: false }));
        const results = await Promise.allSettled([1, 2].map(() => as(testCaller, (tx) => tx.approvals.consume(approval.id, randomUUID()))));
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
        expect(loser.reason).toMatchObject(state('consumed'));
      });

      it('spend details belong to spend approvals only, and one spend request per approval', async () => {
        const item = await seed();
        await expect(as(testCaller, (tx) => tx.approvals.create(newApproval(item.id, testCaller, h.clock, { kind: 'spend' })))).rejects.toBeInstanceOf(TypeError);
        const spend = { merchant: 'Example Shop', amountMinor: 1299, currency: 'USD', itemSummary: 'Test order', instrumentTier: 'tier1' as const };
        await expect(as(testCaller, (tx) => tx.approvals.create(newApproval(item.id, testCaller, h.clock, { spend })))).rejects.toBeInstanceOf(TypeError);
        const approval = await as(testCaller, (tx) => tx.approvals.create(newApproval(item.id, testCaller, h.clock, { kind: 'spend', spend })));
        const request = { approvalId: approval.id, itemId: item.id, ...spend, evidence: null };
        await as(testCaller, (tx) => tx.spend.create(request));
        await expect(as(testCaller, (tx) => tx.spend.create(request))).rejects.toBeInstanceOf(StoreDuplicateError);
        const executed = await as(testCaller, (tx) => tx.spend.markExecuted(approval.id, 'test-processor-ref'));
        expect(executed).toMatchObject({ executedAt: h.clock.iso(), processorRef: 'test-processor-ref' });
        await expect(as(testCaller, (tx) => tx.spend.markExecuted(approval.id, 'again'))).rejects.toMatchObject(state('executed'));
        expect(await as(outsiderCaller, (tx) => tx.spend.getByApproval(approval.id))).toBeNull();
      });
    });

    // -----------------------------------------------------------------------
    describe('operations', () => {
      const reserve = (caller: VaultCaller, operationId: string, itemId: string) => as(caller, (tx) => tx.operations.reserve({
        operationId, kind: 'fill', itemId, intentHash: sha256hex(`intent ${operationId}`), actor: actorOf(caller), approvalId: null,
      }));

      it('reserve is idempotent per member, and an operation completes once', async () => {
        const item = await seed();
        const operationId = randomUUID();
        const first = await reserve(testCaller, operationId, item.id);
        expect(first.created).toBe(true);
        h.clock.advance(1000);
        const second = await reserve(testCaller, operationId, item.id);
        expect(second).toEqual({ created: false, operation: first.operation });
        // The key is (member, operationId): another member's id space is its own.
        expect((await reserve(otherCaller, operationId, item.id)).created).toBe(true);
        expect(await as(outsiderCaller, (tx) => tx.operations.get(operationId))).toBeNull();
        const done = await as(testCaller, (tx) => tx.operations.complete(operationId, { state: 'done', result: { filled: true } }));
        expect(done).toMatchObject({ state: 'done', result: { filled: true }, completedAt: h.clock.iso() });
        await expect(as(testCaller, (tx) => tx.operations.complete(operationId, { state: 'refused', result: null }))).rejects.toMatchObject(state('done'));
      });

      it('a broker restart turns in-progress operations into unknown, which reconciliation resolves once', async () => {
        const item = await seed();
        const operationId = randomUUID();
        await reserve(testCaller, operationId, item.id);
        const marked = await sys('reconcile', (tx) => tx.operations.markInProgressUnknown());
        expect(marked.map((row) => [row.operationId, row.state])).toEqual([[operationId, 'unknown']]);
        expect((await sys('reconcile', (tx) => tx.operations.listUnknown('fill'))).map((row) => row.operationId)).toEqual([operationId]);
        expect(await sys('reconcile', (tx) => tx.operations.listUnknown('spend'))).toEqual([]);
        await expect(as(testCaller, (tx) => tx.operations.complete(operationId, { state: 'done', result: null }))).rejects.toMatchObject(state('unknown'));
        const resolved = await sys('reconcile', (tx) => tx.operations.resolveUnknown(OWNER_ID, operationId, { state: 'refused', result: { reason: 'test' } }));
        expect(resolved.state).toBe('refused');
        await expect(sys('reconcile', (tx) => tx.operations.resolveUnknown(OWNER_ID, operationId, { state: 'done', result: null }))).rejects.toMatchObject(state('refused'));
      });
    });

    // -----------------------------------------------------------------------
    // Member-auth transactions must serialize per member so countActive +
    // create/revoke and code consume/replace cannot race. Memory gets this
    // automatically because it serializes every transaction; Postgres holds
    // a member-scoped advisory transaction lock (see postgres-auth-lock.test.ts).
    describe('owner authentication rows', () => {
      const passkey = (caller: VaultCaller, counter = 0, credentialId = `Y3JlZC0${randomUUID().slice(0, 8)}`) => as(caller, (tx) => tx.passkeys.create({
        id: randomUUID(), credentialId, publicKey: 'dGVzdC1wdWJsaWMta2V5', counter, transports: ['internal'], backedUp: false,
        deviceType: 'singleDevice', aaguid: null, name: 'Test passkey',
      }));
      const session = (caller: VaultCaller, passkeyId: string, refresh = tokenPair(), family = 7 * 24 * 60 * MINUTE) => as(caller, (tx) => tx.sessions.create({
        id: randomUUID(), passkeyId, deviceLabel: 'Test device', tokenHash: tokenPair().hash, refreshHash: refresh.hash,
        expiresAt: h.clock.iso(15 * MINUTE), refreshExpiresAt: h.clock.iso(12 * 60 * MINUTE), familyExpiresAt: h.clock.iso(family),
      }));

      it('passkey credential ids are unique store-wide and counters only grow', async () => {
        const key = await passkey(testCaller, 5);
        await expect(passkey(otherCaller, 0, key.credentialId)).rejects.toBeInstanceOf(StoreDuplicateError);
        expect((await as(testCaller, (tx) => tx.passkeys.recordUse(key.id, 6))).counter).toBe(6);
        await expect(as(testCaller, (tx) => tx.passkeys.recordUse(key.id, 6))).rejects.toMatchObject(state('counter_regression'));
        const counterless = await passkey(testCaller, 0);
        await as(testCaller, (tx) => tx.passkeys.recordUse(counterless.id, 0));
        await as(testCaller, (tx) => tx.passkeys.recordUse(counterless.id, 3));
        await expect(as(testCaller, (tx) => tx.passkeys.recordUse(counterless.id, 0))).rejects.toMatchObject(state('counter_regression'));
        expect(await as(otherCaller, (tx) => tx.passkeys.get(key.id))).toBeNull();
        expect(await as(otherCaller, (tx) => tx.passkeys.getByCredentialId(key.credentialId))).toBeNull();
        await as(testCaller, (tx) => tx.passkeys.revoke(key.id));
        await expect(as(testCaller, (tx) => tx.passkeys.recordUse(key.id, 9))).rejects.toMatchObject(state('revoked'));
        await expect(session(testCaller, key.id)).rejects.toMatchObject(state('passkey_revoked'));
        expect(await as(testCaller, (tx) => tx.passkeys.countActive())).toBe(1);
      });

      it('a reused refresh token revokes its whole family, and that outcome commits', async () => {
        const key = await passkey(testCaller);
        const r1 = tokenPair();
        const created = await session(testCaller, key.id, r1);
        const r2 = tokenPair();
        const rotate = (presented: string, next = tokenPair()) => as(testCaller, (tx) => tx.sessions.rotateRefresh({
          refreshHash: presented, newTokenHash: tokenPair().hash, newRefreshHash: next.hash,
          expiresAt: h.clock.iso(15 * MINUTE), refreshExpiresAt: h.clock.iso(12 * 60 * MINUTE),
        }));
        const rotated = await rotate(r1.hash, r2);
        expect(rotated).toMatchObject({ result: 'rotated', session: { id: created.id, refreshVersion: 2, refreshHash: r2.hash } });
        // A superseded hash is still taken: no new session may reuse it.
        await expect(session(testCaller, key.id, r1)).rejects.toBeInstanceOf(StoreDuplicateError);
        await expect(session(testCaller, key.id, r2)).rejects.toBeInstanceOf(StoreDuplicateError);
        // Another member never learns anything from a hash.
        expect(await as(otherCaller, (tx) => tx.sessions.rotateRefresh({ refreshHash: r2.hash, newTokenHash: tokenPair().hash, newRefreshHash: tokenPair().hash, expiresAt: h.clock.iso(MINUTE), refreshExpiresAt: h.clock.iso(MINUTE) }))).toEqual({ result: 'unknown' });

        const reused = await rotate(r1.hash);
        expect(reused).toMatchObject({ result: 'reused', session: { id: created.id, revokedReason: 'refresh_reuse' } });
        expect(await as(testCaller, (tx) => tx.sessions.get(created.id))).toMatchObject({ revokedAt: h.clock.iso(), revokedReason: 'refresh_reuse' });
        expect((await rotate(r2.hash)).result).toBe('ended');
        expect(await rotate(tokenPair().hash)).toEqual({ result: 'unknown' });
      });

      it('a session never outlives its family, and revocation is idempotent', async () => {
        const key = await passkey(testCaller);
        const short = await session(testCaller, key.id, tokenPair(), 10 * MINUTE);
        expect(short.expiresAt).toBe(h.clock.iso(10 * MINUTE));
        expect(short.refreshExpiresAt).toBe(h.clock.iso(10 * MINUTE));
        const other = await session(testCaller, key.id);
        const revoked = await as(testCaller, (tx) => tx.sessions.revoke(short.id, 'ended'));
        h.clock.advance(1000);
        expect(await as(testCaller, (tx) => tx.sessions.revoke(short.id, 'revoked'))).toEqual(revoked);
        expect((await as(testCaller, (tx) => tx.sessions.revokeForPasskey(key.id))).map((row) => row.id)).toEqual([other.id]);
        await expect(as(otherCaller, (tx) => tx.sessions.revoke(other.id, 'revoked'))).rejects.toBeInstanceOf(notFound);
        expect(await as(otherCaller, (tx) => tx.sessions.getByTokenHash(other.tokenHash))).toBeNull();
      });

      it('challenges have a fixed shape, keep only the intent hash, and are consumed once', async () => {
        const base = { challenge: 'dGVzdC1jaGFsbGVuZ2U', expiresAt: h.clock.iso(5 * MINUTE) };
        const intentHash = sha256hex('bound params');
        const registration = { name: 'Test key', via: 'step_up' as const, codeId: null, userHandle: 'dGVzdC11c2Vy' };
        const create = (shape: { purpose: 'sign_in' | 'step_up' | 'registration'; action: string | null; intentHash: string | null; registration: typeof registration | null }) =>
          as(testCaller, (tx) => tx.challenges.create({ id: randomUUID(), ...base, ...shape } as Parameters<typeof tx.challenges.create>[0]));
        for (const bad of [
          { purpose: 'step_up' as const, action: 'vault.items.delete', intentHash: null, registration: null },
          { purpose: 'step_up' as const, action: 'vault.items.delete', intentHash, registration },
          { purpose: 'step_up' as const, action: 'items.delete', intentHash, registration: null },
          { purpose: 'registration' as const, action: 'vault.items.delete', intentHash: null, registration },
          { purpose: 'sign_in' as const, action: null, intentHash, registration: null },
        ]) {
          await expect(create(bad)).rejects.toBeInstanceOf(TypeError);
        }
        const stepUp = await create({ purpose: 'step_up', action: 'vault.items.delete', intentHash, registration: null });
        expect(Object.keys(stepUp).sort()).toEqual(['action', 'challenge', 'consumedAt', 'createdAt', 'expiresAt', 'id', 'intentHash', 'memberId', 'purpose', 'registration']);
        expect(await as(testCaller, (tx) => tx.challenges.consume(stepUp.id, 'sign_in'))).toBeNull();
        expect(await as(otherCaller, (tx) => tx.challenges.consume(stepUp.id, 'step_up'))).toBeNull();
        expect((await as(testCaller, (tx) => tx.challenges.consume(stepUp.id, 'step_up')))?.consumedAt).toBe(h.clock.iso());
        expect(await as(testCaller, (tx) => tx.challenges.consume(stepUp.id, 'step_up'))).toBeNull();
        const late = await create({ purpose: 'sign_in', action: null, intentHash: null, registration: null });
        h.clock.advance(5 * MINUTE);
        expect(await as(testCaller, (tx) => tx.challenges.consume(late.id, 'sign_in'))).toBeNull();
        expect(await sys('cleanup', (tx) => tx.challenges.deleteExpired())).toBeGreaterThanOrEqual(1);
      });

      it('recovery codes: replaceAll swaps the unused set atomically and each code is used once', async () => {
        const code = () => ({ id: randomUUID(), hash: fakeArgon2idHash() });
        const [a, b, c] = [code(), code(), code()];
        await as(testCaller, (tx) => tx.recoveryCodes.replaceAll([a, b]));
        expect(await as(testCaller, (tx) => tx.recoveryCodes.markUsed(a.id))).toBe(true);
        expect(await as(testCaller, (tx) => tx.recoveryCodes.markUsed(a.id))).toBe(false);
        expect(await as(otherCaller, (tx) => tx.recoveryCodes.markUsed(b.id))).toBe(false);
        await as(testCaller, (tx) => tx.recoveryCodes.replaceAll([c]));
        expect((await as(testCaller, (tx) => tx.recoveryCodes.listUnused())).map((row) => row.id)).toEqual([c.id]);
        const d = code();
        for (const bad of [[d, d], [code(), a], [{ id: randomUUID(), hash: 'plain-text-code' }]]) {
          await expect(as(testCaller, (tx) => tx.recoveryCodes.replaceAll(bad))).rejects.toBeInstanceOf(bad.length === 1 ? TypeError : StoreDuplicateError);
          expect((await as(testCaller, (tx) => tx.recoveryCodes.listUnused())).map((row) => row.id)).toEqual([c.id]);
        }
        expect(await as(testCaller, (tx) => tx.recoveryCodes.countUnused())).toBe(1);
      });

      it('enrollment codes are minted in system scope only', async () => {
        const minted = { id: randomUUID(), memberId: OWNER_ID, spaceId: SPACE_A, hash: fakeArgon2idHash(), expiresAt: h.clock.iso(60 * MINUTE), mintedBy: 'test-operator' };
        await expect(as(testCaller, (tx) => tx.enrollmentCodes.create(minted))).rejects.toBeInstanceOf(StoreScopeError);
        await sys('enrollment', (tx) => tx.enrollmentCodes.create(minted));
        expect((await as(testCaller, (tx) => tx.enrollmentCodes.listUsable())).map((row) => row.id)).toEqual([minted.id]);
        expect(await as(otherCaller, (tx) => tx.enrollmentCodes.listUsable())).toEqual([]);
        expect(await as(testCaller, (tx) => tx.enrollmentCodes.markUsed(minted.id))).toBe(true);
        expect(await as(testCaller, (tx) => tx.enrollmentCodes.markUsed(minted.id))).toBe(false);
      });

      it('a capture link opens only with its token hash, before expiry, and is consumed once', async () => {
        const token = tokenPair();
        const link = await as(testCaller, (tx) => tx.captureLinks.create({
          id: randomUUID(), itemType: 'login', purpose: 'create', itemId: null, name: null, tokenHash: token.hash,
          captureKid: 'test-kid', expiresAt: h.clock.iso(10 * MINUTE), createdBy: actorOf(testCaller),
        }));
        expect(await as(testCaller, (tx) => tx.captureLinks.getUsable(link.id, tokenPair().hash))).toBeNull();
        expect(await as(otherCaller, (tx) => tx.captureLinks.getUsable(link.id, token.hash))).toBeNull();
        expect((await as(testCaller, (tx) => tx.captureLinks.getUsable(link.id, token.hash)))?.id).toBe(link.id);
        await as(testCaller, (tx) => tx.captureLinks.markOpened(link.id));
        const consumed = await Promise.all([1, 2].map(() => as(testCaller, (tx) => tx.captureLinks.consume(link.id, token.hash))));
        expect(consumed.filter(Boolean)).toHaveLength(1);
        expect(await as(testCaller, (tx) => tx.captureLinks.getUsable(link.id, token.hash))).toBeNull();

        const login = await seed();
        const replace = (caller: VaultCaller, itemType: 'login' | 'card') => as(caller, (tx) => tx.captureLinks.create({
          id: randomUUID(), itemType, purpose: 'replace', itemId: login.id, name: null, tokenHash: tokenPair().hash,
          captureKid: 'test-kid', expiresAt: h.clock.iso(10 * MINUTE), createdBy: actorOf(caller),
        }));
        await expect(replace(testCaller, 'card')).rejects.toMatchObject(state('wrong_item_type'));
        await share(login.id);
        await expect(replace(otherCaller, 'login')).rejects.toBeInstanceOf(notFound);
        const late = await replace(testCaller, 'login');
        h.clock.advance(10 * MINUTE);
        expect(await as(testCaller, (tx) => tx.captureLinks.consume(late.id, late.tokenHash))).toBeNull();
      });
    });

    // -----------------------------------------------------------------------
    describe('audit chain', () => {
      it('appends one gapless global chain that verifies end to end', async () => {
        const item = await seed();
        await share(item.id);
        await as(testCaller, (tx) => tx.audit.append(event(testCaller, 'item.captured', item.id, { type: 'login' })));
        await as(otherCaller, (tx) => tx.audit.append({ ...event(otherCaller, 'fill.started', item.id, { origin: 'https://login.example.test' }), subjectMemberId: OWNER_ID }));
        await as(outsiderCaller, (tx) => tx.audit.append(event(outsiderCaller, 'session.signed_in')));
        const head = await as(testCaller, (tx) => tx.audit.head());
        expect(head.seq).toBe(3);
        const events = await sys('audit', (tx) => tx.audit.range(1, head.seq));
        expect(events.map((row) => row.seq)).toEqual([1, 2, 3]);
        expect(events[0]!.prevHash).toBe(AUDIT_GENESIS_HASH);
        expect(verifyAuditRun({ seq: 0, hash: AUDIT_GENESIS_HASH }, events)).toEqual({ ok: true, head: { seq: 3, hash: head.hash } });

        // A member sees exactly the events about their own vault.
        expect((await as(testCaller, (tx) => tx.audit.list({}))).rows.map((row) => row.seq)).toEqual([2, 1]);
        expect((await as(outsiderCaller, (tx) => tx.audit.list({}))).rows.map((row) => row.seq)).toEqual([3]);
        expect((await as(otherCaller, (tx) => tx.audit.list({}))).rows).toEqual([]);
        // Per item: the owner sees everything, a grantee only what they did.
        const since = h.clock.iso(-MINUTE);
        expect((await as(testCaller, (tx) => tx.audit.listForItem(item.id, since, 10))).map((row) => row.seq)).toEqual([2, 1]);
        expect((await as(otherCaller, (tx) => tx.audit.listForItem(item.id, since, 10))).map((row) => row.seq)).toEqual([2]);
      });

      it('fillFailureStreak counts every caller\'s attempted refusals for one origin, back to the last attempted done', async () => {
        const item = await seed();
        await share(item.id);
        await share(item.id, 'member', { granteeId: third.memberId });
        const origin = 'https://login.example.test';
        const other = 'https://other.example.test';
        const record = (caller: VaultCaller, action: string, params: AuditBody['params']) =>
          as(caller, (tx) => tx.audit.append({ ...event(caller, action, item.id, params), subjectMemberId: OWNER_ID }));
        const streak = (caller: VaultCaller, at = origin) => as(caller, (tx) => tx.audit.fillFailureStreak(item.id, at));
        expect(await streak(testCaller)).toBe(0);

        await record(otherCaller, 'fill.refused', { origin, attempted: true, code: 'fields_not_found' });
        await record(third, 'fill.refused', { origin, attempted: true, code: 'timeout' });
        // None of these counts, and none of them ends the streak.
        await record(otherCaller, 'fill.refused', { origin, attempted: false, code: 'grant_constraint' });
        await record(third, 'fill.done', { origin: other, attempted: true });
        await record(third, 'fill.done', { origin, attempted: false });
        await record(otherCaller, 'fill.started', { origin });
        await record(third, 'fill.refused', { origin: other, attempted: true, code: 'timeout' });
        // Each grantee sees only its own events, yet both count the other's refusal.
        expect((await as(otherCaller, (tx) => tx.audit.listForItem(item.id, h.clock.iso(-MINUTE), 50)))
          .every((row) => row.actor.memberId === otherCaller.memberId)).toBe(true);
        expect(await streak(otherCaller)).toBe(2);
        expect(await streak(third)).toBe(2);
        expect(await streak(testCaller)).toBe(2);
        expect(await streak(testCaller, other)).toBe(1);

        // A burst of 200 other events hides nothing (the old 200-event window would).
        await as(testCaller, async (tx) => {
          for (let index = 0; index < 200; index += 1) {
            await tx.audit.append(event(testCaller, 'fill.refused', item.id, { origin, attempted: false, code: 'grant_constraint' }));
          }
        });
        await record(third, 'fill.refused', { origin, attempted: true, code: 'navigation_failed' });
        expect(await streak(otherCaller)).toBe(3);

        await record(otherCaller, 'fill.done', { origin, attempted: true });
        expect(await streak(third)).toBe(0);
        expect(await streak(testCaller, other)).toBe(1);
        await record(third, 'fill.refused', { origin, attempted: true, code: 'timeout' });
        expect(await streak(testCaller)).toBe(1);

        // A caller who cannot see the item reads it exactly as a missing one.
        await expect(as(outsiderCaller, (tx) => tx.audit.fillFailureStreak(item.id, origin))).rejects.toBeInstanceOf(notFound);
        await expect(as(testCaller, (tx) => tx.audit.fillFailureStreak(randomUUID(), origin))).rejects.toBeInstanceOf(notFound);
        await expect(as(testCaller, (tx) => tx.audit.fillFailureStreak(item.id, 'x'.repeat(2049)))).rejects.toBeInstanceOf(TypeError);
      });

      it('event time never runs backwards along the chain, whatever the clock does', async () => {
        const first = await as(testCaller, (tx) => tx.audit.append(event(testCaller, 'session.signed_in')));
        h.clock.advance(-5 * MINUTE);
        const second = await as(testCaller, (tx) => tx.audit.append(event(testCaller, 'session.ended')));
        expect(second.at).toBe(first.at);
        expect(Date.parse(second.at) % 1).toBe(0);
        expect(second.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      });

      it('any append failure kills the transaction: an action never commits without its event', async () => {
        const item = newLogin();
        const outcome = as(testCaller, async (tx) => {
          await tx.items.create(item, fakeSecret());
          await expect(tx.audit.append(event(testCaller, 'not.an.action', item.id))).rejects.toBeInstanceOf(AuditUnavailableError);
          await expect(tx.items.get(item.id)).rejects.toBeInstanceOf(AuditUnavailableError);
          return 'the handler swallowed the error';
        });
        await expect(outcome).rejects.toBeInstanceOf(AuditUnavailableError);
        expect(await as(testCaller, (tx) => tx.items.get(item.id))).toBeNull();
        expect((await as(testCaller, (tx) => tx.audit.head())).seq).toBe(0);
      });

      it('a checkpoint must name a real head', async () => {
        const appended = await as(testCaller, (tx) => tx.audit.append(event(testCaller, 'session.signed_in')));
        const checkpoint = { seq: 1, headHash: appended.entryHash, at: h.clock.iso(), sink: 'off' as const, anchored: false, location: null, keyId: null, signature: null };
        await expect(sys('audit', (tx) => tx.audit.recordCheckpoint({ ...checkpoint, headHash: sha256hex('forged') }))).rejects.toMatchObject(state('checkpoint_mismatch'));
        await expect(sys('audit', (tx) => tx.audit.recordCheckpoint({ ...checkpoint, seq: 2 }))).rejects.toMatchObject(state('checkpoint_mismatch'));
        await expect(as(testCaller, (tx) => tx.audit.recordCheckpoint(checkpoint))).rejects.toBeInstanceOf(StoreScopeError);
        await sys('audit', (tx) => tx.audit.recordCheckpoint({ ...checkpoint, seq: 0, headHash: AUDIT_GENESIS_HASH }));
        await sys('audit', (tx) => tx.audit.recordCheckpoint(checkpoint));
        expect(await sys('audit', (tx) => tx.audit.latestCheckpoint())).toEqual(checkpoint);
      });

      it('verification finds an edited or a deleted event', async (ctx: TestContext) => {
        if (!h.hooks.tamperAuditEvent || !h.hooks.deleteAuditEvent) return ctx.skip();
        for (const action of ['session.signed_in', 'session.refreshed', 'session.ended', 'session.revoked']) {
          await as(testCaller, (tx) => tx.audit.append(event(testCaller, action, null, { n: 1 })));
        }
        const verify = async () => verifyAuditRun({ seq: 0, hash: AUDIT_GENESIS_HASH }, await sys('audit', (tx) => tx.audit.range(1, 10)));
        expect((await verify()).ok).toBe(true);
        await h.hooks.tamperAuditEvent(3, { params: { n: 2 } });
        expect(await verify()).toMatchObject({ ok: false, firstBrokenSeq: 3, head: { seq: 2 } });
        await h.hooks.deleteAuditEvent(2);
        expect(await verify()).toMatchObject({ ok: false, firstBrokenSeq: 2, head: { seq: 1 } });
      });
    });

    // -----------------------------------------------------------------------
    describe('transactions', () => {
      it('a throwing transaction commits nothing', async () => {
        const item = newLogin();
        await expect(as(testCaller, async (tx) => {
          await tx.items.create(item, fakeSecret());
          await tx.audit.append(event(testCaller, 'item.captured', item.id));
          throw new Error('handler failed');
        })).rejects.toThrow('handler failed');
        expect(await as(testCaller, (tx) => tx.items.get(item.id))).toBeNull();
        expect((await as(testCaller, (tx) => tx.audit.head())).seq).toBe(0);
      });

      it('tx.now is fixed for the transaction and comes from the store clock', async () => {
        const at = await as(testCaller, async (tx) => {
          const before = tx.now;
          h.clock.advance(1000);
          const item = await tx.items.create(newLogin(), fakeSecret());
          expect(item.createdAt).toBe(before);
          return before;
        });
        expect(at).toBe(h.clock.iso(-1000));
      });

      it('an unavailable store fails closed and the transaction is dead', async (ctx: TestContext) => {
        const setUnavailable = h.hooks.setUnavailable;
        if (!setUnavailable) return ctx.skip();
        const item = newLogin();
        const outcome = as(testCaller, async (tx) => {
          await tx.items.create(item, fakeSecret());
          setUnavailable(true);
          await expect(tx.items.get(item.id)).rejects.toBeInstanceOf(StoreUnavailableError);
          setUnavailable(false);
          await expect(tx.items.get(item.id)).rejects.toBeInstanceOf(StoreUnavailableError);
          return 'swallowed';
        });
        await expect(outcome).rejects.toBeInstanceOf(StoreUnavailableError);
        expect(await as(testCaller, (tx) => tx.items.get(item.id))).toBeNull();
        setUnavailable(true);
        await expect(as(testCaller, async () => 1)).rejects.toBeInstanceOf(StoreUnavailableError);
        expect((await h.store.health()).ok).toBe(false);
        setUnavailable(false);
      });

      it('an audit outage rolls the action back (test 18)', async (ctx: TestContext) => {
        const setAuditAppendFailure = h.hooks.setAuditAppendFailure;
        if (!setAuditAppendFailure) return ctx.skip();
        const item = await seed();
        setAuditAppendFailure(true);
        const operationId = randomUUID();
        await expect(as(testCaller, async (tx) => {
          await tx.operations.reserve({ operationId, kind: 'fill', itemId: item.id, intentHash: sha256hex('fill'), actor: actorOf(testCaller), approvalId: null });
          await tx.audit.append(event(testCaller, 'fill.started', item.id));
        })).rejects.toBeInstanceOf(AuditUnavailableError);
        setAuditAppendFailure(false);
        expect(await as(testCaller, (tx) => tx.operations.get(operationId))).toBeNull();
      });
    });
  });
}

function apiPolicy() {
  return {
    mode: 'generic' as const,
    connector: null,
    hosts: ['api.example.test'],
    methods: ['GET' as const],
    pathPrefixes: ['/v1/'],
    maxRequestBytes: 4096,
    maxResponseBytes: 65536,
    injection: { kind: 'bearer' as const },
  };
}
