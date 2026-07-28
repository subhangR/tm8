/**
 * The delivery principal, in PRODUCTION SHAPE — a connection that AUTHENTICATES
 * as `tm8_delivery_worker` rather than a superuser that ASSUMES it.
 *
 * ## Why this file exists
 *
 * `internal.require_delivery_principal` (015:1346-1347) is an `AND`:
 *
 * ```sql
 * if session_user <> 'tm8_delivery_worker'
 *    and coalesce(current_setting('role', true), '') <> 'tm8_delivery_worker' then
 *   raise exception ... using errcode = '42501';
 * ```
 *
 * It raises only if BOTH limbs are false, so satisfying EITHER passes. A
 * superuser that issues `set local role tm8_delivery_worker` satisfies the
 * second limb, and the database accepts it. Measured on the full 34-file chain:
 *
 * ```
 *                                    session_user | current_user         | role GUC             | rolsuper(session_user)
 * authenticated as the worker        worker       | worker               | none                 | f
 * superuser + `set local role`       tm8          | worker               | tm8_delivery_worker  | t
 * ```
 *
 * `current_user` and the `role` GUC read identically in the impersonating case,
 * so a guard written against either **passes in exactly the case it exists to
 * catch**. Only `session_user` survives `SET ROLE`.
 *
 * **And a third value with the same trap, measured here and not previously
 * written down:** `current_setting('is_superuser')` reads `off` in the
 * impersonating row too, because `SET ROLE` to a non-superuser drops the flag.
 * It is NOT a discriminator. The production boot check
 * (`execution.ts:355-368`, `verifyDeliveryPrincipal`) correctly uses
 * `pg_roles.rolsuper WHERE rolname = session_user` instead; this file mirrors
 * that exact predicate so the test's premise and the node's boot assertion
 * cannot drift apart.
 *
 * ## What this replaces, and why it was a finding rather than a chore
 *
 * `w1-foundations.test.ts` and `w2-messages-handoffs.pg.test.ts` reached the
 * three delivery RPCs by `set local role` from the SUPERUSER scratch pool.
 * Measured consequence: those suites produce the IDENTICAL observable against a
 * chain with the role guard and against a chain with the role check DELETED
 * ENTIRELY. They carried no information about which world they ran in — they
 * were not weak tests of the guard, they were not tests of the guard — and they
 * would have turned red on the tightening of `015` for a reason unrelated to the
 * tightening being wrong.
 *
 * The correct pattern already existed twelve files away at
 * `w2-execution.pg.test.ts:321-324`, whose own header named this exact defect in
 * these exact two files. The knowledge existed and did not transfer; that is why
 * it lives in a shared module now instead of being open-coded a third time.
 *
 * ## The premise is ASSERTED, never assumed
 *
 * Every transaction opened here proves, in-band and before running the caller's
 * body, that it really did authenticate. A future edit that points the URL back
 * at the superuser fails loudly instead of silently restoring the defect. A test
 * whose whole subject is *which principal am I* must not take its own principal
 * on trust.
 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export const DELIVERY_ROLE = 'tm8_delivery_worker';

/**
 * Rewrite a scratch-database URL to authenticate as the delivery worker.
 *
 * `015:17` creates the role `login noinherit nosuperuser` with no password, and
 * `015:20` grants it CONNECT on the database the migration is applied to — so on
 * a trust-auth development cluster the empty password is correct and sufficient.
 * `TM8_DELIVERY_WORKER_PASSWORD` covers a cluster configured with md5/scram.
 *
 * There is deliberately NO conditional skip when the connection cannot be made.
 * A conditional skip that currently passes is invisible to every skip count
 * anyone runs; an unreachable delivery principal is a real result and is
 * reported as a red with a reason.
 */
