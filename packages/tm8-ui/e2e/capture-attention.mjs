/**
 * Drives the attention inbox against a RUNNING node and reports what it sees.
 *
 * Must live inside packages/tm8-ui: `chromium` resolves from this package's
 * node_modules, and a script in a scratch dir has no such path.
 *
 *   node e2e/capture-attention.mjs <spaceId> [uiOrigin] [api]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// `api` defaults to same-origin so the vite proxy carries the call; the server
// sends no CORS headers, so an absolute origin here fails in the browser.
const [spaceId, ui = 'http://127.0.0.1:4612', api = ''] = process.argv.slice(2);
if (!spaceId) {
  console.error('usage: node e2e/capture-attention.mjs <spaceId> [uiOrigin] [api]');
  process.exit(2);
}

const OUT = 'gate-evidence';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const url = `${ui}/e2e/attention-harness.html?spaceId=${spaceId}&api=${encodeURIComponent(api)}`;
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="attention-inbox"]', { timeout: 15_000 });
// Titles arrive one read per row; wait for the hydrated form rather than racing it.
await page.waitForFunction(
  () => !!document.querySelector('.att-inbox__list, .att-inbox__none, .att-inbox__error'),
  { timeout: 15_000 },
);
await page.waitForTimeout(1200);

const seen = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-testid^="attention-row-"]')];
  return {
    eyebrow: document.querySelector('.att-inbox__eyebrow')?.textContent?.trim() ?? null,
    empty: document.querySelector('.att-inbox__none')?.textContent?.trim() ?? null,
    error: document.querySelector('.att-inbox__error-detail')?.textContent?.trim() ?? null,
    rows: rows.map((r) => ({
      entityId: r.getAttribute('data-testid')?.replace('attention-row-', ''),
      points: r.querySelector('.att-inbox__points')?.textContent?.trim(),
      name: r.querySelector('.att-inbox__name')?.textContent?.trim(),
      rawName: !!r.querySelector('.att-inbox__name--raw'),
      kind: r.querySelector('.att-inbox__kind')?.textContent?.trim() ?? null,
      reason: r.querySelector('.att-inbox__reason')?.textContent?.trim(),
      count: r.querySelector('.att-inbox__count')?.textContent?.trim() ?? null,
      // Layout is the thing jsdom cannot check: a clipped row is a real defect.
      width: Math.round(r.getBoundingClientRect().width),
      overflows: r.scrollWidth > r.clientWidth + 1,
    })),
  };
});

const shot = `${OUT}/attention-inbox.png`;
await page.screenshot({ path: shot, fullPage: false });

console.log(JSON.stringify({ url, seen, errors, screenshot: shot }, null, 2));
await browser.close();
