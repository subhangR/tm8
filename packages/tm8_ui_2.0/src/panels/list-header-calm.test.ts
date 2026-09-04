/**
 * THE ENTITY LIST HEADER — the contract for the row that renders above EVERY
 * entity list in the product (Tasks, Docs, Artifacts, Files, …). One header,
 * every kind, which is why it is worth pinning.
 *
 * WHY THIS READS CSS AS TEXT RATHER THAN RENDERING IT. `vite.config.ts:57`
 * sets `environment: 'node'` with no `css` key, so vitest's default
 * `css: false` applies and stylesheets are NEVER applied in this suite. A
 * jsdom render cannot see a single declaration below. Source-reading is not a
 * second-best here; it is the only instrument that can see this file at all,
 * and a green component test says nothing about any of it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, 'panels.css'), 'utf8');
const TSX = readFileSync(join(HERE, 'EntityListPanel.tsx'), 'utf8');

/**
 * EVERY BLOCK FOR A SELECTOR, NOT THE FIRST.
 *
 * THE TRAP THIS EXISTS TO AVOID, which cost the integrator a false red on the
 * 2026-08-30 gate and which this selector family is the worst case of:
 * `.cv2-root .lp__tab` has TWO blocks, and the `@media (prefers-reduced-motion)`
 * one — whose whole body is `transition: none` — is declared ABOVE the base
 * rule. A first-match helper therefore reads the media override, finds no
 * `color`, and fails a rule that is perfectly correct.
 *
 * A media override declared above its base rule is ordinary CSS. It must not
 * be able to fail an assertion about the base rule, so the question asked here
 * is "does ANY block for this selector declare it", never "does the first".
 *
 * THROWS when it finds none, rather than returning []. A silent empty makes
 * every `.not` assertion below pass vacuously, so a renamed selector would
 * read as a satisfied invariant — lane I's hardening, same shape, same file.
 */
