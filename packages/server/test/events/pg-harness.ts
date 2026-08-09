/**
 * A minimal `Db` for the events lane's integration tests.
 *
 * ## Why this exists instead of importing the real client
 *
 * `src/db/client.ts` is another lane's file and is being built concurrently.
 * This lane codes against the FROZEN `Db` interface (src/db/types.ts) precisely
 * so it does not have to wait for that implementation, and importing it here
 * would give back the coupling the interface exists to remove. This harness is
 * ~60 lines, lives in the test tree, and ships nowhere.
 *
 * ## It connects as `tm8_app`, not as the superuser
 *
 * This is the point of the harness, not an incidental detail. `tm8` is the
 * database superuser and superusers BYPASS row-level security — a test run as
 * `tm8` would pass whether or not the RLS policies work, and would pass even if
 * the poll query returned every space's events to every caller. Running as
 * `tm8_app` (which has SELECT-through-policy and EXECUTE on the RPCs, and no
 * write grants at all) means the test exercises the same authority the real
 * server has.
 */
import { Pool } from 'pg';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';

/** `SET LOCAL` for the four canonical claims, via `set_config(…, is_local => true)`. */
async function applyClaims(client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, claims: DbClaims): Promise<void> {
  const bindings: Array<[string, string]> = [];
  if (claims.identityId !== undefined) bindings.push(['tm8.identity_id', claims.identityId]);
  if (claims.actorId !== undefined) bindings.push(['tm8.actor_id', claims.actorId]);
  // 'true'/'false', NOT 'on'/'off': internal.is_node_admin() compares against
  // the literal 'true', so 'on' would silently read as "not an admin".
  if (claims.nodeAdmin !== undefined) bindings.push(['tm8.node_admin', claims.nodeAdmin ? 'true' : 'false']);
  if (claims.requestId !== undefined) bindings.push(['tm8.request_id', claims.requestId]);
  for (const [name, value] of bindings) {
    await client.query('select set_config($1, $2, true)', [name, value]);
  }
}

export interface TestDb extends Db {
  /** Same as `tx`, but as the OWNER — for fixture setup that RLS would block. */
  asOwner<T>(fn: (q: Querier) => Promise<T>): Promise<T>;
}

export function createTestDb(connectionString: string): TestDb {
  const pool = new Pool({ connectionString, max: 8 });

  const querier = (client: {
    query: (
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: unknown[]; fields?: ReadonlyArray<{ name: string }> }>;
  }): Querier => ({
    async query<R>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
      const res = await client.query(sql, [...params]);
      return res.rows as R[];
    },
    // MIRRORS db/client.ts `makeQuerier`. The older shape here was
    // `select fn(...) as result`, which silently assumed every RPC returns a
    // single scalar; a `returns table(...)` function returning zero rows made
    // `rows[0]` undefined and threw. Production discriminates STRUCTURALLY on
    // 1x1, so this must too, or the harness disagrees with the server about
    // what an RPC returns.
    async rpc<T>(fn: string, args: readonly unknown[] = []): Promise<T> {
      const placeholders = args.map((_, i) => `$${String(i + 1)}`).join(', ');
      const qualified = fn.includes('.') ? fn : `public.${fn}`;
      const res = await client.query(`select * from ${qualified}(${placeholders})`, [...args]);
      if (res.rows.length === 1 && res.fields?.length === 1) {
        const field = res.fields[0];
        return (field ? (res.rows[0] as Record<string, unknown>)[field.name] : undefined) as T;
      }
      return res.rows as unknown as T;
    },
  });

  async function run<T>(role: string | null, claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      // Order matters: SET ROLE first, then the claims, so the claims are set in
      // the same transaction the role will read them from.
      if (role !== null) await client.query(`set local role ${role}`);
      await applyClaims(client, claims);
      const out = await fn(querier(client));
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    tx: (claims, fn) => run('tm8_app', claims, fn),
    asOwner: (fn) => run(null, {}, fn),
    rpc: (claims, fn, args = []) => run('tm8_app', claims, (q) => q.rpc(fn, args)),
    query: (claims, sql, params = []) => run('tm8_app', claims, (q) => q.query(sql, params)),
    end: () => pool.end(),
  };
}

/**
 * The scratch database for this lane. Skipping (rather than failing) when it is
 * unset keeps the unit tests runnable without Postgres, while a lane run always
 * sets it.
 */
export const TEST_DATABASE_URL = process.env['TM8_DATABASE_URL'];
