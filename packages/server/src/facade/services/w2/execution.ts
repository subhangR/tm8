/**
 * W2 G11 — execution and session lifecycle: B1's internal prompt authority and
 * the durable three-RPC delivery protocol.
 *
 * TWO ADOPTED LAWS LIVE HERE, AND THEY ARE THE SAME LAW SEEN TWICE.
 *
 * B1 — `execution.prompt` is Server-internal-only. It is a v1 catalog operation
 * and must stay routed (a node that dropped it would answer 501 and lie about
 * its own contract), but no public caller may reach a terminal through it. The
 * public route therefore refuses UNCONDITIONALLY and FIRST, and the real write
 * lives behind `promptInternal`, which is a function rather than an operation —
 * there is no request body, header, flag or act-as shape that produces the
 * object `isSystemDeliveryPrincipalFor` accepts, because the only producer is
 * `mintSystemDeliveryPrincipal` and it registers object IDENTITY in a
 * module-private WeakSet. That is why B1 can be a closed guard rather than a
 * blocklist of caller shapes: the positive half is unforgeable, so the negative
 * half does not have to enumerate anything.
 *
 * Migration 135 removes the wake counter, unordered-pair table and copied
 * version pin. The pin was not delivery-row optimistic concurrency: it never
 * changed after reserve, and claim/settle never revisited the pair. Delivery
 * concurrency remains owned by the exact delivery/message/target tuple, the
 * delivery row's `FOR UPDATE` lock and its legal status transitions. This file
 * therefore carries no pair state or surrogate version at all.
 *
 * WHY A SECOND DATABASE CONNECTION EXISTS IN THIS FILE.
 * `internal.require_delivery_principal` demands authenticated `session_user` be
 * `tm8_delivery_worker`, plus four `tm8.delivery_*` settings, plus that
 * `internal.actor_id()` and `internal.acting_as()` are both null. The frozen
 * `Db` seam binds exactly four claims and never sets a role, and pg_catalog
 * confirms `tm8_app` is not a member of `tm8_delivery_worker` (it is `noinherit
 * login`), so `Db` cannot call these three RPCs and must not be taught to. The
 * delivery worker is a different PRINCIPAL, not a different query — giving the
 * application role a path to it would dissolve the boundary 015 built.
 */
import { randomUUID } from 'node:crypto';

import { CollabError } from '@tm8/contract';
import {
  W2MessageDeliveryAdapter,
  type Logger,
  type W2DeliveryBinding,
  type W2DeliveryClaim,
  type W2DeliveryOutcome,
} from '@tm8/execution';
import { Pool, type PoolClient } from 'pg';

import {
  isSystemDeliveryPrincipalFor,
  mintSystemDeliveryPrincipal,
} from '../../../identity/index.js';
import type { SystemDeliveryPrincipalBinding } from '../../../identity/types.js';
import type {
  MessageDeliveryDispatchOutcome,
  MessageDeliveryReservationIntent,
  PreReservedMessageDeliveryAdapter,
  RejectedMessageDeliveryAttempt,
  ReservedMessageDelivery,
  ReservedMessageDeliveryAttempt,
} from './messages-handoffs.js';

// ---------------------------------------------------------------------------
// B1 — the public refusal
// ---------------------------------------------------------------------------

/**
 * The single reason string for every public `execution.prompt` call.
 *
 * It is a value, not a literal repeated at each throw site, because the CLI's
 * discovery (`reason: 'use_message_send'`), the conformance foundations (M11)
 * and this guard have to agree exactly, and three independent spellings of the
 * same word is how they stop agreeing.
 */
export const PUBLIC_PROMPT_REFUSAL_REASON = 'use_message_send';

/**
 * Refuse a public `execution.prompt`, having done nothing else.
 *
 * `forbidden` rather than `not_implemented`: the operation IS implemented, on
 * an internal path, and 501 would invite a client to retry when the capability
 * lands. `use_message_send` names the public route that does work, which is the
 * whole point of the amendment — persistence first, delivery second.
 */
export function refusePublicExecutionPrompt(): never {
  throw new CollabError(
    'forbidden',
    'execution.prompt is a Server-internal delivery adapter; the public authoring route is messages.post',
    { details: { reason: PUBLIC_PROMPT_REFUSAL_REASON, publicComposite: 'messages.post' } },
  );
}

// ---------------------------------------------------------------------------
// B1 — the internal seam (the POSITIVE half)
// ---------------------------------------------------------------------------

/**
 * The slice of `PtyHostService` a delivery may touch.
 *
 * Narrowed on purpose. A delivery adapter that could reach `spawn` or `kill`
 * would be an execution capability wearing a delivery principal, and the
 * principal is scoped to exactly one write.
 */
export interface InternalPromptPty {
  hasSession(sessionId: string): boolean;
  deliverPrompt(
    sessionId: string,
    content: string,
    mode: 'send' | 'paste',
    deliveryId?: string,
  ): Promise<boolean>;
}

