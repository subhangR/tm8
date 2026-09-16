/**
 * W5 · DUO F · TESTER — the two CLI-side properties my server-side path could
 * not reach. `@tm8/server` does not depend on `@tm8/cli`, so until this path
 * existed both of these were CITED, NEVER MEASURED. They are measured here.
 *
 * NEITHER DESCRIBE BLOCK EDITS OR REPLACES A SHIPPED TEST. Advisor 2 ruled that
 * `test/discovery-availability.test.ts` is a W4-era file, nobody's owned path,
 * and its assertion is WEAK RATHER THAN WRONG — so the property is pinned
 * CORRECTLY here instead of being repaired there.
 */
import { describe, expect, it } from 'vitest';

import {
  AVAILABILITY_SOURCES,
  AvailabilityLedger,
  contractAvailability,
  resolveAvailability,
} from '../../../src/discovery/availability.js';
import { discovery } from '../../../src/discovery/operations.js';
import { commandSurface } from '../../../src/prompt.js';

/**
 * ═══ PIN 1 (CONVERTED, NOT RE-PINNED — §3d) ═══
 *
 * THE DEFECT, AS PINNED: `availability.ts` (then :261, now :266 — the file
 * drifted ~5 lines) returned `availabilitySource: 'contract'` for the default
 * `unknown` verdict — on the path where `contractAvailability()` RETURNED
 * NULL, i.e. the contract explicitly DECLINED to answer. `contract` is defined
 * at `availability.ts:19-22` as the source that is offline, node-independent
 * and FINAL, so the label with the strongest meaning in the vocabulary was
 * applied to the rows nothing looked at. `commands/help.ts` printed it to an
 * agent as `availability: [availability unknown] (source: contract)`.
 *
 * THE FIX LANDED 2026-08-02 (plan Change 4): `none` joined
 * `AVAILABILITY_SOURCES` and the declined verdict now carries it. The pin
 * fired on cue — its LAST SCHEDULED ACT, exactly as its own disposition
 * predicted — and was converted per that disposition: each test below now
 * asserts that a verdict's `availabilitySource` names a source that actually
 * produced it, with `none` as the honest "nothing looked". The renderer needed
 * no change: `(source: none)` reads correctly as-is.
 *
 * The disposition's enumerated shipped assertions were resolved as follows:
 *   test/discovery-availability.test.ts (the weak shape check) — strengthened
 *     to assert `none`; its reserved-row `contract` assertion is EARNED and
 *     stays. test/discovery-operations.test.ts's enumerated assertion covers
 *     the two reserved rows — also earned, unchanged. test/integration/
 *     inbox.test.ts's fresh-process probe — moved to `none`. Two sites the
 *     enumeration missed (asserted via `toEqual`/derived triples, invisible to
 *     a `toBe('contract')` sweep) moved too: test/event.test.ts and
 *     test/w5/f/composite-shard-honesty.test.ts (control, precondition and
 *     synthetic-rollup fixtures).
 *
 * WHAT THIS GUARD CAN BE SATISFIED BY: the current labelling. It remains NOT
 * evidence that the old label ever caused an agent to misbehave — no such
 * measurement exists — and NOT evidence about the composite/multi-operation
 * path, which is M2 and a different code path.
 */
