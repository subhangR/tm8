import { expect, test, type Locator, type Page } from '@playwright/test';
const popover = (page: Page) => page.getByTestId('pending-forms-popover');
const scroller = (page: Page) => popover(page).locator('.pf-banner__list');
const submit = (page: Page) => popover(page).getByRole('button', { name: 'Submit', exact: true });
async function open(page: Page) {
  await page.goto('/e2e/attention-scroll-harness.html');
  await page.getByTestId('pending-forms-chip').click();
  await expect(popover(page)).toBeFocused();
  await popover(page).getByRole('button', { name: 'Answer', exact: true }).click();
  await page.getByTestId('question-question_15').waitFor();
}
async function measurements(page: Page) {
  return page.locator('.pf-chip__pop, .pf-banner, .pf-banner__list').evaluateAll(elements => elements.map(el => ({
    className: el.className, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop, rect: el.getBoundingClientRect().toJSON(),
  })));
}
async function reachable(locator: Locator) {
  await expect(locator).toBeVisible();
  expect(await locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && !!hit && el.contains(hit);
  })).toBe(true);
}
for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 400 }, { width: 390, height: 420 }, { width: 320, height: 240 }]) {
  test(`wheel scrolls questions with reachable actions at ${viewport.width}×${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await open(page);
    const before = await measurements(page);
    const box = await popover(page).boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => scroller(page).evaluate(el => el.scrollTop)).toBeGreaterThan(100);
    await reachable(popover(page).getByRole('button', { name: 'Hide', exact: true }));
    await reachable(submit(page));
    await expect(popover(page).locator('.pf-banner__head')).toBeInViewport();
    await scroller(page).evaluate(el => { el.scrollTop = el.scrollHeight; });
    await reachable(page.getByTestId('question-question_15').getByRole('textbox'));
    await reachable(submit(page));
    const after = await measurements(page);
    expect(await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - innerWidth,
      y: document.documentElement.scrollHeight - innerHeight, scroll: window.scrollY,
    }))).toEqual({ x: 0, y: 0, scroll: 0 });
    await info.attach('layout', { body: JSON.stringify({ viewport, before, after }, null, 2), contentType: 'application/json' });
    await info.attach('scrolled-to-last-question', { body: await page.screenshot(), contentType: 'image/png' });
  });
}
test('keyboard reaches the last field, submits, discards an amendment, and Escape restores focus', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await open(page);
  const last = page.getByTestId('question-question_15').getByRole('textbox');
  // Real tab order exercises native focus scrolling without scrollIntoView.
  await popover(page).getByRole('button', { name: 'Hide', exact: true }).focus();
  for (let i = 0; i < 16; i++) await page.keyboard.press('Tab');
  await expect(last).toBeFocused();
  const lastFieldFocused = await last.evaluate(el => document.activeElement === el);
  await reachable(last);
  await last.fill('Reviewed');
  await page.keyboard.press('Tab');
  await expect(submit(page)).toBeFocused();
  const submitFocused = await submit(page).evaluate(el => document.activeElement === el);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Edit & resubmit' }).click();
  await page.setViewportSize({ width: 320, height: 240 });
  await reachable(page.getByRole('button', { name: 'Discard changes' }));
  await reachable(page.getByRole('button', { name: 'Resubmit', exact: true }));
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByRole('button', { name: 'Edit & resubmit' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expect(page.getByTestId('pending-forms-chip')).toBeFocused();
  await info.attach('focus-behavior', { body: JSON.stringify({ lastFieldFocused, submitFocused, restoredToTrigger: await page.getByTestId('pending-forms-chip').evaluate(el => document.activeElement === el), amendmentViewport: { width: 320, height: 240 } }), contentType: 'application/json' });
});
test('touch scrolling reaches lower questions within the narrow popover', async ({ browser, baseURL }, info) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 420 }, hasTouch: true });
  const page = await context.newPage();
  await open(page);
  const box = await scroller(page).boundingBox();
  const cdp = await context.newCDPSession(page);
  const x = box!.x + box!.width / 2, start = box!.y + box!.height * 0.75;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start - i * 15 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => scroller(page).evaluate(el => el.scrollTop)).toBeGreaterThan(40);
  await reachable(submit(page));
  await reachable(popover(page).getByRole('button', { name: 'Hide', exact: true }));
  await info.attach('touch-scroll', { body: JSON.stringify(await scroller(page).evaluate(el => ({ scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, pageScrollY: window.scrollY }))), contentType: 'application/json' });
  await context.close();
});

test('the inline banner keeps its own bounded scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 400 });
  await page.goto('/e2e/attention-scroll-harness.html?inline');
  await page.getByRole('button', { name: 'Answer', exact: true }).click();
  await page.getByTestId('question-question_15').waitFor();
  const banner = page.getByTestId('pending-forms-banner');
  expect(await banner.evaluate(el => getComputedStyle(el).maxHeight)).toBe('70%');
  await banner.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => banner.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await expect(page.getByText('Session content remains below the inline banner')).toBeInViewport();
  await expect(popover(page)).toHaveCount(0);
});
