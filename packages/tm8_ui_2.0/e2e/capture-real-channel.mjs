// Standalone real-app capture (NOT a spec — .mjs is outside the test glob).
// Creates a browser-local scratch account (the gate stores it in THIS Playwright
// profile's localStorage only — "nothing leaves this machine"), then walks to a
// channel chat surface and screenshots it. Evidence only; no messages posted.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const BASE = 'http://127.0.0.1:4612';
const OUT = 'gate-evidence';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1492, height: 812 } });
const page = await ctx.newPage();

await page.goto(BASE);
await page.getByText(/create owner account/i).waitFor({ timeout: 10_000 });
await page.getByLabel(/your name/i).fill('Probe Capture');
await page.getByLabel(/password/i).fill(`scratch-${randomBytes(6).toString('hex')}`);
await page.getByRole('button', { name: /create owner account/i }).click();
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/real-app-home.png` });
console.log('saved', `${OUT}/real-app-home.png`);

// Find a channel in the shell nav (the user's screenshot shows "general").
const general = page.getByText('general', { exact: true }).first();
if (await general.count()) {
  await general.click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/real-channel-chat.png` });
  console.log('saved', `${OUT}/real-channel-chat.png`);
} else {
  console.log('no element with text "general" found');
}
console.log('final url:', page.url());
await browser.close();
