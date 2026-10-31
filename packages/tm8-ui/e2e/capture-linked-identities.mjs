// Bridges B3's browser check (Account → Linked identities, Invite to space).
// Start the Vite app (`bun run dev --port 4613 --host 127.0.0.1`), then run
// this from the package root. Screenshots land in TM8_EVIDENCE_DIR.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const out = process.env.TM8_EVIDENCE_DIR ?? '/tmp/b3-linked-identities';
const base = process.env.TM8_UI_URL ?? 'http://127.0.0.1:4613';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process', '--use-gl=swiftshader'],
});
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  page.setDefaultTimeout(180_000); page.setDefaultNavigationTimeout(300_000);
  const open = async (q) => { await page.goto(`${base}/e2e/linked-identities-harness.html?${q}`); };

  await open('view=settings'); await page.getByTestId('link-row-link-fixture-1').waitFor(); await shot(page, '01-linked-identities');
  await page.getByTestId('link-begin').click(); await page.getByTestId('link-code').waitFor(); await shot(page, '02-link-code');
  await page.getByTestId('link-code-close').click();
  await page.getByTestId('link-pending').waitFor(); await shot(page, '03-pending-code-not-shown');
  await page.getByTestId('link-revoke-link-fixture-1').click(); await shot(page, '04-unlink-armed');
  await page.getByTestId('link-revoke-confirm-link-fixture-1').click();
  await page.getByTestId('link-row-link-fixture-1').waitFor({ state: 'detached' }); await shot(page, '05-unlinked');
  await open('view=settings&theme=dark'); await page.getByTestId('link-row-link-fixture-1').waitFor();
  await page.getByTestId('link-begin').click(); await page.getByTestId('link-code').waitFor(); await shot(page, '06-dark-code');
  await open('view=invite'); await page.getByText('Invite to space').click(); await shot(page, '07-invite-confirm');
  await page.getByTestId('bridge-invite-mint').click(); await page.getByTestId('bridge-invite-link').waitFor(); await shot(page, '08-invite-link');
  await open('view=invite&refuse=1'); await page.getByText('Invite to space').click();
  await page.getByTestId('bridge-invite-mint').click(); await page.getByTestId('bridge-invite-error').waitFor(); await shot(page, '09-invite-refused');
  await page.setViewportSize({ width: 390, height: 780 });
  await open('view=settings&stacked=1'); await page.getByTestId('link-row-link-fixture-1').waitFor();
  await page.getByTestId('link-begin').click(); await page.getByTestId('link-code').waitFor(); await shot(page, '10-phone-code');
  console.log('captured to', out);
} finally { await browser.close(); }
