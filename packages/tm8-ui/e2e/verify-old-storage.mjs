// Does a browser that ALREADY carries the pre-channels panel choice get the
// new default? That is the returning-user path, and the one that decides
// whether a fix reaches anybody who has used the app before.
import { chromium } from '@playwright/test';
import { randomBytes } from 'node:crypto';
const KEY = 'tm8ui.sidePanel.viewer.019fb78b-6ef9-7f20-89cc-c9a9d4895567';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1492, height: 812 } })).newPage();
await page.goto('http://localhost:8888');
const create = page.getByText(/create owner account/i);
if (await create.count()) {
  await page.getByLabel(/your name/i).fill('Returning Probe');
  await page.getByLabel(/password/i).fill(`scratch-${randomBytes(6).toString('hex')}`);
  await page.getByRole('button', { name: /create owner account/i }).click();
}
await page.waitForTimeout(3000);
// The exact record an existing profile carries: old generation, no `v`.
await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({
  left: 'task', right: 'work_session', leftWidth: 300, rightWidth: 415,
})), KEY);
await page.reload();
await page.waitForTimeout(4000);
const kind = await page.getByLabel('Right panel').locator('[data-testid="entity-list-panel"]').getAttribute('data-kind');
const box = await page.getByLabel('Right panel').boundingBox();
console.log('RIGHT kind after old-generation storage:', kind);
console.log('stored width honoured (415 expected):', Math.round(box?.width ?? 0));
await browser.close();
