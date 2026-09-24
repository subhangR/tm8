// Standalone pixel-evidence capture (NOT a spec — .mjs is outside the test glob).
// Drives the REAL CraftScreen through the craft harness in system Chrome and
// saves screenshots to gate-evidence/. Run: bunx node e2e/capture-craft.mjs
//   BASE=http://127.0.0.1:4612  SCENARIO=typical|awkward|plan|large  THEME=light|dark
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4612';
const OUT = process.env.OUT ?? 'gate-evidence/craft';
const SCENARIO = process.env.SCENARIO ?? 'plan';
const THEME = process.env.THEME ?? 'light';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1492, height: 860 } });
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text());
});
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

const name = (n) => `${SCENARIO}-${THEME}-${n}`;
async function shoot(n) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name(n)}.png` });
  console.log('saved', `${OUT}/${name(n)}.png`);
}

await page.goto(`${BASE}/e2e/craft-harness.html?scenario=${SCENARIO}`);
await page.getByTestId('craft-screen').waitFor({ timeout: 15_000 });
await page.getByTestId('crf-canvas').waitFor({ timeout: 15_000 });
// The chat surface is a LAZY chunk; measuring before it lands reports the
// pre-solo grid for a reason that is purely a race.
await page.getByTestId('chat-home-screen').waitFor({ timeout: 15_000 });
await page.waitForTimeout(400);
if (THEME === 'dark') {
  await page.getByTestId('harness-theme').click();
  await page.waitForTimeout(200);
}

// ---- 1. THE OPENING VIEW: one header, chat + canvas, legible zoom. --------
const geom = await page.evaluate(() => {
  const w = (sel) => {
    const el = document.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().width) : null;
  };
  const title = document.querySelector('.crf-node__title');
  const t = title?.getBoundingClientRect();
  return {
    headers: document.querySelectorAll('[data-testid="crf-head"]').length,
    oldPaneHeads: document.querySelectorAll('.crf-pane-head').length,
    chat: w('.crf-chat'),
    canvas: w('.crf-canvas'),
    nodes: document.querySelectorAll('[data-testid="crf-node"]').length,
    edges: document.querySelectorAll('[data-testid="crf-edge"]').length,
    avatarsDocked: document.querySelectorAll('[data-testid="crf-avatar"]').length,
    lod: document.querySelector('.crf-viewport')?.getAttribute('data-lod'),
    // Legibility: the rendered height of a card title's glyph box, in px.
    titlePx: t ? Math.round(t.height * 10) / 10 : null,
    minimap: !!document.querySelector('[data-testid="crf-minimap"]'),
  };
});
console.log('OPENING', JSON.stringify(geom));
await shoot('01-open');

// ---- 2. SELECT A NODE: inspector, neighbourhood emphasis. ------------------
const target = page.locator('[data-testid="crf-node"][data-key^="t-"], [data-testid="crf-node"]').nth(1);
await target.click();
await page.getByTestId('crf-inspector').waitFor();
console.log('SELECTED', await page.evaluate(() => ({
  selected: document.querySelector('[data-emphasis="selected"]')?.getAttribute('data-key'),
  neighbours: document.querySelectorAll('[data-emphasis="neighbour"]').length,
  dimmed: document.querySelectorAll('[data-emphasis="dim"]').length,
  activeEdges: document.querySelectorAll('.crf-edge[data-state="active"]').length,
  columns: document.querySelectorAll('.crf-split > section, .crf-split > aside').length,
})));
await shoot('02-inspector');

// A REFERENCE node opens its entity IN the inspector's column (never a 4th).
const ref = page.locator('.crf-node--ref, .crf-node--built').first();
if (await ref.count()) {
  // Fit first: the reference may sit off-screen at the legible opening zoom.
  await page.getByTestId('crf-zoom-fit').click().catch(() => {});
  await page.waitForTimeout(250);
  await ref.click();
  await page.getByTestId('crf-open-entity').click();
  await page.getByTestId('crf-back').waitFor({ timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(500);
  console.log('OPEN ENTITY', await page.evaluate(() => ({
    columns: document.querySelectorAll('.crf-split > section:not([hidden]), .crf-split > aside').length,
    back: !!document.querySelector('[data-testid="crf-back"]'),
  })));
  await shoot('02b-open-entity');
  await page.getByTestId('crf-back').click().catch(() => {});
  await target.click();
}

// Focus the neighbourhood.
await page.getByTestId('crf-focus').click();
await page.waitForTimeout(300);
await shoot('03-focus');
await page.getByTestId('crf-focus').click();
await page.waitForTimeout(200);

// Ask about this → the composer holds the node link.
await page.getByTestId('crf-ask').click();
await page.waitForTimeout(200);
console.log('ASK SEEDS', await page.getByLabel('Message the chat agent').inputValue());
await shoot('04-ask');
await page.getByLabel('Message the chat agent').fill('');

// ---- 3. THE VIEWS. ---------------------------------------------------------
for (const v of ['lanes', 'outline', 'table']) {
  const option = page.getByTestId(`crf-view-${v}`);
  if (await option.count()) {
    await option.click();
    await page.waitForTimeout(400);
    await shoot(`05-view-${v}`);
  }
}
await page.getByTestId('crf-view-flow').click();
await page.waitForTimeout(300);

// ---- 4. FIND. ---------------------------------------------------------------
await page.getByTestId('crf-viewport').focus();
await page.keyboard.press('f');
await page.keyboard.type(SCENARIO === 'large' ? 'API' : 'copy');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
await shoot('06-find');
await page.keyboard.press('Escape');

// ---- 5. FIT EVERYTHING (the reader asked: semantic zoom may apply). --------
await page.getByTestId('crf-zoom-fit').click().catch(() => {});
await page.waitForTimeout(300);
console.log('FIT', await page.evaluate(() => document.querySelector('.crf-viewport')?.getAttribute('data-lod')));
await shoot('07-fit-all');

// ---- 6. ORCHESTRATE PRE-FLIGHT (needs a thread: send one message). -------
await page.getByLabel('Message the chat agent').fill('Draft the plan.');
await page.keyboard.press('Enter');
await page.waitForFunction(() => !document.querySelector('[data-testid="crf-orchestrate"]')?.disabled, null, { timeout: 15_000 }).catch(() => {});
await page.getByTestId('crf-orchestrate').click().catch(() => {});
await page.waitForTimeout(300);
await shoot('08-preflight');
await page.keyboard.press('Escape');

// ---- 7. NARROW WINDOW: the inspector overlays the canvas. ------------------
await page.setViewportSize({ width: 1180, height: 820 });
await page.locator('[data-testid="crf-node"]').first().click();
await page.waitForTimeout(400);
console.log('NARROW', await page.evaluate(() => ({
  overlay: document.querySelector('[data-testid="crf-detail"]')?.hasAttribute('data-overlay'),
  resizers: document.querySelectorAll('.crf-split .kit-resizer').length,
})));
await shoot('09-narrow-overlay');

console.log('final url:', page.url());
await browser.close();
