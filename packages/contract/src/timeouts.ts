/**
 * ONE DECISION, THREE CALL SITES: how long anybody may wait for anybody.
 *
 * These numbers were previously set independently in two packages and neither
 * referenced the other, with the result that **the server was permitted to
 * spend twice as long as any client would ever wait**:
 *
 *   - client gave up at 15s  (`tm8-ui/src/data/real/http.ts`)
 *   - server ran to 30s      (`server/src/db/client.ts`,
 *                             `server/src/facade/services/w2/execution.ts`)
 *
 * The second 15s of every slow query was waste by construction: a statement
 * still running after the client's `AbortController` fired is writing into a
 * socket nobody reads, while holding one of `max` pooled connections against
 * every other request on the node.
 *
 * HOW THE WASTE IS ACTUALLY STOPPED, and why it is not by arithmetic on these
 * numbers. The obvious repair is to squeeze the server's ceilings until they
 * fit inside the client's — `connect + statement <= request`, so the server
 * always gives up first. That was written, and then MEASURED, and it is wrong:
 * with `REQUEST_TIMEOUT_MS` at 15s and a 5s connect ceiling it leaves a
 * statement 10s, down from 30s, and 10s is not enough. Running
 * `server/test/w3/g02-public.test.ts` on a loaded box, the identical code
 * scored 20/20 with a 30s ceiling and 15/20 with the derived 10s one — five
 * legitimate operations killed mid-flight by SQLSTATE 57014, which is the bug
 * this file was opened to fix, reintroduced from the other end.
 *
 * So the relationship is NOT arithmetic. A client that hangs up now CANCELS its
 * own read through the Postgres cancel channel (`server/src/db/cancel.ts`),
 * which stops the statement in milliseconds — far tighter than any ceiling
 * could, and it responds to the actual event rather than to a guess about how
 * long that event takes to matter. Once cancellation exists, making
 * `statement_timeout` fit inside the request budget buys nothing: the cases it
 * still covers are precisely the ones with NO client waiting (work started
 * outside a request, a disconnect the frame missed, and commands, which are
 * never cancelled on purpose). Bounding those by a client's patience is
 * arithmetic about a clock they are not on.
 *
 * WHY NOT RAISE THE CLIENT TO 30s TO MAKE THEM AGREE. Also considered, also
 * rejected: it converts a fast failure into a slow one, doubling the time a
 * user stares at a spinner before being told the same thing. The failing
 * direction is the one worth optimising. The client keeps its 15s; the server
 * keeps a ceiling sized for the work it actually has to finish.
 *
 * WHY 15s IS THE FIXED POINT AND NOT SOMETHING SHORTER. Measured on prod
 * 2026-08-19 (recorded at `tm8-ui/src/views/useGateData.ts`): N identical
 * concurrent `collections.query`, median 0.32s at N=1 rising LINEARLY to 2.20s
 * at N=32, with no cliff separating "slow" from "broken", and the whole curve
 * shifting ~2.8x on a busier box. A deadline tight enough to be interesting is
 * therefore a bet on how many tabs and agents happen to be booting at once.
 * 15s sits far above the top of that curve on any load yet observed.
 *
 * Uploads are deliberately NOT governed by this file — see `UPLOAD_TIMEOUT_MS`
 * in `tm8-ui/src/data/real/http.ts`, which moves real bytes and has no reason
 * to fit inside an interactive read's budget.
 */

/**
 * Ceiling on ONE HTTP request, headers-to-body, enforced client-side by an
 * `AbortController`.
 *
 * This is the fixed point: every other number in this file is derived from it,
 * downward. Raising it is a product decision about how long a user waits before
 * being told the node is unwell; lowering it is bounded by the measurement in
 * the file header.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Ceiling on WAITING FOR A POOLED CLIENT, before any statement runs
 * (`pg.Pool`'s `connectionTimeoutMillis`).
 *
 * Bounded well under `REQUEST_TIMEOUT_MS` because this is time the caller
 * spends waiting exactly as surely as execution is — a saturated pool delays a
 * request it has not started — and unlike a statement, waiting for a client
 * accomplishes nothing. A request that cannot get a connection in 5s is better
 * told so while someone is still listening.
 */
export const DB_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Ceiling on ONE STATEMENT, enforced by Postgres itself
 * (`statement_timeout`, applied as a connection startup parameter).
 *
 * A BACKSTOP, and deliberately NOT derived from `REQUEST_TIMEOUT_MS` — see the
 * file header for the measurement that settled it. The primary bound on
 * abandoned work is cancellation (`server/src/db/cancel.ts`), which stops a
 * read in milliseconds when its client hangs up. What is left for this ceiling
 * is the work cancellation cannot reach, and NONE of it has a client waiting:
 * work started outside a request, a disconnect the frame missed, and commands,
 * which are never cancelled on purpose. Sizing it to a browser's patience would
 * be sizing it for a caller those cases do not have.
 *
 * UNCHANGED AT 30s, on purpose. This value is load-bearing for real operations
 * — the tracking and hierarchy paths in `w3/g02-public.test.ts` exceed 10s on a
 * busy box — and every one of them fails as an opaque 503 when it is cut. A
 * future editor tightening this should first check what it kills; the honest
 * lever for "the server should stop sooner" is cancellation, not this number.
 */
export const DB_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Ceiling on a transaction sitting IDLE between statements
 * (`idle_in_transaction_session_timeout`).
 *
 * Measured from the LAST STATEMENT, not from the start of the request, so it is
 * on a different clock from everything above and cannot be compared with them.
 * It guards a different failure: a `tx` callback awaiting something that never
 * resolves, which leaves its connection `idle in transaction` forever. See
 * `PgDbOptions.idleInTransactionTimeoutMillis`.
 */
export const DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;
