// Plan 01a0094b Part A — pixel capture + geometry checks for the fullscreen
// entity graph (NOT a spec — .mjs is outside the test glob).
//
// The vitest suite proves structure and arithmetic in jsdom. It cannot prove:
//   1. the dialog actually covers the viewport and sits above the chat;
//   2. drag PANS (the pan math divides by the canvas rect — zero in jsdom);
//   3. wheel zoom changes the viewBox (the listener is native passive:false);
//   4. the rail, canvas and detail panel share the width without overflow;
//   5. dimming reads as dimming (opacity is a stylesheet fact).
// This is the instrument for those five.
//
//   TM8_SERVER_ORIGIN=http://127.0.0.1:7778 bunx vite --port 4621   # this package
//   node e2e/capture-graph-fullscreen.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const OUT = process.env.OUT ?? '/tmp/tm8-graph-shots';
const PORT = process.env.PORT ?? '4621';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 940 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/e2e/graph-fullscreen-harness.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// 1 — the inline strip, calm inside a chat column, Expand beside the toggle.
await page.screenshot({ path: `${OUT}/1-inline.png` });
console.log('INLINE:', JSON.stringify(await page.evaluate(() => {
  const strip = document.querySelector('[data-testid="chat-entity-graph"]');
  const expand = strip.querySelector('.ceg__expand');
  const toggle = strip.querySelector('.ceg__toggle');
  const eb = expand.getBoundingClientRect();
  const tb = toggle.getBoundingClientRect();
  return {
    cards: strip.querySelectorAll('.ceg-cell').length,
    expandOnToggleRow: Math.abs((eb.top + eb.height / 2) - (tb.top + tb.height / 2)) < 8,
    stripWidth: Math.round(strip.getBoundingClientRect().width),
  };
})));

// 2 — open fullscreen: dialog must cover the viewport.
await page.locator('.ceg__expand').click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/2-fullscreen.png` });
console.log('DIALOG:', JSON.stringify(await page.evaluate(() => {
  const scrim = document.querySelector('.ceg-full__scrim');
  const dialog = document.querySelector('.ceg-full');
  const rail = document.querySelector('.ceg-full__rail');
  const canvas = document.querySelector('[data-testid="ceg-full-canvas"]');
  const sb = scrim.getBoundingClientRect();
  const db = dialog.getBoundingClientRect();
  const cb = canvas.getBoundingClientRect();
  return {
    scrimCovers: sb.width >= innerWidth - 1 && sb.height >= innerHeight - 1,
    dialogBox: [Math.round(db.width), Math.round(db.height)],
    railWidth: Math.round(rail.getBoundingClientRect().width),
    canvasBox: [Math.round(cb.width), Math.round(cb.height)],
    cards: canvas.querySelectorAll('.ceg-cell').length,
    focusInDialog: dialog.contains(document.activeElement),
    routeEcho: document.querySelector('[data-testid="route-echo"]').textContent,
  };
})));

// 3 — wheel zoom about the cursor, then drag pan: both must move the viewBox.
const canvasBox = await page.locator('[data-testid="ceg-full-canvas"]').boundingBox();
const cx = canvasBox.x + canvasBox.width / 2;
const cy = canvasBox.y + canvasBox.height / 2;
const viewBoxOf = () => page.evaluate(() =>
  document.querySelector('[data-testid="ceg-full-canvas"] svg').getAttribute('viewBox'));
const vb0 = await viewBoxOf();
await page.mouse.move(cx, cy);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(200);
const vb1 = await viewBoxOf();
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx - 180, cy - 60, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const vb2 = await viewBoxOf();
await page.screenshot({ path: `${OUT}/3-zoomed-panned.png` });
console.log('PANZOOM:', JSON.stringify({
  fit: vb0, afterWheel: vb1, afterDrag: vb2,
  wheelZoomed: vb0 !== vb1,
  dragPanned: vb1 !== vb2 && vb1.split(' ')[2] === vb2.split(' ')[2],
  zoomLabel: await page.locator('.ceg-full__zoom').textContent(),
}));

// 4 — Fit, then a kind filter through the rail: fewer cards, honest summary,
//     and the route echo carries the encoded gf.
await page.locator('button', { hasText: 'Fit' }).click();
await page.locator('.ceg-full__chip', { hasText: 'Tasks 3' }).locator('input').check();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/4-filtered.png` });
console.log('FILTER:', JSON.stringify(await page.evaluate(() => ({
  cards: document.querySelectorAll('[data-testid="ceg-full-canvas"] .ceg-cell').length,
  summary: document.querySelector('[data-testid="ceg-full-summary"]').textContent,
  routeEcho: document.querySelector('[data-testid="route-echo"]').textContent,
}))));

// 5 — clear the filter, select a hub card: detail panel + neighbourhood dim.
await page.locator('.ceg-full__chip', { hasText: 'Tasks 3' }).locator('input').uncheck();
await page.waitForTimeout(300);
await page.locator('[data-testid="ceg-full-canvas"] .ceg-cell')
  .filter({ hasText: 'Opus 5 Teammate' }).first().click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/5-selected.png` });
console.log('SELECT:', JSON.stringify(await page.evaluate(() => {
  const canvas = document.querySelector('[data-testid="ceg-full-canvas"]');
  const detail = document.querySelector('[data-testid="ceg-full-detail"]');
  const dimmed = canvas.querySelectorAll('.ceg-cell--dim');
  const sample = dimmed[0] ? getComputedStyle(dimmed[0]).opacity : null;
  return {
    detailShown: !!detail,
    detailWidth: detail ? Math.round(detail.getBoundingClientRect().width) : 0,
    detailText: detail ? detail.textContent.slice(0, 120) : null,
    dimmedCount: dimmed.length,
    dimOpacityApplied: sample !== null && parseFloat(sample) < 0.5,
  };
})));

// 6 — Esc clears selection, second Esc closes; inline echo carries filters.
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
const afterFirstEsc = await page.evaluate(() => ({
  detail: !!document.querySelector('[data-testid="ceg-full-detail"]'),
  dialog: !!document.querySelector('.ceg-full'),
}));
await page.locator('.ceg-full__chip', { hasText: 'Sessions 4' }).locator('input').check();
await page.waitForTimeout(200);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/6-closed-inline-echo.png` });
console.log('CLOSE:', JSON.stringify({
  afterFirstEsc,
  ...(await page.evaluate(() => ({
    dialogGone: !document.querySelector('.ceg-full'),
    inlineCards: document.querySelectorAll('.ceg__canvas .ceg-cell').length,
    inlineEcho: document.querySelector('[data-testid="ceg-filter-echo"]')?.textContent ?? null,
    routeEcho: document.querySelector('[data-testid="route-echo"]').textContent,
    focusOnExpand: document.activeElement === document.querySelector('.ceg__expand'),
  }))),
}));

// 7 — dark theme sanity of the dialog.
await page.locator('[data-testid="theme-toggle"]').click();
await page.locator('.ceg__expand').click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/7-dark-fullscreen.png` });

console.log('PAGE ERRORS:', errors.length ? errors : 'none');
await browser.close();
