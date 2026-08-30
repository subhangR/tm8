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

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = panels.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
  expect(m, `no rule found for ${selector}`).not.toBeNull();
  return m![1];
}

describe('list panel header rows never delete a control to make room', () => {
  it('the category tab strip wraps instead of scrolling behind a hidden scrollbar', () => {
    const tabs = rule('.cv2-root .lp__tabs');
    expect(tabs).toMatch(/flex-wrap:\s*wrap/);

    // The strip wraps; a TAB must not. Wrapping inside a tab is the older
    // defect ("In / Progress 2") and re-introducing it would trade one break
    // for the other.
    expect(rule('.cv2-root .lp__tab')).toMatch(/white-space:\s*nowrap/);

    // A scroll whose scrollbar is suppressed is a scroll with no cue. If the
    // strip is ever made scrollable again, it must not also be made invisible.
    const scrolls = /overflow-x:\s*(auto|scroll)/.test(tabs);
    const hidesScrollbar = /scrollbar-width:\s*none/.test(tabs);
    expect(
      scrolls && hidesScrollbar,
      'lp__tabs may scroll, or may hide its scrollbar, but not both',
    ).toBe(false);
  });

  it('the filter chip row wraps, because none of its chips can compress', () => {
    expect(rule('.cv2-root .lp__filters')).toMatch(/flex-wrap:\s*wrap/);

    // The premise. Every chip is incompressible by design, so wrapping is the
    // ONLY way the row can absorb a deficit without deleting a control. If a
    // chip is ever allowed to shrink, this test should be revisited rather
    // than silently satisfied.
    expect(rule('.cv2-root .lp__chip')).toMatch(/flex:\s*none/);
  });
});
