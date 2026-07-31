/**
 * `Db` over a `pg` Pool — the only pool that BINDS CALLER CLAIMS.
 *
 * Not the only pool in the server: `facade/services/w2/execution.ts` opens a
 * second one authenticating as `tm8_delivery_worker`, which runs as a different
 * role and carries no caller identity. The invariant worth holding is the claim
 * binding, not a count — a count goes stale on the next pool, and
 * `test/one-identity-path.test.ts` already enforces this file as the sole binder
 * by path.
 *
 * Two rules govern everything in this file, and both exist because a pool
 * reuses connections between unrelated requests:
 *
 * 1. **Claims are SET LOCAL, always.** `SET LOCAL` dies at COMMIT/ROLLBACK. A
 *    claim that survived the transaction would hand the next request whoever
 *    the previous one was — the single worst bug this layer can have. See
 *    `test/db/claims.test.ts`, which proves it empirically rather than by
 *    inspection.
 *
 * 2. **`SET LOCAL` cannot take a bind parameter.** `SET LOCAL tm8.identity_id
 *    = $1` is a plain syntax error in Postgres: SET's argument is parsed, not
 *    bound. The function form does take parameters —
 *    `select set_config('tm8.identity_id', $1, true)` with `true` meaning
 *    local-to-transaction — which is why every claim goes through set_config,
 *    and incidentally why claim binding is injection-safe here.
 *
 * The trusted claim surface is exactly four settings (STATE 'Claims contract'):
 * `tm8.identity_id`, `tm8.actor_id`, `tm8.node_admin`, `tm8.request_id`. RLS
 * resolves membership and can_act_as from TABLES, so there is no fifth.
 */
import pg from 'pg';
import { CollabError } from '@tm8/contract';
import type { Db, DbClaims, Querier } from './types.js';
import { translateDbError } from './errors.js';

/**
 * `node_admin` is bound as the string `'true'` / `'false'`.
 *
 * NOT `'on'`/`'off'`. `internal.is_node_admin()` (001_core_graph.sql:166) is
 * literally:
 *
 *     coalesce(lower(claim_text('tm8.node_admin')) = 'true', false)
 *
 * so `'on'` evaluates to FALSE and a caller bound that way silently is not a
 * node admin. Verified against tm8_deneb, not inferred; `identity/claims.ts`
 * and `db/types.ts` were corrected to agree (Orion, 2026-07-25).
 *
 * The failure mode is why this is spelled out at the binding site: a
 * mis-spelled claim READS AS DENIED rather than raising, so a claims bug
 * presents as an RLS bug and gets debugged in the wrong file.
 */
function nodeAdminClaim(value: boolean | undefined): string {
  return value === true ? 'true' : 'false';
}

/**
 * An absent claim binds as the empty string, which `internal.claim_text`
 * (001:147) normalises straight back to NULL — so `''` IS "unset" as far as
 * every predicate in the schema is concerned.
 *
 * Why bind it at all instead of skipping the statement: binding all four every
 * transaction means a claim can never be inherited, even if some other code
 * path ever issues a non-local `SET`. Skipping would rely on SET LOCAL being
 * the only writer, which is true today and is exactly the kind of assumption
 * that stops being true quietly.
 *
 * `undefined` and `null` both become `''`. They never become the string
 * "undefined", which would be a claim value that compares equal to nothing and
 * unequal to everything — authorizing or denying the wrong thing in silence.
 */
function claimValue(value: string | undefined): string {
  return value === undefined || value === null ? '' : String(value);
}

const BIND_CLAIMS_SQL = `select
  set_config('tm8.identity_id', $1, true),
  set_config('tm8.actor_id',    $2, true),
  set_config('tm8.node_admin',  $3, true),
  set_config('tm8.request_id',  $4, true)`;

/**
 * An RPC name must be a bare (optionally schema-qualified) identifier. `fn` is
 * the ONE thing in this file that reaches SQL by interpolation rather than
 * binding — Postgres has no way to parameterise a function name — so it is
 * constrained to a shape that cannot carry anything else.
 */
const RPC_NAME_RE = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/;

function rpcSql(fn: string, argCount: number): string {
  if (!RPC_NAME_RE.test(fn)) {
    throw new CollabError('invalid_input', `illegal rpc name: ${JSON.stringify(fn)}`);
  }
  const qualified = fn.includes('.') ? fn : `public.${fn}`;
  const placeholders = Array.from({ length: argCount }, (_, i) => `$${i + 1}`).join(', ');
  return `select * from ${qualified}(${placeholders})`;
}

/**
 * Unwrap an RPC result.
 *
 * The 007 catalog has two return shapes and this is the seam that keeps both
 * usable through one method:
 *
 * - the command RPCs return a single `jsonb` (the CommandResult), which
 *   `select * from f(...)` renders as one row with one column — unwrapped here
 *   to the value itself, so callers get the object they expect;
 * - the compound reads (`entity_tree`, `ready_to_work`, `leaderboard`) are
 *   `returns table(...)`, i.e. many rows of many columns — returned as the row
 *   array.
 *
 * The discriminator is structural (1×1 or not), so it cannot disagree with
 * what the function actually declared.
 */
function unwrapRpc<T>(result: pg.QueryResult): T {
  if (result.rows.length === 1 && result.fields.length === 1) {
    const row = result.rows[0] as Record<string, unknown>;
    const field = result.fields[0];
    return (field ? row[field.name] : undefined) as T;
  }
  return result.rows as unknown as T;
}

