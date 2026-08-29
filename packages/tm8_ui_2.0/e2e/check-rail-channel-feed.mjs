import { chromium } from '@playwright/test';
import { randomBytes } from 'node:crypto';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1492, height: 812 } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
await page.goto('http://localhost:8888');
const create = page.getByText(/create owner account/i);
if (await create.count()) {
  await page.getByLabel(/your name/i).fill('Feed Check');
  await page.getByLabel(/password/i).fill(`scratch-${randomBytes(6).toString('hex')}`);
  await page.getByRole('button', { name: /create owner account/i }).click();
}
await page.waitForTimeout(4500);
// The exact path the user took: rail row -> a channel -> its feed.
await page.locator('.shell-rail__leaf', { hasText: 'Channels' }).first().click();
await page.waitForTimeout(2000);
await page.getByText('general', { exact: true }).first().click();
await page.waitForTimeout(4000);
const body = await page.locator('body').textContent();
console.log('scope refusal present:', /session_chat_v1 is not applicable/.test(body ?? ''));
console.log('could not be read  :', /could not be read/.test(body ?? ''));
console.log('composer present   :', await page.getByLabel('Message this channel').count());
await page.screenshot({ path: 'gate-evidence/rail-channel-feed.png' });
console.log('console errors:', JSON.stringify(errors.slice(0, 3)));
await browser.close();
