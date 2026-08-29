import { expect, test } from '@playwright/test';

test('five task actions stay clear of the ellipsised title at desktop breakpoints', async ({ page }) => {
  await page.goto('/e2e/cluster-harness.html');

  const column = page.locator('.harness-col').first();
  const panel = column.locator('.harness-panel');
  const tile = panel.locator('.pn-tt').first();
  const title = tile.locator('.pn-tt__title');
  const actions = tile.locator('.pn-tt__actions');

  await tile.hover();
  await expect(actions).toBeVisible();
  await expect(actions.locator(':scope > *')).toHaveCount(5);

  for (const width of [500, 280]) {
    await panel.evaluate((node, nextWidth) => {
      node.style.width = `${nextWidth}px`;
    }, width);

    await expect.poll(async () => {
      const [titleBox, actionBox] = await Promise.all([
        title.boundingBox(),
        actions.boundingBox(),
      ]);
      if (!titleBox || !actionBox) return false;
      return titleBox.x + titleBox.width <= actionBox.x + 0.5;
    }).toBe(true);
  }
});
