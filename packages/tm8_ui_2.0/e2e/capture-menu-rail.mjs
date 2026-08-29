/**
 * Photograph and MEASURE the collapsed rail. The ruling is "icon rail with the
 * text below the icons", which is a pixel claim: jsdom proves the caption
 * element exists, this proves it is readable — that nothing is clipped, that
 * the longest caption wraps rather than overflowing, and that the caption sits
 * BELOW its glyph rather than beside it.
 *
 * Usage: node e2e/capture-menu-rail.mjs [origin]
 */
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:4612';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 700, height: 820 } });

await page.goto(`${origin}/e2e/menu-rail-harness.html`);
await page.waitForSelector('[data-testid="harness-ready"]', { state: 'attached' });

const measured = await page.evaluate(() => {
  const pane = document.querySelector('[data-pane^="collapsed 72"]');
  const rail = pane.querySelector('.shell-rail');
  const rows = [...pane.querySelectorAll('.shell-rail__row, .shell-rail__leaf')];
  return {
    railWidth: Math.round(rail.getBoundingClientRect().width),
    railScrollsHorizontally: rail.scrollWidth > rail.clientWidth + 1,
    rows: rows.map((row) => {
      const label = row.querySelector('.shell-rail__label');
      const icon = row.querySelector('.shell-rail__icon');
      const lb = label.getBoundingClientRect();
      const ib = icon ? icon.getBoundingClientRect() : null;
      // The caption owns the bottom of the row now, so a corner mark pinned
      // there sits ON the word. Stated as intersection, not as a coordinate.
      const marks = [...row.querySelectorAll('.shell-rail__badge-corner, .shell-rail__live-corner')];
      const overlapsMark = marks.some((mark) => {
        const mb = mark.getBoundingClientRect();
        return mb.left < lb.right && mb.right > lb.left && mb.top < lb.bottom && mb.bottom > lb.top;
      });
      return {
        text: label.textContent,
        marks: marks.length,
        overlapsMark,
        // "below the icon" stated as geometry, not as a class name.
        labelBelowIcon: ib ? Math.round(lb.top) >= Math.round(ib.bottom) - 1 : null,
        lines: Math.round(lb.height / parseFloat(getComputedStyle(label).lineHeight)),
        // The two ways a caption lies about itself: cut off, or spilling out.
        clipped: label.scrollHeight > label.clientHeight + 1,
        overflowsRow: Math.round(lb.right) > Math.round(row.getBoundingClientRect().right) + 1,
      };
    }),
  };
});
console.log(JSON.stringify(measured, null, 2));

await page.screenshot({ path: 'gate-evidence/menu-rail-collapsed.png' });
await browser.close();