/**
 * The slice of `PromptSettlementWaiter` (`@tm8/execution`) `promptInternal` needs:
 * register a wait for a deliveryId's REAL outcome, and abandon one that will
 * never resolve because admission was refused. See that class's own docs for
 * the full contract (ordering, no-timeout rationale, cancel semantics) — this
 * interface exists so this file depends on the SHAPE, not the concrete class,
 * matching how `InternalPromptPty` already narrows `PtyHostService`.
 */
export interface InternalPromptDeliverySettlement {
  awaitOutcome(deliveryId: string): Promise<{ outcome: 'delivered' | 'unknown'; reason?: string }>;
  cancel(deliveryId: string): void;
}

export interface InternalPromptDeps {
  readonly pty: InternalPromptPty;
  readonly promptSettlement: InternalPromptDeliverySettlement;
}

export interface InternalPromptDelivery extends SystemDeliveryPrincipalBinding {
  readonly content: string;
  readonly mode: 'send' | 'paste';
}

/**
 * Bind a minted principal to the binding G04's adapter hands `authorize`.
 *
 * THE SEAM DID NOT FIT, AND THIS IS WHERE IT IS MADE TO. `isSystemDeliveryPrincipalFor`
 * validates its `expected` argument with an EXACT-OWN-KEYS check over exactly
 * three keys. `W2MessageDeliveryAdapter`'s `bindingOf` returns FIVE — it adds
 * `requestId` and `expiresAt`. So passing the adapter's binding straight to the
 * guard, which is literally what `w2-message-delivery.ts:43` documents ("G11
 * supplies the closed `isSystemDeliveryPrincipalFor` guard here"), makes the
 * guard return false for EVERY delivery, forever. Wired as documented, the
 * adapter refuses 100% of writes and B2 can never deliver anything.
 *
 * Neither half is wrong on its own; nothing had ever run them together, so the
 * mismatch had nowhere to show. It is the same disease as the missing call
 * sites, one layer in: a defence with no invocation is a comment, and a seam
 * with no traffic is a drawing.
 *
 * The projection is narrowing, never widening — the three identity fields are
 * passed through untouched. `expiresAt` is then compared EXPLICITLY rather than
 * dropped: it is the lease this same attempt sends to the database as
 * `tm8.delivery_expires_at`, so letting the attempt claim a longer life than
 * the principal it was minted from would put the durable claim outside the
 * authority that authorized it.
 */
function authorizeDeliveryPrincipal(
  principal: unknown,
  binding: {
    deliveryId: string;
    messageId: string;
    targetWorkSessionId: string;
    expiresAt: string;
  },
): boolean {
  const identity: SystemDeliveryPrincipalBinding = {
    deliveryId: binding.deliveryId,
    messageId: binding.messageId,
    targetWorkSessionId: binding.targetWorkSessionId,
  };
  if (!isSystemDeliveryPrincipalFor(principal, identity)) return false;
  return principal.claims.expiresAt === binding.expiresAt;
}

/**
 * The ONLY path from this server to a live terminal for a stored message.
 *
 * The guard is the first statement, before the session lookup and before any
 * byte is composed — the defect class this program keeps finding is an
 * authorization check that is not the first thing the path does, and the cheap
 * way to not have it is to have nothing above the check.
 *
 * A missing terminal is `refused`, not a throw: the reservation is durable and
 * a target that exited between reserve and write is an ordinary outcome to
 * settle, not an exception to lose.
 *
 * WHY THIS AWAITS THE REAL OUTCOME NOW, NOT JUST ADMISSION: delivery and
 * record are separate truths, and the facet must never claim `delivered`
 * before the write is actually known to have left the composer — that is the
 * program's oldest law, and this function was violating it. Measured, not
 * inferred: driving `messages.post` over real HTTP against a live claude-code
 * agent, the durable row already read `status: 'delivered'` with `settledAt`
 * ~84ms after the POST — before the PTY closed loop's readiness gate had even
 * evaluated its first quiescence check — while the actual agent response
 * (confirmed independently over the session's raw PTY stream) took several
 * real seconds. Polled 8 more times over the next 15s; the row never
 * revisited. Reproduced twice, on two separate spawns. So: admit fast (bound
 * rejections are still immediate and honest — a full queue or open handoff IS
 * known instantly), but for an ADMITTED delivery, wait for
 * `promptSettlement.awaitOutcome` — the two-signal completion PtyHostService
 * reports once `writePromptToEntry`'s closed loop actually concludes — before
 * returning anything this function's caller will settle as terminal.
 *
 * The wait is registered BEFORE admission is attempted, not after — see
 * `PromptSettlementWaiter`'s own docs for the same-tick-resolve hazard that
 * ordering exists to close.
 *
 * DIAGNOSTIC TRAP, BECAUSE THIS DOCBLOCK IS WHERE YOU WILL LAND LOOKING FOR IT:
 * `status: 'delivered'` with a `failure_reason` of NULL and an agent that never
 * answers is **almost never a delivery fault**. The far likelier cause is the
 * target session's ACCESS MODE. A session spawned `--access-mode safe` stops at
 * a permission prompt the first time it tries to run `tm8 message send` — the
 * prompt is drawn in its terminal, the text was genuinely delivered, and the
 * agent waits for a human who is not watching. Measured twice on two spawns
 * while proving the desktop app's delivery path: identical `delivered` rows,
 * no reply; the same message to a `fullAccess` session was answered in ~90 s.
 * So when the row says delivered and the terminal is silent, check the access
 * mode BEFORE you go looking in here.
 */
