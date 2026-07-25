/**
 * The claims contract, proven against a real Postgres rather than by reading
 * the code that is supposed to implement it.
 *
 * The load-bearing test in this file is `does not leak claims across
 * transactions on a pooled connection`. Everything else here is scaffolding
 * for it. If SET LOCAL were ever downgraded to SET — or if a claim were bound
 * outside the transaction — every other test in the suite would still pass and
 * the server would start authorizing requests as whoever used the connection
 * last. This is the test that catches that.
 *
 * Needs a database: set TM8_DATABASE_URL (see HOW-TO-TEST.md). Skipped, loudly
 * and by name, when it is absent — a silently-skipped security test is worse
 * than no test, because the suite still reports green.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';

const DATABASE_URL = process.env.TM8_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('db claims (SET LOCAL)', () => {
  const db: Db = createDb(DATABASE_URL as string);

  afterAll(async () => {
    await db.end();
  });

  /** `current_setting(name, true)` returns NULL when unset and '' when blanked. */
  const readClaims = (q: {
    query<R = Record<string, unknown>>(sql: string, p?: readonly unknown[]): Promise<R[]>;
  }): Promise<Array<{ identity: string | null; actor: string | null; admin: boolean; request: string | null }>> =>
    q.query(`select
        current_setting('tm8.identity_id', true) as identity,
        current_setting('tm8.actor_id', true)    as actor,
        internal.is_node_admin()                 as admin,
        current_setting('tm8.request_id', true)  as request`);

  const isEmpty = (v: string | null): boolean => v === null || v === '';

  it('binds all four claims inside the transaction', async () => {
    const rows = await db.tx(
      {
        identityId: 'id_alpha',
        actorId: '00000000-0000-7000-8000-000000000001',
        nodeAdmin: true,
        requestId: 'req_test_1',
      },
      readClaims,
    );

    expect(rows[0]?.identity).toBe('id_alpha');
    expect(rows[0]?.actor).toBe('00000000-0000-7000-8000-000000000001');
    expect(rows[0]?.request).toBe('req_test_1');
    // The POSITIVE node-admin assertion, deliberately: a mis-spelled claim
    // ('on' instead of 'true') reads as DENIED rather than raising, so only an
    // assertion that the claim GRANTS can catch that regression. Asserting
    // `false` for the off case would pass either way.
    expect(rows[0]?.admin).toBe(true);
  });

  it('binds node_admin false when not requested', async () => {
    const rows = await db.tx({ identityId: 'id_alpha' }, readClaims);
    expect(rows[0]?.admin).toBe(false);
  });

  it('does not leak claims across transactions on a pooled connection', async () => {
    // Force reuse: a single-connection pool guarantees the second transaction
    // gets the exact backend the first one used. With `max` at its default the
    // test could pass by picking a fresh connection and prove nothing.
    const shared: Db = createDb(DATABASE_URL as string, { max: 1 });
    try {
      const first = await shared.tx(
        { identityId: 'id_alpha', actorId: '00000000-0000-7000-8000-000000000001', nodeAdmin: true },
        readClaims,
      );
      expect(first[0]?.identity).toBe('id_alpha');
      expect(first[0]?.admin).toBe(true);

      // Same backend, no claims. If SET LOCAL were SET, this transaction would
      // be authenticated as id_alpha and node-admin.
      const second = await shared.tx({}, readClaims);
      expect(isEmpty(second[0]?.identity ?? null)).toBe(true);
      expect(isEmpty(second[0]?.actor ?? null)).toBe(true);
      expect(second[0]?.admin).toBe(false);
    } finally {
      await shared.end();
    }
  });

  it('does not leak claims after a rolled-back transaction', async () => {
    const shared: Db = createDb(DATABASE_URL as string, { max: 1 });
    try {
      await expect(
        shared.tx({ identityId: 'id_rollback', nodeAdmin: true }, async (q) => {
          await q.query('select 1');
          throw new Error('deliberate failure');
        }),
      ).rejects.toThrow('deliberate failure');

      const after = await shared.tx({}, readClaims);
      expect(isEmpty(after[0]?.identity ?? null)).toBe(true);
      expect(after[0]?.admin).toBe(false);
    } finally {
      await shared.end();
    }
  });

  it('treats an undefined claim as unset, never as the string "undefined"', async () => {
    const rows = await db.tx({ identityId: 'id_alpha' }, readClaims);
    // The bug this guards: `String(undefined)` binds the literal text
    // "undefined", which compares unequal to every real id and equal to any
    // other request that made the same mistake.
    expect(rows[0]?.actor).not.toBe('undefined');
    expect(isEmpty(rows[0]?.actor ?? null)).toBe(true);
    expect(rows[0]?.request).not.toBe('undefined');
    expect(isEmpty(rows[0]?.request ?? null)).toBe(true);
  });

  it('rejects an rpc name that is not a bare identifier', async () => {
    await expect(db.rpc({}, 'public.foo(); drop table entities; --')).rejects.toThrow(/illegal rpc name/);
  });

  it('translates a SQLSTATE into the contract taxonomy', async () => {
    // 28000 from internal.require_identity() — a write RPC with no identity
    // bound is the canonical unauthenticated case.
    await expect(db.rpc({}, 'current_identity')).rejects.toMatchObject({
      code: 'unauthenticated',
      status: 401,
    });
  });
});
