// D67 — standalone pixel capture for the expanded row's state dropdown and
// archive control (NOT a spec — .mjs is outside the test glob).
//
// WHY IT EXISTS. The vitest assertions beside this run in jsdom, which has no
// layout engine. They proved the select exists, offers the registry's
// vocabulary and dispatches the right verb — and they were GREEN while the
// control had three defects a user would have hit immediately:
//
//   1. `.lp__rowaction` is a `grid`, so the Archive button's label became a
//      second ROW and rendered stacked BELOW the button, outside its 22px box.
//   2. the dropdown caret was drawn with `background-image`, and the pill tone
//      class sets the `background` SHORTHAND — which resets it. The caret
//      vanished, leaving a control pixel-identical to the static badge beside
//      it. Nothing said "dropdown".
//   3. the refused Archive fell through to the ICON vocabulary — an unlabelled
//      square with a hover tooltip — directly beneath a STATE row that printed
//      its reason as visible text.
//
// All three are layout facts. This is the instrument that finds them.
//
//   npx vite --port 4620          # in this package
//   OUT=gate-evidence/row-state node e2e/capture-row-state.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const OUT = process.env.OUT ?? '/tmp/claude-503/-Users-subhang-Desktop-Projects-tm8/909f6b1c-d321-4fe1-b206-50eb4395db9a/scratchpad/shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 940 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:4620/e2e/row-state-harness.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// A0) THE COLLAPSED TILE'S STATUS MARK, which is now the same control in a
//     16px anatomy. Two layout facts jsdom cannot see, and both would ship as
//     a visible defect:
//       - the mark sits in a 16px grid slot on a row whose height is set by its
//         tallest child, so a button with any padding grows EVERY task row;
//       - `.pn-tt` sets `overflow: hidden` and `container-type`, so a menu that
//         is not portalled out is clipped to the row it opens on.
const rowH = await page.evaluate(() =>
  parseFloat(getComputedStyle(document.querySelector('.cv2-root')).getPropertyValue('--pn-listrow-h')));
console.log('COLLAPSED MARK:', JSON.stringify(await page.evaluate((rowH) => {
  const panel = document.querySelector('.harness-panel');
  const trigger = panel.querySelector('[data-testid="row-state-trigger"]');
  const box = trigger.getBoundingClientRect();
  const tallest = [...document.querySelectorAll('.harness-panel .pn-tt__main')]
    .map((el) => el.getBoundingClientRect().height);
  return {
    triggerIsButton: trigger.tagName,
    triggerBox: [Math.round(box.width), Math.round(box.height)],
    listRowH: rowH,
    tallestMainRow: Math.max(...tallest),
    rowsOverRowH: tallest.filter((h) => h > rowH + 0.5).length,
  };
}, rowH)));

await page.locator('[data-testid="row-state-trigger"]').first().click();
await page.waitForTimeout(250);
console.log('MENU OPEN:', JSON.stringify(await page.evaluate(() => {
  const menu = document.querySelector('.lp__assignmenu');
  if (!menu) return { menu: null };
  const m = menu.getBoundingClientRect();
  const tile = document.querySelector('.pn-tt').getBoundingClientRect();
  return {
    portalled: menu.closest('.pn-tt') === null,
    options: [...menu.querySelectorAll('[data-testid="row-state-option"]')].map((b) => b.dataset.state),
    escapesTile: m.bottom > tile.bottom + 0.5,
    insideViewport: m.left >= 0 && m.top >= 0
      && m.right <= innerWidth + 0.5 && m.bottom <= innerHeight + 0.5,
  };
})));
// Viewport-only, NOT fullPage: a fullPage shot scrolls the document, and this
// menu correctly dismisses on scroll — so the fullPage form photographs its
// own absence.
await page.screenshot({ path: `${OUT}/00-collapsed-menu.png` });
await page.getByTestId('row-state-option').filter({ hasText: 'blocked' }).first().click();
await page.waitForTimeout(250);
console.log('COLLAPSED WRITE:',
  JSON.stringify((await page.locator('.harness-log').first().textContent()).trim()),
  '| strips opened by the write:', await page.locator('.lp__rowdetail').count());

