// Standalone real-app capture (NOT a spec — .mjs is outside the test glob) for
// the channels-in-the-entity-list ruling, run against STAGING on 8888.
//
// What it has to show, because jsdom cannot: that the rail no longer carries a
// Channels section, that the Entity List Panel's kind switcher offers Channels,
// and that opening one renders the real feed INSIDE a side-panel-width column —
// the one thing a jsdom assertion can never tell you about.
//
// Follows capture-real-channel.mjs: a browser-local scratch account in THIS
// Playwright profile's localStorage only. Evidence only; no messages posted.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const BASE = process.env.CAPTURE_BASE ?? 'http://127.0.0.1:8888';
const OUT = process.env.CAPTURE_OUT ?? 'gate-evidence/channels-in-list';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1492, height: 812 } });
const page = await ctx.newPage();
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('saved', `${OUT}/${name}.png`);
};

await page.goto(BASE);

// The gate: either a fresh owner-account form, or an already-bound profile.
const create = page.getByText(/create owner account/i);
if (await create.count()) {
  await page.getByLabel(/your name/i).fill('Channels Capture');
  await page.getByLabel(/password/i).fill(`scratch-${randomBytes(6).toString('hex')}`);
  await page.getByRole('button', { name: /create owner account/i }).click();
}
await page.waitForTimeout(3500);
await shot('01-workspace');

// 1. THE RAIL: no Channels section, and Home is Dashboard alone.
const railHeaders = await page.locator('.shell-rail__header').allTextContents();
console.log('rail groups:', JSON.stringify(railHeaders));
const railRows = await page.locator('.shell-rail__label').allTextContents();
console.log('rail rows:', JSON.stringify(railRows));

// 2. THE KIND SWITCHER: Channels is an offered collection.
const leftPanel = page.getByLabel('Left panel');
await leftPanel.locator('.lp__kind').click();
await page.waitForTimeout(400);
await shot('02-kind-switcher-open');
const options = await page.locator('.lp__kindopt').allTextContents();
console.log('collections offered:', JSON.stringify(options));

const channelsOption = page.locator('.lp__kindopt', { hasText: 'Channels' }).first();
if (!(await channelsOption.count())) {
  console.log('FAIL: no Channels option in the kind switcher');
  await browser.close();
  process.exit(1);
}
await channelsOption.click();
await page.waitForTimeout(1500);
await shot('03-channels-listed');

// 3. OPEN ONE: the panel must render the real feed, not a front-door summary.
const row = leftPanel.getByText('general', { exact: true }).first();
if (!(await row.count())) {
  console.log('no channel row named "general" in the list');
  await browser.close();
  process.exit(1);
}
await row.click();
await page.waitForTimeout(3000);
await shot('04-channel-panel-open');

const hasHubBody = await page.locator('[data-testid="hub-body"]').count();
const hasComposer = await page.getByLabel('Message this channel').count();
const hasRedirect = await page.locator('[data-testid="hub-redirect"]').count();
console.log('hub body:', hasHubBody, '| composer:', hasComposer, '| stale redirect note:', hasRedirect);

// The measurement jsdom cannot make: how wide the feed actually renders, and
// whether the page scrolls sideways because of it.
const panel = page.locator('[data-testid="entity-detail-panel"]').first();
if (await panel.count()) {
  const box = await panel.boundingBox();
  console.log('panel box:', JSON.stringify(box));
}
const overflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log('horizontal overflow px:', overflow);

console.log('final url:', page.url());
await browser.close();