export async function promptInternal(
  deps: InternalPromptDeps,
  principal: unknown,
  delivery: InternalPromptDelivery,
): Promise<W2DeliveryOutcome> {
  const binding: SystemDeliveryPrincipalBinding = {
    deliveryId: delivery.deliveryId,
    messageId: delivery.messageId,
    targetWorkSessionId: delivery.targetWorkSessionId,
  };
  if (!isSystemDeliveryPrincipalFor(principal, binding)) {
    throw new CollabError('forbidden', 'a valid system delivery principal is required', {
      details: { reason: PUBLIC_PROMPT_REFUSAL_REASON },
    });
  }
  if (typeof delivery.content !== 'string' || delivery.content.length === 0) {
    throw new CollabError('invalid_input', 'delivery content must not be empty');
  }

  if (!deps.pty.hasSession(delivery.targetWorkSessionId)) {
    return { outcome: 'refused', reason: 'no_live_terminal' };
  }

  const outcomePromise = deps.promptSettlement.awaitOutcome(delivery.deliveryId);
  const admitted = await deps.pty.deliverPrompt(
    delivery.targetWorkSessionId,
    delivery.content,
    delivery.mode,
    delivery.deliveryId,
  );
  if (!admitted) {
    deps.promptSettlement.cancel(delivery.deliveryId);
    return { outcome: 'refused', reason: 'delivery_queue_refused' };
  }

  const result = await outcomePromise;
  return result.outcome === 'delivered'
    ? { outcome: 'delivered' }
    // Plainly, not a code: the closed loop's own exhausted-retries case already
    // logs this exact word (PtyHostService.submitWithVerify), and every other
    // 'unknown' this can carry (session replaced/exited mid-delivery, killed or
    // exited with the delivery still queued) is likewise free text from that
    // same seam — never abbreviated, never re-coded here.
    : { outcome: 'unknown', reason: result.reason ?? 'submit_unverified' };
}

// ---------------------------------------------------------------------------
// B2 — the three-RPC delivery boundary
// ---------------------------------------------------------------------------

export type StoredDeliveryStatus =
  | 'pending'
  | 'dispatching'
  | 'delivered'
  | 'failed_retryable'
  | 'failed_permanent'
  | 'unknown'
  | 'expired'
  | 'cancelled';

export type DeliverySettlementStatus =
  | 'delivered'
  | 'failed_retryable'
  | 'failed_permanent'
  | 'unknown';

/** One minted authority's exact delivery coordinates, as the RPCs want them. */
export interface DeliveryPrincipalLease {
  readonly deliveryId: string;
  readonly messageId: string;
  readonly targetWorkSessionId: string;
  readonly expiresAt: string;
}

export interface StoredDelivery {
  readonly deliveryId: string;
  readonly messageId: string;
  readonly targetWorkSessionId: string;
  readonly status: StoredDeliveryStatus;
  readonly attemptNo: number;
  readonly failureReason: string | null;
}

/**
 * The closed three-RPC surface. There is no fourth verb here and there must
 * never be one: expiry and retention belong to
 * `internal.w1_prune_operational_state`, an owner-internal maintenance path
 * that is deliberately NOT on the delivery role's allowlist.
 */
export interface W2DeliveryRpcPort {
  reserve(lease: DeliveryPrincipalLease, attemptNo: number): Promise<StoredDelivery>;
  claim(lease: DeliveryPrincipalLease): Promise<StoredDelivery>;
  settle(
    lease: DeliveryPrincipalLease,
    status: DeliverySettlementStatus,
    failureReason: string | null,
  ): Promise<StoredDelivery>;
  close(): Promise<void>;
}

interface DeliveryRowJson {
  delivery_id: string;
  message_id: string;
  target_work_session_id: string;
  status: string;
  attempt_no: number;
  failure_reason: string | null;
}

function storedDeliveryOf(row: DeliveryRowJson): StoredDelivery {
  return {
    deliveryId: row.delivery_id,
    messageId: row.message_id,
    targetWorkSessionId: row.target_work_session_id,
    status: row.status as StoredDeliveryStatus,
    attemptNo: row.attempt_no,
    failureReason: row.failure_reason,
  };
}

/**
 * The four delivery claims, bound `SET LOCAL` for one transaction.
 *
 * `set local role tm8_delivery_worker` is issued unconditionally rather than
 * assumed from the connection. It succeeds when the pool already authenticates
 * as the delivery worker (a role may always assume itself), succeeds for the
 * superuser a test fixture uses, and FAILS LOUDLY from `tm8_app` — which is
 * the outcome we want, because a silent fallback to the application role is
 * exactly how a delivery boundary stops being one.
 *
 * `tm8.actor_id` and `tm8.acting_as` are conspicuously absent:
 * `require_delivery_principal` rejects a principal that carries either, and a
 * delivery is authored by the stored message, never by whoever is connected.
 */
