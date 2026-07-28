/**
 * W5 · DUO F · TESTER — the RED for my developer's M2 and M3.
 *
 * §19.4 and the duo model: THE TESTER'S RED IS THE ACCEPTANCE CRITERION FOR THE
 * DEVELOPER'S FIX, and it must exist BEFORE the fix lands if the fix would
 * destroy the ability to re-capture it. My developer has deliberately left M2
 * and M3 unfixed and asked to be told when this file exists. It is the whole
 * reason this file is written now rather than after.
 *
 * These pins were only possible after my developer added `ShardOptions.from`
 * (help.ts:175-189). Before that, `commandHelp` read the process-wide `ledger`
 * singleton, and pinning either defect meant WRITING TO SHARED PROCESS STATE —
 * a test whose result file ordering could decide. THE SEAM IS VERIFIED HERE,
 * INDEPENDENTLY, rather than taken on my developer's word: see the CONTROL.
 *
 * BOTH PINS ASSERT THE DEFECT AND ARE THEREFORE GREEN TODAY, with dispositions
 * authored now (§3d). When my developer fixes M2/M3 these go red ON CUE — that
 * is their last scheduled act, not a regression.
 *
 * `file upload` is the vehicle because it is the one multi-operation command:
 * `files.uploadInit` and `files.uploadComplete` both map to `['file','upload']`
 * (operations.ts:706-723). A composite shard has to roll two verdicts into one,
 * and that rollup is where both defects live.
 */
import { describe, expect, it } from 'vitest';

import {
  AVAILABILITY_SOURCES,
  AvailabilityLedger,
  resolveAvailability,
  ledger as processLedger,
  type AvailabilityVerdict,
} from '../../../src/discovery/availability.js';
import { commandHelp } from '../../../src/discovery/help.js';

const UPLOAD = ['file', 'upload'] as const;

/** A ledger where stage 1 answered and stage 2 is absent on this node. */
function partiallyImplemented(): AvailabilityLedger {
  const l = new AvailabilityLedger();
  l.record('files.uploadInit', 'handled');
  l.record('files.uploadComplete', 'not_implemented');
  return l;
}

/**
 * EVERY triple `resolveAvailability` can produce, derived by EXHAUSTING its
 * input space rather than by listing what I expect. This is the instrument the
 * M2 pin depends on, so it is built by enumeration, not by assertion.
 */
function producibleTriples(): Set<string> {
  const out = new Set<string>();
  const key = (v: AvailabilityVerdict): string =>
    `${v.availability}|${v.availabilityReason}|${v.availabilitySource}`;

  for (const status of ['v1', 'reserved'] as const) {
    for (const observation of [undefined, 'handled', 'not_implemented'] as const) {
      for (const advertised of [undefined, true, false] as const) {
        const l = new AvailabilityLedger();
        if (observation !== undefined) l.record('entities.get', observation);
        if (advertised !== undefined) {
          l.setAdvertised({
            implemented: new Set(advertised ? (['entities.get'] as const) : []),
            epoch: 'adv_probe',
          });
        }
        out.add(key(resolveAvailability('entities.get', status, l)));
      }
    }
  }
  return out;
}

describe('W5.F CONTROL — the seam does not touch the process singleton', () => {
  it('driving commandHelp with a private ledger leaves the shared ledger untouched', () => {
    // Verified INDEPENDENTLY of my developer's own measurement. §1: neither
    // seat declares the other's verdict. If this ever fails, every assertion
    // below is contaminated by file ordering and must be discarded.
    const before = processLedger.revision();
    const shard = commandHelp(UPLOAD, { from: partiallyImplemented() });
    expect(shard, 'the file upload command shard must exist').toBeDefined();
    expect(processLedger.revision(), 'commandHelp wrote to the PROCESS ledger').toBe(before);
  }, 15_000);

  it('CONTROL — the private ledger actually changes the answer, so the seam is load-bearing', () => {
    // A seam that is ignored would also leave the singleton at rest. This
    // distinguishes "honoured the ledger" from "did nothing".
    const cold = commandHelp(UPLOAD, { from: new AvailabilityLedger() });
    const warm = commandHelp(UPLOAD, { from: partiallyImplemented() });
    expect(cold?.availability).toBe('unknown');
    expect(warm?.availability).toBe('unavailable');
    expect(warm?.availability).not.toBe(cold?.availability);
  }, 15_000);
});

