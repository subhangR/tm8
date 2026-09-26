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

/**
 * The fifth binding is the ROLE DOWNGRADE (Identity v2 Stage 1, trap 3).
 *
 * The connection string is historically a superuser with `rolbypassrls`,
 * which left migration 008's RLS policies inert on every read this pool
 * served. Dropping to the app role per transaction makes them real:
 * `set_config('role', …, true)` is exactly `SET LOCAL ROLE`, dies at
 * COMMIT/ROLLBACK with the claims, and cannot leak between pooled requests.
 * SECURITY DEFINER RPCs are unaffected (they run as the schema owner);
 * direct reads now see only what the bound claims entitle them to.
 *
 * This is deliberately in the same round trip as the claims: nothing in the
 * transaction may ever observe superuser reads with caller claims bound —
 * that combination is the entire defect this line removes.
 */
/**
 * `tm8.auth_kind` — the FIFTH claim, added by 082 (architect ruling R11).
 *
 * It carries the SERVER-RESOLVED kind of the auth session — `browser`, `cli`,
 * `agent` or `agent_runtime` — read out of `auth_sessions` by token hash in `resolveBearerIdentity`
 * and never asserted by the client.
 *
 * WHY WIDENING THE TRUSTED SURFACE IS LEGITIMATE HERE, AND ONLY HERE. The
 * standing rule above ("RLS resolves membership and can_act_as from TABLES, so
 * there is no fifth") exists to keep STALE authorization out of claims: every
 * path that changes membership opens a window where the claim disagrees with
 * the rows, and RLS answers from the claim. That objection does not apply to
 * `kind`. An auth session's kind is fixed when the session is issued and is
 * IMMUTABLE for its whole life — there is no verb anywhere that changes one, so
 * there is no window in which the claim can disagree with the row.
 *
 * WHAT READS IT: `internal.require_human_auth_kind()` (082), which gates all
 * four `credentials.*` RPCs. It FAILS CLOSED — null, empty and unrecognised all
 * refuse — which is why an omitted claim binds as `''` below rather than being
 * skipped, and why no caller that forgets to supply a kind can accidentally be
 * treated as human. The reason this matters is measured (sub-doc 14, C7): an
 * agent's `TM8_AGENT_TOKEN` carries its owner's FULL identity, not a reduced
 * principal, so `identity_id()`, `can_act_as` and `is_space_member` all answer
 * as the human. `kind` is the ONLY thing that distinguishes them.
 *
 * `tm8.session_space_id` — the SIXTH claim (227, plan W0a). The one space an
 * agent session may act in, read from `auth_sessions.space_id` (226) and bound
 * only for agent kinds while `TM8_SPACE_SESSIONS` is not `off`. Every
 * membership helper intersects with it, so the owner's full identity is
 * narrowed to that space. Immutable for the session's life, like `kind`.
 *
 * `tm8.via_link` — the SEVENTH claim (992, W7p). The space link a `link`
 * session, or an agent session minted under one, descends from
 * (`auth_sessions.via_link_id`). Written once by the issuing RPC, like the
 * two above; `internal.link_bound()` reads it.
 */
const BIND_CLAIMS_SQL = `select
  set_config('tm8.identity_id', $1, true),
  set_config('tm8.actor_id',    $2, true),
  set_config('tm8.node_admin',  $3, true),
  set_config('tm8.request_id',  $4, true),
  set_config('tm8.auth_kind',   $5, true),
  set_config('tm8.session_space_id', $6, true),
  set_config('tm8.via_link',    $7, true),
  set_config('role',            $8, true)`;

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
   *
   * It must stay BELOW the client deadline (`DEFAULT_TIMEOUT_MS`, 15s, in both
   * `packages/cli/src/client.ts` and `packages/tm8-ui/src/data/real/http.ts`).
   * The default was 30s, which is a sound answer to "how long before a wedged
   * client is permanently stuck" and the wrong answer to "how long may a slot
   * be held for a caller who has already left". Nothing cancels a query when
   * the HTTP client disconnects — the JSON response path registers no `close`
   * handler and this module has no cancellation primitive — so a 30s ceiling
   * against a 15s deadline means every timed-out request keeps burning one of
   * `max` slots for 15s MORE while the UI retries into a pool that is filling
   * with work nobody awaits. Measured on prod 2026-09-17: pool 32/32 active,
   * `waiting=0`, every backend CPU-bound. Set it under the deadline so an
   * abandoned statement dies with its caller rather than outliving it.
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
  /**
   * The role every claim-binding transaction runs as (T-L11: low-privilege
   * role, per-transaction claims). Defaults to `tm8_app` — the role 008's
   * policies are written for. The session user must be a member of it (a
   * superuser always is); a connection that cannot assume it fails its first
   * transaction loudly rather than serving bypass-RLS reads quietly.
   */
  readonly role?: string;
}

