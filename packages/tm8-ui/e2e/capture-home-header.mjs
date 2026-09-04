/**
 * PHOTOGRAPHS the Home header before and after, side by side, at the 280px
 * column the grid actually produces.
 *
 *   node e2e/capture-home-header.mjs [uiOrigin]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const ui = process.argv[2] ?? 'http://127.0.0.1:4671';
const OUT = 'gate-evidence';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});

for (const [name, query] of [
  ['home-header-before', 'w=280&kind=task&legacy=1'],
  ['home-header-after', 'w=280&kind=task'],
]) {
  const page = await browser.newPage({ viewport: { width: 340, height: 320 } });
  await page.goto(`${ui}/e2e/home-header-harness.html?${query}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="tch-hosted-list"]', { timeout: 25_000 });
  await page.waitForTimeout(300);
  /* NOT `fullPage`: a full-page shot scrolls, and the header is pinned chrome —
     the crop that matters is the top of the column. */
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
  await page.close();
}

await browser.close();
