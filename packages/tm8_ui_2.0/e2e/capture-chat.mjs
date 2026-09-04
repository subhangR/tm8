// Standalone pixel-evidence capture (NOT a spec — .mjs is outside the test glob).
// Drives the REAL ChannelScreen through the m7 harness in system Chrome and saves
// screenshots to gate-evidence/. Run: bunx node e2e/capture-chat.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:4612';
const OUT = 'gate-evidence';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1492, height: 812 } });
const page = await ctx.newPage();

async function setTheme(theme) {
  await page.evaluate((t) => {
    for (const el of document.querySelectorAll('.cv2-root')) el.setAttribute('data-theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
}

async function shoot(name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('saved', `${OUT}/${name}.png`);
}

// Presentation scenario: richest feed (messages, edited reply, redaction tombstone, artifact card).
await page.goto(`${BASE}/e2e/m7-harness.html?scenario=presentation`);
await page.getByRole('region', { name: 'Chat history' }).waitFor();
await setTheme('light');
await shoot('chatui-D10-presentation-light');
await setTheme('dark');
await shoot('chatui-D10-presentation-dark');

// Surface scenario: the Terminal/Chat switch with composer + live feed.
await page.goto(`${BASE}/e2e/m7-harness.html?scenario=surface`);
await page.getByRole('tab', { name: 'Chat' }).click();
await page.getByRole('region', { name: 'Chat history' }).waitFor();
await setTheme('light');
await shoot('chatui-D10-surface-chat-light');
await setTheme('dark');
await shoot('chatui-D10-surface-chat-dark');

// Unknown-template diagnostics notice (the §14.3.1 change this session made).
await page.goto(`${BASE}/e2e/m7-harness.html?scenario=profiles`);
await setTheme('light');
await page.getByTestId('profile-unknown').scrollIntoViewIfNeeded();
await page.getByTestId('profile-unknown').screenshot({ path: `${OUT}/chatui-D10-unknown-template-diag.png` });
console.log('saved', `${OUT}/chatui-D10-unknown-template-diag.png`);

await browser.close();
console.log('done');