describe('W5.F PIN 1 (CONVERTED) — availabilitySource names a source that produced it', () => {
  it('the contract DECLINES on every v1 row — measured, not assumed', () => {
    // The premise of the original finding, still the premise of the guard: if
    // this ever returns non-null, `none` below stops being the honest answer
    // and this block is void rather than green.
    expect(contractAvailability('v1')).toBeNull();
    expect(contractAvailability('reserved')).not.toBeNull();
  }, 15_000);

  it('FIXED, GUARDED — the declined verdict is labelled `none`, never `contract`', () => {
    const fresh = new AvailabilityLedger();
    const verdict = resolveAvailability('entities.get', 'v1', fresh);

    expect(verdict.availability).toBe('unknown');
    expect(verdict.availabilityReason).toBeNull();
    expect(
      verdict.availabilitySource,
      'REGRESSION: the unknown fallback (availability.ts:266) is borrowing a '
        + 'source\'s name again. A verdict no source produced carries `none`.',
    ).toBe('none');
  }, 15_000);

  it('the vocabulary can say "no source answered" — and unknown says it', () => {
    // Pre-fix, this test proved the shipped shape check was satisfied by the
    // exact value its own title denied, and that the vocabulary had no honest
    // member for "nothing looked". Both halves are now the guard: the member
    // exists, and the declined verdict is what carries it.
    const fresh = new AvailabilityLedger();
    const source = resolveAvailability('entities.get', 'v1', fresh).availabilitySource;
    expect(AVAILABILITY_SOURCES).toContain(source); // the shape check, now backed...
    expect(source).toBe('none'); // ...by the truth check it used to lack.
    expect([...AVAILABILITY_SOURCES]).toEqual(['contract', 'observed', 'advertised', 'none']);
  }, 15_000);

  it('BLAST RADIUS, CONVERTED — the two populations are now distinguishable', () => {
    const fresh = new AvailabilityLedger();
    const rows = discovery(fresh);
    // 121 -> 126 (2026-08-02): auth.* Identity v2 Stage 1 (4 ops, all public, all with commands).
    // 126 -> 127 (2026-08-02): execution.launch (public, with a command).
    // 127 -> 128 (2026-08-09): execution.transcript (public, with a command).
    // 128 -> 129 (2026-08-09): projects.branches.list (public, with a command).
    // 129 -> 131 (2026-08-09): projects.contention + entities.commands.gate.
    // 131 -> 135: credentials.* Tier B.
    // 137 -> 138 (2026-08-09): execution.dispatch (public, `session dispatch`).
    // 142 -> 144 (2026-08-12): collections.addItem/removeItem.
    // 144 -> 150 (2026-08-12, Git UI landing): the six execution.git* rows.
    // 172 -> 197 (2026-09-03, containers): the 25 containers.* rows. MEASURED.
    expect(rows).toHaveLength(197);

    const earned = rows.filter((r) => r.availabilitySource === 'contract');
    const unknownRows = rows.filter((r) => r.availability === 'unknown');

    // EXACT SETS, not counts (§3c — a count cannot detect a substitution).
    // `contract` now appears exactly where the contract ANSWERED.
    expect(earned.map((r) => r.operation).sort()).toEqual(['bridge.fetchBlob', 'search.query']);
    expect(earned.every((r) => r.availability === 'unavailable')).toBe(true);
    // And the rows nothing looked at all say so, uniformly.
    // 123 -> 125 (2026-08-02): execution.launch is a v1 row, so the cold ledger
    // declines it like every other — it joins the `none` population, not `earned`.
    // 125 -> 126 (2026-08-07): execution.transcript, for the same reason.
    // 126 -> 127 (2026-08-09): projects.branches.list, likewise a v1 row.
    // 127 -> 129 (2026-08-09): projects.contention + entities.commands.gate.
    // 129 -> 133: the four credentials.* v1 rows join the `none` population.
    // 135 -> 136: execution.dispatch, a v1 row, joins `none` too.
    // 142 -> 148 (2026-08-12, Git UI landing): the six execution.git* rows.
    // 170 -> 195: all 25 containers.* rows are non-reserved. MEASURED.
    expect(unknownRows).toHaveLength(195);
    expect(unknownRows.every((r) => r.availabilitySource === 'none')).toBe(true);
  }, 15_000);
});

/**
 * ═══ PIN 2 ═══ THE ENTRY-POINT PIN. Approved by Advisor 2.
 *
 * The three-seat synthesis — Duo D's 65-of-99 silent flag discard, my
 * developer's M1 byte-identity measurement, and my harness link — rests on ONE
 * fact that nothing currently guards: that the prompt every spawned agent boots
 * with MANDATES this exact command as its way to learn the grammar.
 *
 * `packages/prompt/src/index.ts:176,200,269-272` — and `@tm8/prompt` is the
 * SINGLE implementation, imported by both the spawn path (`@tm8/execution`,
 * which embeds the prompt in the agent's command line) and by this CLI
 * (`src/prompt.ts` re-exports it, `tm8 worker init` re-reads it). So pinning it
 * from here pins the spawn path too — there is no second implementation to
 * drift.
 *
 * WITHOUT THIS PIN the synthesis expires silently the day someone renames or
 * moves the discovery root, and nothing anywhere would say so.
 *
 * WHAT IT CAN BE SATISFIED BY: it is satisfied by the string being PRESENT in
 * the composed surface. It is NOT evidence that an agent reads it, obeys it, or
 * succeeds — and it is NOT evidence about the typo behaviour itself, which is
 * my developer's M1 against the built binary and is a different measurement.
 */
describe('W5.F PIN 2 — the harness still mandates the discovery entry point', () => {
  const DISCOVERY_ROOT = 'tm8 help --format json';

  it('the composed command surface names the discovery root, with and without a session', () => {
    for (const hasSession of [true, false]) {
      const surface = commandSurface(hasSession);
      const usages = surface.map((c) => c.usage);
      expect(
        usages,
        `the discovery root left the command surface (hasSession=${hasSession}). `
          + 'Three seats\' synthesis is anchored to this string: if it MOVED, re-anchor '
          + 'the pin; if it was REMOVED, the synthesis needs re-deriving, not re-pinning.',
      ).toContain(DISCOVERY_ROOT);
    }
  }, 15_000);

  it('CONTROL — the surface is non-trivial, so `toContain` is not passing on a fluke', () => {
    // A one-element surface containing only the root would satisfy the test
    // above for the wrong reason. It must be a real command list.
    const surface = commandSurface(true);
    expect(surface.length).toBeGreaterThan(1);
    expect(new Set(surface.map((c) => c.usage)).size).toBe(surface.length);
    // Negative control on the matcher itself.
    expect(surface.map((c) => c.usage)).not.toContain('tm8 help --format jsonl');
  }, 15_000);
});