/**
 * How long a transaction may stay open before the watchdog names it in the
 * log. Diagnosis, not enforcement: the kill belongs to Postgres (see
 * `idleInTransactionTimeoutMillis`); this exists so the log says WHICH call
 * path was holding the client when it happened, which `pg_stat_activity`
 * cannot.
 */
const TX_WATCHDOG_MILLIS = 10_000;

/** Timer rounding allowance when deciding a checkout ran out its deadline. */
const POOL_TIMER_SLACK_MILLIS = 10;

/**
 * A checkout that had to QUEUE because every pooled client was in use, and
 * then gave up at `connectionTimeoutMillis`.
 *
 * pg-pool reports this as a bare `Error('timeout exceeded when trying to
 * connect')` — no SQLSTATE, so `translateDbError` passes it through and
 * `sendWireError` turns it into the generic `internal server error` 503. That
 * is the text the UI showed for a launch while the pool sat at 32/32 behind
 * list reads (prod 2026-09-24: 145 of 362 half-second samples had >=31 of 32
 * backends active; `/health`'s `select 1`, same pool, went from 3ms to ~0.6s
 * p50 at saturation while a non-DB path stayed at ~1ms). A spawn opens ~20
 * transactions in sequence, so it is the request most likely to lose one of
 * these races — and the one whose failure said least about why.
 *
 * Decided by the pool's own state at checkout (full, nothing idle), never by
 * the error text: a connect that failed WITHOUT queueing (database down, auth)
 * is a different fault and is rethrown untouched.
 */
export class DbPoolExhaustedError extends CollabError {
  constructor(waitedMs: number, inUse: number, max: number, waiting: number) {
    super(
      'upstream_unavailable',
      `database busy: no connection became free within ${waitedMs}ms (${inUse}/${max} in use, ${waiting} waiting)`,
      {
        retryable: true,
        details: { reason: 'db_pool_exhausted', waitedMs, inUse, max, waiting, retryAfterSeconds: 1 },
      },
    );
  }
}

export class PgDb implements Db {
  private readonly pool: pg.Pool;
  private readonly role: string;
  private readonly max: number;
  private readonly connectionTimeoutMillis: number;

  constructor(options: PgDbOptions) {
    this.role = options.role ?? 'tm8_app';
    this.max = options.max ?? 8;
    this.connectionTimeoutMillis = options.connectionTimeoutMillis ?? 5_000;
    this.pool = new pg.Pool({
      connectionString: options.databaseUrl,
      max: this.max,
      connectionTimeoutMillis: this.connectionTimeoutMillis,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      // Startup parameters, applied by the server per connection — a stuck
      // statement or an abandoned transaction is killed by Postgres itself,
      // so no Node-side failure mode can wedge a pooled client permanently.
      statement_timeout: options.statementTimeoutMillis ?? 12_000,
      idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMillis ?? 30_000,
      // JIT OFF, per connection. Every statement this pool runs is a short
      // interactive read or write, and JIT only ever costs such a statement:
      // once the planner's estimate crosses `jit_above_cost` (100k — easy for
      // an entity read whose RLS predicates call functions over tables with
      // no statistics yet), Postgres pays LLVM compilation on EVERY execution,
      // hundreds of ms each, before returning a handful of rows. A full
      // command result is ~60 such statements in one request, so the request
      // crossed the clients' 15s deadline while no single statement came near
      // `statement_timeout`. Measured in CI (postgres:17, JIT built in): one
      // backend CPU-bound for 45s across a run of SELECTs, RSS 61→175 MB as
      // LLVM loaded; `task link-pr` timed out at 15s and the byte-measurement
      // test hung 600s. Homebrew Postgres is built without LLVM
      // (`pg_jit_available()` = false), which is why it never reproduced on a
      // Mac. Set here rather than in the cluster so every node gets it,
      // whatever its Postgres was built with.
      options: `-c tm8.idempotency_enabled=${options.idempotencyEnabled === false ? 'off' : 'on'} -c jit=off`,
    });
    // An idle-client error (server restart, sidecar bounce) is emitted on the
    // pool, and an unhandled 'error' event on an EventEmitter takes the process
    // down. The pool discards the broken client either way; we only have to not
    // die about it.
    this.pool.on('error', (err) => {
      console.error(`[db] idle client error: ${err.message}`);
    });
  }

