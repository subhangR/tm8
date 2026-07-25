/**
 * The loopback owner bootstrap, against a real database.
 *
 * The interesting case is the SECOND call. `ensure_account` is claim-free only
 * while the node has zero accounts (F1); once the owner exists, calling it
 * again with no identity bound raises 28000. So "resolve the owner" and
 * "create the owner" cannot be the same call, and this file proves the second
 * boot takes the read path.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/index.js';
import { createLoopbackOwnerResolver, resolveLoopbackOwner } from '../../src/identity/loopback.js';
import type { Db } from '../../src/db/types.js';

const DATABASE_URL = process.env.TM8_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('loopback owner', () => {
  const db: Db = createDb(DATABASE_URL as string);

  afterAll(async () => {
    await db.end();
  });

  it('bootstraps an owner on first run and returns the same one after', async () => {
    const first = await resolveLoopbackOwner(db);
    expect(first.identityId).toMatch(/^id_/);
    expect(first.isOwner).toBe(true);
    expect(first.isNodeAdmin).toBe(true);
    expect(first.username).toBe('owner');

    // Second call must NOT re-enter ensure_account — with an account already on
    // the node, a claim-free call there raises 28000 (F1). If this throws
    // `unauthenticated`, the read path regressed.
    const second = await resolveLoopbackOwner(db);
    expect(second.identityId).toBe(first.identityId);
    expect(second.accountId).toBe(first.accountId);
  });

  it('resolves concurrent first-requests to one bootstrap', async () => {
    const resolver = createLoopbackOwnerResolver(db);
    const owners = await Promise.all(Array.from({ length: 8 }, () => resolver()));
    const ids = new Set(owners.map((o) => o.identityId));
    expect(ids.size).toBe(1);
  });

  it('produces claims that satisfy current_identity()', async () => {
    const owner = await resolveLoopbackOwner(db);
    // The end-to-end assertion: the identity this file resolves is an identity
    // the DATABASE agrees exists. `current_identity` raises 28000 if the bound
    // claim has no account row.
    const identity = await db.rpc<{ identityId: string; isOwner: boolean }>(
      { identityId: owner.identityId, nodeAdmin: owner.isNodeAdmin },
      'current_identity',
    );
    expect(identity.identityId).toBe(owner.identityId);
    expect(identity.isOwner).toBe(true);
  });
});
