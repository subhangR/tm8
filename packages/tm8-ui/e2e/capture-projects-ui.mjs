// Pixel evidence for the Projects UI (task 01a15a00): NOT a spec.
// Build the harness (`npx vite build --config e2e/projects-ui.build.config.ts`),
// serve /tmp/pui-dist on :4689, then: node e2e/capture-projects-ui.mjs
// (screenshots land in gate-evidence/projects-ui).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4689';
const OUT = process.env.OUT ?? 'gate-evidence/projects-ui';
mkdirSync(OUT, { recursive: true });

// CDP=http://127.0.0.1:9333 drives an already-running Chrome (a host whose
// bundled browser cannot start); otherwise Playwright launches its own.
const browser = process.env.CDP ? await chromium.connectOverCDP(process.env.CDP) : await chromium.launch();
const context = process.env.CDP ? browser.contexts()[0] : await browser.newContext();
const page = await context.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
page.on('pageerror', (e) => console.log('pageerror', e.message));

async function shoot(name, locator) {
  await page.waitForTimeout(400);
  const path = `${OUT}/${name}.png`;
  if (locator) await locator.screenshot({ path });
  else await page.screenshot({ path });
  console.log('saved', path);
}

async function open(query = '') {
  await page.goto(`${BASE}/e2e/projects-ui-harness.html${query}`, { timeout: 120_000 });
  await page.getByTestId('tws-browser').waitFor({ timeout: 120_000 });
}

/** The left column on the Projects kind, then the tm8-ui project's page. */
async function openProject() {
  await page.getByRole('button', { name: /change kind/ }).first().click();
  await page.getByRole('menuitemradio', { name: 'Projects' }).click();
  await page.getByTestId('row-note').first().waitFor({ timeout: 30_000 });
  await page.getByTestId('tws-browser-list').getByRole('button', { name: 'tm8-ui', exact: true }).click();
  await page.getByTestId('governed-path').waitFor({ timeout: 30_000 });
  await page.getByTestId('governed-git-current').or(page.getByTestId('governed-git-error')).waitFor({ timeout: 30_000 });
}

await open();
await openProject();
await shoot('01-projects-list-and-page-node-admin');

await page.getByTestId('governed-path-edit').click();
await page.getByLabel('Working folder').fill('/home/subhang/code/tm8-next');
await shoot('02-change-folder');
await page.getByRole('button', { name: 'Save folder' }).click();
await page.getByText('/home/subhang/code/tm8-next').first().waitFor();

await page.getByRole('button', { name: 'Trust this project' }).click();
await shoot('03-trust-confirm');
await page.getByTestId('governed-trust-confirm').getByRole('button', { name: 'Trust' }).click();
await page.locator('[data-trust="trusted"]').waitFor();
await shoot('04-after-change-and-trust');

const tabs = page.getByTestId('governed-work').getByRole('tab');
if (await tabs.count() > 1) {
  await tabs.nth(1).click();
  await shoot('05-work-filter');
}

await open('?member=1');
await openProject();
await shoot('06-member-view');

// Add project: what the folder field is for, and the ~/<name> default.
await open();
await page.getByRole('button', { name: /change kind/ }).first().click();
await page.getByRole('menuitemradio', { name: 'Projects' }).click();
await page.getByTestId('tws-browser-new').click();
await page.getByLabel('Project name').waitFor({ timeout: 30_000 });
await page.getByLabel('Project name').fill('Docs Site');
await shoot('07-add-project-folder-help');

await browser.close();