  /** `pool.connect()`, with a queued-then-timed-out checkout named for what it is. */
  private async checkout(): Promise<pg.PoolClient> {
    // Sampled BEFORE connecting: only a checkout that found the pool full had
    // to wait in its queue, and only that wait can end in pool exhaustion.
    const queued = this.pool.totalCount >= this.max && this.pool.idleCount === 0;
    const startedAt = Date.now();
    try {
      return await this.pool.connect();
    } catch (err) {
      // Queued is necessary, not sufficient. pg-pool serves a queued waiter
      // with a NEW client when a slot frees (_pulseQueue -> newClient), so a
      // Postgres restart or backend kill rejects a queued checkout quickly
      // with ECONNREFUSED / 57P03 / 53300 — a different fault that must pass
      // through untouched. Only a wait that ran out the acquire deadline is
      // exhaustion. The slack absorbs timer rounding (a timer may fire a
      // millisecond early against Date.now()).
      const waitedMs = Date.now() - startedAt;
      if (!queued || waitedMs < this.connectionTimeoutMillis - POOL_TIMER_SLACK_MILLIS) throw err;
      const exhausted = new DbPoolExhaustedError(
        waitedMs,
        this.pool.totalCount - this.pool.idleCount,
        this.max,
        this.pool.waitingCount,
      );
      console.error(`[db] ${exhausted.message} (${err instanceof Error ? err.message : String(err)})`);
      throw exhausted;
    }
  }

  async tx<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    const client = await this.checkout();
    // THE POOL GUARD IN THE CONSTRUCTOR DOES NOT COVER THIS CLIENT.
    //
    // `pool.on('error')` is only consulted for clients sitting IDLE in the pool.
    // A client that has been checked out emits on itself, and pg says so in the
    // shape of the report: "Emitted 'error' event on Client instance ... at
    // Client._handleErrorEvent". Nothing listens there, and an unhandled
    // 'error' on an EventEmitter is rethrown out of the socket callback — not
    // into the `await` below, where the catch is, but at the top of the stack,
    // which exits the process.
    //
    // This is not hypothetical and it is not rare: `idleInTransactionTimeoutMillis`
    // above ARMS Postgres to terminate exactly this client, by design, whenever a
    // transaction stalls for 30s. So the one failure the pool deliberately
    // provokes is the one failure nothing catches. Measured on a live node:
    // three process deaths (2026-08-17, 08-18, 08-21), each `SQLSTATE 25P03`
    // reaching `throw er`, each taking every running agent session down with it
    // — nine `claude` processes on one of them — while `Restart=on-failure`
    // brought the node back so cleanly that the loss left no trace in the
    // service record.
    //
    // A stalled transaction is recoverable: the query rejects, `catch` rolls
    // back, `release()` evicts the poisoned client and the next caller gets a
    // fresh one. Every part of that already works. It is only reachable if the
    // process is still alive to run it.
    const absorbClientError = (err: Error): void => {
      console.error(
        `[db] checked-out client error (request ${claims.requestId ?? 'unknown'}): ${err.message}`,
      );
    };
    client.on('error', absorbClientError);
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
        // K6 (W3): the one branch every caller shares. A space-pinned session
        // never binds node admin, whatever claims builder produced `claims`.
        nodeAdminClaim(claims.sessionSpaceId ? false : claims.nodeAdmin),
        claimValue(claims.requestId),
        // Absent binds as `''`, which `internal.claim_text` normalises to NULL
        // and `require_human_auth_kind` refuses. Fail-closed by construction:
        // every caller that does not know its own kind is not human.
        claimValue(claims.authKind),
        // Absent binds as `''`: unpinned, every helper answers as before 227.
        claimValue(claims.sessionSpaceId),
        // 992 (W7p). Absent binds as `''`: not link-bound.
        claimValue(claims.viaLinkId),
        this.role,
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
      // BEFORE `release()`, and always. A pooled client is reused, so a listener
      // left attached would accumulate one per checkout on every long-lived
      // connection until Node warns about a leak and the log gains a duplicate
      // line per past transaction. Removing it also hands the client back in the
      // state the pool expects: unlistened, and covered again by the pool guard
      // for as long as it is idle.
      client.off('error', absorbClientError);
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
