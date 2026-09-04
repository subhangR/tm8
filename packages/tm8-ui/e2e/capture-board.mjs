// THE COMPACT FILTER CHROME — standalone pixel capture for the Board tab
// (NOT a spec — .mjs is outside the test glob).
//
// WHY IT EXISTS. The change this measures is entirely a claim about HEIGHT: the
// filter rail it replaced drew every status, every priority and the whole
// roster TWICE as inline chips, so the chrome above the board grew a row for
// every teammate added to the space. The vitest cases beside this run in jsdom,
// which has no layout engine — they can prove the bar renders four triggers and
// that the options live behind them, and they structurally CANNOT prove the bar
// is one line, that it stays one line, or that the board got the space back.
//
// The dropdowns make a second claim jsdom is blind to: each menu is portalled
// to `.cv2-root` and positioned from a viewport rect, so "does it land under
// its trigger, and inside the window" is only answerable in a real engine.
//
//   npx vite --port 4621          # in this package
//   OUT=gate-evidence node e2e/capture-board.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT ?? '/tmp/board-shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 940 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:4621/e2e/board-harness.html', { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="bd-column"]', { timeout: 15000 });
await page.waitForTimeout(600);

// 1) THE HEIGHT BUDGET. One line of chrome, and the columns own the rest.
console.log('CHROME:', JSON.stringify(await page.evaluate(() => {
  const bar = document.querySelector('.bd__bar').getBoundingClientRect();
  const cols = document.querySelector('.bd__cols').getBoundingClientRect();
  const root = document.querySelector('.bd').getBoundingClientRect();
  /* One line means every control OVERLAPS every other vertically. Distinct
     `top` values prove nothing — `align-items: center` gives a short control a
     different top than a tall one on the SAME line. A wrap is a control whose
     top clears another's bottom. */
  const boxes = [...document.querySelectorAll('.bd__bar > *')]
    .map((el) => el.getBoundingClientRect())
    .sort((a, b) => a.top - b.top);
  let barRows = 1;
  let floor = boxes[0].bottom;
  for (const b of boxes.slice(1)) {
    if (b.top >= floor - 0.5) { barRows += 1; floor = b.bottom; }
    else floor = Math.min(floor, b.bottom);
  }
  return {
    barHeight: Math.round(bar.height),
    barRows,
    boardHeight: Math.round(cols.height),
    boardShareOfScreen: `${Math.round((cols.height / root.height) * 100)}%`,
    columnsScrollSideways: document.querySelector('.bd__cols').scrollWidth
      > document.querySelector('.bd__cols').clientWidth,
  };
})));

// 2) ROSTER-INDEPENDENCE, the actual defect. Every axis is a constant-height
//    trigger, so the bar cannot grow with the number of options behind it.
console.log('AXES:', JSON.stringify(await page.evaluate(() =>
  [...document.querySelectorAll('.bd__sel')].map((el) => ({
    axis: el.dataset.testid,
    height: Math.round(el.getBoundingClientRect().height),
    width: Math.round(el.getBoundingClientRect().width),
  })))));

await page.screenshot({ path: `${OUT}/board-chrome-closed.png` });

// 3) THE PORTALLED MENU — under its trigger, inside the window, unclipped.
//    Viewport-only, NOT fullPage: a fullPage shot scrolls the document and this
//    menu correctly dismisses on scroll, so the fullPage form photographs its
//    own absence.
for (const axis of ['bd-filter-status', 'bd-filter-person']) {
  await page.getByTestId(axis).click();
  await page.waitForTimeout(250);
  console.log(`MENU ${axis}:`, JSON.stringify(await page.evaluate((axis) => {
    const menu = document.querySelector(`[data-testid="${axis}-menu"]`);
    if (!menu) return { menu: null };
    const m = menu.getBoundingClientRect();
    const t = document.querySelector(`[data-testid="${axis}"]`).getBoundingClientRect();
    return {
      portalled: menu.closest('.bd__bar') === null,
      options: menu.querySelectorAll('.bd__opt').length,
      hasSearch: menu.querySelector('.bd__menu-search') !== null,
      belowTrigger: m.top >= t.bottom - 0.5,
      alignedToTrigger: Math.abs(m.left - t.left) < 2,
      insideViewport: m.left >= 0 && m.top >= 0
        && m.right <= innerWidth + 0.5 && m.bottom <= innerHeight + 0.5,
      optionsOverflowMenu: [...menu.querySelectorAll('.bd__opt')]
        .filter((o) => o.getBoundingClientRect().right > m.right + 0.5).length,
    };
  }, axis)));
  await page.screenshot({ path: `${OUT}/board-menu-${axis}.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
}

// 4) A SELECTED AXIS SAYS SO WITHOUT BEING OPENED, and the bar STILL does not
//    grow — the trigger carries faces and a summary inside its own line.
await page.getByTestId('bd-filter-person').click();
await page.waitForTimeout(200);
for (const opt of await page.locator('[data-testid="bd-filter-person-menu"] .bd__opt').all()) {
  await opt.click();
}
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
console.log('SELECTED:', JSON.stringify(await page.evaluate(() => {
  const t = document.querySelector('[data-testid="bd-filter-person"]');
  return {
    label: t.getAttribute('aria-label'),
    summary: t.querySelector('.bd__sel-val')?.textContent ?? null,
    faces: t.querySelectorAll('.bd__sel-faces > *').length,
    triggerHeight: Math.round(t.getBoundingClientRect().height),
    barHeight: Math.round(document.querySelector('.bd__bar').getBoundingClientRect().height),
  };
})));
await page.screenshot({ path: `${OUT}/board-chrome-selected.png` });

console.log('PAGE ERRORS:', errors.length, errors.slice(0, 3));
await browser.close();