const SET_DELIVERY_CLAIMS = `
  select set_config('tm8.principal_type', 'system_delivery_adapter', true),
         set_config('tm8.delivery_id', $1, true),
         set_config('tm8.delivery_message_id', $2, true),
         set_config('tm8.delivery_target_work_session_id', $3, true),
         set_config('tm8.delivery_expires_at', $4, true)`;

/**
   * Refuse a delivery URL that is not AUTHENTICATED as `tm8_delivery_worker`.
   *
   * ## Why `session_user` and not `current_user`
   *
   * `internal.require_delivery_principal` (migration 039, copied forward by
   * 135) checks `session_user`. A SUPERUSER MAY ASSUME ANY ROLE, so
   * `current_user` and `current_setting('role')` can both read
   * `tm8_delivery_worker` while `session_user` still names the authenticated
   * login. Only that last value survives SET ROLE and closes the impersonation.
   *
   * `rolsuper` is asserted too, in the same round trip, because "the role is
   * named tm8_delivery_worker" is an assumption about a role a deployment can
   * ALTER. 015 creates it NOSUPERUSER today; that is not a guarantee about
   * tomorrow, and the whole finding here is that a role NAME was taken to imply
   * a privilege LEVEL.
   *
   * ## Why this is a standalone function called at startup
   *
   * It must NOT be folded into `fromConnectionString`, which is synchronous and
   * could therefore only defer the check to first use — and first use is inside
   * the deliberately empty `catch` at messages-handoffs.ts:351, which swallows
   * delivery failures so an adapter outage cannot disguise a stored message.
   * That is right for a delivery outage and fatal for a config assertion: the
   * throw would be discarded, the node would boot clean, every send would return
   * 200, and deliveries would silently never happen. Trading "runs as superuser,
   * loudly wrong" for "does nothing, silently" is a worse outcome than the
   * defect. So this is awaited at startup, above the swallow, and fails the boot.
   *
   * This startup check protects the wiring before stored-first delivery catches
   * can hide a configuration error; the database guard independently enforces
   * the authenticated worker role on every RPC.
   */
export async function verifyDeliveryPrincipal(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  // An 'error' event with no listener is rethrown by EventEmitter and takes the
  // process down, and that is true however short-lived the pool is. This one
  // runs during boot, where a dead process is indistinguishable from a failed
  // verification: the operator sees an exit, not the assertion this function
  // exists to make. Mirrors the guard in db/client.ts.
  pool.on('error', (err) => {
    console.error(`[w2-delivery] idle client error on the principal-check pool: ${err.message}`);
  });
  try {
    const rows = (await pool.query<{ who: string; is_super: boolean | null }>(
      'select session_user as who, (select rolsuper from pg_roles where rolname = session_user) as is_super',
    )).rows;
    const who = rows[0]?.who ?? '<unknown>';
    if (who !== 'tm8_delivery_worker' || rows[0]?.is_super === true) {
      throw new Error(
        `TM8_DELIVERY_DATABASE_URL must AUTHENTICATE as a non-superuser 'tm8_delivery_worker', not merely be able to assume that role — ` +
          `expected session_user 'tm8_delivery_worker' (rolsuper false), got '${who}' (rolsuper ${String(rows[0]?.is_super)}). ` +
          `session_user is checked because it survives SET ROLE: a superuser URL can assume tm8_delivery_worker and would otherwise pass every database-side check.`,
      );
    }
  } finally {
    await pool.end();
  }
}

export class PgW2DeliveryRpcPort implements W2DeliveryRpcPort {
  private readonly ownsPool: boolean;

  constructor(private readonly pool: Pool, ownsPool = false) {
    this.ownsPool = ownsPool;
    // `fromConnectionString` arms `idle_in_transaction_session_timeout`, so
    // Postgres WILL terminate a wedged delivery transaction — that is the
    // point of it, and the comment there says so. The termination arrives as
    // SQLSTATE 25P03 on an 'error' event on this pool, and an unhandled 'error'
    // on an EventEmitter takes the whole node down, killing every running agent
    // session with it. A node that arms a timeout on itself and then dies of it
    // is a node that cannot stay up under its own design.
    //
    // Guarded in the constructor rather than beside the `new Pool` in
    // `fromConnectionString`, so a caller-supplied pool is covered by
    // construction and no future call site can reintroduce the hole.
    //
    // The pool discards the broken client either way; we only have to not die
    // about it — the same reasoning, and the same shape, as db/client.ts.
    this.pool.on('error', (err) => {
      console.error(`[w2-delivery] idle client error: ${err.message}`);
    });
  }

