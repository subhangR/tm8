// The 187 follow-through, in a real browser: the Session sharing settings
// section (fixture seam, /settings-dev.html) and the per-session sharing
// picker changing state, from its row (/e2e/sharing-harness.html) and from
// its detail panel (/e2e/sharing-detail-harness.html).
//
//   npx vite --port 4637          # in this package
//   OUT=<dir> PORT=4637 node e2e/capture-sharing.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT ?? '/tmp/sharing-evidence';
const PORT = process.env.PORT ?? '4637';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--single-process', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=1'],
});
const ctx = await browser.newContext({ viewport: { width: 1100, height: 820 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 85 });

// 1 — the settings section, then one dial changed.
await page.goto(`http://127.0.0.1:${PORT}/settings-dev.html`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Session sharing/ }).first().click();
await page.getByTestId('sharing-scope').waitFor();
await shot('01-settings-sharing');
const typeDial = page.getByTestId('sharing-dial-type');
await typeDial.getByRole('radio', { name: 'Everyone who can watch' }).click();
await typeDial.locator('[aria-checked="true"][data-value="space"]').waitFor();
await shot('02-settings-sharing-drive-space');
const checked = await page.locator('.set-sharing [role="radio"][aria-checked="true"]').evaluateAll((els) =>
  els.map((el) => el.getAttribute('data-value')),
);
console.log('settings checked after one click:', JSON.stringify(checked));

// 2 — the row picker on a teammate-launched session, before and after.
await page.goto(`http://127.0.0.1:${PORT}/e2e/sharing-harness.html`, { waitUntil: 'networkidle' });
const trigger = page.getByTestId('row-sharing-trigger').first();
// The cluster is revealed by hovering the TILE; the trigger is under it.
await page.locator('.pn-st__main').first().hover();
await trigger.click({ force: true });
await page.getByTestId('row-sharing-menu').waitFor();
await shot('03-row-picker-teammate-unset');
await page.getByTestId('row-sharing-type').locator('[data-value="space"]').click();
await page.getByTestId('row-sharing-type').locator('[aria-checked="true"][data-value="space"]').waitFor();
await shot('04-row-picker-after-drive-click');
console.log('row log:', await page.getByTestId('harness-log').textContent());
console.log('row note:', await page.getByTestId('row-sharing-teammate').textContent());

// 3 — the same picker from the session's DETAIL PANEL, before and after.
await page.goto(`http://127.0.0.1:${PORT}/e2e/sharing-detail-harness.html`, { waitUntil: 'networkidle' });
await page.getByTestId('row-sharing-trigger').click();
await page.getByTestId('row-sharing-menu').waitFor();
await shot('05-detail-picker-teammate-unset');
await page.getByTestId('row-sharing-watch').locator('[data-value="none"]').click();
await page.getByTestId('row-sharing-watch').locator('[aria-checked="true"][data-value="none"]').waitFor();
await shot('06-detail-picker-after-watch-click');
console.log('detail log:', await page.getByTestId('harness-log').textContent());
console.log('detail trigger:', await page.getByTestId('row-sharing-trigger').getAttribute('aria-label'));
console.log('detail note:', await page.getByTestId('row-sharing-teammate').textContent());

console.log('page errors:', JSON.stringify(errors));
await browser.close();
