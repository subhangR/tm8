import { chromium } from '@playwright/test';
import { randomBytes } from 'node:crypto';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1492, height: 812 } })).newPage();
await page.goto('http://localhost:8888');
const create = page.getByText(/create owner account/i);
if (await create.count()) {
  await page.getByLabel(/your name/i).fill('Layout Probe');
  await page.getByLabel(/password/i).fill(`scratch-${randomBytes(6).toString('hex')}`);
  await page.getByRole('button', { name: /create owner account/i }).click();
}
await page.waitForTimeout(4000);
await page.locator('.shell-rail__leaf', { hasText: 'Channels' }).first().click();
await page.waitForTimeout(1500);
await page.getByText('general', { exact: true }).first().click();
// Wait for the REAL body, not the skeleton — the previous run measured
// pn-skeleton and reported nothing about the layout that ships.
await page.getByLabel('Message this channel').waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);
const m = await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { sel, h: Math.round(r.height), top: Math.round(r.top), flex: cs.flex,
             display: cs.display, overflowY: cs.overflowY, minH: cs.minHeight,
             scrollH: el.scrollHeight, clientH: el.clientHeight };
  };
  const panel = document.querySelector('[data-testid="entity-detail-panel"]');
  const walk = (el, d) => {
    if (d > 4 || !el) return [];
    return [...el.children].flatMap((c) => {
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      return [{ d, cls: (c.className || '').toString().slice(0, 46), tag: c.tagName,
                h: Math.round(r.height), flex: cs.flex, ov: cs.overflowY,
                scroll: c.scrollHeight - c.clientHeight }, ...walk(c, d + 1)];
    });
  };
  return walk(panel, 0);
});
console.log(JSON.stringify(m, null, 1));
await browser.close();
