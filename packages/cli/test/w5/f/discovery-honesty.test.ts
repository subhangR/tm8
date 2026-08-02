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
 * ═══ PIN 1 ═══ A CAUSATION PIN AGAINST PRODUCTION STATE (standing orders §3d),
 * so its disposition is authored HERE, at the same moment as the pin.
 *
 * THE DEFECT: `availability.ts:261` returns `availabilitySource: 'contract'`
 * for the default `unknown` verdict — on the path where `contractAvailability()`
 * RETURNED NULL, i.e. the contract explicitly DECLINED to answer. `contract` is
 * defined at `availability.ts:19-22` as the source that is offline,
 * node-independent and FINAL. So the label with the strongest meaning in the
 * vocabulary is applied to the rows nothing looked at.
 *
 * `commands/help.ts:118` prints it to an agent as:
 *     availability: [availability unknown] (source: contract)
 *
 * THIS PIN ASSERTS THE DEFECT, DELIBERATELY, AND IS THEREFORE GREEN TODAY.
 * Ownership of the repair was undecided at write time (it flips assertions in
 * three files that are neither my duo's nor my developer's), so an always-red
 * test would have been a permanent gate failure owned by nobody.
 *
 * DISPOSITION — WHAT TO DO WHEN THIS GOES RED:
 *   Red here means someone fixed `availability.ts:261`. That is the DESIRED
 *   outcome and this pin firing is its LAST SCHEDULED ACT, not a regression.
 *   Do NOT re-pin it to the new value. CONVERT it: assert that a verdict's
 *   `availabilitySource` names a source that actually produced it — i.e. that
 *   `unknown` carries the new `none`/`default` member — so the file keeps a
 *   regression guard instead of leaving an unexplained red at a landing window.
 *   The three shipped assertions that must move WITH that fix, enumerated now
 *   so the fixer does not have to rediscover them (§3d's retrospective half):
 *     test/discovery-availability.test.ts:71
 *     test/discovery-operations.test.ts:234
 *     test/integration/inbox.test.ts:433
 *
 * WHAT THIS PIN CAN BE SATISFIED BY, before what it asserts: it is satisfied by
 * the CURRENT labelling. It is NOT evidence that the labelling causes any agent
 * to misbehave — no such measurement exists — and it is NOT evidence about the
 * composite/multi-operation path, which is my developer's separately measured
 * M2 and is a different code path.
 */
describe('W5.F PIN 1 — availabilitySource names a source that did not answer', () => {
  it('the contract DECLINES on every v1 row — measured, not assumed', () => {
    // The premise of the whole finding. If this ever returns non-null, the
    // label below stops being unearned and PIN 1 is void rather than green.
    expect(contractAvailability('v1')).toBeNull();
    expect(contractAvailability('reserved')).not.toBeNull();
  }, 15_000);

  it('DEFECT, PINNED — the declined verdict is labelled `contract` anyway', () => {
    const fresh = new AvailabilityLedger();
    const verdict = resolveAvailability('entities.get', 'v1', fresh);

    expect(verdict.availability).toBe('unknown');
    expect(verdict.availabilityReason).toBeNull();
    // THE ASSERTION THE SHIPPED TEST'S TITLE PROMISES AND ITS BODY CANNOT MAKE.
    // Read the disposition block above before changing this line.
    expect(
      verdict.availabilitySource,
      'availability.ts:261 labels a declined verdict `contract`; see the '
        + 'disposition block — if this is red, CONVERT this pin, do not re-pin it',
    ).toBe('contract');
  }, 15_000);

  it('WHY IT SURVIVED — the shipped assertion cannot distinguish the defect', () => {
    // `test/discovery-availability.test.ts:43` is titled "unknown carries no
    // reason and DOES NOT PRETEND TO A SOURCE IT DID NOT USE". Its only source
    // assertion is `expect(AVAILABILITY_SOURCES).toContain(d.availabilitySource)`.
    // This test proves that assertion is satisfied BY THE EXACT VALUE ITS OWN
    // TITLE DENIES — it is a shape check, not a truth check.
    const fresh = new AvailabilityLedger();
    const unearned = resolveAvailability('entities.get', 'v1', fresh).availabilitySource;
    expect(AVAILABILITY_SOURCES).toContain(unearned); // passes — and proves nothing

    // And the vocabulary has no way to say "no source answered", which is why
    // the defect had nowhere honest to go. This is the missing member.
    expect(AVAILABILITY_SOURCES).not.toContain('none');
    expect(AVAILABILITY_SOURCES).not.toContain('default');
    expect([...AVAILABILITY_SOURCES]).toEqual(['contract', 'observed', 'advertised']);
  }, 15_000);

  it('BLAST RADIUS — 124 of 126 rows carry the unearned label on a cold ledger', () => {
    const fresh = new AvailabilityLedger();
    const rows = discovery(fresh);
    expect(rows).toHaveLength(126); // +1 node-local project directory browser.

    const earned = rows.filter(
      (r) => r.availabilitySource === 'contract' && r.availability === 'unavailable',
    );
    const unearned = rows.filter(
      (r) => r.availabilitySource === 'contract' && r.availability === 'unknown',
    );

    // EXACT SETS, not counts (§3c — a count cannot detect a substitution).
    expect(earned.map((r) => r.operation).sort()).toEqual(['bridge.fetchBlob', 'search.query']);
    expect(unearned).toHaveLength(124);
    // The two populations are INDISTINGUISHABLE by the source field alone:
    // both read `contract`, and nothing else in the row separates them.
    expect(earned.every((r) => r.availabilitySource === 'contract')).toBe(true);
    expect(unearned.every((r) => r.availabilitySource === 'contract')).toBe(true);
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
