import { expect, test, type Page } from '@playwright/test';

const PANEL = '[data-testid="harness-panel"] .pn-panel';

test.setTimeout(60_000);

async function boot(page: Page, query = 'width=720') {
  await page.goto(`/e2e/task-detail-premium-harness.html?${query}`);
  await expect(page.locator(PANEL)).toBeVisible({ timeout: 15_000 });
}

async function expectContained(page: Page) {
  const overflow = await page.locator(PANEL).evaluate((panel) => ({
    panel: panel.scrollWidth - panel.clientWidth,
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(overflow.panel).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
}

test('complete task content has premium hierarchy and honest run states', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1120, height: 900 });
  await boot(page);

  await expect(page.getByTestId('panel-header')).toContainText(/4f8c2a9e/i);
  await expect(page.locator('#tab-content')).toHaveAttribute('aria-selected', 'true');
  const discussionTabFits = await page.locator('#tab-discussion').evaluate(
    (tab) => tab.clientWidth >= tab.scrollWidth,
  );
  expect(discussionTabFits).toBe(true);
  const controls = page.getByRole('group', { name: 'Controls' });
  await expect(controls.getByTestId('row-number-input')).toHaveAttribute('placeholder', 'points');
  await expect(controls.getByTestId('row-date-input')).toHaveCount(2);
  const pointsBox = await controls.getByTestId('row-number-input').boundingBox();
  expect(pointsBox?.width ?? 0).toBeGreaterThanOrEqual(90);
  const strip = await controls.locator('.lp__rowdetail--chips').evaluate((node) => ({
    flexWrap: getComputedStyle(node).flexWrap,
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(strip.flexWrap).toBe('nowrap');
  expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);

  const unavailableSave = page.getByRole('button', { name: 'Save' });
  await expect(unavailableSave).toHaveAttribute('aria-disabled', 'true');
  await expect(unavailableSave).toHaveCSS('opacity', '1');
  const saveReasonId = await unavailableSave.getAttribute('aria-describedby');
  expect(saveReasonId).toBeTruthy();
  await expect(page.locator(`[id="${saveReasonId}"]`)).toContainText(/Saving is not wired here/i);
  await expect(page.getByTestId('attachment-add')).toBeVisible();
  await expect(page.getByTestId('acceptance-progress')).toHaveAttribute('data-state', 'in-progress');
  await expect(page.getByTestId('acceptance-progress').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  await expect(page.getByTestId('live-session-section')).toContainText('Live now');
  await expect(page.getByTestId('run-history-section')).toContainText('History');
  await expect(page.getByTestId('run-unresolved-section')).toContainText('Liveness unresolved');

  const alignment = await page.locator('.sb-grid__cell').first().evaluate((cell) => {
    const prose = document.querySelector<HTMLElement>('.sb-description .pn-prose');
    const root = document.querySelector<HTMLElement>('.cv2-root');
    if (!prose || !root) throw new Error('task reading anatomy is incomplete');
    const uiFamily = getComputedStyle(root).getPropertyValue('--pn-ui').split(',')[0]?.replace(/["']/g, '').trim();
    return {
      delta: Math.abs(cell.getBoundingClientRect().x - prose.getBoundingClientRect().x),
      proseUsesUi: uiFamily ? getComputedStyle(prose).fontFamily.includes(uiFamily) : false,
    };
  });
  expect(alignment.delta).toBeLessThanOrEqual(1);
  expect(alignment.proseUsesUi).toBe(true);
  await expectContained(page);

  await testInfo.attach('task-detail-light-desktop', {
    body: await page.locator('[data-testid="harness-panel"]').screenshot(),
    contentType: 'image/png',
  });
});

test('narrow desktop and phone-width dark surfaces stay contained', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 595, height: 900 });
  await boot(page, 'width=560');
  await expectContained(page);
  await expect(page.getByTestId('acceptance-progress')).toBeVisible();

  /* Browser zoom reduces the effective inline-size without changing the
     viewport contract. Keep this distinct from the phone-width assertion so
     a viewport-unit regression cannot hide behind one passing breakpoint. */
  await page.goto('/e2e/task-detail-premium-harness.html?width=440');
  await page.locator(PANEL).waitFor();
  await page.evaluate(() => document.documentElement.style.setProperty('zoom', '1.25'));
  await expectContained(page);

  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto('/e2e/task-detail-premium-harness.html?width=390&theme=dark');
  await expect(page.locator(PANEL)).toBeVisible();
  await expectContained(page);
  await expect(page.getByRole('button', { name: /Attach a file/i })).toBeVisible();

  await testInfo.attach('task-detail-dark-390', {
    body: await page.locator('[data-testid="harness-panel"]').screenshot(),
    contentType: 'image/png',
  });
});

test('Discussion keeps real history, activity and composer in one surface', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 860, height: 900 });
  await boot(page, 'width=680&theme=dark');
  await page.getByRole('tab', { name: /Discussion/i }).click();

  const discussion = page.getByTestId('task-discussion');
  await expect(discussion).toBeVisible();
  await expect(discussion.getByText(/The crash is reproducible/i)).toBeVisible();
  await expect(discussion.getByText(/Work status/i)).toBeVisible();
  const composer = discussion.getByRole('textbox');
  await expect(composer).toBeVisible();
  await composer.fill('Review note from browser evidence');
  await expect(composer).toHaveValue('Review note from browser evidence');
  await expectContained(page);

  await testInfo.attach('task-detail-discussion-dark', {
    body: await page.locator('[data-testid="harness-panel"]').screenshot(),
    contentType: 'image/png',
  });
});

test('reduced motion, forced colors and keyboard focus remain explicit', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce', forcedColors: 'active' });
  await page.setViewportSize({ width: 700, height: 900 });
  await boot(page, 'width=640&theme=dark');

  const body = page.locator('[data-testid="subtree-body"]');
  const motion = await body.evaluate((node) => {
    const style = getComputedStyle(node);
    return { animationDuration: style.animationDuration, transitionDuration: style.transitionDuration };
  });
  expect(['0s', '0.01ms']).toContain(motion.animationDuration);

  await page.keyboard.press('Tab');
  const focus = await page.locator(':focus').evaluate((node) => {
    const style = getComputedStyle(node);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(focus.style).not.toBe('none');
  expect(Number.parseFloat(focus.width)).toBeGreaterThanOrEqual(2);
  await expectContained(page);
});
