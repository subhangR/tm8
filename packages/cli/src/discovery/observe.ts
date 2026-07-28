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
 * ⚠⚠ THE NARROWED RULE ABOVE IS **NOT APPLIED**. IT IS PARKED, DELIBERATELY.
 *
 * `observedInvoke` below still ships the ORIGINAL, UNSOUND rule. That is a
 * KNOWN DEFECT, not an oversight, and this comment exists so nobody "fixes"
 * the inconsistency by deleting the analysis above.
 *
 * WHY IT IS PARKED. Applying it is a CHANGE TO THE AVAILABILITY PROJECTION'S
 * CONTRACT, not a defect repair. The rule it replaces is a deliberate premise
 * expressed in SIX places across FOUR files — `availability.ts:26`,
 * `availability.ts:107`, this header, `commands/file.ts:375`,
 * `test/space.test.ts:516` (a test NAMED for it, which drives a 403 `forbidden`
 * specifically), and `test/discovery-availability.test.ts:12,:86`. Four of the
 * six chose `forbidden` as the worked example — the one code measured as
 * decided at pipeline step 2. A duo cannot ratify that between themselves.
 *
 * AND THE FIX WOULD BE INCOMPLETE ANYWAY: `commands/file.ts:378-391` is a
 * SECOND, INDEPENDENT copy of this classification (`observedDownload`) in
 * another duo's module. Applying it here alone leaves two implementations
 * DISAGREEING, which is worse than either consistent state.
 *
 * THE EVIDENCE IS NOT LOST BY PARKING IT: the defect is pinned by Duo F's
 * tester in `packages/server/test/w5/agentic/observation-soundness.test.ts`,
 * which drives a real Server and shows an unmounted operation answering
 * BYTE-IDENTICALLY to a mounted one under overflow and malformed-JSON.
 *
 * TO APPLY: swap the two marked lines in the catch block below, fix
 * `file.ts:378-391` to match under a grant, and re-pin the three sites above.
 * Blocked on a ruling from W5 Advisor 2 (R0/R4).
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
      // ── SHIPPED RULE — KNOWN-UNSOUND, ruling pending. See PROVES_A_HANDLER_RAN. ──
      into.record(name, err.code === 'not_implemented' ? 'not_implemented' : 'handled');
      // ── NARROWED RULE — swap the line above for these two when R0/R4 lands: ──
      // if (err.code === 'not_implemented') into.record(name, 'not_implemented');
      // else if (PROVES_A_HANDLER_RAN.has(err.code)) into.record(name, 'handled');
    }
    // A TransportError teaches NOTHING about the operation: the node never
    // answered, so recording anything here would be inventing a capability
    // claim out of a network failure.
    throw err;
  }
}
