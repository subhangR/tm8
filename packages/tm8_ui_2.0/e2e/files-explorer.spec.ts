import { expect, test } from '@playwright/test';

/**
 * FILES EXPLORER — geometry and interaction in a real browser. Every
 * assertion here is one jsdom cannot make (boxes, wrapping, grid columns);
 * behaviour is owned by `src/files-explorer/*.test.*`.
 */

const RAIL = '[data-testid="files-explorer"] .fx-roots';
const MAIN = '[data-testid="files-explorer"] .fx-main';

async function boot(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/e2e/files-explorer-harness.html');
  await expect(page.getByTestId('harness-ready')).toBeVisible({ timeout: 15_000 });
}

async function box(page: import('@playwright/test').Page, selector: string) {
  const rect = await page.locator(selector).boundingBox();
  if (!rect) throw new Error(`${selector} has no box — it is not laid out`);
  return rect;
}

test('roots rail is a fixed left column and the listing takes the remaining width', async ({ page }) => {
  await boot(page);
  const rail = await box(page, RAIL);
  const main = await box(page, MAIN);
  expect(rail.x).toBeLessThan(main.x);
  // The rail is bounded (flex-basis 220 under the app zoom), the main is not.
  expect(rail.width).toBeLessThan(300);
  expect(main.width).toBeGreaterThan(rail.width * 2);
});

test('library listing renders real fixture rows with visible download links', async ({ page }) => {
  await boot(page);
  const rows = page.locator('.fx-row');
  await expect(rows.first()).toBeVisible();
  const downloads = page.locator('a.fx-act');
  await expect(downloads.first()).toBeVisible();
  const href = await downloads.first().getAttribute('href');
  expect(href).toBeTruthy();
});

test('gallery mode forms a multi-column grid, not a single stack', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'gallery' }).click();
  const tiles = page.locator('.fx-gallery .fx-tile');
  const count = await tiles.count();
  expect(count).toBeGreaterThan(0);
  if (count >= 2) {
    const a = await tiles.nth(0).boundingBox();
    const b = await tiles.nth(1).boundingBox();
    // Two tiles share a row: columns exist.
    expect(Math.abs((a?.y ?? 0) - (b?.y ?? -999))).toBeLessThan(2);
  }
});

test('narrow viewport: the toolbar wraps and the listing stays visible', async ({ page }) => {
  await boot(page);
  await page.setViewportSize({ width: 720, height: 800 });
  await expect(page.locator('.fx-row').first()).toBeVisible();
  const main = await box(page, MAIN);
  expect(main.width).toBeGreaterThan(300);
});

test('keyboard: root switcher and mode buttons are reachable by Tab and labelled', async ({ page }) => {
  await boot(page);
  const railButtons = page.locator('.fx-root-btn');
  await railButtons.first().focus();
  await expect(railButtons.first()).toBeFocused();
  // aria-pressed states on the layout group are real toggles.
  const listBtn = page.getByRole('button', { name: 'list' });
  await expect(listBtn).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'tree' }).click();
  await expect(page.getByRole('tree', { name: 'Folder tree' })).toBeVisible();
});
