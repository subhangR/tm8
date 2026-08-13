/**
 * The database seam — TYPES ONLY, owned by the coordinator and frozen for the
 * G1A lanes.
 *
 * Three lanes need to talk to Postgres and they are being built concurrently:
 * the facade handlers (db/client.ts implements this), the events mapper, and
 * the execution handlers. If each waited for the others' concrete code to
 * exist, nothing would compile until everything did. So the INTERFACE lands
 * first, in a file nobody else edits, and all three code against it from
 * minute one.
 *
 * The rule this file encodes: **a database session carries only claims that
 * cannot go stale** (STATE 'Claims contract'). RLS resolves membership and
 * can_act_as from TABLES, never from a claim snapshot — so there is no seat
 * here for a "roles" or "memberships" claim, and adding one would reintroduce
 * the staleness window the ruling exists to close.
 *
 * The surface was four for W1/W2 and is FIVE from 082 (ruling R11): `auth_kind`
 * joined it because an auth session's kind is immutable for the life of the
 * session, which is precisely what membership is not. Read `authKind`'s own
 * doc below before adding a sixth — "is it immutable?" is the test, not "is it
 * useful?".
 */

/**
 * The canonical claims, and the whole trusted surface of a db session.
 *
 * `SET LOCAL` — not `SET` — because these must die with the transaction. A
 * pooled connection that keeps a claim after COMMIT hands the next request
 * someone else's identity.
 */
export interface DbClaims {
  /** → `SET LOCAL tm8.identity_id`. The authenticated identity row. */
  readonly identityId?: string | undefined;
  /** → `SET LOCAL tm8.actor_id`. The effective author (acting-as target). */
  readonly actorId?: string | undefined;
  /**
   * → `SET LOCAL tm8.node_admin`, serialised as the literal string `'true'` or
   * `'false'`. Not `'on'`/`'off'`: 001_core_graph.sql:166 tests
   * `lower(claim) = 'true'`, so any other spelling silently reads as "not an
   * admin" rather than raising. Verified against a live database, 2026-07-25.
   */
  readonly nodeAdmin?: boolean | undefined;
  /** → `SET LOCAL tm8.request_id`. Joins an audit row to a client-visible id. */
  readonly requestId?: string | undefined;
  /**
   * → `SET LOCAL tm8.auth_kind`. The fifth claim (082, ruling R11): the
   * SERVER-RESOLVED kind of the auth session — `'browser'`, `'cli'`, `'agent'`
   * or `'agent_runtime'` — read from `auth_sessions` by token hash in
   * `resolveBearerIdentity`, never asserted by the client.
   *
   * Read by `internal.require_human_auth_kind()`, which gates the four
   * `credentials.*` RPCs and FAILS CLOSED: null, empty and unrecognised all
   * refuse. An omitted value therefore binds as `''` and is refused, which is
   * the intended behaviour for any caller that cannot say what it is — not an
   * oversight to be patched with an `is null` escape.
   *
   * It exists because an agent's bearer credential carries its owner's FULL
   * identity and not a reduced principal (sub-doc 14, channel C7): every other
   * predicate — `identity_id()`, `can_act_as`, `is_space_member` — answers as
   * the human. This claim is the only thing that tells the two apart.
   */
  readonly authKind?: string | undefined;
}

/** A handle to one open transaction. Valid only inside `Db.tx`'s callback. */
export interface Querier {
  /** Raw parameterised SQL. READS ONLY — every write goes through `rpc`. */
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<R[]>;
  /**
   * Call one of Cygnus's SECURITY DEFINER functions from db/migrations/007.
   *
   * `fn` is a bare qualified name (`public.create_task`); args bind
   * positionally. This is the ONLY write path — no handler issues INSERT,
   * UPDATE or DELETE directly, because the RPCs are where the command ledger,
   * the event capture trigger and the F1/F2 guards live. A raw INSERT that
   * "works" silently skips all three.
   */
  rpc<T = unknown>(fn: string, args?: readonly unknown[]): Promise<T>;
}

export interface Db {
  /**
   * Run `fn` inside a single transaction with `claims` applied via SET LOCAL.
   * Commits on resolve, rolls back on throw. Postgres SQLSTATEs raised inside
   * are translated to the contract's error taxonomy on the way out.
   */
  tx<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T>;
  /** One RPC in its own transaction — the common command-handler shape. */
  rpc<T = unknown>(claims: DbClaims, fn: string, args?: readonly unknown[]): Promise<T>;
  /** One read in its own transaction — the common read-handler shape. */
  query<R = Record<string, unknown>>(
    claims: DbClaims,
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;
  /** Closes the pool. Called once at shutdown. */
  end(): Promise<void>;
}
