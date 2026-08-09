import { expect, test } from '@playwright/test';

/**
 * THE DIFF RENDERER'S LAYOUT PROOFS — the two claims jsdom cannot make.
 *
 * The vitest suite already owns the cap ARITHMETIC. What is only decidable in
 * a real layout engine is whether the cap bounds the rendered HEIGHT, and
 * whether a line longer than the panel scrolls inside its own box instead of
 * dragging the page sideways.
 */

test.describe.configure({ mode: 'serial' });

test('a 4,000-line file renders capped, short, and honest about the remainder', async ({
  page,
}) => {
  await page.goto('/e2e/diff-harness.html');

  const capped = page.getByTestId('panel-capped');
  const rows = capped.locator('.kit-diff__row');

  // 200 rows of budget, one of which the hunk header spends.
  await expect(rows).toHaveCount(199);

  const more = capped.getByTestId('kit-diff-more');
  await expect(more).toBeVisible();
  // 4,001 rows (one hunk header + 4,000 lines) less the 200 shown.
  await expect(more).toHaveText('Show 3,801 more lines');

  // THE HEIGHT CLAIM. ~199 rows at ~19px is well under 6,000px; the uncapped
  // 4,001 rows would be ~76,000px. A cap that bounds a counter but not the
  // page is not a cap.
  const box = await capped.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThan(6_000);

  // And nothing is HIDDEN: pressing the expander produces the whole file.
  await more.click();
  await expect(rows).toHaveCount(4_000);
  await expect(capped.getByTestId('kit-diff-more')).toHaveCount(0);
});

test('a 600-character line scrolls inside its file box, not across the panel', async ({ page }) => {
  await page.goto('/e2e/diff-harness.html');

  const panel = page.getByTestId('panel-wide');
  const body = panel.locator('.kit-diff__body');
  const file = panel.locator('.kit-diff__file');

  // The line really is wider than the panel — otherwise this proves nothing.
  const overflow = await body.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth + 100);

  // Yet the file box itself stays inside the 460px panel...
  const panelBox = (await panel.boundingBox())!;
  const fileBox = (await file.boundingBox())!;
  expect(fileBox.width).toBeLessThanOrEqual(panelBox.width);

  // ...and the document does not scroll sideways, which is the failure mode
  // this package ships when a padded box forgets its box-sizing.
  const docOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(docOverflow).toBeLessThanOrEqual(0);
});

test('a review-sized diff shows every file, its counts and its hunk headers', async ({ page }) => {
  await page.goto('/e2e/diff-harness.html');

  const sample = page.getByTestId('panel-sample');
  await expect(sample.getByTestId('kit-diff-summary')).toContainText('5 files changed');
  await expect(sample.getByTestId('kit-diff-file')).toHaveCount(5);
  await expect(sample.locator('.kit-diff__hunk').first()).toContainText('@@ -12,7 +12,11 @@');
  // No expander: a diff this size is under both ceilings.
  await expect(sample.getByTestId('kit-diff-more')).toHaveCount(0);
});