function blocksFor(selector: string): readonly string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\.cv2-root\\s+${escaped}\\s*\\{([^}]*)\\}`, 'g');
  const found = [...CSS.matchAll(re)].map((m) => m[1] ?? '');
  if (found.length === 0) throw new Error(`no block opens for selector: ${selector}`);
  return found;
}

const declares = (selector: string, needle: string): boolean =>
  blocksFor(selector).some((body) => body.includes(needle));

describe('the active tab is marked by an outline', () => {
  it('finds the blocks it claims to read (a helper matching nothing proves nothing)', () => {
    expect(blocksFor('.lp__tab').length).toBeGreaterThanOrEqual(2);
    expect(blocksFor('.lp__tab--active').length).toBeGreaterThanOrEqual(1);
    expect(() => blocksFor('.lp__tab--nonexistent')).toThrow();
  });

  it('carries no fill — the shape the owner rejected TWICE', () => {
    /*
     * THE SEQUENCE, and it now has three steps rather than two. The owner was
     * sent the status row with a FILLED active pill, asked for that shape to
     * go, was offered underline / ring / ink-only, and chose the UNDERLINE.
     * That shipped as an `::after` rule and was never deployed. Looking at
     * prod — still the fill, because none of this has shipped — the owner then
     * asked for "nice bordered one same right side": the RING they had earlier
     * declined. It was put to them again with the underline named as the
     * alternative, and they chose bordered. Latest instruction wins.
     *
     * THE INVARIANT ACROSS ALL THREE ROUNDS IS THE FILL. It is the one shape
     * that has been rejected every time, so `background` is the assertion that
     * must never soften here, whatever carries the mark next.
     *
     * The accent also STAYS on the word: "where you are" is its one sanctioned
     * job, and decolouring the active tab would delete the only cue naming the
     * band on screen. The border joins the word; it does not replace it.
     */
    expect(declares('.lp__tab--active', 'color: var(--pn-brand-2)')).toBe(true);
    expect(declares('.lp__tab--active', 'font-weight: 700')).toBe(true);
    expect(declares('.lp__tab--active', 'background')).toBe(false);
  });

  it('draws the ring on the tab\'s own reserved border, so the mark costs no layout', () => {
    expect(declares('.lp__tab--active', 'border-color: var(--pn-brand-2)')).toBe(true);
    // The 1px is reserved TRANSPARENT on the base rule precisely so turning it
    // on cannot reflow the row. If that ever becomes `border: none`, this mark
    // starts moving its neighbours and the failure looks like a spacing bug.
    expect(declares('.lp__tab', 'border: 1px solid transparent')).toBe(true);
    // The underline is GONE, not left dead. Seven built-but-unrendered rules
    // were catalogued on 2026-08-30; a retired mark that still ships is how an
    // eighth happens.
    expect(() => blocksFor('.lp__tab--active::after')).toThrow();
    expect(CSS).not.toContain('lp__tab--active::after');
  });

  it('keeps BOTH halves of the mark under the pointer, and never grows a fill', () => {
    // Hover must not read as deselection. Under the underline this needed only
    // the word defended, because a pseudo-element no hover rule touched
    // carried the state. The ring lives on the tab's own border, which the
    // base `:hover` does touch — so hover now has to hold two declarations
    // where it used to hold one. That is the cost of moving a state onto a
    // property something else already writes.
    expect(declares('.lp__tab--active:hover', 'color: var(--pn-brand-2)')).toBe(true);
    expect(declares('.lp__tab--active:hover', 'border-color: var(--pn-brand-2)')).toBe(true);
    expect(declares('.lp__tab--active:hover', 'background')).toBe(false);
  });

  it('flips the ring in dark, not only the word', () => {
    // WHEN YOU MOVE WHAT CARRIES A STATE, EVERY RULE THAT RESTATES IT MOVES
    // TOO — and this is the SECOND time that audit has been forced on this
    // element. The dark block lifts the active word off `--pn-brand-2` (muddy
    // on a dark surface) onto `--pn-brand`. Under the underline the bar had to
    // follow, in its own selector, because a pseudo-element does not inherit
    // `background`. The ring follows too, but it can ride the SAME group,
    // because `border-color` is a property of the element the word is on.
    //
    // That is the one respect in which the ring is cheaper than the underline:
    // one carrier, one dark override, no pseudo-element to keep in step.
    //
    // COLLECT THE DARK GROUPS AND ASK WHICH PROPERTY EACH CARRIES, rather than
    // writing one regex per group. My first draft did the latter and the text
    // regex used `[^{:]*`, which cannot match a group whose last selector
    // before `{` is `… .lp__tab--active:hover` — it excluded the very colon it
    // had to cross. It failed while the CSS was correct, which is the same
    // false-red the first-match helper produces one level up.
    const dark = [...CSS.matchAll(/\[data-theme='dark'\][^{]*\.lp__tab--active[^{]*\{([^}]*)\}/g)]
      .map((m) => m[1] ?? '');
    expect(dark.length).toBeGreaterThanOrEqual(1);
    expect(dark.some((b) => b.includes('color: var(--pn-brand)'))).toBe(true);
    expect(dark.some((b) => b.includes('border-color: var(--pn-brand)'))).toBe(true);
    // The word and the edge must flip TOGETHER. A dark tab whose ring stays on
    // `--pn-brand-2` while its word moves to `--pn-brand` is two blues arguing
    // about which one means "here" — the exact defect the underline version
    // had to answer, inherited by the shape that replaced it.
    expect(dark.some((b) => b.includes('color: var(--pn-brand)') && b.includes('border-color: var(--pn-brand)'))).toBe(true);
  });

  it('hovers with an edge, never with the retired --pn-hover fill', () => {
    // MEASURED, NOT ASSUMED. The owner's screenshot shows the hovered
    // `collections` chip at (239,242,244) against a (247,249,251) page — that
    // grey IS `--pn-hover` rendering. It was read as a third control shape; it
    // was this fill. The calm pass retired the pattern for edge-strengthening,
    // and these two rules are the busiest row in the product.
    expect(declares('.lp__tab:hover', 'var(--pn-hover)')).toBe(false);
    expect(declares('.lp__chip:hover', 'var(--pn-hover)')).toBe(false);
    expect(declares('.lp__tab:hover', 'border-color: var(--pn-line-2)')).toBe(true);
    expect(declares('.lp__chip:hover', 'border-color: var(--pn-line-2)')).toBe(true);
  });
});

describe('the header says what the design says', () => {
  it('shows every count, including a zero', () => {
    /*
     * Measured off TARGET.png: `To Do 0` and `Done 603` sample the SAME black
     * (0,0,0). The empty tab carries no demotion — not lighter ink, not
     * lighter weight — and it keeps its number.
     *
     * I had dropped the zero and greyed the tab, on the argument that `To Do 0`
     * is a control advertising its own emptiness. The design says otherwise and
     * the design is the bar. `0` is the honest answer to "how many are in this
     * band", and a reader comparing four bands wants four numbers.
     *
     * PINNED AS THE WHOLE EXPRESSION, NOT AS A SUBSTRING OF IT. My first
     * version asserted only that the label template appears somewhere and the
     * comment claimed that caught "a future branch that renders the name
     * alone". It did not: adding a third arm leaves the template present, so
     * the assertion passes and the regression ships. The comment described a
     * guarantee the assertion did not have — the same defect lane I found in
     * its own `not.toMatch(/[▸▾]/)` comment, which claimed a whole-chrome ban
     * that only ever read one stylesheet.
     *
     * Matching the complete ternary is what actually holds the shape: two
     * arms, glyph or label-with-count, and nothing else. A third arm changes
     * this string and fails here.
     */
    /*
     * SUPERSEDED 2026-08-31 — THERE IS A THIRD ARM NOW, AND THIS TEST IS WHY IT
     * IS WRITTEN DOWN RATHER THAN DISCOVERED.
     *
     * What was pinned here was the complete two-arm ternary, on the reasoning
     * quoted above: "a third arm changes this string and fails here". It did
     * exactly that, on the first run after the change, which is the whole value
     * of pinning the expression instead of a substring of it.
     *
     * WHAT ADDED THE ARM: `bucketCountLabel` (domain/types.ts) can now answer
     * `null` — "this bucket's count cannot be reconciled with the number of
     * entities that exist". That is the repair for the owner's
     * `To Do 898 · In Progress 0 · Done 0 · Cancelled 0` over a space holding
     * 466 tasks, and it needs a rendering that is neither a number nor a
     * placeholder.
     *
     * AND IT DOES NOT WEAKEN THE RULING THIS CASE EXISTS FOR. `0` is an ANSWER
     * and is still drawn, at full ink, with no demotion — that is the design
     * measured off TARGET.png and it is unchanged. `null` is the ABSENCE of an
     * answer, and the two must not look alike: drawing a placeholder for it
     * would be the manufactured-fact failure a second time, in the row people
     * navigate by. The tab keeps its label, its seat and its click.
     *
     * Still pinned as the COMPLETE expression, for the original reason: a
     * FOURTH arm changes this string and fails here.
     */
    expect(TSX).toContain(
      '{oneSurface\n            ? <CategoryGlyph category={tab.id} />\n            : tabLabel(tab) === null ? tab.label : `${tab.label} ${tabLabel(tab)}`}',
    );
    /* The zero is still a number and still undemoted — the half of this case
       that did not change, asserted separately so a future edit cannot trade
       one for the other. */
    expect(TSX, 'a zero-count tab is being demoted again').not.toContain('lp__tab--empty');
    expect(CSS).not.toContain('lp__tab--empty');
  });

  it('keeps the filter controls lowercase beneath Title-Case tabs', () => {
    // The two casings are DELIBERATE in the design: Title Case names the
    // lifecycle bands (registry copy this file does not own), lowercase names
    // the controls acting on them. I Title-Cased these on the reading that it
    // was unjustified noise; the owner's design keeps both, so it stays.
    expect(TSX).toContain('filter ▾');
    expect(TSX).toContain("'people ▾'");
    expect(TSX).toContain('membership.label.toLowerCase()');
  });

  it('names the sort control in words, never with a lone glyph', () => {
    // At the floor this collapses to `↓`, and an arrow is not self-describing
    // — sort direction, download and scroll-to-bottom all draw it. `title` is
    // a pointer-only affordance. The accessible name is stated, which is the
    // colour+word rule applied to a mark. The design does not speak to
    // accessible names, so it cannot contradict this one.
    expect(TSX).toContain('aria-label={`Sort: ${current.label}`}');
  });
});
