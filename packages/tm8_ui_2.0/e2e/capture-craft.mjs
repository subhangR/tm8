// Standalone pixel-evidence capture (NOT a spec — .mjs is outside the test glob).
// Drives the REAL CraftScreen through the craft harness in system Chrome and
// saves screenshots to gate-evidence/. Run: bunx node e2e/capture-craft.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:4612';
const OUT = 'gate-evidence/craft';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1492, height: 860 } });
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text());
});
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

async function shoot(name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${OUTP(name)}.png` });
  console.log('saved', `${OUT}/${OUTP(name)}.png`);
}

const SCENARIO = process.env.SCENARIO ?? 'awkward';
const OUTP = (n) => `${SCENARIO}-${n}`;
await page.goto(`${BASE}/e2e/craft-harness.html?scenario=${SCENARIO}`);
await page.getByTestId('craft-screen').waitFor({ timeout: 15_000 });
await page.getByTestId('crf-canvas').waitFor({ timeout: 15_000 });
// The chat surface is a LAZY chunk. Waiting for the screen only tells us the
// studio mounted; measuring before the chunk lands reports the pre-solo grid
// and calls the two-pane claim false for a reason that is purely a race.
await page.getByTestId('chat-home-screen').waitFor({ timeout: 15_000 });
await page.waitForTimeout(400);

// ---- 1. THE COLUMN COUNT. Two panes, and the numbers to prove it. -------
const geom = await page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const svg = document.querySelector('.crf-svg');
  const pane = document.querySelector('.crf-viewport');
  const svgR = svg?.getBoundingClientRect();
  const paneR = pane?.getBoundingClientRect();
  return {
    chat: box('.crf-chat'),
    resizer: box('.kit-resizer'),
    canvas: box('.crf-canvas'),
    sidebarsInsideChat: document.querySelectorAll('.crf-chat .tch-sidebar').length,
    soloRoot: !!document.querySelector('.tch-root--solo'),
    viewBox: svg?.getAttribute('viewBox'),
    // How much of the canvas pane the drawing actually fills, and whether the
    // slack is split evenly (centred) or dumped on one side (top-left parked).
    fill: svgR && paneR
      ? {
          svgFillsPane: Math.round(svgR.width) === Math.round(paneR.width)
            && Math.round(svgR.height) === Math.round(paneR.height),
        }
      : null,
    // The drawn content's real box, in client px — this is the centring claim.
    contentBox: (() => {
      const cells = [...document.querySelectorAll('.crf-cell')];
      if (!cells.length || !paneR) return null;
      const rs = cells.map((c) => c.getBoundingClientRect());
      const minX = Math.min(...rs.map((r) => r.left));
      const maxX = Math.max(...rs.map((r) => r.right));
      const minY = Math.min(...rs.map((r) => r.top));
      const maxY = Math.max(...rs.map((r) => r.bottom));
      return {
        leftGap: Math.round(minX - paneR.left),
        rightGap: Math.round(paneR.right - maxX),
        topGap: Math.round(minY - paneR.top),
        bottomGap: Math.round(paneR.bottom - maxY),
        drawnW: Math.round(maxX - minX),
        drawnH: Math.round(maxY - minY),
        paneW: Math.round(paneR.width),
        paneH: Math.round(paneR.height),
      };
    })(),
  };
});
console.log('GEOMETRY', JSON.stringify(geom, null, 2));
await shoot('craft-01-two-panes');

// ---- 2. THE CONVERSATION PICKER, open over the chat pane. --------------
await page.getByTestId('crf-chat-picker').click();
await page.getByTestId('crf-chat-pop').waitFor();
await shoot('craft-02-picker-scoped');
// The escape hatch: threads that predate anchoring are still reachable.
await page.getByTestId('crf-chat-scope').click();
await page.waitForTimeout(150);
await shoot('craft-03-picker-all');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

// ---- 3. THE DIVIDER ACTUALLY DRAGS. ------------------------------------
const before = await page.evaluate(() => document.querySelector('.crf-chat').getBoundingClientRect().width);
const handle = page.getByTestId('panel-resizer-left');
const hb = await handle.boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(hb.x + hb.width / 2 + 220, hb.y + hb.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(200);
const after = await page.evaluate(() => document.querySelector('.crf-chat').getBoundingClientRect().width);
console.log('RESIZE', { before: Math.round(before), after: Math.round(after), delta: Math.round(after - before) });
await shoot('craft-04-resized-wide');

// Drag back, and confirm the canvas floor holds when pushed past it.
// Re-measure the handle: it MOVED with the last drag, and pressing at its old
// x would land on the chat pane and quietly measure nothing.
const hb2 = await handle.boundingBox();
await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
await page.mouse.down();
await page.mouse.move(hb2.x + 2000, hb2.y + hb2.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(200);
const floored = await page.evaluate(() => ({
  chat: Math.round(document.querySelector('.crf-chat').getBoundingClientRect().width),
  canvas: Math.round(document.querySelector('.crf-canvas').getBoundingClientRect().width),
}));
console.log('CANVAS FLOOR (dragged far right)', floored);
await shoot('craft-05-canvas-floor');

// Reset via double-click (the documented gesture) and confirm.
await handle.dblclick();
await page.waitForTimeout(200);
console.log('AFTER RESET', await page.evaluate(() =>
  Math.round(document.querySelector('.crf-chat').getBoundingClientRect().width)));

// ---- 4. ZOOM AND PAN. --------------------------------------------------
const vb0 = await page.getAttribute('.crf-svg', 'viewBox');
await page.getByTestId('crf-zoom-in').click();
await page.getByTestId('crf-zoom-in').click();
await page.waitForTimeout(150);
const vb1 = await page.getAttribute('.crf-svg', 'viewBox');
await shoot('craft-06-zoomed-in');
console.log('ZOOM', { fit: vb0, zoomedIn: vb1, changed: vb0 !== vb1 });

// Drag the empty canvas to pan.
const cb = await page.locator('.crf-viewport').boundingBox();
await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.85);
await page.mouse.down();
await page.mouse.move(cb.x + cb.width * 0.35, cb.y + cb.height * 0.6, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(150);
const vb2 = await page.getAttribute('.crf-svg', 'viewBox');
console.log('PAN', { before: vb1, after: vb2, changed: vb1 !== vb2 });
await shoot('craft-07-panned');

// Fit puts it back exactly.
await page.getByTestId('crf-zoom-fit').click();
await page.waitForTimeout(200);
const vb3 = await page.getAttribute('.crf-svg', 'viewBox');
console.log('FIT RESTORES', { fit: vb0, afterFit: vb3, identical: vb0 === vb3 });
await shoot('craft-08-refit');

// ---- 5. REGION C: a blueprint card press opens the entity panel. -------
const pressable = page.locator('.crf-cell[role="button"]');
console.log('PRESSABLE CARDS', await pressable.count());
await pressable.first().click();
await page.getByTestId('crf-detail').waitFor({ timeout: 10_000 });
const three = await page.evaluate(() => {
  const w = (sel) => {
    const el = document.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().width) : null;
  };
  return {
    chat: w('.crf-chat'),
    canvas: w('.crf-canvas'),
    detail: w('.crf-detail'),
    resizers: document.querySelectorAll('.crf-split .kit-resizer').length,
    panelMounted: !!document.querySelector('.crf-detail [data-testid="entity-detail-panel"], .crf-detail .pn-panel, .crf-detail'),
  };
});
console.log('THREE COLUMNS', three);
await shoot('craft-10-region-c');

// The canvas must have RE-FITTED into its narrower pane, still centred.
const centred = await page.evaluate(() => {
  const pane = document.querySelector('.crf-viewport');
  const cells = [...document.querySelectorAll('.crf-cell')];
  if (!pane || !cells.length) return null;
  const p = pane.getBoundingClientRect();
  const rs = cells.map((c) => c.getBoundingClientRect());
  return {
    leftGap: Math.round(Math.min(...rs.map((r) => r.left)) - p.left),
    rightGap: Math.round(p.right - Math.max(...rs.map((r) => r.right))),
    topGap: Math.round(Math.min(...rs.map((r) => r.top)) - p.top),
    bottomGap: Math.round(p.bottom - Math.max(...rs.map((r) => r.bottom))),
  };
});
console.log('STILL CENTRED IN 3-COL', centred);

// Escape closes region C — one rung.
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
console.log('ESC CLOSES C', { detailGone: (await page.locator('.crf-detail').count()) === 0 });
await shoot('craft-11-after-esc');

// ---- 6. DARK. ----------------------------------------------------------
await page.getByTestId('harness-theme').click();
await page.waitForTimeout(200);
await shoot('craft-09-dark');

console.log('final url:', page.url());
await browser.close();