function makeQuerier(client: pg.PoolClient): Querier {
  return {
    async query<R = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
      try {
        const result = await client.query(sql, params as unknown[]);
        return result.rows as R[];
      } catch (err) {
        throw translateDbError(err);
      }
    },
    async rpc<T = unknown>(fn: string, args: readonly unknown[] = []): Promise<T> {
      const sql = rpcSql(fn, args.length);
      try {
        const result = await client.query(sql, args as unknown[]);
        return unwrapRpc<T>(result);
      } catch (err) {
        throw translateDbError(err);
      }
    },
  };
}

export interface PgDbOptions {
  readonly databaseUrl: string;
  /** Pool ceiling. Small on purpose: this is a single-user local node. */
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
  /**
   * Server-enforced ceiling on any single statement. The interactive reads
   * this pool serves complete in milliseconds; a statement still running after
   * this long is a bug, and without the ceiling it holds one of `max` clients
   * against every other request on the node.
   */
  readonly statementTimeoutMillis?: number;
  /**
   * Server-enforced ceiling on a transaction sitting idle between statements.
   * This is the guard for the failure this pool has actually had in the field:
   * a `tx` callback that awaits something that never resolves leaves its
   * connection `idle in transaction` FOREVER — invisible to `/health`, fatal
   * to every space-scoped read once it has happened `max` times. Postgres
   * kills such a session at this timeout; the pool evicts the dead client and
   * the node degrades for seconds instead of until someone runs
   * `pg_terminate_backend` by hand.
   */
  readonly idleInTransactionTimeoutMillis?: number;
  /**
   * Local test mode only. Passed as a per-connection PostgreSQL startup
   * setting, not a request claim, so it cannot be influenced by an HTTP
   * caller and does not widen the four-claim RLS contract.
   */
  readonly idempotencyEnabled?: boolean;
}

/**
 * How long a transaction may stay open before the watchdog names it in the
 * log. Diagnosis, not enforcement: the kill belongs to Postgres (see
 * `idleInTransactionTimeoutMillis`); this exists so the log says WHICH call
 * path was holding the client when it happened, which `pg_stat_activity`
 * cannot.
 */
const TX_WATCHDOG_MILLIS = 10_000;

export class PgDb implements Db {
  private readonly pool: pg.Pool;

  constructor(options: PgDbOptions) {
    this.pool = new pg.Pool({
      connectionString: options.databaseUrl,
      max: options.max ?? 8,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      // Startup parameters, applied by the server per connection — a stuck
      // statement or an abandoned transaction is killed by Postgres itself,
      // so no Node-side failure mode can wedge a pooled client permanently.
      statement_timeout: options.statementTimeoutMillis ?? 30_000,
      idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMillis ?? 30_000,
      options: `-c tm8.idempotency_enabled=${options.idempotencyEnabled === false ? 'off' : 'on'}`,
    });
    // An idle-client error (server restart, sidecar bounce) is emitted on the
    // pool, and an unhandled 'error' event on an EventEmitter takes the process
    // down. The pool discards the broken client either way; we only have to not
    // die about it.
    this.pool.on('error', (err) => {
      console.error(`[db] idle client error: ${err.message}`);
    });
  }

  async tx<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // Captured BEFORE any await so the trace names the caller, not the pool
    // internals. When Postgres kills a wedged transaction (see
    // `idleInTransactionTimeoutMillis`) the error surfaces wherever the NEXT
    // query runs — this log line is the only thing that names the code that
    // was actually holding the client.
    const openedAt = new Error('transaction opened here');
    const watchdog = setTimeout(() => {
      console.warn(
        `[db] transaction still open after ${TX_WATCHDOG_MILLIS}ms ` +
          `(request ${claims.requestId ?? 'unknown'})\n${openedAt.stack}`,
      );
    }, TX_WATCHDOG_MILLIS);
    watchdog.unref?.();
    try {
      await client.query('begin');
      // One round trip, immediately after BEGIN and before any other statement:
      // nothing in the transaction may ever observe an unbound claim.
      await client.query(BIND_CLAIMS_SQL, [
        claimValue(claims.identityId),
        claimValue(claims.actorId),
        nodeAdminClaim(claims.nodeAdmin),
        claimValue(claims.requestId),
      ]);

      const result = await fn(makeQuerier(client));
      await client.query('commit');
      return result;
    } catch (err) {
      try {
        await client.query('rollback');
      } catch {
        // The connection is already unusable; `release(err)` below evicts it
        // from the pool rather than handing a poisoned client to the next
        // caller. Reporting the rollback failure would mask the real error.
      }
      throw translateDbError(err);
    } finally {
      clearTimeout(watchdog);
      client.release();
    }
  }

  rpc<T = unknown>(claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    return this.tx(claims, (q) => q.rpc<T>(fn, args));
  }

  query<R = Record<string, unknown>>(
    claims: DbClaims,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    return this.tx(claims, (q) => q.query<R>(sql, params));
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

/** The composition root's entry point. One pool per process, created once. */
export function createDb(databaseUrl: string, options: Omit<PgDbOptions, 'databaseUrl'> = {}): Db {
  return new PgDb({ databaseUrl, ...options });
}