/**
 * ═══ M2 ═══ THE COMPOSITE PATH MANUFACTURES A TRIPLE NO OPERATION CAN PRODUCE.
 *
 * `help.ts` writes the composite `availability` and `availabilityReason` from
 * the multi-operation rollup but never rewrites `availabilitySource`, so the
 * shard keeps the source belonging to a DIFFERENT verdict.
 *
 * WHY IT MATTERS, and the direction it runs: `availability.ts:19-22` defines a
 * `contract` verdict as offline, node-independent and FINAL. The shard tells an
 * agent this operation is permanently unavailable on EVERY node, when the truth
 * is node-local and would be cleared by re-pointing at another Server. WRONG IN
 * THE DIRECTION THAT STOPS AN AGENT RETRYING SOMEWHERE IT WOULD HAVE WORKED.
 *
 * DISPOSITION: red here means the source is now derived from the same rollup as
 * the other two fields. Do NOT re-pin. CONVERT to asserting the shard's triple
 * is a MEMBER of `producibleTriples()` — the property this pin exists to
 * establish the absence of.
 *
 * CAN BE SATISFIED BY: the current rollup on THIS command. It is NOT evidence
 * that any other multi-operation command exists or misbehaves — `file upload`
 * is the only one — and NOT evidence that an agent has ever acted on it.
 */
describe('W5.F PIN 3 (M2) — the composite shard triple is unreachable for any operation', () => {
  it('CONTROL — the producible set is derived by exhaustion and is non-trivial', () => {
    const triples = producibleTriples();
    // 18 input combinations collapse to a small set. If this is 1 the
    // enumeration is broken and the M2 assertion below would pass vacuously.
    expect(triples.size).toBeGreaterThan(1);
    expect(triples).toContain('unknown|null|contract');
    expect(triples).toContain('unavailable|reserved|contract');
    expect(triples).toContain('available|observed_ok|observed');
    // The one that matters: a `not_implemented_on_node` verdict NEVER carries
    // `contract` for any single operation.
    expect(triples).not.toContain('unavailable|not_implemented_on_node|contract');
  }, 15_000);

  /**
   * ⚠ M2 DOES NOT REPRODUCE. THIS TEST RECORDS A DISPROOF, NOT A DEFECT.
   *
   * My developer measured the composite shard triple as
   *   (unavailable, not_implemented_on_node, CONTRACT)
   * and argued it is unreachable for any single operation — which would make it
   * a manufactured verdict claiming contract-level finality for a node-local
   * fact. I wrote this pin to archive that red before the fix.
   *
   * MY INDEPENDENT MEASUREMENT DISAGREES. The shard reports
   *   (unavailable, not_implemented_on_node, OBSERVED)
   * which IS producible — it is exactly what a single operation with a
   * `not_implemented` observation resolves to. The rollup carries the weakest
   * operation's source ALONG WITH its availability and reason, so all three
   * fields describe the same verdict and the shard is self-consistent.
   *
   * I DID NOT re-pin this to match. I ran it, it went red, and the red was
   * against MY DEVELOPER'S CLAIM rather than against the tree — which is what
   * a tester's pin is for. Reported as a disproof; M2 is withdrawn pending my
   * developer's re-measurement. The most likely explanation is that M2 was
   * measured before `ShardOptions.from` landed, when `commandHelp` read the
   * process singleton and another test's observations could bleed in.
   *
   * WHAT SURVIVES AND IS WORTH KEEPING: this is now a REGRESSION GUARD. It
   * asserts the composite triple stays in the producible set — so if a future
   * rollup change ever does manufacture an unreachable verdict, M2 becomes real
   * and this test catches it on the spot.
   */
  it('DISPROOF — the composite triple IS producible; M2 does not reproduce', () => {
    const shard = commandHelp(UPLOAD, { from: partiallyImplemented() });
    expect(shard).toBeDefined();

    const triple = `${shard!.availability}|${shard!.availabilityReason}|${shard!.availabilitySource}`;

    // MEASURED, and it is NOT the triple M2 reported.
    expect(triple).toBe('unavailable|not_implemented_on_node|observed');
    expect(triple).not.toBe('unavailable|not_implemented_on_node|contract');

    // THE PROPERTY M2 CLAIMED WAS VIOLATED, ASSERTED DIRECTLY — and it holds.
    // If this ever fails, M2 has become real: the rollup is manufacturing a
    // verdict no operation can produce. Do not re-pin it; investigate.
    expect(
      producibleTriples(),
      'the composite rollup now manufactures an unreachable triple — M2 has '
        + 'become REAL; this is a defect, not a stale expectation',
    ).toContain(triple);

    expect(AVAILABILITY_SOURCES).toContain(shard!.availabilitySource);
  }, 15_000);
});

