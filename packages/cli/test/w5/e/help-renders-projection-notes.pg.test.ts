/**
 * W5 DUO E — DO THE PROJECTION'S NOTES ACTUALLY REACH THE PTY?
 *
 * ── WHY THIS EXISTS, AND WHY IT IS THE LAST THING I OWED ──────────────────
 *
 * Duo E's first disproof was that the `commands.undo` note is no longer
 * inverted — `discovery/operations.ts:615-631` carries the correction. I stated
 * a limit on that disproof in my first hour and carried it open all session:
 * **I READ THE TABLE. I HAD NOT CONFIRMED THE RENDERED TEXT AN AGENT ACTUALLY
 * SEES.** Help, completion and search are three renderings of one table
 * (`operations.ts:40`), so it was very likely — and "very likely" is not
 * measured.
 *
 * It is measured now, and the render is CORRECT. But closing it by looking
 * revealed the more useful thing:
 *
 * ⚠ **NOTHING PINS THE RENDER TO THE TABLE.** `test/help.test.ts` contains no
 * assertion about notes at all. If `help` ever filtered, truncated, reordered
 * or de-duplicated them, every projection test would stay green and the text an
 * agent reads would silently diverge from the text the program reviews.
 *
 * THAT IS NOT HYPOTHETICAL FOR THIS DUO RIGHT NOW. E-5 is a NOTE defect, and
 * its fix changes a note. **If the render were unfaithful, repairing the
 * projection would not repair what the agent sees, and my E-5 witness — which
 * reads the projection — would go green while the PTY still lied.**
 *
 * ── THE SHAPE IS STRUCTURAL AGREEMENT, NEVER A PROSE MATCH ────────────────
 *
 * §8 of the W4 handoff is explicit that pinning wording "goes red when an owner
 * legitimately rewords their own file", which punishes the correct action. So
 * this asserts **the rendered output contains exactly the notes the projection
 * declares** — both sides move together, so a legitimate reword keeps it green
 * and a dropped or mangled note turns it red.
 *
 * ── ⚠ OWNERSHIP OVERLAP, DECLARED RATHER THAN DISCOVERED ──────────────────
 *
 * `commands/help.ts` is **Duo F's** module (groups 10/11). This file EDITS
 * NOTHING of F's — it drives the built binary and reads its stdout, and it
 * lives under `test/w5/e/**`, which is Duo E's path. But the PROPERTY belongs
 * to F's mandate, and I am declaring the overlap rather than letting F discover
 * a duplicate later. **If F wires an equivalent, delete this file rather than
 * keep both** — two detectors for one property is how a fix greens one and
 * leaves the other, and then someone deletes the one that was right.
 */
import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../../integration/harness.js';
import { DISCOVERY } from '../../../src/discovery/operations.js';
import { commandHelp } from '../../../src/discovery/help.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const CLI = join(REPO_ROOT, 'packages/cli/dist/index.js');

/** `help` is LOCAL — no server, no database, no scratch anything. */
async function help(path: readonly string[]): Promise<{ code: number; stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn('node', [CLI, 'help', ...path], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.once('close', (code) => resolve({ code: code ?? -1, stdout }));
  });
}

/**
 * Commands whose notes carry a CORRECTNESS claim an agent acts on, so a
 * dropped note is a wrong belief rather than a missing nicety.
 *
 * `undo apply` is here because its note was INVERTED and repaired — it told an
 * operator that redemption RESTORES a message when it REDACTS one, which is a
 * wrong belief about data recovery. `session spawn` is here because its note is
 * inverted RIGHT NOW (Duo E's E-5), so this file also proves the render is
 * faithful enough for that repair to reach an agent at all.
 */
const COMMANDS: ReadonlyArray<{ path: string[]; operation: string }> = [
  { path: ['undo', 'apply'], operation: 'commands.undo' },
  { path: ['session', 'spawn'], operation: 'execution.spawn' },
  { path: ['message', 'send'], operation: 'messages.post' },
];

