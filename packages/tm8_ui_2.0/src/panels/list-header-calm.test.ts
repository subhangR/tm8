/**
 * THE ENTITY LIST HEADER — the calm pass's contract for the row that renders
 * above EVERY entity list in the product (Tasks, Docs, Artifacts, Files, …).
 * One header, every kind, which is why it is worth pinning.
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

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panels.css'), 'utf8');

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
 * Anchored on `.cv2-root ` and a following `{` so that `.lp__tab` cannot match
 * `.lp__tab--active`, which would silently widen every assertion below.
 */
function blocksFor(selector: string): readonly string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\.cv2-root\\s+${escaped}\\s*\\{([^}]*)\\}`, 'g');
  return [...CSS.matchAll(re)].map((m) => m[1] ?? '');
}

const declares = (selector: string, needle: string): boolean =>
  blocksFor(selector).some((body) => body.includes(needle));

describe('the list header is one shape with one casing and one accent', () => {
  it('finds the blocks it claims to read (a helper matching nothing proves nothing)', () => {
    // THE BOTH-HALVES DETECTOR. Every assertion below is of the form "some
    // block declares X". If `blocksFor` silently matched zero blocks, every
    // `.not` assertion would pass vacuously and this file would report green
    // while checking nothing. Pin the counts that make the rest meaningful.
    expect(blocksFor('.lp__tab').length).toBeGreaterThanOrEqual(2);
    expect(blocksFor('.lp__tab--active').length).toBeGreaterThanOrEqual(1);
    expect(blocksFor('.lp__tab--empty:not(.lp__tab--active)').length).toBe(1);
    expect(blocksFor('.lp__chip').length).toBeGreaterThanOrEqual(1);
  });

  it('spends the accent on the ring, not on a fill — the active tab keeps its job', () => {
    /*
     * COLOUR IS FOR STATE THAT CHANGES WHAT YOU DO. An active tab is the
     * canonical "where you are", so it KEEPS the accent — decolouring it would
     * delete the only cue naming the lifecycle band on screen.
     *
     * What it must not do is spend the accent TWICE. It used to carry both
     * `color: var(--pn-brand-2)` and `background: var(--pn-brand-soft)`, and
     * the fill is the half that competes: a filled tab sits on the same plane
     * as every other filled thing, and Von Restorff only pays while the accent
     * is scarce. Rings and fills are different jobs; this row takes the ring.
     */
    expect(declares('.lp__tab--active', 'color: var(--pn-brand-2)')).toBe(true);
    expect(declares('.lp__tab--active', 'border-color: var(--pn-brand-2)')).toBe(true);
    expect(declares('.lp__tab--active', 'background: var(--pn-brand-soft)')).toBe(false);
  });

  it('keeps the ring under the pointer — hover must not read as deselection', () => {
    // THE HALF THAT WOULD HAVE SHIPPED AS A SILENT REGRESSION. The hover rule
    // used to clear `border-color`, which was correct while the fill carried
    // the active state and the border was decoration. With the ring carrying
    // it, the same declaration erases "where you are" exactly when the pointer
    // is on the tab. Swapping fill for ring without reading what the hover
    // rule was FOR is the whole defect this pins.
    expect(declares('.lp__tab--active:hover', 'border-color: var(--pn-brand-2)')).toBe(true);
    expect(declares('.lp__tab--active:hover', 'border-color: transparent')).toBe(false);
  });

  it('flips the ring in dark, not only the text', () => {
    // WHEN YOU MOVE WHAT CARRIES A STATE, EVERY RULE THAT RESTATES THAT STATE
    // MOVES WITH IT. The dark block existed to lift active TEXT off
    // `--pn-brand-2` onto `--pn-brand`. The ring now says the same thing, so
    // leaving it behind gives dark mode a tab whose text and edge disagree.
    const dark = CSS.match(/\[data-theme='dark'\][^{]*\.lp__tab--active[^{]*\{([^}]*)\}/);
    expect(dark).not.toBeNull();
    expect(dark?.[1]).toContain('color: var(--pn-brand)');
    expect(dark?.[1]).toContain('border-color: var(--pn-brand)');
  });

  it('demotes an empty band without disabling it', () => {
    /*
     * A TAB READING `To Do 0` IS A CONTROL ADVERTISING ITS OWN EMPTINESS, and
     * three of four on the owner's screen read zero. The count is the part
     * saying "nothing here" and it says it in the row the reader scans to
     * choose where to go — so the NAME stays and the zero goes.
     *
     * DEMOTED, NEVER HIDDEN, and never disabled: an empty status is a
     * legitimate destination that happens to hold nothing today. A client
     * asking "where is To Do?" must find it greyed, not gone.
     */
    const empty = blocksFor('.lp__tab--empty:not(.lp__tab--active)')[0] ?? '';
    expect(empty).toContain('font-weight: 500');
    expect(empty).toContain('color: var(--pn-ink-3)');
    // Not a refusal: no opacity dimming, no pointer-events removal.
    expect(empty).not.toContain('pointer-events');
    expect(empty).not.toContain('opacity');
  });

  it('hovers with an edge, never with the retired --pn-hover fill', () => {
    // MEASURED, NOT ASSUMED. The owner's screenshot shows the hovered
    // `collections` chip at (239,242,244) against a (247,249,251) page — that
    // grey IS `--pn-hover` rendering. It was read as a third control shape;
    // it was this fill. The calm pass retired the pattern for
    // edge-strengthening, and these two rules are the busiest row in the
    // product, so they are the ones that matter.
    expect(declares('.lp__tab:hover', 'var(--pn-hover)')).toBe(false);
    expect(declares('.lp__chip:hover', 'var(--pn-hover)')).toBe(false);
    expect(declares('.lp__tab:hover', 'border-color: var(--pn-line-2)')).toBe(true);
    expect(declares('.lp__chip:hover', 'border-color: var(--pn-line-2)')).toBe(true);
  });
});

describe('the header speaks one casing', () => {
  const TSX = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'EntityListPanel.tsx'),
    'utf8',
  );

  it('title-cases the filter row to match the tier row above it', () => {
    /*
     * The tier row's labels are REGISTRY DATA (`To Do`, `In Progress`) that
     * this file does not own, so the only casing choice available is to match
     * up to them. Two casing systems in adjacent rows is noise the reader
     * resolves before discovering it means nothing.
     *
     * The `.toLowerCase()` is the one that mattered: it was applied in CODE
     * rather than typed into a literal, so it alone would have kept
     * re-lowercasing a registry label after the literals were fixed — the
     * header would revert to two casings the moment a kind declared a lens.
     */
    expect(TSX).toContain('Filter ▾');
    expect(TSX).toContain("'People ▾'");
    expect(TSX).not.toContain('membership.label.toLowerCase()');
  });

  it('names the sort control in words, never with a lone glyph', () => {
    // At the floor this collapses to `↓`, and an arrow is not self-describing
    // — sort direction, download and scroll-to-bottom all draw it. `title` is
    // a pointer-only affordance. The accessible name is stated, which is the
    // colour+word rule applied to a mark: never let the glyph be the only
    // thing carrying the meaning.
    expect(TSX).toContain('aria-label={`Sort: ${current.label}`}');
  });

  it('threads emptiness from the producer instead of parsing the rendered label', () => {
    // `tabCount` already computes `{ n, label, exact }`; the component was
    // handed only the rendered string. Recovering "is this empty" by reading
    // that string back as a number is how `22+` becomes 22 and how a
    // truncated page's `0` becomes a lie. The fact is passed, never
    // re-derived from its own rendering.
    expect(TSX).toContain('tabEmpty');
    // And the count survives for a screen reader even when it stops painting.
    expect(TSX).toContain("'aria-label': `${tab.label}, ${tabLabel(tab)}`");
  });

  it('demotes only on a SETTLED zero — never on an unread one', () => {
    /*
     * THE ONE THAT WOULD HAVE SHIPPED THE COMPOSER'S BUG TO EVERY LIST.
     *
     * `tabCount` computes `n: page?.total ?? loaded`, and `loaded` is
     * `rowsFor(...).length` — which is 0 while the first page is in flight
     * (`ListPageState.loading`: "a page is in flight, including the first,
     * before anything has arrived"). So `n === 0` is true of an EMPTY band
     * AND of an UNREAD one, and `tabEmpty` written as `n === 0` alone would
     * demote every tab on the opening read, then un-demote them as rows land.
     *
     * That is deriving "there is none" from a value that also means "we have
     * not asked yet" — the exact defect this pass removed from Home's
     * composer, which claimed a space with 34 teammates was empty.
     *
     * `exact` is `page?.total !== undefined`: the server VOLUNTEERED a total,
     * which silence can never look like. `exact && n === 0` is a settled zero
     * and nothing else, and every uncertain case falls through to showing the
     * count. Pinned because dropping `exact` leaves code that reads correct.
     */
    expect(TSX).toContain('count?.exact === true && count.n === 0');
  });
});