/**
 * ═══ M3 ═══ THE SAME DTO CONTRADICTS ITSELF, AND THIS IS THE NATURAL CASE.
 *
 * `errorRefsFor` decides whether to advertise `not_implemented` from the HEAD
 * operation's availability rather than from the composite. On `file upload` the
 * head (`files.uploadInit`) is `available`, so the reference is omitted — while
 * the very same DTO says the command is unavailable BECAUSE it is not
 * implemented on this node.
 *
 * ONE DTO, TWO FIELDS, DIRECTLY CONTRADICTORY, and an agent reading `errorRefs`
 * to decide which failures to handle will not prepare for the one it will
 * actually get.
 *
 * DISPOSITION: red here means `errorRefsFor` now reads the composite. Do NOT
 * re-pin. CONVERT to asserting the reference IS present whenever
 * `availability !== 'available'`, which is the rule the file already intends.
 *
 * CAN BE SATISFIED BY: the omission on this command with this ledger. It is NOT
 * evidence about single-operation commands, where head and composite coincide
 * and the existing behaviour is correct.
 */
describe('W5.F PIN 4 (M3) — the shard omits the error it just said you would get', () => {
  const NOT_IMPLEMENTED_REF = 'tm8://error/not_implemented';

  it('CONTROL — errorRefs is populated, so a missing entry is an omission not an empty list', () => {
    const shard = commandHelp(UPLOAD, { from: partiallyImplemented() });
    expect(shard!.errorRefs.length).toBeGreaterThan(0);
    // Negative control on the matcher: a reference that should never be there.
    expect(shard!.errorRefs).not.toContain('tm8://error/definitely_not_a_code');
  }, 15_000);

  it('DEFECT, PINNED — availability says not_implemented_on_node; errorRefs omits it', () => {
    const shard = commandHelp(UPLOAD, { from: partiallyImplemented() });

    // Half one: the DTO says the command is unavailable for this exact reason.
    expect(shard!.availability).toBe('unavailable');
    expect(shard!.availabilityReason).toBe('not_implemented_on_node');

    // Half two: and omits that error from what the caller may receive.
    expect(
      shard!.errorRefs,
      'M3 is FIXED if this reference is now present — read the disposition '
        + 'block: CONVERT this pin to assert presence, do not re-pin it',
    ).not.toContain(NOT_IMPLEMENTED_REF);
  }, 15_000);

  it('SCOPE — a fully-unavailable command DOES advertise it, so the bug is composite-only', () => {
    // Both stages unreachable: head and composite agree, and the reference
    // appears. This is what proves M3 is a ROLLUP defect and not a blanket
    // failure of errorRefsFor — the distinction my developer needs to fix the
    // right function.
    const l = new AvailabilityLedger();
    l.record('files.uploadInit', 'not_implemented');
    l.record('files.uploadComplete', 'not_implemented');
    const shard = commandHelp(UPLOAD, { from: l });
    expect(shard!.availability).toBe('unavailable');
    expect(shard!.errorRefs).toContain(NOT_IMPLEMENTED_REF);
  }, 15_000);
});