export function deliveryPrincipalUrl(scratchUrl: string): string {
  const url = new URL(scratchUrl);
  url.username = DELIVERY_ROLE;
  url.password = process.env['TM8_DELIVERY_WORKER_PASSWORD'] ?? '';
  return url.toString();
}

export interface DeliveryPrincipalObservation {
  session_user: string;
  current_user: string;
  role_guc: string;
  session_user_is_superuser: boolean | null;
}

export interface DeliveryPrincipalPool {
  readonly url: string;
  /** The principal facts, read over this pool. Exposed so a test can assert them itself. */
  observe(): Promise<DeliveryPrincipalObservation>;
  /**
   * Run `fn` in a transaction that has PROVEN it authenticated as the delivery
   * worker and has NOT assumed the role.
   */
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;
  end(): Promise<void>;
}

const OBSERVE_SQL = `select session_user::text as session_user,
                            current_user::text as current_user,
                            coalesce(current_setting('role', true), 'none') as role_guc,
                            (select rolsuper from pg_roles where rolname = session_user)
                              as session_user_is_superuser`;

function assertAuthenticated(seen: DeliveryPrincipalObservation, url: string): void {
  const redacted = url.replace(/:[^:@/]*@/, ':***@');
  if (seen.session_user !== DELIVERY_ROLE) {
    throw new Error(
      `delivery principal pool must AUTHENTICATE as '${DELIVERY_ROLE}', not merely be able to assume it — ` +
        `session_user is '${seen.session_user}' (current_user '${seen.current_user}'). ` +
        `session_user is the assertion because it is the only one of the three that survives SET ROLE: ` +
        `current_user, the role GUC and current_setting('is_superuser') all read as the worker ` +
        `when a superuser impersonates it. URL: ${redacted}`,
    );
  }
  if (seen.session_user_is_superuser === true) {
    throw new Error(
      `delivery principal '${DELIVERY_ROLE}' has rolsuper=true on this cluster; ` +
        `015:17 creates it NOSUPERUSER, so it has been ALTERed. A superuser worker makes every ` +
        `privilege assertion in this suite vacuous. URL: ${redacted}`,
    );
  }
  if (seen.role_guc !== 'none') {
    throw new Error(
      `delivery principal transaction has an assumed role in play (role GUC '${seen.role_guc}'). ` +
        `This pool must reach the delivery RPCs with NO SET ROLE at all — an assumed role would ` +
        `re-satisfy 015:1347's second limb and reintroduce the defect this pool exists to remove.`,
    );
  }
}

/**
 * Build a delivery-principal pool over an already-migrated scratch database.
 *
 * MUST be created after `015` has been applied: the CONNECT grant the worker
 * needs is issued by `015:20` against `current_database()`. `pg.Pool` connects
 * lazily, so construction before first query is harmless, but the ordering is
 * stated because a missing CONNECT grant surfaces as an authentication error
 * that reads like a cluster misconfiguration.
 */
export function createDeliveryPrincipalPool(scratchUrl: string): DeliveryPrincipalPool {
  const url = deliveryPrincipalUrl(scratchUrl);
  // 5 concurrent reservations are raced in w1-foundations' B2 budget test; the
  // cap is above that so the race is a database race and not a pool queue.
  const pool = new Pool({ connectionString: url, max: 12 });

  const observeOn = async (client: PoolClient): Promise<DeliveryPrincipalObservation> =>
    (await client.query<DeliveryPrincipalObservation>(OBSERVE_SQL)).rows[0]!;

  return {
    url,
    async observe(): Promise<DeliveryPrincipalObservation> {
      const client = await pool.connect();
      try {
        return await observeOn(client);
      } finally {
        client.release();
      }
    },
    async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        assertAuthenticated(await observeOn(client), url);
        const result = await fn(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async query<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<R[]> {
      const client = await pool.connect();
      try {
        assertAuthenticated(await observeOn(client), url);
        return (await client.query<R>(sql, [...params])).rows;
      } finally {
        client.release();
      }
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
}
