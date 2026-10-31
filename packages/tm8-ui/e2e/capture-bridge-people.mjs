// The bridge People tab's browser check (Bridges P, D50-D52). Start the Vite
// app (`bun run dev --port 4612 --host 127.0.0.1`), then run this from the
// package root. Screenshots land in TM8_EVIDENCE_DIR.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const out = process.env.TM8_EVIDENCE_DIR ?? 'gate-evidence/bridge-people';
const base = process.env.TM8_UI_URL ?? 'http://127.0.0.1:4612';
mkdirSync(out, { recursive: true });
/* This host has no system Chrome and no root: Playwright's bundled Chromium
   launches only with the extracted libraries on LD_LIBRARY_PATH
   (~/.local/chromium-libs/usr/lib/x86_64-linux-gnu:~/.local/pw-min/lib), and
   these args, as capture-entity-help.mjs does. */
const browser = await chromium.launch({
  args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process', '--use-gl=swiftshader'],
});
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
const row = (page, name) => page.getByTestId('bridge-participant').filter({ has: page.locator('.brp__name', { hasText: new RegExp(`^${name}$`) }) });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  page.setDefaultTimeout(180_000); page.setDefaultNavigationTimeout(300_000);
  const open = async (q) => { await page.goto(`${base}/e2e/bridge-people-harness.html?${q}`); };

  await open('view=admin'); await page.getByTestId('bridge-participant').first().waitFor(); await shot(page, '01-admin-roster');
  await open('view=member'); await page.getByTestId('bridge-participant').first().waitFor(); await shot(page, '02-member-masked');
  await open('view=admin'); await page.getByTestId('bridge-participant').first().waitFor();
  await row(page, 'Rahul').getByRole('button', { name: 'This is…' }).click();
  await page.getByRole('combobox', { name: 'Member Rahul is' }).selectOption({ label: 'Rahul Verma' });
  await shot(page, '03-admin-assert-picker');
  await page.getByRole('button', { name: 'Assert', exact: true }).click();
  await row(page, 'Rahul').getByText('asserted').waitFor(); await shot(page, '04-admin-asserted');
  await row(page, 'Rahul').getByRole('button', { name: 'Mute' }).click();
  await row(page, 'Rahul').getByText('muted').waitFor(); await shot(page, '05-admin-muted');
  await page.getByRole('radio', { name: 'Linked' }).click(); await shot(page, '06-filter-linked');
  await page.getByRole('radio', { name: 'Guests' }).click(); await shot(page, '07-filter-guests');
  await open('view=refuse'); await page.getByTestId('bridge-participant').first().waitFor();
  await row(page, 'Rahul').getByRole('button', { name: 'Mute' }).click(); await page.getByRole('alert').waitFor(); await shot(page, '08-refusal');
  await open('view=empty'); await page.getByText(/Nobody has spoken/).waitFor(); await shot(page, '09-empty');
  await open('view=error'); await page.getByRole('alert').waitFor(); await shot(page, '10-load-error');
  await open('view=admin&theme=dark'); await page.getByTestId('bridge-participant').first().waitFor(); await shot(page, '11-admin-dark');
  await page.setViewportSize({ width: 390, height: 780 });
  await open('view=admin'); await page.getByTestId('bridge-participant').first().waitFor(); await shot(page, '12-admin-phone');
  console.log('captured to', out);
} finally { await browser.close(); }
