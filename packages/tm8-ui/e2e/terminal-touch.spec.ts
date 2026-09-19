import { test, expect, type Page } from '@playwright/test';
import type { Terminal } from '@xterm/xterm';

declare global {
  interface Window { term: Terminal; detach(): void; remount(): void; inputs: { type: string; data: string }[]; setLive(live: boolean): void }
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
  await expect(page.locator('.xterm-screen')).toHaveCount(0);
  await page.evaluate(() => window.remount());
  await expect.poll(() => page.evaluate(() => window.term.buffer.active.baseY)).toBeGreaterThan(100);
  await page.evaluate(() => window.term.scrollToLine(70));
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
    await expect(page.getByRole('button', { name: 'Left arrow', exact: true })).toBeVisible();
    const controls = await page.locator('.term-mod__keys--controls button').evaluateAll(buttons => buttons.map(b => {
      const r = b.getBoundingClientRect(); return { y: r.y, right: r.right, left: r.left };
    }));
    expect(controls).toHaveLength(13);
    expect(new Set(controls.map(c => c.y)).size).toBe(1);
    expect(controls.every(c => c.left >= 0 && c.right <= width)).toBe(true);
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
    await page.getByRole('button', { name: /Terminal settings/ }).click();
    await expect(page.getByRole('button', { name: 'Left arrow', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Terminal settings/ }).click();
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

test('Claude mouse mode scrolls by touch and buttons through binary and SGR input', async ({ page }) => {
  await page.evaluate(() => new Promise<void>(resolve => window.term.write('\x1b[?1049h\x1b[?1003h', resolve)));
  expect(await page.evaluate(() => ({ type: window.term.buffer.active.type, baseY: window.term.buffer.active.baseY, mouse: window.term.modes.mouseTrackingMode })))
    .toEqual({ type: 'alternate', baseY: 0, mouse: 'any' });
  await page.evaluate(() => { window.inputs = []; });
  await swipe(page, 0, 120);
  expect(await page.evaluate(() => window.inputs.some(i => i.type === 'binary' && i.data.startsWith('\x1b[M`')))).toBe(true);
  await page.evaluate(() => { window.inputs = []; });
  await swipe(page, 0, -120);
  expect(await page.evaluate(() => window.inputs.some(i => i.type === 'binary' && i.data.startsWith('\x1b[Ma')))).toBe(true);
  for (const [label, prefix] of [['Scroll up', '\x1b[M`'], ['Scroll down', '\x1b[Ma']]) {
    await page.evaluate(() => { window.inputs = []; });
    await page.getByRole('button', { name: label, exact: true }).click();
    expect(await page.evaluate(prefix => window.inputs.some(i => i.type === 'binary' && i.data.startsWith(prefix)), prefix)).toBe(true);
  }
  await page.evaluate(() => new Promise<void>(resolve => window.term.write('\x1b[?1006h', resolve)));
  await page.getByRole('button', { name: 'Control', exact: true }).click();
  await page.evaluate(() => { window.inputs = []; });
  await page.getByRole('button', { name: 'Scroll up', exact: true }).click();
  expect(await page.evaluate(() => window.inputs.some(i => i.type === 'text' && i.data.startsWith('\x1b[<64;')))).toBe(true);
  await expect(page.getByRole('button', { name: 'Control', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.setLive(false));
  await page.evaluate(() => { window.inputs = []; });
  await page.getByRole('button', { name: 'Scroll down', exact: true }).click();
  expect(await page.evaluate(() => window.inputs)).toEqual([]);
});

test('all bottom controls send keys, consume modifiers, scroll history, and open actions', async ({ page }) => {
  const last = () => page.evaluate(() => window.inputs.at(-1)?.data);
  for (const [name, data] of [['Escape', '\x1b'], ['Tab', '\t'], ['Left arrow', '\x1b[D'], ['Down arrow', '\x1b[B'], ['Up arrow', '\x1b[A'], ['Right arrow', '\x1b[C']]) {
    await page.getByRole('button', { name, exact: true }).click();
    expect(await last()).toBe(data);
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  }
  await page.getByRole('button', { name: 'Control', exact: true }).click();
  await page.keyboard.type('c');
  expect(await last()).toBe('\x03');
  await expect(page.getByRole('button', { name: 'Control', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Alt', exact: true }).click();
  await page.keyboard.type('b');
  expect(await last()).toBe('\x1bb');
  await expect(page.getByRole('button', { name: 'Alt', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Control', exact: true }).click();
  await page.getByRole('button', { name: 'Alt', exact: true }).click();
  await page.getByRole('button', { name: 'Left arrow', exact: true }).click();
  expect(await last()).toBe('\x1b[1;7D');
  await expect(page.getByRole('button', { name: 'Control', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Alt', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => new Promise<void>(resolve => window.term.write('\x1b[?1h', resolve)));
  await page.getByRole('button', { name: 'Up arrow', exact: true }).click();
  expect(await last()).toBe('\x1bOA');
  const before = await line(page);
  await page.getByRole('button', { name: 'Scroll up', exact: true }).click();
  expect(await line(page)).toBeLessThan(before);
  await page.getByRole('button', { name: 'Scroll down', exact: true }).click();
  expect(await line(page)).toBe(before);
  await page.getByRole('button', { name: 'Exit terminal focus', exact: true }).click();
  await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused();
  await page.getByRole('button', { name: /Terminal settings/ }).click();
  await page.getByRole('button', { name: /Smaller text/ }).click();
  await expect.poll(() => page.evaluate(() => window.term.options.fontSize)).toBe(12);
  await page.getByRole('button', { name: /Larger text/ }).click();
  await expect.poll(() => page.evaluate(() => window.term.options.fontSize)).toBe(13);
  await page.getByRole('button', { name: /Terminal settings/ }).click();
  await expect(page.locator('.term-mod__actions .efab__trigger')).toBeVisible();
  await page.getByRole('button', { name: 'Session actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Session details', exact: true }).click();
  expect(await last()).toBe('details');
  await page.getByRole('tab', { name: 'Transcript', exact: true }).click();
  await expect(page.locator('.efab > .efab__trigger')).toBeVisible();
  await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.term-mod__actions .efab__trigger')).toBeVisible();
  await page.evaluate(() => window.setLive(false));
  for (const name of ['Control', 'Alt', 'Escape', 'Tab', 'Left arrow', 'Down arrow', 'Up arrow', 'Right arrow']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  }
  const readOnlyBefore = await line(page);
  await page.getByRole('button', { name: 'Scroll up', exact: true }).click();
  expect(await line(page)).toBeLessThan(readOnlyBefore);
});
