// Browser check for the People/Invite mount (task 01a18bff-1231): the real
// bridge panel on fixtures, desktop and phone width. Start Vite first
// (`./node_modules/.bin/vite --port 4613 --strictPort --host 127.0.0.1`).
// On the tm8 host: LD_LIBRARY_PATH=~/chromedeps/root/usr/lib/x86_64-linux-gnu,
// and CHROMIUM_PATH to an installed headless shell when Playwright's pinned
// build is absent.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const out = process.env.TM8_EVIDENCE_DIR ?? 'gate-evidence/bridge-people-mount';
const base = process.env.TM8_UI_URL ?? 'http://127.0.0.1:4613';
mkdirSync(out, { recursive: true });
// --single-process cannot open a second page once the first closes, so each
// viewport gets its own browser.
const launch = () => chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process'],
});
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
const row = (page, name) => page.getByTestId('bridge-participant').filter({ has: page.locator('.brp__name', { hasText: new RegExp(`^${name}$`) }) });
async function people(page, url) {
  await page.goto(url);
  await page.getByTestId('bridge-page').waitFor();
  await page.getByRole('tab', { name: 'People' }).click();
  await page.getByTestId('bridge-participant').first().waitFor();
}
const only = process.env.TM8_ONLY;
if (only !== 'phone') {
  const browser = await launch();
  try {
  const desk = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  desk.setDefaultTimeout(120_000); desk.setDefaultNavigationTimeout(180_000);
  await people(desk, `${base}/e2e/bridge-people-mount-harness.html`);
  await shot(desk, '01-desktop-people-roster');
  await row(desk, 'Rahul').locator('[data-testid^="bridge-invite-"]').click();
  await desk.getByTestId('bridge-invite-panel').waitFor();
  await shot(desk, '02-desktop-invite-ask');
  await desk.getByTestId('bridge-invite-mint').click();
  await desk.getByTestId('bridge-invite-link').waitFor();
  await shot(desk, '03-desktop-invite-link');
  await people(desk, `${base}/e2e/bridge-people-mount-harness.html?theme=dark`);
  await shot(desk, '04-desktop-people-dark');
  } finally { await browser.close(); }
}
if (only !== 'desktop') {
  const browser = await launch();
  try {
  const phone = await browser.newPage({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  phone.setDefaultTimeout(120_000); phone.setDefaultNavigationTimeout(180_000);
  await people(phone, `${base}/e2e/bridge-people-mount-harness.html`);
  await shot(phone, '05-phone-people-roster');
  await row(phone, 'Rahul').locator('[data-testid^="bridge-invite-"]').click();
  await phone.getByTestId('bridge-invite-panel').waitFor();
  await shot(phone, '06-phone-invite-ask');
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('phone horizontal overflow px:', overflow);
  } finally { await browser.close(); }
}
console.log('captured to', out);
