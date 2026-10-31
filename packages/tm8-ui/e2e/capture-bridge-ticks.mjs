// Pixel evidence for bridged bubbles and delivery ticks (§4.5). NOT a spec.
// Serve: ./node_modules/.bin/vite --port 4699 --strictPort ; run: node e2e/capture-bridge-ticks.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4699';
const OUT = process.env.OUT ?? 'gate-evidence/bridge-ticks';
mkdirSync(OUT, { recursive: true });

// On this host: LD_LIBRARY_PATH=~/chromedeps/root/usr/lib/x86_64-linux-gnu, and the renderer needs one process.
const browser = await chromium.launch({ args: ['--disable-gpu', '--single-process', '--no-zygote'] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1500 }, deviceScaleFactor: 2 })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${BASE}/e2e/bridge-ticks-harness.html`);
await page.getByTestId('bridged-from').waitFor();
await page.waitForTimeout(400);

const shoot = async (name, locator) => {
  await (locator ?? page).screenshot({ path: `${OUT}/${name}.png`, ...(locator ? {} : { fullPage: true }) });
  console.log('saved', `${OUT}/${name}.png`);
};
for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
    for (const el of document.querySelectorAll('.cv2-root')) el.setAttribute('data-theme', t);
  }, theme);
  await page.waitForTimeout(200);
  await shoot(`chat-${theme}`);
}
await page.evaluate(() => {
  document.documentElement.setAttribute('data-theme', 'light');
  for (const el of document.querySelectorAll('.cv2-root')) el.setAttribute('data-theme', 'light');
});
await shoot('header-chip', page.getByTestId('bridged-from'));
const turns = page.locator('.tch-turn');
const count = await turns.count();
for (let i = 0; i < count; i += 1) {
  const t = turns.nth(i);
  const tick = t.getByTestId('bridge-tick');
  const name = (await tick.count())
    ? `tick-${await tick.getAttribute('data-status')}-${i}`
    : `bubble-${(await t.getByTestId('bridge-via').locator('[data-trust]').getAttribute('data-trust')) ?? 'plain'}-${i}`;
  await t.scrollIntoViewIfNeeded();
  await shoot(name, t);
}
// The via mark and the chip open the bridge.
await page.getByTestId('bridged-from').click();
console.log('chip opened', await page.evaluate(() => document.body.dataset.opened));
console.log('page errors', errors.length ? errors : 'none');
await browser.close();
