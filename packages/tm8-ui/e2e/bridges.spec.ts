import { devices, expect, test, type Page } from '@playwright/test';

/*
 * Settings → Bridges and the bridge panel (BRIDGE-ENTITY-DESIGN §4.2, §4.4;
 * BRIDGES-V2-DESIGN §1). The fixture seam seeds three bridges: Infra (live
 * WhatsApp group), #deploys (paused Slack channel) and Rahul (degraded DM).
 */
const SETTINGS = '/e2e/admin-pages-harness.html#/s/sp-atelier/settings/bridges';

async function openSettings(page: Page) {
  await page.goto(SETTINGS);
  await expect(page.getByTestId('bridges-table')).toBeVisible({ timeout: 60_000 });
}

const ENTITY = (id: string) => `/e2e/admin-pages-harness.html#/s/sp-atelier/e/${id}`;

async function openBridge(page: Page, id: string) {
  await page.goto(ENTITY(id));
  await expect(page.getByTestId('bridge-page')).toBeVisible({ timeout: 60_000 });
}
const openInfra = (page: Page) => openBridge(page, 'ent-bridge-infra');

test('Settings → Bridges lists accounts and bridges, status in colour and word', async ({ page }, info) => {
  await openSettings(page);
  await expect(page.getByText('Accounts & secrets')).toBeVisible();
  await expect(page.getByTestId('bridge-row-ent-bridge-rahul')).toContainText('degraded');
  await page.screenshot({ path: info.outputPath('01-settings-bridges.png') });

  await page.getByRole('button', { name: 'More for Infra' }).click();
  await page.screenshot({ path: info.outputPath('02-settings-row-menu.png') });
  await page.getByRole('menuitem', { name: 'Remove Infra…' }).click();
  await page.getByLabel('Type Infra to confirm').fill('Infra');
  await page.screenshot({ path: info.outputPath('03-remove-confirm.png') });
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'More for Infra' }).click();
  await page.getByRole('menuitem', { name: 'Pause Infra' }).click();
  await expect(page.getByTestId('bridges-notice')).toContainText('Messages are still logged');
  await page.screenshot({ path: info.outputPath('04-settings-after-pause.png') });
  // Opening a row opens the bridge in Work (review #1445 r1: `bridge` was
  // missing from WORKSPACE_KINDS, so this opened nothing).
  await page.getByRole('button', { name: 'Open Infra bridge' }).click();
  await expect(page.getByTestId('bridge-page')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: info.outputPath('05-opened-from-settings.png') });
});

test('the bridge panel: header, and each tab', async ({ page }, info) => {
  await openInfra(page);
  await expect(page.getByTestId('bridge-conversation')).toContainText('@tm8 is the deploy done?');
  await page.screenshot({ path: info.outputPath('10-panel-conversation.png') });

  await page.getByRole('button', { name: /^Status: live/ }).click();
  await page.screenshot({ path: info.outputPath('11-panel-status-menu.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More for Infra' }).last().click();
  await page.screenshot({ path: info.outputPath('12-panel-more-menu.png') });
  await page.mouse.click(5, 5);

  for (const [tab, testId, n] of [
    ['People', 'bridge-people', '13'],
    ['Routing', 'bridge-routing', '14'],
    ['Memory', 'bridge-memory', '16'],
    ['Loops', 'bridge-loops', '17'],
    ['Health', 'bridge-health', '18'],
  ] as const) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByTestId(testId)).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${n}-panel-${tab.toLowerCase()}.png`), fullPage: true });
  }

  await page.getByRole('tab', { name: 'Routing' }).click();
  await page.getByLabel(/^Anyone in the group/).check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByTestId('bridge-consequences')).toContainText('not linked, will be able to start agents');
  await page.screenshot({ path: info.outputPath('15-routing-consequence-confirm.png') });
});

test('a degraded bridge says why on Health', async ({ page }, info) => {
  await openBridge(page, 'ent-bridge-rahul');
  await page.getByRole('tab', { name: 'Health' }).click();
  await expect(page.getByTestId('bridge-health')).toContainText('The runtime has not checked in');
  await page.screenshot({ path: info.outputPath('19-degraded-health.png') });
});

test('Settings → Bridges at 900×600: no horizontal page scroll', async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await openSettings(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('20-settings-900x600.png') });
});

test.describe('dark theme', () => {
  test.use({ colorScheme: 'dark' });
  test('Settings → Bridges, Routing and the §1.5 confirm in dark', async ({ page }, info) => {
    await page.addInitScript(() => window.localStorage.setItem('tm8ui.theme', 'dark'));
    await openSettings(page);
    await page.screenshot({ path: info.outputPath('30-dark-settings.png') });
    await openInfra(page);
    await page.getByRole('tab', { name: 'Routing' }).click();
    await page.screenshot({ path: info.outputPath('31-dark-routing.png') });
    await page.getByLabel(/^Anyone in the group/).check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByTestId('bridge-consequences')).toBeVisible();
    await page.screenshot({ path: info.outputPath('32-dark-consequence.png') });
  });
});

test.describe('phone shell', () => {
  // A coarse pointer under 500px selects the mobile shell (mobile/shell-for.ts).
  const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 5'];
  test.use(pixel);
  test('Settings → Bridges and the bridge panel on a phone', async ({ page }, info) => {
    await page.goto(SETTINGS);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: info.outputPath('40-phone-settings.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByTestId('bridges-table').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('41-phone-settings-table.png') });
    // The phone shell opens a bridge in its generic mobile entity page, not the
    // bridge page (follow-up: a mobile bridge page, §4.1 Mobile). Recorded here.
    await page.goto(`/e2e/admin-pages-harness.html#/s/sp-atelier/e/ent-bridge-infra`);
    await expect(page.getByText('Infra').first()).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: info.outputPath('42-phone-entity-page.png') });
  });
});