describe('help renders the projection notes — structural agreement, not wording', () => {
  for (const { path, operation } of COMMANDS) {
    it(`tm8 help ${path.join(' ')} renders every note of ${operation}`, async () => {
      // ⚠ COMPARE AGAINST THE SHARD, NOT THE TABLE. THE FIRST VERSION OF THIS
      // TEST COMPARED AGAINST `DISCOVERY` AND WAS AIMED AT THE WRONG LIST.
      //
      // `discovery/help.ts:395-406 commandHelp` builds a shard via
      // `shardFrom(..., CAPS.command)`, so THE PROJECTION ITSELF TRUNCATES
      // before anything is rendered. A detector comparing the render against
      // the UNTRUNCATED table flags working truncation as a defect. It passed
      // only because the largest row in the whole projection carries FOUR notes
      // against a 16384-byte cap — fixture luck, not aim.
      //
      // Fact supplied by `commands/help.ts`'s OWNER (Duo F's developer),
      // unprompted, before this file's green could be relied on. Verified here
      // rather than accepted: `CAPS.command` is 16384 (`discovery/help.ts:60-64`)
      // and `commandHelp` passes it at `:402`.
      const shard = commandHelp(path);
      expect(shard, `no command shard for ${path.join(' ')}`).toBeDefined();
      const notes = shard!.notes ?? [];
      // A command with no notes proves nothing here and would pass vacuously.
      expect(notes.length, `${operation} declares no notes — this row cannot test the property`).toBeGreaterThan(0);

      const r = await help(path);
      expect(r.code, 'help must succeed locally').toBe(0);

      for (const note of notes) {
        // ⚠ `String.includes('')` IS ALWAYS TRUE, so an empty note would pass
        // this assertion vacuously forever. Measured: ZERO rows in the whole
        // projection carry an empty note, so this is LATENT rather than live —
        // but the guard is free and the vacuity would be invisible.
        expect(note.length, 'an empty note makes the assertion below vacuous').toBeGreaterThan(0);
        expect(
          r.stdout.includes(note),
          `a declared note never reached the PTY:\n  ${note.slice(0, 120)}`,
        ).toBe(true);
      }
    });
  }

  /**
   * ⚠ THE SECOND PROPERTY, AND IT IS WHY "THE RENDER SHOWS EVERY NOTE" WAS
   * NEVER THE RIGHT SINGLE ASSERTION.
   *
   * `RENDER != FULL NOTES` IS DESIGNED BEHAVIOUR AT THE CAP. So the honest pair
   * is: the render matches THE SHARD IT WAS RENDERED FROM (asserted above), AND
   * a shard that dropped notes SAYS SO. Silent truncation is the defect; loud
   * truncation is the feature.
   *
   * TODAY THIS IS A NO-OP AND THE FILE SAYS SO RATHER THAN IMPLYING COVERAGE:
   * the largest row carries 4 notes against a 16384-byte cap, so no shard
   * truncates and the loop below asserts a vacuous truth. **IT IS WIRED NOW SO
   * THAT IT BECOMES MEANINGFUL WITHOUT ANYONE REMEMBERING TO WIRE IT** — the
   * day a row grows past the cap, this either confirms `truncated` is present
   * or fails. Wiring a guard before its subject exists is cheap; noticing the
   * subject arrived is not.
   */
  it('a shard that drops notes records the truncation — silent loss is the defect', async () => {
    for (const { path, operation } of COMMANDS) {
      const shard = commandHelp(path);
      const full = DISCOVERY.find((d) => d.operation === operation);
      const shardNotes = shard?.notes ?? [];
      const fullNotes = full?.notes ?? [];
      if (shardNotes.length === fullNotes.length) continue; // not truncated
      expect(
        shard!.truncated,
        `${operation}: the shard dropped notes and recorded no truncation`,
      ).toBeDefined();
    }
  });

  /**
   * ⚠ THE TRUNCATING PATH, ACTUALLY EXERCISED — CLOSING THE RESIDUAL DUO F's
   * TESTER NAMED AGAINST ITS OWN SECOND-READ.
   *
   * Its verdict verified the FACTS this detector rests on and then said the
   * honest thing: nobody has ever driven a notes list past 16384 bytes, so the
   * truncation guard above was **calibrated but never fired**. A guard that has
   * never fired is a hypothesis about a guard.
   *
   * THE DATA CANNOT REACH THE CAP — the largest row carries four short notes —
   * **SO SHRINK THE CAP INSTEAD OF GROWING THE DATA.** `commandHelp` takes
   * `opts.cap` (`discovery/help.ts:402`, `opts.cap ?? CAPS.command`). No
   * production caller passes it (traced by F's tester), which is exactly why it
   * is safe to use here: this exercises the truncating branch WITHOUT touching
   * `commands/help.ts` and without asserting anything about production caps.
   *
   * ⚠ WHAT THIS DOES AND DOES NOT SHOW: it proves the drop-and-record mechanism
   * WORKS and that my length-inequality test DETECTS IT. It does NOT show that
   * any real projection row will ever truncate — on today's data none can, and
   * the guard above stays a no-op until the data grows. Two different claims,
   * and only the first is measured here.
   */
  it('PROBE: at a forced tiny cap the shard really does drop notes AND record it', async () => {
    const path = ['undo', 'apply'];
    const full = commandHelp(path);
    const fullCount = (full?.notes ?? []).length;
    expect(fullCount, 'need a multi-note row for this probe to mean anything').toBeGreaterThan(1);

    // Small enough that the notes section cannot fit whole.
    const squeezed = commandHelp(path, { cap: 400 });
    expect(squeezed, 'the shard builder returned nothing at a small cap').toBeDefined();
    const squeezedCount = (squeezed!.notes ?? []).length;

    // THE DROP IS REAL...
    expect(
      squeezedCount,
      'a 400-byte cap dropped no notes — the truncating branch was not reached, so the guard above is still unexercised',
    ).toBeLessThan(fullCount);
    // ...AND IT IS RECORDED, which is the property that makes the loss loud.
    expect(
      squeezed!.truncated,
      'notes were dropped and nothing recorded it — THIS IS THE SILENT-TRUNCATION DEFECT',
    ).toBeDefined();
  });

  /**
   * THE NEGATIVE HALF. Without it, `includes()` over a long rendering could be
   * satisfied by almost anything and this file would pass while asserting
   * nothing — the same vacuity that makes a substring guard useless.
   */
  it('PROBE-RED CONTROL: a note the projection does NOT declare is absent', async () => {
    const r = await help(['undo', 'apply']);
    expect(r.code).toBe(0);
    expect(r.stdout.includes('redemption restores a redacted message to visible')).toBe(false);
    expect(r.stdout.includes('this sentence is not in any projection row')).toBe(false);
  });

  /**
   * ⚠ THE ONE THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT'S WHOLE CLASS.
   *
   * The `commands.undo` note was INVERTED — it said redemption RESTORES. The
   * repair is in the table. This asserts the repaired claim reaches the PTY,
   * structurally: the note the projection declares about redaction is rendered.
   *
   * It does NOT assert the wording. It asserts that whatever the projection
   * says on this subject is what the agent is told — so the day someone rewords
   * it correctly, this stays green, and the day the render drops it, it fails.
   */
  it('the repaired commands.undo redaction note reaches the PTY', async () => {
    const row = DISCOVERY.find((d) => d.operation === 'commands.undo');
    const redactionNote = (row?.notes ?? []).find((n) => /REDACT/i.test(n));
    expect(redactionNote, 'the projection no longer carries a redaction note — E-1 disproof may have expired').toBeDefined();

    const r = await help(['undo', 'apply']);
    expect(r.stdout.includes(redactionNote!)).toBe(true);
  });
});
