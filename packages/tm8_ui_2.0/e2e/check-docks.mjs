import { chromium } from '@playwright/test';
import { randomBytes } from 'node:crypto';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1492, height: 812 } })).newPage();
await page.goto('http://localhost:8888');
const create = page.getByText(/create owner account/i);
if (await create.count()) {
  await page.getByLabel(/your name/i).fill('Rail Check');
  await page.getByLabel(/password/i).fill(`scratch-${randomBytes(6).toString('hex')}`);
  await page.getByRole('button', { name: /create owner account/i }).click();
}
await page.waitForTimeout(4500);
console.log('LEFT dock :', await page.getByLabel('Left panel').locator('[data-testid="entity-list-panel"]').getAttribute('data-kind'));
console.log('RIGHT dock:', await page.getByLabel('Right panel').locator('[data-testid="entity-list-panel"]').getAttribute('data-kind'));
console.log('rail rows :', JSON.stringify(await page.locator('.shell-rail__label, .shell-rail__leaf').allTextContents()));
// The rail row must actually go somewhere.
const channels = page.locator('.shell-rail__leaf', { hasText: 'Channels' }).first();
console.log('Channels rail row present:', await channels.count());
if (await channels.count()) {
  await channels.click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'gate-evidence/rail-channels.png' });
  console.log('after click, rows on screen:', JSON.stringify((await page.locator('.evt-row, .lp__tile, [data-id]').allTextContents()).slice(0, 6)));
}
await browser.close();