test('Loops tab: the loops that post here, their words, a new loop here', async ({ page }, info) => {
  await openInfra(page);
  await page.getByRole('tab', { name: 'Loops' }).click();
  const tab = page.getByTestId('bridge-loops');
  await expect(tab.getByRole('button', { name: 'Stand-up nudge', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('70-loops-tab.png') });
  await page.getByRole('button', { name: 'Run Stand-up nudge now' }).click();
  await expect(tab.getByText(/Last run here: posted/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('71-loops-after-run.png') });
  await page.getByRole('button', { name: 'Edit what Stand-up nudge says here' }).click();
  await page.screenshot({ path: info.outputPath('72-loops-edit-text.png') });
  await page.getByRole('button', { name: 'Cancel' }).first().click();
  await page.getByRole('button', { name: '+ New loop here' }).click();
  await page.getByLabel('Loop name').fill('Friday wrap-up');
  await page.getByLabel('Schedule').fill('every friday at 17:00');
  await page.getByLabel('What it posts in Infra').fill("It's Friday: post one thing you shipped this week.");
  await expect(page.getByTestId('bridge-new-loop-preview')).toContainText('every friday');
  await page.screenshot({ path: info.outputPath('73-loops-new-loop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create loop' }).click();
  await expect(tab.getByRole('button', { name: 'Friday wrap-up', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('74-loops-created.png'), fullPage: true });
});

test('Conversation opens on the newest page and scrolls back (#1446)', async ({ page }, info) => {
  await openInfra(page);
  const conv = page.getByTestId('bridge-conversation');
  await expect(conv.getByText('nice, ship the changelog too')).toBeVisible();
  await expect(conv.getByText('@tm8 is the deploy done?')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('75-conversation-newest.png') });
  await conv.getByTestId('bridge-conversation-older').click();
  await expect(conv.getByText('@tm8 is the deploy done?')).toBeVisible();
  await expect(conv.getByTestId('bridge-conversation-start')).toBeVisible();
  await page.screenshot({ path: info.outputPath('76-conversation-scrolled-back.png') });
});

test('PR2: the add-bridge wizard, step by step', async ({ page }, info) => {
  await openSettings(page);
  await expect(page.getByTestId('connection-0b9f3c1e-6b1a-4c55-9a51-7d3a0c1b9494')).toBeVisible();
  await page.screenshot({ path: info.outputPath('50-settings-my-accounts.png') });
  await page.getByTestId('bridges-add').click();
  await expect(page.getByTestId('wizard-step-connection')).toBeVisible();
  await page.screenshot({ path: info.outputPath('51-wizard-1-connection.png') });
  await page.getByRole('button', { name: 'Use Ada · work phone' }).click();
  await expect(page.getByRole('option', { name: /Gaming/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('52-wizard-2-conversation.png') });
  await page.getByRole('option', { name: /Gaming/ }).click();
  await page.getByRole('button', { name: 'Next: where it lands' }).click();
  await expect(page.getByTestId('wizard-step-target')).toBeVisible();
  await page.getByRole('combobox', { name: 'Target', exact: true }).selectOption({ label: 'Plan the launch sequence' });
  await page.screenshot({ path: info.outputPath('53-wizard-3-target.png') });
  await page.getByLabel(/^Anyone in the group/).check();
  await page.getByRole('button', { name: 'Create bridge' }).click();
  await expect(page.getByTestId('bridge-consequences')).toBeVisible();
  await page.screenshot({ path: info.outputPath('54-wizard-3-confirm.png') });
  await page.getByRole('button', { name: 'Yes, create it' }).click();
  await expect(page.getByTestId('wizard-step-test')).toBeVisible();
  await page.screenshot({ path: info.outputPath('55-wizard-4-test.png') });
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByTestId('bridge-page')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: info.outputPath('56-wizard-finished-opens-bridge.png') });
});

test('PR2: linking a number — QR and pairing code', async ({ page }, info) => {
  await openSettings(page);
  await page.getByRole('button', { name: '+ Link a new account' }).click();
  await expect(page.getByTestId('bridge-link-number')).toBeVisible();
  await page.screenshot({ path: info.outputPath('60-link-choose.png') });
  await page.getByRole('button', { name: 'Show the QR code' }).click();
  await expect(page.getByAltText('WhatsApp link QR code')).toBeVisible();
  await page.screenshot({ path: info.outputPath('61-link-qr.png') });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: '+ Link a new account' }).click();
  await page.getByLabel(/^This phone/).check();
  await page.getByLabel('Phone number').fill('+91 98000 00094');
  await page.getByRole('button', { name: 'Get a code' }).click();
  await expect(page.getByTestId('bridge-link-code')).toHaveText('K7Q2-9MXD');
  await page.screenshot({ path: info.outputPath('62-link-pairing-code.png') });
});

test('PR2: the account menu, and the wizard in dark', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => window.localStorage.setItem('tm8ui.theme', 'dark'));
  await openSettings(page);
  await page.getByRole('button', { name: 'More for Ada · work phone' }).click();
  await page.screenshot({ path: info.outputPath('63-account-menu-dark.png') });
  await page.keyboard.press('Escape');
  await page.getByTestId('bridges-add').click();
  await page.getByRole('button', { name: 'Use Ada · work phone' }).click();
  await expect(page.getByRole('option', { name: /Family/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('64-wizard-2-dark.png') });
});
