import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE PANEL HEADER'S WIDTH BUDGET.
 *
 * Lane C's law, in the form this file kept breaking it: an item that CAN yield
 * surrenders the whole deficit, while incompressible neighbours give up
 * nothing. Both header rows here got that wrong in opposite directions and
 * arrived at the same result — a control destroyed rather than shrunk.
 *
 * MEASURED ON LIVE PROD 2026-08-30, bundle index-CKbB-BZn.js, Firefox, real
 * data, at the owner's own 1999px window, in the 264px Tasks panel:
 *
 *   "Done 113"           37% visible  — cut through the middle of the word
 *   "Cancelled 7"         0% visible  — gone entirely
 *   "↓ Recent activity"  61% / 0%     — in the two panels respectively
 *
 * `.lp__tabs` scrolled with `scrollbar-width: none`, so the deficit went to the
 * one scrollable thing with no cue that it went anywhere. `.lp__filters` gave
 * every chip `flex: none`, so nothing could compress and `overflow: hidden`
 * deleted whatever was last. Neither is a truncation the reader can see.
 *
 * jsdom applies no stylesheet — vite.config sets no `css` key, so `css: false`
 * and rules are never applied — which is exactly why the defect shipped past a
 * suite this large. So these are pinned at the SOURCE, like the reading measure
 * and the section-card rule: assert the declaration, because no rendered box in
 * this package can.
 */

const here = dirname(fileURLToPath(import.meta.url));
const panels = readFileSync(join(here, 'panels.css'), 'utf8');

/**
 * EVERY block for a selector, not the first one — and the first version of this
 * helper returning only the first is what made this file fail its own first run.
 *
 * `.cv2-root .lp__tab` appears TWICE in panels.css. The earlier occurrence is
 * inside `@media (prefers-reduced-motion: reduce)` and its whole body is
 * `transition: none;`. A first-match helper reads that block, finds no
 * `white-space`, and reports the base rule as broken — a red with nothing wrong
 * in the stylesheet at all.
 *
 * This is the standing cost of source-reading tests, which this pass adopted
 * everywhere: reading CSS as TEXT makes its SHAPE load-bearing, so declaration
 * ORDER becomes API alongside grouping and spelling. A media-query override
 * declared above its base rule is ordinary CSS and must not be able to fail a
 * test about the base rule. So: collect all blocks, and assert the property
 * holds in AT LEAST ONE of them.
 */
function rules(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = [...panels.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n?\\}`, 'g'))].map(
    (m) => m[1],
  );
  expect(found.length, `no rule found for ${selector}`).toBeGreaterThan(0);
  return found;
}

/** The declaration exists somewhere among that selector's blocks. */
function declares(selector: string, property: RegExp): boolean {
  return rules(selector).some((body) => property.test(body));
}

describe('list panel header rows never delete a control to make room', () => {
  it('the category tab strip wraps instead of scrolling behind a hidden scrollbar', () => {
    expect(declares('.cv2-root .lp__tabs', /flex-wrap:\s*wrap/)).toBe(true);

    // The strip wraps; a TAB must not. Wrapping inside a tab is the older
    // defect ("In / Progress 2") and re-introducing it would trade one break
    // for the other.
    expect(declares('.cv2-root .lp__tab', /white-space:\s*nowrap/)).toBe(true);

    // A scroll whose scrollbar is suppressed is a scroll with no cue. If the
    // strip is ever made scrollable again, it must not also be made invisible.
    // Checked per BLOCK, not across the union: the pairing is only a defect
    // when one rule declares both.
    const bothInOneBlock = rules('.cv2-root .lp__tabs').some(
      (body) =>
        /overflow-x:\s*(auto|scroll)/.test(body) && /scrollbar-width:\s*none/.test(body),
    );
    expect(
      bothInOneBlock,
      'lp__tabs may scroll, or may hide its scrollbar, but not both',
    ).toBe(false);
  });

  it('the filter chip row wraps, because none of its chips can compress', () => {
    expect(declares('.cv2-root .lp__filters', /flex-wrap:\s*wrap/)).toBe(true);

    // The premise. Every chip is incompressible by design, so wrapping is the
    // ONLY way the row can absorb a deficit without deleting a control. If a
    // chip is ever allowed to shrink, this test should be revisited rather
    // than silently satisfied.
    expect(declares('.cv2-root .lp__chip', /flex:\s*none/)).toBe(true);
  });
});
