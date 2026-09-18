import { test, expect, type Page } from '@playwright/test';
import type { Terminal } from '@xterm/xterm';

declare global {
  interface Window { term: Terminal; detach(): void; remount(): void }
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const line = (page: Page) => page.evaluate(() => window.term.buffer.active.viewportY);
async function swipe(page: Page, dx: number, dy: number) {
  const box = (await page.locator('.xterm-screen').boundingBox())!;
  const x = box.x + 100;
  const y = box.y + 150;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 10, y: y + dy * i / 10 }] });
    await page.waitForTimeout(20);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(500);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/terminal-touch.html');
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.term.buffer.active.baseY)).toBeGreaterThan(100);
});

test('real xterm scrollback moves both ways without a native scrollable viewport', async ({ page }) => {
  const legacy = await page.locator('.xterm-viewport').evaluate(v => ({ height: v.clientHeight, scrollHeight: v.scrollHeight }));
  expect(legacy.scrollHeight).toBe(legacy.height);
  const before = await line(page);
  await swipe(page, 0, 180);
  expect(await line(page)).toBeLessThan(before);
  const up = await line(page);
  await swipe(page, 0, -120);
  expect(await line(page)).toBeGreaterThan(up);
  console.log('touch scroll lines', { before, up, down: await line(page) });
});

test('horizontal gestures, teardown, remount, and alternate buffer', async ({ page }) => {
  await page.evaluate(() => window.term.scrollToLine(70));
  await swipe(page, 160, 0);
  expect(await line(page)).toBe(70);
  await page.evaluate(() => window.detach());
  await swipe(page, 0, 160);
  expect(await line(page)).toBe(70);
  await page.evaluate(() => window.remount());
  await swipe(page, 0, 160);
  expect(await line(page)).toBeLessThan(70);
  await page.evaluate(() => new Promise<void>(resolve => window.term.write('\x1b[?1049h', resolve)));
  await swipe(page, 0, 160);
  expect(await line(page)).toBe(0);
});

for (const width of [320, 390, 430]) {
  test(`session fills the phone at ${width}px and details restore without remounting`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const host = page.locator('#host');
    await expect(page.locator('.mobile-frame__header')).toBeHidden();
    await expect(page.locator('.mobile-frame__tabbar')).toBeHidden();
    await expect(page.locator('.pn-head')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Left arrow', exact: true })).toHaveCount(0);
    const fullHeight = (await host.boundingBox())!.height;
    expect(fullHeight).toBeGreaterThan(730);
    if (width === 390) await page.screenshot({ path: testInfo.outputPath('mobile-terminal.png') });
    expect((await page.locator('.term-mod').boundingBox())!.height).toBeLessThan(60);
    await page.evaluate(() => { (window.term as Terminal & { witness?: boolean }).witness = true; });
    await page.getByRole('button', { name: 'Show session details and navigation' }).click();
    await expect(page.locator('.mobile-frame__header')).toBeVisible();
    await expect(page.locator('.mobile-frame__tabbar')).toBeVisible();
    await expect(page.locator('.pn-head')).toBeVisible();
    expect((await host.boundingBox())!.height).toBeLessThan(fullHeight - 100);
    await page.getByRole('button', { name: 'Fill screen with session' }).click();
    expect(await page.evaluate(() => (window.term as Terminal & { witness?: boolean }).witness)).toBe(true);
    await page.getByRole('button', { name: /More terminal keys/ }).click();
    await expect(page.getByRole('button', { name: 'Left arrow', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /More terminal keys/ }).click();
    await page.getByRole('tab', { name: 'Transcript', exact: true }).click();
    await expect(page.locator('.mobile-frame__header')).toBeHidden();
    expect((await page.locator('.tr-surface__foot').boundingBox())!.height).toBeLessThan(65);
    if (width === 390) await page.screenshot({ path: testInfo.outputPath('mobile-transcript.png') });
    await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
    await expect(host).toBeVisible();
    await page.locator('.mobile-frame').evaluate(el => (el as HTMLElement).style.setProperty('--mobile-keyboard-inset', '300px'));
    await expect.poll(async () => (await host.boundingBox())!.height).toBeLessThan(fullHeight - 290);
    expect((await host.boundingBox())!.height).toBeGreaterThan(430);
    console.log('layout', { width, fullHeight, keyboardHeight: (await host.boundingBox())!.height });
  });
}
