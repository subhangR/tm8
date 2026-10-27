/**
 * THE FLAG-ON HEADER READS IN FULL AT THE DEFAULT WIDTH (QA finding 1, ruled
 * 2026-10-17).
 *
 * WHAT WENT WRONG. The navigator's grid gave the top row two tracks — `header`
 * over the column, `strip` over the content — so the header was exactly the
 * column: 300px at the default. Its four children need ~342, so two of them
 * ellipsised, measured in a browser on a live node: the space name lost 24.5px
 * (`Navigator QA` → `Naviga…`) and the mode's own switcher 17.3px (`Mixed` →
 * `M`), while ~1000px of the same row sat empty over the content. With the
 * flag OFF the header already spans the rail AND the browser (48 + 300 = 348)
 * and reads in full, so this was the navigator's alone.
 *
 * WHY A SOURCE TEST. `text-overflow: ellipsis` changes no DOM and no
 * `textContent` — `innerText` still reads the whole string — and jsdom has no
 * layout at all, so there is no assertion in this suite's 8000 that can see
 * it. `row-height-parity.test.ts` makes the same argument for row height. The
 * pixels are a browser screenshot, attached to the close-out; what this file
 * pins is the grid that makes them possible, so the two-track version cannot
 * come back as a "simplification".
 *
 * THE INVARIANT, in three parts:
 *   - the header's area spans PAST the navigator column, into the top row over
 *     the content;
 *   - the BODY row does not move with it — the content still starts at the
 *     column's edge, or the fix would have paid for the header by narrowing
 *     everything else;
 *   - the overhang is `auto`, so at a width where the header fits it is 0 and
 *     this is the two-column grid it replaced.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WORKSPACE_CSS = readFileSync(
  fileURLToPath(new URL('./workspace.css', import.meta.url)),
  'utf8',
);
const NAVIGATOR_CSS = readFileSync(
  fileURLToPath(new URL('./navigator.css', import.meta.url)),
  'utf8',
);

/** The body of `selector { … }`, comments stripped. */
function rule(css: string, selector: string): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = bare.indexOf(selector + ' {');
  if (at === -1) throw new Error(`no rule for ${selector}`);
  const open = bare.indexOf('{', at);
  const close = bare.indexOf('}', open);
  return bare.slice(open + 1, close);
}

/** `'header header strip'` → `['header', 'header', 'strip']`. */
function areaRows(body: string): string[][] {
  const decl = body.match(/grid-template-areas:([^;]*);/);
  if (!decl) throw new Error('no grid-template-areas');
  return [...decl[1].matchAll(/'([^']*)'/g)].map((m) => m[1].trim().split(/\s+/));
}

describe('the navigator grid, with the flag on', () => {
  const navGrid = rule(WORKSPACE_CSS, '.tws-root[data-nav]');

  it('gives the header a track the content row does not have to give up', () => {
    const [top, body] = areaRows(navGrid);
    expect(top).toHaveLength(body.length);
    // The header owns more than one track; the navigator column owns exactly
    // the first, and the content takes every track the header overhangs into.
    expect(top[0]).toBe('header');
    expect(top[1]).toBe('header');
    expect(body[0]).toBe('nav');
    expect(body.slice(1)).toEqual(Array(body.length - 1).fill('content'));
  });

  it('keeps the column itself on the persisted width, and makes the overhang auto', () => {
    const cols = navGrid.match(/grid-template-columns:([^;]*);/)![1].trim();
    /* First track: the width the resizer and `--tws-browser-w` persist, which
       is what makes "the body row did not move" true by construction. */
    expect(cols.startsWith('var(--tws-nav-w, 300px)')).toBe(true);
    /* Middle track: `auto`, not a number. A fixed overhang would jog the strip
       off the column edge at every width, including the ones where the header
       fits; `auto` collapses to 0 there and this is the old grid again. */
    expect(cols).toMatch(/var\(--tws-nav-w, 300px\)\s+auto\s+minmax\(0, 1fr\)/);
  });

  it('caps the overhang, because the space name is user data', () => {
    const header = rule(WORKSPACE_CSS, '.tws-root[data-nav]:not(.app-frame) .tws-left-header');
    expect(header).toMatch(/max-width:\s*calc\(var\(--tws-nav-w, 300px\) \+ var\(--tws-header-overhang-max/);
  });

  /**
   * AND IT STAYS OFF `AppFrame`. Craft and Settings render
   * `class="tws-root app-frame"` and set `data-nav` too, and their own grid
   * already spans the header over two tracks (300 + 300), which is why they
   * never truncated. An unscoped cap would clamp that 600px band to 480 and
   * leave 120px of its own area unpainted — a regression in a surface this
   * task does not touch, and one no test here would have seen.
   */
  it('and the cap does not reach AppFrame, whose header is already two tracks wide', () => {
    const bare = WORKSPACE_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const capping = [...bare.matchAll(/([^{}]*)\.tws-left-header \{([^{}]*)\}/g)].filter((m) =>
      /max-width/.test(m[2]),
    );
    // An empty list would pass the loop below without checking anything.
    expect(capping.length).toBeGreaterThan(0);
    for (const m of capping) expect(m[1]).toContain(':not(.app-frame)');
  });

  it('collapsed, the overhang is nothing — no jog beside a 48px strip', () => {
    /* Everything but the mark is `display: none` at 48px, so the header's
       max-content contribution is the mark cell; the 12px right padding would
       be the only thing holding the track open. */
    expect(NAVIGATOR_CSS).toMatch(
      /\.tws-root\[data-nav\]\[data-nav-collapsed\] \.tws-left-header > :not\(\.tws-mark-cell\) \{\s*display: none;/,
    );
    const collapsed = rule(WORKSPACE_CSS, '.tws-root[data-nav][data-nav-collapsed]:not(.app-frame) .tws-left-header');
    expect(collapsed).toMatch(/max-width:\s*var\(--tws-nav-w, 300px\)/);
    expect(collapsed).toMatch(/padding-right:\s*0/);
  });
});

describe('the flag-off grid is untouched', () => {
  it('still spans the header over the rail and the browser, three tracks, two areas', () => {
    const base = rule(WORKSPACE_CSS, '.tws-root');
    expect(base).toMatch(
      /grid-template-columns:\s*var\(--tws-rail-w\) var\(--tws-browser-w, 320px\) minmax\(0, 1fr\);/,
    );
    expect(areaRows(base)).toEqual([
      ['header', 'header', 'strip'],
      ['rail', 'browser', 'content'],
    ]);
  });
});
