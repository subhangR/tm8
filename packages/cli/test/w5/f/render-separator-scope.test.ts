/**
 * W5 · DUO F · TESTER — the RED for the separator defect.
 *
 * MY CALL AS THE FILE'S TESTER: this is a red, and it is a SMALL one. Both
 * halves of that sentence are deliberate.
 *
 * THE DEFECT. /Users/subhang/Desktop/Projects/tm8/packages/cli/src/commands/help.ts:151
 *     return lines.filter((l) => l !== '').join('\n');
 * `renderCommand` pushes blank strings as SECTION SEPARATORS throughout, and
 * this filter eats every one of them. `renderNoun` in the same file uses the
 * same push-a-blank idiom and has NO such filter, so it keeps its breaks. Same
 * file, same idiom, opposite outcomes.
 *
 * The filter's TRUE subject is the two CONDITIONAL empties at :126-131 — the
 * `dto.reason ? ... : ''` and `dto.publicComposite ? ... : ''` slots, which must
 * not render as blank lines when absent. A CORRECT INTENTION APPLIED AT TOO
 * COARSE A SCOPE: it cannot tell "this slot was empty" from "this is a break".
 *
 * That is the same shape as every wholesale-overwrite defect this wave found —
 * an operation that cannot distinguish the thing it means to remove from the
 * thing it happens to match — expressed in whitespace instead of data.
 *
 * ═══ WHY IT IS A RED RATHER THAN AN OPINION ═══
 * The author's intent is EXECUTABLE a few lines away in `renderNoun`. So
 * "denser than intended" is not an aesthetic preference; it is a divergence
 * from the same file's own demonstrated intent, and that is pinnable.
 *
 * ═══ WHY IT IS SMALL, SCOPED DOWN AGAINST MY OWN INTEREST IN A BIGGER FINDING ═══
 *  - IT IS NOT CONTENT LOSS. Every note, example, error ref and schema line
 *    survives. Only blank lines are removed. This file asserts exactly that.
 *  - THE JSON IS UNTOUCHED. The filter is human-render only.
 *  - IT DOES NOT BITE MY OWN MANDATE'S POPULATION. An agent discovering the
 *    grammar runs `tm8 help --format json` — the harness mandates that exact
 *    string (packages/prompt/src/index.ts:176,200). The dense wall reaches
 *    HUMAN readers. I would queue this behind anything an agent can trip on.
 *
 * ═══ WHAT THIS CAN BE SATISFIED BY ═══
 * It is satisfied by the human render of ONE command shard containing no blank
 * line while its sibling noun render does. It is NOT evidence about the DTO,
 * NOT evidence any information is lost, and NOT evidence about the other two
 * renderers, which do not emit notes at all.
 *
 * DISPOSITION (§3d): red here means the filter was narrowed to its two real
 * subjects. Do NOT re-pin. CONVERT to asserting the command render CONTAINS
 * blank separators AND still contains no doubled blank line — the property
 * `renderNoun` already satisfies.
 */
import { describe, expect, it } from 'vitest';

import { createOutput } from '../../../src/output.js';
import { emitCommandHelp, help } from '../../../src/commands/help.js';
import { parseInvocation } from '../../../src/args.js';

/** Capture a human render without touching the real streams. */
function render(fn: (out: ReturnType<typeof createOutput>) => void): string {
  let captured = '';
  const out = createOutput({
    format: 'human',
    streams: {
      // OutputStreams members are FUNCTIONS, not node streams (output.ts:19-22).
      stdout: (chunk: string | Uint8Array) => { captured += String(chunk); },
      stderr: () => {},
    },
  });
  fn(out);
  // Output.data appends a single trailing newline (output.ts:64). Splitting
  // without stripping it yields a phantom empty final element that looks
  // exactly like a surviving separator — an artifact of MY instrument, caught
  // by the pin reporting [ '' ] rather than [].
  return captured.replace(/\n$/, '');
}

describe('W5.F RED — the command render loses every section separator', () => {
  it('CONTROL — renderNoun KEEPS its blank separators (the executable intent)', () => {
    const text = render((out) => {
      help(['file'], parseInvocation(['help', 'file']).options, out);
    });
    // The sibling renderer, same file, same push-a-blank idiom, no filter.
    expect(text.length).toBeGreaterThan(0);
    expect(
      text.split('\n').some((l) => l === ''),
      'renderNoun must keep blank lines — it is the intent this red measures against',
    ).toBe(true);
  }, 15_000);

  it('DEFECT, PINNED — renderCommand emits NOT ONE blank line', () => {
    const text = render((out) => {
      emitCommandHelp(['file', 'upload'], out);
    });
    expect(text.length).toBeGreaterThan(0);

    const blanks = text.split('\n').filter((l) => l === '');
    expect(
      blanks,
      'the :151 filter was narrowed — read the disposition block: CONVERT this '
        + 'pin to assert separators are PRESENT, do not re-pin it',
    ).toHaveLength(0);
  }, 15_000);

  it('SCOPE — NOTHING IS LOST. Every section still renders; only breaks are gone', () => {
    // The half that keeps this finding honest and stops it being inflated into
    // a content-loss claim. If any of these ever disappears, THAT is a
    // different and much larger defect.
    const text = render((out) => {
      emitCommandHelp(['file', 'upload'], out);
    });
    for (const section of ['availability:', 'syntax', 'operations', 'schemas', 'catalog ']) {
      expect(text, `section "${section}" must survive the filter`).toContain(section);
    }
    expect(text.split('\n').length).toBeGreaterThan(5);
  }, 15_000);
});
