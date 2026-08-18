/**
 * THE CASCADE, TESTED AS ARITHMETIC — because nothing else here can test it.
 *
 * jsdom does not compute specificity or apply a real cascade, and the component
 * tests run in jsdom, so a bubble that renders in the wrong place looks
 * identical to a correct one in every other test in this directory. That blind
 * spot is not hypothetical: the sidedness rule shipped BROKEN between being
 * written and being built. `.cv2-root .md-root.tr-turn__body` is (0,3,0) —
 * raised deliberately to outrank `kit/markdown.css:10` — and the sidedness rule
 * was a bare `.tr-turn[data-input] .tr-turn__body`, which is ALSO (0,3,0). The
 * tie went to source order, the bubble declared `margin-left: 26px` later in
 * the file, and the viewer's turn never moved to the right edge.
 *
 * So the two invariants that decide whether this surface LOOKS right are
 * asserted against the stylesheet text itself:
 *
 *   1. every rule that overrides the base bubble must be STRICTLY more
 *      specific than it — never merely later;
 *   2. the base bubble must outrank `.cv2-root .md-root`, or the whole surface
 *      renders in the document serif (which is what Chat Home does today).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  selectorsTargeting,
  specificity,
  specificityRank,
  weakOverridesOf,
} from '../kit/css-specificity';

const CSS = readFileSync(fileURLToPath(new URL('./transcript.css', import.meta.url)), 'utf8');
/** Comments explain the rules and sometimes name what the rules must NOT do,
 *  so anything asserting on declarations reads this instead. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the transcript stylesheet cascade', () => {
  const BASE = '.cv2-root .md-root.tr-turn__body';

  it('reads the base bubble rule at the specificity it needs', () => {
    const selectors = selectorsTargeting(CSS, 'tr-turn__body');
    expect(selectors).toContain(BASE);
    // (0,3,0) — .cv2-root + .md-root + .tr-turn__body.
    expect(specificity(BASE)).toEqual([0, 3, 0]);
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR. A tie is a bug even when it happens to
   * render correctly today, because it renders correctly only for as long as
   * nobody moves a rule.
   */
  it('makes every bubble override STRICTLY more specific than the base rule', () => {
    // Not vacuous: there ARE overrides to check.
    expect(
      selectorsTargeting(CSS, 'tr-turn__body').filter((s) => s !== BASE).length,
    ).toBeGreaterThan(0);

    expect(
      weakOverridesOf(CSS, BASE, 'tr-turn__body'),
      'these selectors do not strictly outrank the base bubble rule, so which one wins '
        + 'depends on source order. Qualify the selector; do not move it.',
    ).toEqual([]);
  });

  /**
   * `kit/Markdown` always emits `md-root` and the app shell is always
   * `.cv2-root`, so `kit/markdown.css`'s `.cv2-root .md-root` — a serif family
   * at document size — applies to every turn body unless this rule outranks it.
   */
  it('outranks the shared markdown defaults it renders inside', () => {
    expect(specificityRank(specificity(BASE)))
      .toBeGreaterThan(specificityRank(specificity('.cv2-root .md-root')));
  });

  // Sidedness is presentation only: `justify-content`, never `row-reverse`, so
  // DOM order — and with it screen-reader and tab order — is identical on both
  // sides. This is Chat Home's ruled treatment and the reason for it.
  it('moves a turn with alignment, never by reversing the DOM', () => {
    expect(RULES).toMatch(/\[data-input='true'\][^{]*\{\s*justify-content:\s*flex-end/);
    expect(RULES).not.toMatch(/row-reverse/);
  });
});
