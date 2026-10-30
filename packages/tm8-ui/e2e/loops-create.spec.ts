import { expect, test } from '@playwright/test';

/*
 * A human creates a loop in the UI (design 01a182d4 §6): New loop, a name,
 * the teammate picker, a preset, a timezone, the server's preview, Create;
 * the row lands in the list; its page fires it with Run now and the run shows
 * in RUNS. Run with `bunx playwright test -c e2e/loops-create.config.ts`
 * (under the node's heavy lock).
 */
test('create a loop with the pickers and the preview, then fire it from its page', async ({ page }, info) => {
  await page.goto('/e2e/loops-create-harness.html');
  await expect(page.getByTestId('loops-empty')).toContainText('No loops yet');

  await page.getByTestId('loop-new').click();
  const form = page.getByRole('dialog', { name: 'New loop' });
  await expect(form).toBeVisible();
  await form.getByLabel('Name').fill('Morning triage');

  // The teammate is a picker, never a typed id.
  await form.getByTestId('loop-teammate').click();
  await page.getByTestId(`loop-teammate-019fe999-0000-7000-8000-00000000a001`).click();
  await expect(form.getByTestId('loop-teammate')).toContainText('Ada');

  // Weekdays at 09:00, London time: the preview is the server's answer.
  await form.getByTestId('loop-preset').selectOption('weekdays');
  await form.getByLabel('Time').fill('09:00');
  await form.getByLabel('Timezone').selectOption('Europe/London');
  await expect(form.getByTestId('loop-schedule-summary')).toHaveText('Weekdays at 09:00 Europe/London');
  await expect(form.getByRole('list', { name: 'Next runs' }).getByRole('listitem')).toHaveCount(3);
  await page.screenshot({ path: info.outputPath('loops-create-form.png'), fullPage: true });

  await form.getByRole('button', { name: 'Create loop' }).click();
  await expect(form).toBeHidden();

  // The new row: the server's schedule words, the teammate, the Enabled switch on.
  const row = page.locator('[data-testid^="loop-row-"]').first();
  await expect(row).toContainText('Morning triage');
  await expect(row).toContainText('Ada');
  await expect(row.getByRole('switch', { name: 'Disable Morning triage' })).toHaveAttribute('aria-checked', 'true');

  // Creating opened its page: Run now fires it, and the run shows in RUNS.
  const loopPage = page.getByTestId('harness-loop-page');
  await expect(loopPage.getByTestId('loop-header')).toBeVisible();
  await loopPage.getByRole('button', { name: 'Run now' }).click();
  await expect(loopPage.getByTestId('loop-run-started')).toContainText('Run started');
  await expect(loopPage.getByTestId('loop-run-row')).toHaveCount(1);
  await expect(loopPage.getByTestId('loop-run-row')).toHaveAttribute('data-status', 'running');
  await page.screenshot({ path: info.outputPath('loops-create-page.png'), fullPage: true });
});
