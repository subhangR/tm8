// Standalone pixel-evidence capture (NOT a spec — .mjs is outside the test glob).
// Drives the REAL PromptsScreen through the prompts harness in system Chrome.
// Run: node e2e/capture-prompts.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:4612';
const OUT = 'gate-evidence';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1492, height: 900 } });
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

async function setTheme(theme) {
  await page.evaluate((t) => {
    for (const el of document.querySelectorAll('.cv2-root')) el.setAttribute('data-theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.waitForTimeout(120);
}

async function shoot(name) {
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('saved', `${OUT}/${name}.png`);
}

await page.goto(`${BASE}/e2e/prompts-harness.html`);
await page.getByTestId('prompts-screen').waitFor();

// The default landing state: All prompts, first entry selected (the kernel —
// the largest single prompt, so the worst case for the detail pane).
await setTheme('light');
await shoot('prompts-all-light');
await setTheme('dark');
await shoot('prompts-all-dark');

// A category with the densest rows.
await setTheme('light');
await page.getByText('Trusted control blocks').click();
await page.waitForTimeout(150);
await shoot('prompts-trusted-control-light');

// A pointer entry — the one that must NOT pretend to have text.
await page.getByText('All prompts').click();
await page.getByLabel('Prompts').getByText('Team-member persona').click();
await page.waitForTimeout(150);
await shoot('prompts-pointer-entry-light');

// Search across categories.
await page.getByLabel('Search prompts').fill('untrusted');
await page.waitForTimeout(200);
await shoot('prompts-search-light');

// --- measurements the DOM can answer and jsdom cannot ----------------------
await page.getByLabel('Search prompts').fill('');
await page.getByText('All prompts').click();
// Select the kernel — the largest single prompt, so the worst case for wrapping.
await page.getByLabel('Prompts').getByText('Trusted kernel (tm8.core.v1)').click();
await page.waitForTimeout(150);

const m = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const r = (el) => (el ? el.getBoundingClientRect() : null);
  const body = r(q('.pr-body'));
  const cats = r(q('.pr-cats'));
  const list = r(q('.pr-list'));
  const detail = r(q('.pr-detail'));
  const pre = q('.pr-text');
  return {
    body: body && { w: Math.round(body.width), h: Math.round(body.height) },
    cats: cats && Math.round(cats.width),
    list: list && Math.round(list.width),
    detail: detail && Math.round(detail.width),
    // Sideways scroll anywhere is the failure this screen is most prone to.
    docScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    preScrollsX: pre ? pre.scrollWidth > pre.clientWidth + 1 : null,
    preChars: pre ? pre.textContent.length : 0,
  };
});
console.log('measurements', JSON.stringify(m, null, 2));

// Narrow viewport — the floors are the whole point of the grid definition.
await page.setViewportSize({ width: 900, height: 800 });
await page.waitForTimeout(200);
const narrow = await page.evaluate(() => ({
  docScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  detail: Math.round(document.querySelector('.pr-detail').getBoundingClientRect().width),
}));
console.log('narrow', JSON.stringify(narrow));
await shoot('prompts-narrow-light');

// --- CLI help mode ---------------------------------------------------------
await page.setViewportSize({ width: 1492, height: 900 });
await page.getByRole('tab', { name: /CLI help/ }).click();
await page.waitForTimeout(250);
await setTheme('light');
await shoot('cli-help-all-light');
await setTheme('dark');
await shoot('cli-help-all-dark');

await setTheme('light');
await page.getByLabel('CLI nouns').getByText('entity', { exact: true }).click();
await page.waitForTimeout(200);
await shoot('cli-help-entity-noun-light');

// The noun that owns no operations — must explain, not just show an empty list.
await page.getByLabel('CLI nouns').getByText('task', { exact: true }).click();
await page.waitForTimeout(200);
await shoot('cli-help-empty-noun-light');
await page.getByLabel('CLI nouns').getByText('entity', { exact: true }).click();
await page.waitForTimeout(200);

const cli = await page.evaluate(() => ({
  ops: document.querySelectorAll('.pr-list .pr-item').length,
  nouns: document.querySelectorAll('.pr-cats .pr-cat').length,
  docScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  preScrollsX: (() => {
    const p = document.querySelector('.pr-text');
    return p ? p.scrollWidth > p.clientWidth + 1 : null;
  })(),
}));
console.log('cli-help', JSON.stringify(cli));

console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
console.log('done');