// The refusal columns wear the TOOLTIP vocabulary here, not the caption one —
// a caption under a 16px mark would break the single-line row.
console.log('REFUSALS:', JSON.stringify(await page.evaluate(() =>
  [...document.querySelectorAll('.harness-col')]
    .filter((c) => /refused|loading|unwired/.test(c.querySelector('.harness-cap').textContent))
    .map((c) => ({
      col: c.querySelector('.harness-cap').textContent,
      tipsInRow: c.querySelectorAll('.pn-tt__main .hon-tip').length,
      captionsInRow: c.querySelectorAll('.pn-tt__main .hon-caption').length,
      triggers: c.querySelectorAll('[data-testid="row-state-trigger"]').length,
    })))));

// A) THE REAL INTERACTION, once, on one row: hover the tile so the action
//    cluster un-hides, then click the toggle the way a user would. This is the
//    half a DOM-level .click() would fake.
const firstTile = page.locator('.pn-tt').first();
await firstTile.hover();
await page.waitForTimeout(200);
const revealed = await page.getByRole('button', { name: /^Expand details/ }).first()
  .evaluate((el) => getComputedStyle(el.parentElement).pointerEvents);
await page.getByRole('button', { name: /^Expand details/ }).first().click({ timeout: 4000 });
await page.waitForTimeout(300);
console.log('HOVER PATH: cluster pointer-events on hover =', revealed,
            '| strips after one real click =', await page.locator('.lp__rowdetail').count());

// B) Open the FIRST row of every column for the layout census. DOM-level click
//    on purpose: (A) already proved the pointer path; this is about geometry.
await page.evaluate(() => {
  document.querySelectorAll('.harness-panel').forEach((panel) => {
    const btn = panel.querySelector('button[aria-label^="Expand details"]');
    if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
  });
});
await page.waitForTimeout(500);
console.log('strips open:', await page.locator('.lp__rowdetail').count(),
            '| live selects:', await page.getByTestId('row-state-select').count());
await page.screenshot({ path: `${OUT}/01-expanded.png`, fullPage: true });

// C) Drive a real write through the live select and read the harness log back.
const sel = page.getByTestId('row-state-select').first();
await sel.selectOption('blocked');
await page.waitForTimeout(250);
console.log('AFTER blocked:', JSON.stringify((await page.locator('.harness-log').first().textContent()).trim()));
await sel.selectOption('done');
await page.waitForTimeout(250);
console.log('AFTER done  :', JSON.stringify((await page.locator('.harness-log').first().textContent()).trim()));
await page.getByRole('button', { name: 'Archive' }).first().click({ force: true });
await page.waitForTimeout(250);
console.log('AFTER archive:', JSON.stringify((await page.locator('.harness-log').first().textContent()).trim()));
await page.screenshot({ path: `${OUT}/02-driven.png`, fullPage: true });

// D) GEOMETRY — the question jsdom cannot answer.
console.log('GEOMETRY:', JSON.stringify(await page.evaluate(() => {
  const out = { overflowingStrips: [], clippedSelects: 0, pageScrollsSideways:
    document.documentElement.scrollWidth > document.documentElement.clientWidth };
  document.querySelectorAll('.lp__rowdetail').forEach((el) => {
    const panel = el.closest('.harness-panel');
    if (panel && el.getBoundingClientRect().right > panel.getBoundingClientRect().right + 0.5) {
      out.overflowingStrips.push(el.parentElement?.className ?? '?');
    }
  });
  document.querySelectorAll('.lp__statesel').forEach((el) => {
    if (el.scrollWidth > el.clientWidth + 1) out.clippedSelects += 1;
  });
  return out;
}, null), null, 0));
console.log('PAGE ERRORS:', errors.length, errors.slice(0, 3));
await browser.close();
