/**
 * The observation seam — how a call the caller ALREADY MADE teaches the
 * availability ledger, without anything in this package ever probing.
 *
 * There is exactly one rule and it is what makes trusting a 501 safe: an honest
 * `not_implemented` is decided BEFORE input validation and before any handler
 * runs, so it reserves no `clientMutationId` and applies nothing. Learning from
 * it costs the caller nothing they did not already spend.
 *
 * ⚠ THE CONVERSE IS NOT TRUE, AND THIS FILE USED TO CLAIM IT WAS. It read
 * "every other outcome — a success, a `forbidden`, a `version_conflict` —
 * proves a handler exists". A `forbidden` proves NOTHING: it is emitted at
 * `http/security.ts:48` from `checkTransport`, which runs at `server.ts:116`,
 * FORTY-SEVEN LINES BEFORE the handler lookup at `server.ts:163`. See
 * `PROVES_A_HANDLER_RAN` below for the measured pipeline order and the four
 * pre-lookup refusal sites.
 *
 * Deliberately NOT here: any function that issues a call for the purpose of
 * learning. Speculatively calling a mutation to discover whether it exists
 * would be exactly the destructive probe this design refuses, and a read probe
 * would still be traffic nobody asked for.
 *
 * `clientFor` lives here rather than in the kernel because the kernel is frozen
 * for this wave. It is a five-line composition over `CliContext` and belongs in
 * a shared kernel helper once that file can be touched — see the report.
 */
import type { OperationName } from '@tm8/contract';
import { Tm8Client, type InvokeOptions } from '../client.js';
import type { CliContext } from '../context.js';
import { ApiError } from '../errors.js';
import { ledger, type AvailabilityLedger } from './availability.js';

export function clientFor(ctx: CliContext): Tm8Client {
  return new Tm8Client({
    baseUrl: ctx.baseUrl.value,
    token: ctx.token,
    timeoutMs: ctx.timeoutMs,
  });
}

/**
 * Error codes that prove a HANDLER RAN — an ALLOWLIST, and the direction of the
 * default is the whole point.
 *
 * This module used to read "any code other than `not_implemented` proves a
 * handler exists". THAT WAS FALSE, and it was false because it is a claim about
 * PIPELINE ORDER that the Server does not honour. Measured in
 * `packages/server/src/http/server.ts`, handler lookup is at `:163` and
 * `notImplemented` at `:164` — but FOUR refusal sites run BEFORE it:
 *
 *     :116  checkTransport   → `forbidden`            (http/security.ts:48)
 *     :156  readJsonBody     → `payload_too_large` / `invalid_input`
 *     :159  router unmatched → `not_found`
 *     :152/:161  resolveIdentity
 *
 * So an operation with NO handler can answer BYTE-IDENTICALLY to one with a
 * handler, and under the old rule that reply was recorded as `handled` and
 * resolved to `available` — precisely the optimistic `available` that
 * availability.ts:12-15 forbids in bold.
 *
 * `forbidden`, `invalid_input` and `not_found` are each emitted on BOTH sides
 * of the lookup (`forbidden` at security.ts:48 pre-handler AND at
 * facade/execution-handlers.ts:498 post-handler; `not_found` at server.ts:159
 * pre-handler AND from handlers), so THE CODE ALONE CANNOT TELL THEM APART.
 * Ambiguous is treated exactly like pre-handler: learn nothing.
 *
 * AN ALLOWLIST RATHER THAN A DENYLIST, DELIBERATELY. A refusal code added to
 * the Server later lands here as "record nothing" instead of silently becoming
 * evidence of availability. The unsafe direction requires an edit to this line;
 * the safe direction is the default.
 *
 * THE COST, STATED: this records far less than the old rule. That is accepted
 * — a SUCCESS is unambiguous and carries the feature on its own, and an honest
 * `unknown` is the entire value of the field.
 */
const PROVES_A_HANDLER_RAN: ReadonlySet<string> = new Set([
  'version_conflict',
  'invariant_violation',
]);

/**
 * THE NARROWED RULE ABOVE IS **APPLIED** (2026-07-31). It was parked awaiting
 * a ruling while every transport check was a deferred no-op — under that
 * precondition the unsound rule was harmless, and changing the availability
 * projection's contract was not a duo's call. The precondition expired: the
 * origin-split wave closed S2/S3 (`http/security.ts` now refuses hostile
 * hosts), which is exactly the trigger the scheduled-inversion pin in
 * `packages/server/test/w5/agentic/observation-soundness.test.ts` was armed
 * for. From that point a `forbidden` really can be authored at pipeline
 * step 2, and continuing to record it as `handled` would manufacture
 * `available` out of a hostile-host refusal.
 *
 * Applied everywhere the old rule lived, in the same change: this catch
 * block, the `observedDownload` twin in `commands/file.ts`, and the pinned
 * expectations in `test/space.test.ts` and
 * `test/discovery-availability.test.ts`.
 */

/**
 * Invoke, and record what the outcome revealed about this node. The error is
 * always re-thrown: observation is a side channel, never a swallow.
 */
export async function observedInvoke<T = unknown>(
  client: Tm8Client,
  name: OperationName,
  opts: InvokeOptions = {},
  into: AvailabilityLedger = ledger,
): Promise<T> {
  try {
    const data = await client.invoke<T>(name, opts);
    // A success is decided at server.ts:180, long past the lookup. Unambiguous.
    into.record(name, 'handled');
    return data;
  } catch (err) {
    if (err instanceof ApiError) {
      // ── NARROWED RULE, APPLIED 2026-07-31. The trigger the disposition named
      // fired: S2/S3 transport checks went live server-side, so a `forbidden`
      // can now genuinely originate at pipeline step 2 and the old
      // any-code-means-handled rule would mark unmounted operations available
      // off a hostile-host refusal. See PROVES_A_HANDLER_RAN and
      // packages/server/test/w5/agentic/observation-soundness.test.ts. ──
      if (err.code === 'not_implemented') into.record(name, 'not_implemented');
      else if (PROVES_A_HANDLER_RAN.has(err.code)) into.record(name, 'handled');
    }
    // A TransportError teaches NOTHING about the operation: the node never
    // answered, so recording anything here would be inventing a capability
    // claim out of a network failure.
    throw err;
  }
}
