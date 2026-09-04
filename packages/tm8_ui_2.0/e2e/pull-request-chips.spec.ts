import { expect, test, type Locator } from '@playwright/test';

const SURFACES = ['list', 'board', 'detail'] as const;

function chips(surface: Locator): Locator {
  return surface.getByTestId('linked-pr-chips');
}

async function expectStates(surface: Locator, expected: readonly string[]) {
  const root = chips(surface);
  await expect(root).toBeVisible();
  await expect(root.getByText('PR #42')).toBeVisible();
  await expect(root.getByTestId('pr-state-chip')).toHaveCount(expected.length);
  for (const state of expected) {
    await expect(root.locator(`[data-pr-state="${state}"]`)).toBeVisible();
  }
}

test('task tile, board card, and detail flip with observer-stored PR facts', async ({ page }) => {
  await page.setViewportSize({ width: 1540, height: 900 });
  await page.goto('/e2e/pull-request-chips-harness.html');

  for (const name of SURFACES) {
    await expectStates(page.getByTestId(`surface-${name}`), ['draft', 'ci-green']);
  }

  // Only the normalized PR entity changes; the tracks edge still carries its
  // draft endpoint snapshot. All three shipping surfaces must follow the
  // observer-updated entity facts, not that stale snapshot.
  await page.getByTestId('store-conflict').click();
  for (const name of SURFACES) {
    const surface = page.getByTestId(`surface-${name}`);
    await expectStates(surface, ['open', 'conflict', 'ci-red']);
    await expect(chips(surface).locator('[data-pr-state="draft"]')).toHaveCount(0);
    await expect(chips(surface).locator('[data-pr-state="ci-green"]')).toHaveCount(0);
  }

  // Unknown/null observer conclusions are not success. Lifecycle still flips,
  // while conflict and CI chips disappear because the node made no such claim.
  await page.getByTestId('store-closed').click();
  for (const name of SURFACES) {
    const surface = page.getByTestId(`surface-${name}`);
    await expectStates(surface, ['closed']);
    await expect(chips(surface).locator('[data-pr-state="conflict"]')).toHaveCount(0);
    await expect(chips(surface).locator('[data-pr-state^="ci-"]')).toHaveCount(0);
  }

  await page.getByTestId('store-merged').click();
  for (const name of SURFACES) {
    const surface = page.getByTestId(`surface-${name}`);
    await expectStates(surface, ['merged', 'ci-green']);
    await expect(chips(surface).locator('[data-pr-state="conflict"]')).toHaveCount(0);
    await expect(chips(surface).locator('[data-pr-state="ci-red"]')).toHaveCount(0);
  }
});
