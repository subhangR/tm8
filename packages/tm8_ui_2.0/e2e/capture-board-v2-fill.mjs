// BOARD V2 — real-browser evidence for the two LAYOUT claims jsdom cannot see
// (it loads no stylesheets, so every width below is invisible to vitest):
//
//   1) THE COLUMNS FILL THE WIDTH. Four columns divide a wide window four ways
//      with nothing dead at the right edge — and 272px is a FLOOR, so a window
//      too narrow for four of them scrolls instead of crushing them.
//   2) THE ENTITY PANEL IS EXACTLY ONE COLUMN WIDE, sat over the LAST column,
//      and opening it MOVES NOTHING: every column keeps the rect it had.
//
//   npx vite --port 4673 --strictPort      # in this package
//   OUT=gate-evidence node e2e/capture-board-v2-fill.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const PORT = process.env.PORT ?? '4673';
const OUT = process.env.OUT ?? '/tmp/board-v2-fill-shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 940 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/e2e/board-v2-harness.html`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="b2-column"]', { timeout: 15000 });
await page.waitForTimeout(600);

/** Column rects plus the gap this layout leaves unused at the right edge. */
const geometry = () =>
  page.evaluate(() => {
    const stage = document.querySelector('.b2__stage').getBoundingClientRect();
    const cols = [...document.querySelectorAll('[data-testid="b2-column"]')].map((c) => ({
      key: c.dataset.column,
      left: Math.round(c.getBoundingClientRect().left),
      width: Math.round(c.getBoundingClientRect().width),
    }));
    const last = cols[cols.length - 1];
    const scroller = document.querySelector('.b2__cols');
    return {
      stageWidth: Math.round(stage.width),
      cols,
      // 12px of scroller padding is the designed right margin; anything more
      // is the dead space this change exists to remove.
      deadRight: Math.round(stage.right - (last.left + last.width)),
      scrolls: scroller.scrollWidth > scroller.clientWidth + 1,
    };
  });

console.log('WIDE (1560) —', JSON.stringify(await geometry()));
await page.screenshot({ path: `${OUT}/board-v2-fill-wide.png` });

// The FLOOR: too narrow for four 272px columns, so the strip scrolls rather
// than shrinking them into unreadable slivers.
await page.setViewportSize({ width: 900, height: 940 });
await page.waitForTimeout(400);
console.log('NARROW (900) —', JSON.stringify(await geometry()));
await page.screenshot({ path: `${OUT}/board-v2-fill-narrow.png` });

// THE PANEL. Back to wide, note every column's rect, press a card, and prove
// the panel is one column wide over the last column with nothing moved.
await page.setViewportSize({ width: 1560, height: 940 });
await page.waitForTimeout(400);
const before = await geometry();
await page.locator('[data-testid="b2-card"] .b2__card-title').first().click();
await page.waitForSelector('[data-testid="b2-entity-panel"]', { timeout: 15000 });
await page.waitForTimeout(700);
const after = await geometry();
const panel = await page.evaluate(() => {
  const p = document.querySelector('[data-testid="b2-entity-panel"]').getBoundingClientRect();
  const cols = [...document.querySelectorAll('[data-testid="b2-column"]')];
  const last = cols[cols.length - 1].getBoundingClientRect();
  return {
    panelWidth: Math.round(p.width),
    lastColumnWidth: Math.round(last.width),
    coversLastColumn: p.left <= last.left + 1 && p.right >= last.right - 1,
  };
});
console.log('PANEL —', JSON.stringify(panel));
console.log(
  'COLUMNS MOVED BY OPENING:',
  JSON.stringify(
    before.cols
      .map((c, i) => ({ key: c.key, dx: after.cols[i].left - c.left, dw: after.cols[i].width - c.width }))
      .filter((d) => d.dx !== 0 || d.dw !== 0),
  ),
);
await page.screenshot({ path: `${OUT}/board-v2-panel-over-last.png` });

// Esc gives the board back.
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
console.log('PANEL AFTER ESC:', await page.locator('[data-testid="b2-entity-panel"]').count());

console.log('PAGE ERRORS:', JSON.stringify(errors));
await browser.close();
