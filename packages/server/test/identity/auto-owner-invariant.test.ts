/**
 * The auto-owner boot invariant.
 *
 * `identity-resolver.ts:79-88` resolves an unauthenticated loopback request as
 * the node owner, and `config.ts` defaults `TM8_DISABLE_AUTO_OWNER` to false —
 * so the safe posture on a multi-account node depends on an operator having set
 * a variable. These tests pin the four cases that decide whether the node runs.
 */
import { describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import {
  AutoOwnerInvariantError,
  assertAutoOwnerInvariant,
} from '../../src/bootstrap/auto-owner-invariant.js';

class CountDb implements Db {
  calls = 0;
  constructor(private readonly answer: () => unknown) {}
  async rpc<T>(_c: DbClaims, fn: string): Promise<T> {
    if (fn !== 'public.node_account_count') throw new Error(`unexpected rpc ${fn}`);
    this.calls += 1;
    return this.answer() as T;
  }
  async query<R>(): Promise<R[]> { throw new Error('unexpected query'); }
  tx<T>(_c: DbClaims, _f: (q: Querier) => Promise<T>): Promise<T> { throw new Error('unexpected tx'); }
  end(): Promise<void> { return Promise.resolve(); }
}

describe('auto-owner boot invariant', () => {
  it('refuses a multi-account node that still has auto-owner enabled', async () => {
    const db = new CountDb(() => 8);
    await expect(assertAutoOwnerInvariant({ db, disableAutoOwner: false }))
      .rejects.toBeInstanceOf(AutoOwnerInvariantError);
  });

  it('names the remedy in the refusal, not just the problem', async () => {
    const db = new CountDb(() => 8);
    await expect(assertAutoOwnerInvariant({ db, disableAutoOwner: false }))
      .rejects.toThrow(/TM8_DISABLE_AUTO_OWNER=1/);
  });

  it('allows a multi-account node once auto-owner is off, without asking the database', async () => {
    // Short-circuits before the count: the flag alone settles it, and a boot
    // check that queried anyway would fail a node whose database is slow to
    // come up for no reason.
    const db = new CountDb(() => { throw new Error('must not query'); });
    await expect(assertAutoOwnerInvariant({ db, disableAutoOwner: true })).resolves.toBeUndefined();
    expect(db.calls).toBe(0);
  });

  it('allows the single-account laptop, which is the case auto-owner exists for', async () => {
    for (const n of [0, 1]) {
      const db = new CountDb(() => n);
      await expect(assertAutoOwnerInvariant({ db, disableAutoOwner: false })).resolves.toBeUndefined();
    }
  });

  it('propagates a database outage as itself, so the caller can tell it apart from a refusal', async () => {
    // A node that cannot be counted must not be refused: at boot an unreachable
    // database is an outage, not a security decision. main.ts logs and carries
    // on, and only AutoOwnerInvariantError stops the boot.
    const db = new CountDb(() => { throw new Error('connection refused'); });
    const error = await assertAutoOwnerInvariant({ db, disableAutoOwner: false }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AutoOwnerInvariantError);
  });
});
