import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WHAT THE FAB'S CHIPS ARE ACTUALLY WORTH — read off the stylesheet, because
 * nothing else in this package can read it.
 *
 * `entity-fab.test.tsx` next door asserts the DOM: which rows exist, in what
 * order, which one is `aria-disabled`, and that the refusal's sentence is in
 * the tree and wired to its row. Every one of those passes whether the rule
 * that hides that sentence exists or not — jsdom loads no stylesheets, so a
 * caption restored to full size tomorrow would leave that whole file green
 * while the defect the owner filed came straight back on the phone.
 *
 * So this file asserts the other half, in the only way available: by reading
 * the rule. Same pattern and same reasons as `msheet-size.test.ts` next door.
 *
 * NODE ENVIRONMENT, DELIBERATELY — this file carries no environment pragma, so
 * it takes the runner's `environment: 'node'` default. Under jsdom
 * `import.meta.url` resolves against the DOCUMENT's base rather than this file,
 * and the read below fails outright with "the URL must be of scheme file".
 *
 * DO NOT WRITE THE PRAGMA'S NAME IN THIS COMMENT. Vitest finds the directive by
 * scanning the file's leading comment block for it — the word alone, in prose,
 * in a sentence explaining that the file does not use it, is enough to switch
 * the environment and break the read. Measured here first: this docblock said
 * so plainly, and the file failed on its import line.
 *
 * COMMENTS ARE STRIPPED FIRST, and it is not a formality: the blocks asserted
 * here EXPLAIN the properties they deliberately do not use — `opacity`,
 * `display: none`, `visibility: hidden` — so a negative assertion over raw text
 * would match the explanation and pass on a rule written the wrong way round.
 */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

const css = strip(readFileSync(new URL('./entity-fab.css', import.meta.url), 'utf8'));

/** Just the declarations of one rule, so a claim about `.efab__reason` cannot
    be satisfied by a match somewhere else in the stylesheet. */
function block(selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `${selector} is not in entity-fab.css`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

describe('the refusal’s reason is announced, never drawn', () => {
  /**
   * THE CLIP. Owner ruling 2026-08-20: a refused chip is "just disabled, icon"
   * — no caption. The node stays for `aria-describedby`; the rule is what makes
   * it weightless.
   *
   * Both `clip` and `clip-path` are asserted. `clip` is deprecated and the
   * modern-only version fails on older WebKit, which is exactly the phone this
   * shell is for; `clip-path` alone in a browser that ignores it leaves a 1px
   * box with `overflow: hidden`, which is harmless — but the pair is what
   * `panels.css`'s own `.sr-only` ships and there is no reason for this file to
   * be the weaker copy.
   */
  it('clips the reason to a 1px box', () => {
    const reason = block('.efab__reason');
    expect(reason).toMatch(/inline-size:\s*1px/);
    expect(reason).toMatch(/block-size:\s*1px/);
    expect(reason).toMatch(/overflow:\s*hidden/);
    expect(reason).toMatch(/clip:\s*rect\(/);
    expect(reason).toMatch(/clip-path:\s*inset\(/);
  });

  /**
   * NOT `display: none` AND NOT `visibility: hidden`, and this is the assertion
   * that catches the tidy-looking rewrite. Both remove the element from the
   * ACCESSIBILITY TREE, which deletes the one thing this node is still here for
   * — the row would be dimmed, `aria-describedby` would point at it, and a
   * screen reader would announce nothing at all. Both also *pass* a human
   * reading of the diff as "hides the caption", which is why it is pinned here
   * rather than left to review.
   */
  it('hides it without taking it out of the accessibility tree', () => {
    const reason = block('.efab__reason');
    expect(reason).not.toMatch(/display:\s*none/);
    expect(reason).not.toMatch(/visibility:\s*hidden/);
  });
});

describe('the refused chip', () => {
  /**
   * DIMMED BY INK, NOT BY `opacity` — the shape this file replaced.
   *
   * `opacity` fades the whole chip INCLUDING its border and its shadow toward
   * the 32%-black scrim behind it, and at 0.45 over that scrim the row stops
   * reading as an object and starts reading as a rendering fault. Each property
   * is dropped explicitly instead, which is also what lets the fill drop to
   * paper — putting the refusal visually BEHIND the live chips rather than
   * beside them.
   */
  it('drops its fill, its shadow and its ink rather than its opacity', () => {
    const refused = block(".efab__item[aria-disabled='true']");
    expect(refused).not.toMatch(/opacity:/);
    expect(refused).toMatch(/background:\s*var\(--pn-paper\)/);
    expect(refused).toMatch(/box-shadow:\s*none/);
    expect(refused).toMatch(/color:\s*var\(--pn-ink-3\)/);
  });

  /**
   * THE 44px FLOOR IS UNCONDITIONAL, and belongs to `.efab__item` rather than
   * to a live-only modifier. A refusal shorter than the verb it stands in for
   * makes the stack move as an entity changes state, under a thumb already
   * reaching for the row that was there a moment ago — `panel-bar-phone.css`
   * states the same rule for the panel bar's disabled controls.
   *
   * Asserted as the ABSENCE of a re-declaration in the refused block, because
   * that is how it would actually be broken: not by deleting the floor, but by
   * shrinking it "just for the dimmed ones".
   */
  it('keeps the live chip’s touch floor', () => {
    /* `'] .efab__item {` and not `.efab__item`: the shell attribute's closing
       bracket is what distinguishes the chip's own rule from
       `.efab__row > .efab__item`, which is earlier in the file and would be
       what a bare `indexOf` returned. */
    expect(block("'] .efab__item {")).toMatch(/min-block-size:\s*var\(--mobile-touch-min\)/);
    expect(block(".efab__item[aria-disabled='true']")).not.toMatch(/min-block-size/);
  });
});
