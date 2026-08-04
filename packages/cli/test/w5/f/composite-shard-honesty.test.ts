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

/**
 * ⚠ TWO FIXTURES, NOT ONE. THIS SPLIT IS THE REPAIR OF A REAL ERROR OF MINE.
 *
 * My first draft used ONE helper (recording both stages) for BOTH pins, and on
 * that fixture the M2 pin could not produce M2's condition. I read the red as a
 * disproof of M2 and REPORTED IT AS ONE. My developer refused the withdrawal
 * and showed its working; it was right. That was my first false positive to
 * leave this seat, and it ran toward killing a real finding.
 *
 * THE DISCRIMINATOR IS WHETHER `files.uploadInit` — the HEAD row — HAS AN
 * OBSERVATION. `shardFrom` takes `availabilitySource` from HEAD; help.ts:389-392
 * then overwrites `availability` and `availabilityReason` from the composite
 * `weakest()` and NEVER the source. So:
 *
 *   HEAD UNOBSERVED -> head resolves unknown/null/CONTRACT  -> shard source contract
 *   HEAD OBSERVED   -> head resolves available/observed_ok/OBSERVED -> shard source observed
 *
 * ONE DEFECT — the rollup does not carry source — with TWO PRESENTATIONS chosen
 * entirely by the head row's ledger state. A single fixture can only ever see
 * one of them.
 *
 * THE GENERAL LESSON, and it is not M2-specific: A PIN THAT DOES NOT ASSERT THE
 * WORLD IT NEEDS CANNOT KNOW WHICH WORLD IT RAN IN. Every pin below now asserts
 * its precondition before it asserts anything about the shard.
 */

/** M2's world: the HEAD row is deliberately UNOBSERVED. */
function m2Ledger(): AvailabilityLedger {
  const l = new AvailabilityLedger();
  // files.uploadInit deliberately NOT recorded.
  l.record('files.uploadComplete', 'not_implemented');
  return l;
}

