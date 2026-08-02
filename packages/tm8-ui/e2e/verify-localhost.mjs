import { chromium } from '@playwright/test';
import { randomBytes } from 'node:crypto';
const BASE = 'http://localhost:8888';
const OUT = 'gate-evidence/channels-localhost';
import { mkdirSync } from 'node:fs'; mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1492, height: 812 } });
const page = await ctx.newPage();
await page.goto(BASE);
const create = page.getByText(/create owner account/i);
if (await create.count()) {
  await page.getByLabel(/your name/i).fill('Localhost Probe');
  await page.getByLabel(/password/i).fill(`scratch-${randomBytes(6).toString('hex')}`);
  await page.getByRole('button', { name: /create owner account/i }).click();
}
await page.waitForTimeout(3500);

// SIMULATE THE RETURNING BROWSER: seed the OLD-generation stored choice, the
// exact record every existing profile carries (right = sessions, no `v`).
const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('tm8ui.sidePanel')));
console.log('storage keys found:', JSON.stringify(keys));
await page.evaluate((ks) => {
  for (const k of ks) localStorage.setItem(k, JSON.stringify({ left: 'task', right: 'work_session', leftWidth: 300, rightWidth: 340 }));
}, keys);
await page.reload();
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/arrival-after-old-storage.png` });
console.log('saved arrival screenshot');
const rightLabel = await page.getByLabel('Right panel').locator('.lp__kind').textContent();
const rightKind = await page.getByLabel('Right panel').locator('[data-testid="entity-list-panel"]').getAttribute('data-kind');
console.log('RIGHT PANEL kind:', rightKind, '| header:', JSON.stringify(rightLabel?.trim()));
const rows = await page.getByLabel('Right panel').locator('.lp__tile, [data-testid="entity-list-panel"] li').allTextContents();
console.log('channel rows visible:', JSON.stringify(rows.slice(0, 8)));
await browser.close();