  /** Build a port over its own pool, authenticating as the delivery worker. */
  static fromConnectionString(connectionString: string, max = 4): PgW2DeliveryRpcPort {
    // Same guards as db/client.ts: a delivery transaction that wedges must be
    // killed by Postgres, not hold one of `max` clients until a restart.
    return new PgW2DeliveryRpcPort(
      new Pool({
        connectionString,
        max,
        statement_timeout: 30_000,
        idle_in_transaction_session_timeout: 30_000,
      }),
      true,
    );
  }


  private async withPrincipal<T>(
    lease: DeliveryPrincipalLease,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role tm8_delivery_worker');
      await client.query(SET_DELIVERY_CLAIMS, [
        lease.deliveryId,
        lease.messageId,
        lease.targetWorkSessionId,
        lease.expiresAt,
      ]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        // A connection that cannot roll back is already being discarded; the
        // original failure is the one worth propagating.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async reserve(lease: DeliveryPrincipalLease, attemptNo: number): Promise<StoredDelivery> {
    return this.withPrincipal(lease, async (client) => {
      const result = await client.query<{ row: DeliveryRowJson }>(
        `select public.reserve_session_message_delivery($1, $2, $3, $4) as row`,
        [lease.deliveryId, lease.messageId, lease.targetWorkSessionId, attemptNo],
      );
      return storedDeliveryOf(result.rows[0]!.row);
    });
  }

  async claim(lease: DeliveryPrincipalLease): Promise<StoredDelivery> {
    return this.withPrincipal(lease, async (client) => {
      const result = await client.query<{ row: DeliveryRowJson }>(
        `select public.claim_session_message_delivery($1, $2, $3) as row`,
        [lease.deliveryId, lease.messageId, lease.targetWorkSessionId],
      );
      return storedDeliveryOf(result.rows[0]!.row);
    });
  }

  async settle(
    lease: DeliveryPrincipalLease,
    status: DeliverySettlementStatus,
    failureReason: string | null,
  ): Promise<StoredDelivery> {
    return this.withPrincipal(lease, async (client) => {
      const result = await client.query<{ row: DeliveryRowJson }>(
        `select public.settle_session_message_delivery($1, $2, $3, $4, $5) as row`,
        [
          lease.deliveryId,
          lease.messageId,
          lease.targetWorkSessionId,
          status,
          failureReason,
        ],
      );
      return storedDeliveryOf(result.rows[0]!.row);
    });
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// B2 — the service the messages seam plugs into
// ---------------------------------------------------------------------------

/** Default principal lifetime for ONE delivery attempt. */
export const DEFAULT_DELIVERY_LEASE_MS = 5 * 60_000;

export interface W2ExecutionDeliveryOptions {
  readonly rpc: W2DeliveryRpcPort;
  readonly pty: InternalPromptPty;
  /** See `InternalPromptDeliverySettlement` — threaded through to `promptInternal`
   *  so `writeFor` awaits the REAL closed-loop outcome, not admission. */
  readonly promptSettlement: InternalPromptDeliverySettlement;
  readonly leaseMs?: number;
  /** Injected for tests; production uses the wall clock. */
  readonly now?: () => number;
  /** Injected for tests; production mints a v4 uuid per attempt. */
  readonly newDeliveryId?: () => string;
  /**
   * Names any exception BEFORE G04's swallow sees it.
   *
   * `postMessageBatch` wraps the whole reserve/dispatch sequence in a
   * `catch { }` with an empty body. That is CORRECT and must stay: stored-first
   * means a delivery outage may not roll back or disguise a stored message. But
   * it also means that from outside, a broken delivery path and a healthy node
   * with nothing to deliver produce ONE IDENTICAL OBSERVATION — exit 0, zero
   * delivery rows — and W4 lost a measurement cycle to exactly that ambiguity.
   *
   * So the diagnostic lives HERE, on this side of the seam, where it can name
   * the failure without touching G04's file or changing what its catch does.
   *
   * NOTE WHAT THIS STILL CANNOT TELL YOU, because it is the half that bit us:
   * it fires only when something THROWS. A path that is never invoked logs
   * nothing here, and that is the far more likely reason for zero delivery
   * rows — the answer to THAT question is a startup line saying whether
   * delivery is wired at all, not anything in this class.
   *
   * OPTIONAL HERE, DEFAULTED IN THE FACTORY. Direct construction (tests) stays
   * silent; `createW2ExecutionDelivery` installs `consoleDeliveryLogger`,
   * because this field was passed by nobody and the whole diagnostic was dead
   * in production. See that function.
   */
  readonly logger?: Logger;
}

interface InFlight {
  readonly lease: DeliveryPrincipalLease;
  readonly principal: unknown;
}

/**
 * A reservation intent with the RETRY coordinate G04's shape does not carry.
 *
 * `attempt_no` is part of 015's `unique (message_id, target_work_session_id,
 * attempt_no)`, so a retry of the same message at the same target must supply
 * the next number or collide with its own first attempt. It is OPTIONAL, so
 * this stays assignable from `MessageDeliveryReservationIntent` and the seam
 * G04 declared still type-checks against this service unchanged.
 *
 * A retry is a new durable row with a new delivery id. The logical attempt
 * coordinate remains protected by the database unique constraint.
 */
export interface W2DeliveryReservationIntent extends MessageDeliveryReservationIntent {
  readonly attemptNo?: number;
}

/**
 * `outcome` → stored settlement status.
 *
 * `refused` maps to `failed_retryable` rather than `failed_permanent`: the
 * refusals this path produces (no live terminal, a full delivery queue) are
 * conditions of the moment, and marking them permanent would suppress the
 * retry the message deserves. The permanent refusal in this design is the one
 * SQL writes for itself at reservation time (`session_not_live`, for an exited
 * or failed target) — this server never gets to decide it, which is the point.
 */
function settlementFor(outcome: W2DeliveryOutcome): {
  status: DeliverySettlementStatus;
  failureReason: string | null;
} {
  switch (outcome.outcome) {
    case 'delivered':
      return { status: 'delivered', failureReason: null };
    case 'refused':
      return { status: 'failed_retryable', failureReason: outcome.reason };
    default:
      return { status: 'unknown', failureReason: outcome.reason };
  }
}

/**
 * The B2 delivery path: reserve → mint → claim → one write → settle.
 *
 * The only map it owns is `inFlight`, which lives for
 * the duration of one dispatch and exists because G04's adapter hands
 * `writeAttempt` a binding rather than the principal — so the principal is
 * carried across that call and RE-VALIDATED by `promptInternal` against the
 * same guard `authorize` used. Two checks, one definition.
 */
/**
 * Everything about a failure that is safe to log, and nothing that is not.
 *
 * `sqlstate` is the field worth having: it is what distinguishes 42501 (the
 * delivery principal was refused) from 23514 (an invariant, e.g. the 019
 * exited-target pair_shape defect) from 28000 (no identity), and guessing
 * between those from a message string is how a taxonomy gets re-invented.
 *
 * The message BODY is deliberately absent. Ids correlate a failure to a row;
 * the content is the user's, and a log line is the wrong place for it.
 */
function failureFacts(error: unknown, lease: { deliveryId: string; messageId: string; targetWorkSessionId: string }): Record<string, unknown> {
  const e = error as { name?: unknown; message?: unknown; code?: unknown };
  return {
    deliveryId: lease.deliveryId,
    messageId: lease.messageId,
    targetWorkSessionId: lease.targetWorkSessionId,
    type: typeof e?.name === 'string' ? e.name : typeof error,
    message: typeof e?.message === 'string' ? e.message : String(error),
    // node-postgres puts SQLSTATE on `code`.
    sqlstate: typeof e?.code === 'string' ? e.code : null,
  };
}

export class W2ExecutionDeliveryService implements PreReservedMessageDeliveryAdapter {
  private readonly rpc: W2DeliveryRpcPort;
  private readonly pty: InternalPromptPty;
  private readonly promptSettlement: InternalPromptDeliverySettlement;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly newDeliveryId: () => string;
  private readonly inFlight = new Map<string, InFlight>();
  private readonly delivery: W2MessageDeliveryAdapter;
  private readonly logger: Logger | undefined;

  constructor(options: W2ExecutionDeliveryOptions) {
    this.rpc = options.rpc;
    this.pty = options.pty;
    this.promptSettlement = options.promptSettlement;
    this.leaseMs = options.leaseMs ?? DEFAULT_DELIVERY_LEASE_MS;
    this.now = options.now ?? (() => Date.now());
    this.newDeliveryId = options.newDeliveryId ?? (() => randomUUID());
    this.logger = options.logger;
    this.delivery = new W2MessageDeliveryAdapter({
      authorize: (principal, binding) => authorizeDeliveryPrincipal(principal, binding),
      claim: (binding) => this.claimFor(binding),
      writeAttempt: (attempt) => this.writeFor(attempt),
      settle: (binding, outcome) => this.settleFor(binding, outcome),
    });
  }

  /**
   * Reserve one durable attempt.
   *
   * Returns `null` — never an error, never a byte — when SQL hands back a
   * reservation it has already settled, which arrives as a settled row rather
   * than an exception because the reservation IS the record of the refusal.
   *
   * Since `120` the only refusal that reaches here is
   * `failed_permanent`/`session_not_live` for an exited or failed target; the
   * `automated_wake_limit` one this branch was built for no longer exists. The
   * branch is NOT dead and must not be narrowed to that single reason — it is
   * the general "the database settled it, do not touch the terminal" guard, and
   * every future reservation-time refusal arrives through it.
   */
  async reserve(intent: W2DeliveryReservationIntent): Promise<ReservedMessageDelivery | null> {
    const attemptNo = intent.attemptNo ?? 1;
    const lease: DeliveryPrincipalLease = {
      deliveryId: this.newDeliveryId(),
      messageId: intent.messageId,
      targetWorkSessionId: intent.targetWorkSessionId,
      expiresAt: new Date(this.now() + this.leaseMs).toISOString(),
    };
    let stored: StoredDelivery;
    try {
      stored = await this.rpc.reserve(lease, attemptNo);
    } catch (error) {
      // Log and RETHROW. Swallowing here would be a second silence on top of
      // the one this exists to lift, and G04's catch is the deliberate owner
      // of the stored-first guarantee — not this method.
      this.logger?.error?.(
        'w2 delivery: reserve failed',
        error instanceof Error ? error : undefined,
        failureFacts(error, lease),
      );
      throw error;
    }
    if (stored.status !== 'pending') return null;

    return {
      deliveryId: lease.deliveryId,
      messageId: lease.messageId,
      targetWorkSessionId: lease.targetWorkSessionId,
      expiresAt: lease.expiresAt,
      content: intent.content,
      mode: intent.mode,
    };
  }

  /** Mint the one-write authority. Object identity is the authority (B1). */
  principalFor(reservation: ReservedMessageDelivery): unknown {
    return mintSystemDeliveryPrincipal({
      deliveryId: reservation.deliveryId,
      messageId: reservation.messageId,
      targetWorkSessionId: reservation.targetWorkSessionId,
      expiresAt: reservation.expiresAt,
    });
  }

  async dispatch(attempt: ReservedMessageDeliveryAttempt): Promise<MessageDeliveryDispatchOutcome> {
    const lease: DeliveryPrincipalLease = {
      deliveryId: attempt.deliveryId,
      messageId: attempt.messageId,
      targetWorkSessionId: attempt.targetWorkSessionId,
      expiresAt: attempt.expiresAt,
    };
    this.inFlight.set(attempt.deliveryId, { lease, principal: attempt.principal });
    try {
      return await this.delivery.dispatch({
        deliveryId: attempt.deliveryId,
        requestId: attempt.requestId,
        messageId: attempt.messageId,
        targetWorkSessionId: attempt.targetWorkSessionId,
        expiresAt: attempt.expiresAt,
        principal: attempt.principal,
        content: attempt.content,
        mode: attempt.mode,
      });
    } catch (error) {
      this.logger?.error?.(
        'w2 delivery: dispatch failed',
        error instanceof Error ? error : undefined,
        failureFacts(error, lease),
      );
      throw error;
    } finally {
      this.inFlight.delete(attempt.deliveryId);
    }
  }

  /**
   * Claim and settle a pre-reserved attempt without touching the PTY.
   *
   * Oversize envelopes used to disappear before reserve (or throw a swallowed
   * `BudgetExceededError`), leaving no delivery row to explain the absence.
   * This uses the existing authenticated claim -> settle RPC pair, not a fourth
   * database verb, and records a permanent readable reason because the stored
   * message and this session's interaction-profile pin are immutable.
   */
  async reject(attempt: RejectedMessageDeliveryAttempt): Promise<MessageDeliveryDispatchOutcome> {
    const lease: DeliveryPrincipalLease = {
      deliveryId: attempt.deliveryId,
      messageId: attempt.messageId,
      targetWorkSessionId: attempt.targetWorkSessionId,
      expiresAt: attempt.expiresAt,
    };
    const binding = {
      deliveryId: attempt.deliveryId,
      requestId: attempt.requestId,
      messageId: attempt.messageId,
      targetWorkSessionId: attempt.targetWorkSessionId,
      expiresAt: attempt.expiresAt,
    };
    if (!authorizeDeliveryPrincipal(attempt.principal, binding)) {
      throw new CollabError('forbidden', 'a valid system delivery principal is required', {
        details: { reason: PUBLIC_PROMPT_REFUSAL_REASON },
      });
    }
    if (attempt.reason.length === 0) {
      throw new CollabError('invalid_input', 'delivery rejection reason must not be empty');
    }

    try {
      await this.rpc.claim(lease);
      await this.rpc.settle(lease, 'failed_permanent', attempt.reason);
      return { outcome: 'refused', reason: attempt.reason };
    } catch (error) {
      this.logger?.error?.(
        'w2 delivery: pre-write rejection failed',
        error instanceof Error ? error : undefined,
        failureFacts(error, lease),
      );
      throw error;
    }
  }

  /**
   * Release the delivery connection pool.
   *
   * Exposed because `PgW2DeliveryRpcPort.fromConnectionString` OWNS its pool and
   * the composition root cannot reach it — a pool left open keeps the process
   * alive after the HTTP server has closed, which reads as a hung shutdown.
   */
  async close(): Promise<void> {
    await this.rpc.close();
  }

  private requireInFlight(deliveryId: string): InFlight {
    const entry = this.inFlight.get(deliveryId);
    if (!entry) throw new CollabError('forbidden', 'no in-flight delivery for this binding');
    return entry;
  }

  private async claimFor(binding: W2DeliveryBinding): Promise<W2DeliveryClaim> {
    const { lease } = this.requireInFlight(binding.deliveryId);
    const stored = await this.rpc.claim(lease);
    if (stored.status === 'dispatching' || stored.status === 'pending') return { state: 'claimed' };
    return { state: 'settled', result: outcomeForStored(stored) };
  }

  private async writeFor(attempt: W2DeliveryBinding & {
    content: string;
    mode: 'send' | 'paste';
  }): Promise<W2DeliveryOutcome> {
    const { principal } = this.requireInFlight(attempt.deliveryId);
    return promptInternal({ pty: this.pty, promptSettlement: this.promptSettlement }, principal, {
      deliveryId: attempt.deliveryId,
      messageId: attempt.messageId,
      targetWorkSessionId: attempt.targetWorkSessionId,
      content: attempt.content,
      mode: attempt.mode,
    });
  }

  private async settleFor(binding: W2DeliveryBinding, outcome: W2DeliveryOutcome): Promise<void> {
    const { lease } = this.requireInFlight(binding.deliveryId);
    const { status, failureReason } = settlementFor(outcome);
    await this.rpc.settle(lease, status, failureReason);
  }
}

/** A settled stored row, read back as the outcome a replay must return. */
function outcomeForStored(stored: StoredDelivery): W2DeliveryOutcome {
  if (stored.status === 'delivered') return { outcome: 'delivered' };
  if (stored.status === 'unknown') {
    return { outcome: 'unknown', reason: stored.failureReason ?? 'unknown' };
  }
  return { outcome: 'refused', reason: stored.failureReason ?? stored.status };
}

// ---------------------------------------------------------------------------
// The one registration seam
// ---------------------------------------------------------------------------

/**
 * Build the `messageDelivery` option, ready to hand to the messages seam.
 *
 * CONSTRUCTION LIVES HERE, IN THE FILE THAT OWNS THE PRINCIPAL, so the
 * composition root spends four lines on a DECISION rather than sixteen on
 * plumbing it does not own the invariants for.
 *
 * WHAT A READER SHOULD CHECK, because a green suite cannot answer it: the pool
 * authenticating as `tm8_delivery_worker` is created inside
 * `PgW2DeliveryRpcPort` and held privately there; the port is held privately by
 * the service; and the service exposes exactly `reserve`, `principalFor`,
 * `dispatch` and `close`. Nothing returned from this function hands out the
 * pool, a client, a `Querier`, or the port. The returned `messageDelivery` goes
 * to ONE caller — `registerW2MessagesHandoffsHandlers` — and is deliberately
 * NOT placed on `FacadeDeps`, so no other handler can reach it. The delivery
 * identity is therefore reachable only through `postMessageBatch`'s
 * delivery-intent loop, and only for an intent the RPC itself emitted.
 */
export interface W2ExecutionDeliveryWiring {
  readonly messageDelivery: {
    readonly reserve: (intent: MessageDeliveryReservationIntent) => Promise<ReservedMessageDelivery | null>;
    readonly adapter: PreReservedMessageDeliveryAdapter;
    readonly principalFor: (reservation: ReservedMessageDelivery) => unknown;
  };
  /** Release the delivery pool at shutdown. */
  close(): Promise<void>;
}

/**
 * The default the PRODUCTION factory below installs.
 *
 * WHY A DEFAULT AND NOT AN INJECTION AT THE COMPOSITION ROOT. `logger` on
 * `W2ExecutionDeliveryOptions` was built, tested and then passed by nobody: the
 * one production construction site omitted it, so every diagnostic in this file
 * was a no-op for as long as the node has been shipping. That is not a wiring
 * slip to re-do more carefully — omission is the failure mode, and a default
 * cannot be omitted. The CLASS keeps `logger` optional and silent, so the
 * suite's "a healthy delivery logs NOTHING" control is unchanged and tests that
 * construct the service directly stay quiet.
 *
 * Fields come from `failureFacts`, which is already the allowlist: ids and
 * SQLSTATE, never a message body.
 */
export const consoleDeliveryLogger: Logger = {
  error: (message, _error, meta) =>
    console.error(JSON.stringify({ component: 'w2-delivery', level: 'error', event: message, ...meta })),
  warn: (message, meta) =>
    console.warn(JSON.stringify({ component: 'w2-delivery', level: 'warn', event: message, ...meta })),
  info: () => {},
  debug: () => {},
};

export function createW2ExecutionDelivery(options: {
  readonly connectionString: string;
  readonly pty: InternalPromptPty;
  /** The SAME `PromptSettlementWaiter` `options.pty` was constructed with — see
   *  `ExecutionRuntime.promptSettlement` (execution-handlers.ts) and
   *  `InternalPromptDeliverySettlement`'s docs above. */
  readonly promptSettlement: InternalPromptDeliverySettlement;
  /** Overrides `consoleDeliveryLogger`; absent is NOT silent — see above. */
  readonly logger?: Logger;
}): W2ExecutionDeliveryWiring {
  const service = new W2ExecutionDeliveryService({
    rpc: PgW2DeliveryRpcPort.fromConnectionString(options.connectionString),
    pty: options.pty,
    promptSettlement: options.promptSettlement,
    logger: options.logger ?? consoleDeliveryLogger,
  });
  return {
    messageDelivery: {
      reserve: (intent) => service.reserve(intent),
      adapter: service,
      principalFor: (reservation) => service.principalFor(reservation),
    },
    close: () => service.close(),
  };
}
