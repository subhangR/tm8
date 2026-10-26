import { expect, test } from '@playwright/test';

const harness = '/e2e/admin-pages-harness.html';

test('admin pages have distinct reloadable addresses and working settings navigation', async ({ page }, testInfo) => {
  await page.goto(harness);
  await page.getByRole('button', { name: 'Space admin', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Space admin', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('space-admin.png') });
  await page.getByRole('button', { name: 'Members & roles', exact: true }).click();
  await expect(page).toHaveURL(/\/space-admin\/members$/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Members & roles', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('combobox', { name: 'role for Noor' })).toBeVisible();
  await page.getByRole('button', { name: 'Node admin', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Node administration sections' })).toBeVisible();
  await page.getByRole('button', { name: 'Configuration', exact: true }).click();
  await expect(page).toHaveURL(/\/node-admin\/configuration$/);
  await page.screenshot({ path: testInfo.outputPath('node-admin.png') });
  await page.goBack();
  await expect(page.getByTestId('node-credentials')).toBeVisible();
});

test('a space admin cannot open Node admin', async ({ page }) => {
  await page.goto(`${harness}?node=none&space=admin`);
  await expect(page.getByRole('button', { name: 'Space admin', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Node admin', exact: true })).toHaveCount(0);
  await page.evaluate(() => { location.hash = location.hash.replace(/\/settings.*$/, '/node-admin'); });
  await expect(page.getByText(/Only node admins and node owners/)).toBeVisible();
});

test('node-owner controls fit a narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${harness}?space=member`);
  await page.getByRole('button', { name: 'Node admin', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Node administration sections' })).toBeVisible();
  const bounds = await page.locator('.node-admin').boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  await page.screenshot({ path: testInfo.outputPath('node-admin-mobile.png') });
});