/** M3's world: one real `file upload` — head answered, second stage absent. */
function m3Ledger(): AvailabilityLedger {
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
    const shard = commandHelp(UPLOAD, { from: m3Ledger() });
    expect(shard, 'the file upload command shard must exist').toBeDefined();
    expect(processLedger.revision(), 'commandHelp wrote to the PROCESS ledger').toBe(before);
  }, 15_000);

  it('CONTROL — the private ledger actually changes the answer, so the seam is load-bearing', () => {
    // A seam that is ignored would also leave the singleton at rest. This
    // distinguishes "honoured the ledger" from "did nothing".
    const cold = commandHelp(UPLOAD, { from: new AvailabilityLedger() });
    const warm = commandHelp(UPLOAD, { from: m3Ledger() });
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
describe('W5.F PIN 3 (M2, CONVERTED) — the shard triple is a coherent single verdict', () => {
  it('CONTROL — the producible set is derived by exhaustion and is non-trivial', () => {
    const triples = producibleTriples();
    // 18 input combinations collapse to a small set. If this is 1 the
    // enumeration is broken and the M2 assertion below would pass vacuously.
    expect(triples.size).toBeGreaterThan(1);
    expect(triples).toContain('unknown|null|none');
    expect(triples).toContain('unavailable|reserved|contract');
    expect(triples).toContain('available|observed_ok|observed');
    // The one that matters: a `not_implemented_on_node` verdict NEVER carries
    // `contract` for any single operation.
    expect(triples).not.toContain('unavailable|not_implemented_on_node|contract');
  }, 15_000);

  /**
   * ⚠ THE PRECONDITION IS ASSERTED FIRST, AND THAT IS THE POINT OF THIS PIN.
   *
   * My first draft of this test shared ONE fixture with the M3 pin, ran in M3's
   * world, and I published its red as a DISPROOF of M2. It was not. The pin
   * fired correctly at the wrong world, and nothing in it could say so.
   *
   * A MUTATION TEST PROVES A DETECTOR FIRES, NOT THAT IT IS AIMED AT THE RIGHT
   * PROPERTY. The precondition assertion below is what makes it aimed.
   */
  it('PRECONDITION — this pin runs in M2 world: the HEAD row is UNOBSERVED', () => {
    const l = m2Ledger();
    const head = resolveAvailability('files.uploadInit', 'v1', l);
    const weakest = resolveAvailability('files.uploadComplete', 'v1', l);

    // If this fails, every assertion in the next test is about a world I did
    // not intend, and its result means nothing either way.
    // `none` since Change 4 (2026-08-02): an unobserved row no longer borrows
    // `contract`'s name, so the precondition now reads literally as intended.
    expect(head.availabilitySource, 'HEAD must be unobserved for M2').toBe('none');
    expect(head.availability).toBe('unknown');
    expect(weakest.availabilitySource, 'the WEAKEST row must be observed').toBe('observed');
    expect(weakest.availability).toBe('unavailable');
  }, 15_000);

  it('FIXED, GUARDED — the shard carries the source of the verdict it adopted', () => {
    const l = m2Ledger();
    const shard = commandHelp(UPLOAD, { from: l });
    expect(shard).toBeDefined();

    const weakest = resolveAvailability('files.uploadComplete', 'v1', l);

    // The shard took its availability and reason from the WEAKEST row...
    expect(shard!.availability).toBe(weakest.availability);
    expect(shard!.availabilityReason).toBe(weakest.availabilityReason);

    // ...and did NOT take the source with them. THIS IS THE DEFECT, stated as
    // the property that is actually violated rather than as a literal triple.
    // It is PRESENTATION-INDEPENDENT: it names the incoherence itself, so it
    // cannot be satisfied by a fixture that happens to make both sources agree.
    // ═══ CONVERTED, NOT RE-PINNED (§3d) ═══
    // This pin asserted the DEFECT until the fix landed, then fired on cue —
    // its last scheduled act, predicted when it was written. Per its own
    // disposition it now asserts THE FIX: all three fields describe ONE verdict.
    expect(
      shard!.availabilitySource,
      'REGRESSION: the shard adopted the composite availability but kept a '
        + 'DIFFERENT source. That is M2 returning — the rollup dropped source again.',
    ).toBe(weakest.availabilitySource);

    // The triple is now coherent, so it must be reachable for a single operation.
    const triple = `${shard!.availability}|${shard!.availabilityReason}|${shard!.availabilitySource}`;
    expect(triple).toBe('unavailable|not_implemented_on_node|observed');
    expect(
      producibleTriples(),
      'REGRESSION: the rollup is manufacturing a triple no operation can produce',
    ).toContain(triple);
    expect(AVAILABILITY_SOURCES).toContain(shard!.availabilitySource);
  }, 15_000);

  /**
   * ═══ THE KNOWN-BAD HALF, REVERSE-DERIVED SO IT SURVIVES THE FIX (§3d.1) ═══
   *
   * The original version of this test demonstrated the blindness by observing
   * the live product. THE FIX DESTROYED THAT: post-fix both fixtures agree, so
   * observing the product proves nothing about fixture choice any more, and the
   * test silently became vacuous the moment M2 was repaired.
   *
   * A DETECTOR THAT LOSES ITS KNOWN-BAD HALF AT THE MOMENT OF THE FIX CANNOT
   * PROVE IT WOULD STILL CATCH A REGRESSION. So the blindness is now pinned
   * SYNTHETICALLY: the rollup rule is re-implemented locally over the two
   * fixtures, and the property asserted is that THE M3 FIXTURE CANNOT
   * DISTINGUISH the broken rollup from the correct one while the M2 FIXTURE
   * CAN. That is a fact about the FIXTURES, not about the product, so no source
   * change can ever repair it away (§7d).
   */
  it('SYNTHETIC — the M3 fixture is structurally blind to a dropped source; M2 is not', () => {
    // The two rollups, written out. `correct` carries the source with the
    // verdict; `broken` is M2 — it keeps the HEAD's source.
    const rollup = (l: AvailabilityLedger) => {
      const head = resolveAvailability('files.uploadInit', 'v1', l);
      const weakest = resolveAvailability('files.uploadComplete', 'v1', l);
      return { correct: weakest.availabilitySource, broken: head.availabilitySource };
    };

    const inM2 = rollup(m2Ledger());
    const inM3 = rollup(m3Ledger());

    // In M2's world the two rollups DISAGREE — a pin there can see the defect.
    expect(inM2.broken).not.toBe(inM2.correct);
    expect(inM2.broken).toBe('none');
    expect(inM2.correct).toBe('observed');

    // In M3's world they AGREE — a pin there is blind to it, no matter how
    // well written. This is the exact trap that made my disproof wrong, and it
    // is now a permanent fact of the fixtures rather than a comment.
    expect(
      inM3.broken,
      'if these ever differ, the M3 fixture has become able to see the defect '
        + 'and the two-fixture split may be revisited',
    ).toBe(inM3.correct);
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
describe('W5.F PIN 4 (M3, CONVERTED) — the shard advertises the error it says you will get', () => {
  const NOT_IMPLEMENTED_REF = 'tm8://error/not_implemented';

  it('CONTROL — errorRefs is populated, so a missing entry is an omission not an empty list', () => {
    const shard = commandHelp(UPLOAD, { from: m3Ledger() });
    expect(shard!.errorRefs.length).toBeGreaterThan(0);
    // Negative control on the matcher: a reference that should never be there.
    expect(shard!.errorRefs).not.toContain('tm8://error/definitely_not_a_code');
  }, 15_000);

  it('FIXED, GUARDED — availability says not_implemented_on_node and errorRefs says so too', () => {
    const shard = commandHelp(UPLOAD, { from: m3Ledger() });

    // Half one: the DTO says the command is unavailable for this exact reason.
    expect(shard!.availability).toBe('unavailable');
    expect(shard!.availabilityReason).toBe('not_implemented_on_node');

    // Half two: and omits that error from what the caller may receive.
    // ═══ CONVERTED, NOT RE-PINNED (§3d) ═══ It asserted the omission until the
    // fix landed; it now asserts the DTO is self-consistent — if availability
    // says not_implemented_on_node, errorRefs must advertise that error.
    expect(
      shard!.errorRefs,
      'REGRESSION: the DTO says unavailable BECAUSE not implemented on this '
        + 'node, and omits that very error from what the caller may receive. '
        + 'That is M3 returning — errorRefsFor read the HEAD, not the composite.',
    ).toContain(NOT_IMPLEMENTED_REF);
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
