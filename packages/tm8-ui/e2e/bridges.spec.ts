import { expect, test, type Page } from '@playwright/test';

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

async function openInfra(page: Page) {
  await openSettings(page);
  await page.getByRole('button', { name: 'Open Infra bridge' }).click();
  await expect(page.getByTestId('bridge-page')).toBeVisible({ timeout: 60_000 });
}

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
  await openSettings(page);
  await page.getByRole('button', { name: 'Open Rahul bridge' }).click();
  await page.getByRole('tab', { name: 'Health' }).click();
  await expect(page.getByTestId('bridge-health')).toContainText('The runtime has not checked in');
  await page.screenshot({ path: info.outputPath('19-degraded-health.png') });
});

test('Settings → Bridges at 900×600 and on a phone: no horizontal page scroll', async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await openSettings(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('20-settings-900x600.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SETTINGS);
  await expect(page.getByTestId('bridges-section')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: info.outputPath('21-settings-phone.png') });
});
