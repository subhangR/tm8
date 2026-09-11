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
import {
  CollabError,
  DB_CONNECT_TIMEOUT_MS,
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  DB_STATEMENT_TIMEOUT_MS,
} from '@tm8/contract';
import type { Db, DbClaims, Querier } from './types.js';
import { createCancelChannel, type CancelChannel } from './cancel.js';
import { translateDbError } from './errors.js';
import { currentRequestScope } from './request-scope.js';

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
 */
const BIND_CLAIMS_SQL = `select
  set_config('tm8.identity_id', $1, true),
  set_config('tm8.actor_id',    $2, true),
  set_config('tm8.node_admin',  $3, true),
  set_config('tm8.request_id',  $4, true),
  set_config('tm8.auth_kind',   $5, true),
  set_config('role',            $6, true)`;

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

/** SQLSTATE `query_canceled` — what a cancelled statement raises. */
const QUERY_CANCELED = '57014';

/**
 * The error a read raises when its caller has already hung up.
 *
 * `upstream_unavailable` because the closed taxonomy (contract §4) has no
 * `cancelled` code and this IS the honest slot: the node produced no answer.
 * Retryable, because the request was never refused on its merits — a client
 * that asks again gets a real attempt. Nothing is expected to read it: by
 * construction the socket it would be written to is gone.
 */
function abandonedRead(): CollabError {
  return new CollabError('upstream_unavailable', 'the client stopped waiting for this read', {
    retryable: true,
    details: { abandoned: true },
  });
}

/**
 * ONE TRANSACTION'S RIGHT TO BE CANCELLED, and the gate on it.
 *
 * THE RULE, and it is the load-bearing one in this change: **a read is
 * cancellable, a command is not.** `Querier.query` is raw parameterised SQL and
 * is READS ONLY by the seam's own contract (`db/types.ts`); `Querier.rpc` is
 * the only write path there is. So a transaction that has issued an `rpc` is
 * SEALED — permanently, for the rest of its life — and nothing in it will be
 * cancelled afterwards.
 *
 * WHY SEAL RATHER THAN RELY ON ROLLBACK. Cancelling mid-command could not
 * corrupt anything: Postgres aborts the whole transaction, our catch rolls it
 * back, and the write either happened entirely or not at all. Atomicity is not
 * the risk. The risk is INTENT. A user who clicks send and closes the tab has
 * sent a message; today that write lands, and silently converting it into a
 * write that gets thrown away because their browser was quick about closing the
 * socket would be a behaviour change nobody asked for and nobody could see. So
 * the seal is not about safety from partial writes — it is about not quietly
 * withdrawing work the caller already committed to.
 *
 * A read that runs BEFORE any rpc in the same transaction is still cancellable:
 * if it is cancelled the transaction rolls back before the rpc is ever reached,
 * so there is no write to lose.
 */
class TxCancellation {
  private sealed = false;
  private cancelled = false;
  private listener: (() => void) | undefined;
  /** Bumped on every arm and every disarm; see `armRead`. */
  private epoch = 0;

  constructor(
    private readonly client: pg.PoolClient,
    private readonly channel: CancelChannel,
    private readonly signal: AbortSignal | undefined,
  ) {}

  /** A command ran. Nothing in this transaction may be cancelled from here on. */
  seal(): void {
    this.sealed = true;
    this.disarm();
  }

  /**
   * Called immediately before a READ statement goes on the wire.
   *
   * Throws when the caller is ALREADY gone, which is strictly better than
   * cancelling: the statement never starts, so there is no window in which a
   * CancelRequest could race a query that has not begun and cancel nothing.
   */
  armRead(): void {
    if (this.sealed || this.signal === undefined || !this.channel.available) return;
    if (this.signal.aborted) throw abandonedRead();
    // Identity of the statement this arming covers. `stillWanted` below asks
    // "is the SAME read still in flight?", which a boolean could not answer:
    // by the time the cancel socket connects, this transaction may have moved
    // on to a different statement on the same client.
    const arming = ++this.epoch;
    const fire = (): void => {
      this.cancelled = true;
      // Fire-and-forget by design (see cancel.ts): there is no answer to wait
      // for, and the statement's own rejection is what unblocks the caller.
      void this.channel.cancel(this.client, () => this.epoch === arming);
    };
    this.listener = fire;
    this.signal.addEventListener('abort', fire, { once: true });
  }

  /** Called when a read statement settles, however it settled. */
  disarm(): void {
    // Invalidates any cancel already in flight for the statement that just
    // ended — see `armRead`. Bumping FIRST means a `fire` racing this call
    // still finds a stale epoch at send time.
    this.epoch += 1;
    if (this.listener && this.signal) {
      this.signal.removeEventListener('abort', this.listener);
    }
    this.listener = undefined;
  }

  /**
   * Rewrite a cancellation WE caused into the abandoned-read error.
   *
   * The two ways to see 57014 are our cancel and `statement_timeout`, and they
   * mean opposite things — one is the system working, one is a query that
   * overran its budget with someone still waiting. Postgres tells them apart
   * only in the message text, which this layer does not read on principle
   * (`db/errors.ts`). It does not have to: the guard KNOWS whether it fired.
   */
  translate(err: unknown): unknown {
    if (!this.cancelled) return err;
    const sqlState = (err as { code?: unknown } | null)?.code;
    return sqlState === QUERY_CANCELED ? abandonedRead() : err;
  }
}

function makeQuerier(client: pg.PoolClient, cancellation: TxCancellation): Querier {
  return {
    async query<R = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
      cancellation.armRead();
      try {
        const result = await client.query(sql, params as unknown[]);
        return result.rows as R[];
      } catch (err) {
        throw translateDbError(cancellation.translate(err));
      } finally {
        cancellation.disarm();
      }
    },
    async rpc<T = unknown>(fn: string, args: readonly unknown[] = []): Promise<T> {
      // BEFORE the statement, not after: the seal must hold for the statement
      // that establishes it, not merely for the ones that follow it.
      cancellation.seal();
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
   * DEFAULTS TO `DB_STATEMENT_TIMEOUT_MS`, which `@tm8/contract`'s `timeouts.ts`
   * owns along with the reasoning. Same 30s as the literal it replaces — this is
   * a BACKSTOP for work with nobody waiting on it, and shortening it to fit
   * inside the client's 15s was measured and rejected there. What actually stops
   * an abandoned read is cancellation, below; do not reintroduce a literal here,
   * and do not tighten this one without reading that file first.
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

export class PgDb implements Db {
  private readonly pool: pg.Pool;
  private readonly role: string;
  /**
   * How an abandoned read is stopped. Built once per pool because it resolves
   * the target address at construction — a cancel is issued when a request is
   * already going badly, and is not the place to parse a URL.
   */
  private readonly cancelChannel: CancelChannel;

  constructor(options: PgDbOptions) {
    this.role = options.role ?? 'tm8_app';
    this.cancelChannel = createCancelChannel(options.databaseUrl);
    this.pool = new pg.Pool({
      connectionString: options.databaseUrl,
      max: options.max ?? 8,
      // Both ceilings below live in `@tm8/contract`'s `timeouts.ts` with their
      // reasoning, alongside the client's `REQUEST_TIMEOUT_MS` that they used to
      // contradict — one file so a future change has to see all three at once.
      // They are NOT two halves of one budget: waiting for a connection is
      // bounded by the caller's patience, while a statement is bounded by the
      // work it has to finish for callers who may already be gone.
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? DB_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      // Startup parameters, applied by the server per connection — a stuck
      // statement or an abandoned transaction is killed by Postgres itself,
      // so no Node-side failure mode can wedge a pooled client permanently.
      statement_timeout: options.statementTimeoutMillis ?? DB_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout:
        options.idleInTransactionTimeoutMillis ?? DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
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
    // WHO, IF ANYONE, IS STILL WAITING — read before the pool is touched.
    //
    // `undefined` outside an HTTP request (the scheduler, boot, tests) and for
    // work deliberately detached from one, and it means the same thing in every
    // case: nothing here is cancellable. See db/request-scope.ts.
    const signal = currentRequestScope()?.signal;
    // Nobody is waiting and we have not spent anything yet. Checking out a
    // client to run a read whose answer is already unwanted is the cheapest
    // instance of exactly the waste this whole mechanism exists to remove — and
    // under the load where it matters, that client is the scarce thing.
    if (signal?.aborted === true) throw abandonedRead();

    const client = await this.pool.connect();
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
    const cancellation = new TxCancellation(client, this.cancelChannel, signal);
    try {
      await client.query('begin');
      // One round trip, immediately after BEGIN and before any other statement:
      // nothing in the transaction may ever observe an unbound claim.
      await client.query(BIND_CLAIMS_SQL, [
        claimValue(claims.identityId),
        claimValue(claims.actorId),
        nodeAdminClaim(claims.nodeAdmin),
        claimValue(claims.requestId),
        // Absent binds as `''`, which `internal.claim_text` normalises to NULL
        // and `require_human_auth_kind` refuses. Fail-closed by construction:
        // every caller that does not know its own kind is not human.
        claimValue(claims.authKind),
        this.role,
      ]);

      const result = await fn(makeQuerier(client, cancellation));
      // COMMIT IS NEVER CANCELLABLE, and the seal below says so for the case
      // that would otherwise be left open: a read-only transaction whose caller
      // hangs up between the last statement and the commit. Cancelling there
      // would abort a transaction that has already done all its work, to save
      // nothing — a `commit` on a read is a round trip, not a workload.
      cancellation.seal();
      await client.query('commit');
      return result;
    } catch (err) {
      // BEFORE the rollback. A cancelled transaction is in aborted state and
      // `rollback` is how it is recovered — arming a cancel against THAT would
      // poison the client the recovery exists to save.
      cancellation.seal();
      try {
        await client.query('rollback');
      } catch {
        // The connection is already unusable; `release(err)` below evicts it
        // from the pool rather than handing a poisoned client to the next
        // caller. Reporting the rollback failure would mask the real error.
      }
      throw translateDbError(err);
    } finally {
      // Belt and braces with the seals above: whatever path got here, no
      // listener may outlive the transaction. The signal is the REQUEST's and
      // outlives every one of its transactions, so a listener left attached
      // would fire a CancelRequest at a pid the pool has since handed to
      // somebody else — cancelling an unrelated caller's query.
      cancellation.disarm();
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
