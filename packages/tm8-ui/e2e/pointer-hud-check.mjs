/** Real shared scene and DOM actions; run unchanged against the bd7 baseline as well. */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const url = process.env.POINTER_HUD_URL ?? 'http://127.0.0.1:18543/e2e/pointer-hud.html';
const dir = process.env.POINTER_HUD_EVIDENCE ?? '/tmp/pointer-hud-evidence';
if (!process.env.POINTER_HUD_SOURCE_HEAD) throw new Error('Expected immutable bundle source SHA is required');
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true, timeout: 15_000,
  ...(process.env.POINTER_HUD_CHROMIUM ? { executablePath: process.env.POINTER_HUD_CHROMIUM } : {}),
  args: ['--no-sandbox', '--no-zygote', '--single-process', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const deadline = setTimeout(() => { void browser.close(); }, 90_000);
const report = { sourceHead: process.env.POINTER_HUD_SOURCE_HEAD, startedAt: new Date().toISOString(),
  viewport: { width: 800, height: 600 }, software: true, passed: false, checks: [], errors: [] };
try {
  const page = await browser.newPage({ viewport: report.viewport, reducedMotion: 'reduce' });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(url);
  expect(await page.evaluate(() => window.__pointerHud.sourceHead)).toBe(report.sourceHead);
  const host = page.getByTestId('walking-map'), places = host.locator('details.walking-places');
  const minimap = host.getByTestId('story-game-minimap'), canvas = minimap.locator('canvas');
  const rootId = 'map:space:pointer-space:hub', storyId = 'map:story:pointer-story-15:hub';
  await expect(host).toHaveAttribute('data-renderer', 'webgl');
  await expect.poll(() => host.locator('.ms-label').evaluateAll(nodes => nodes.some(node => {
    const parent = node.parentElement; return parent.style.transform && parent.style.display !== 'none' && node.getBoundingClientRect().width > 0;
  }))).toBe(true);
  await places.locator('summary').click();
  await expect(minimap).toHaveAttribute('data-open', 'true');
  const expectedRows = await page.evaluate(() => window.__pointerHud.places);
  for (const row of expectedRows) {
    const button = places.getByRole('button', { name: `${row.type} ${row.title}`, exact: true });
    await button.scrollIntoViewIfNeeded();
    const hit = await button.evaluate(node => {
      const r = node.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { matches: top === node, interceptedBy: top?.className, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
    });
    report.checks.push({ action: 'Places button center hit test', row, hit });
    expect(hit.matches, `${row.type} ${row.title} must receive the pointer`).toBe(true);
    const count = await page.evaluate(() => window.__pointerHud.actions.length);
    await button.click();
    await expect.poll(() => page.evaluate(() => window.__pointerHud.actions.length)).toBe(count + 1);
    expect(await page.evaluate(() => window.__pointerHud.actions.at(-1))).toEqual({ type: row.type, id: row.id });
    await expect(host).toHaveAttribute('data-map-id', rootId);
  }
  const measure = () => page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return { host: rect('.walking-map'), tools: rect('.walking-map-tools'), places: rect('.walking-places'),
      minimap: rect('.sgm-minimap'), canvas: rect('.sgm-minimap__canvas'), summary: rect('.walking-places summary'),
      pointerEvents: getComputedStyle(document.querySelector('.walking-map-tools')).pointerEvents };
  });
  for (const regime of [
    { name: 'wide', viewport: 800, container: '100%', size: 180, bottom: 74, top: 12 },
    { name: 'compact container', viewport: 800, container: '650px', size: 120, bottom: 136, top: 12 },
    { name: 'compact viewport', viewport: 560, container: '100%', size: 120, bottom: 136, top: 54 },
  ]) {
    await page.setViewportSize({ width: regime.viewport, height: 600 });
    await page.locator('#root').evaluate((node, width) => { node.style.width = width; }, regime.container);
    const rects = await measure();
    expect(rects.pointerEvents).toBe('none');
    expect(rects.places.y + rects.places.height).toBeLessThanOrEqual(rects.minimap.y);
    expect(rects.places.height).toBeGreaterThan(rects.summary.height + 32);
    expect(rects.canvas.width).toBe(regime.size); expect(rects.canvas.height).toBe(regime.size);
    expect(Math.abs(rects.host.y + rects.host.height - rects.tools.y - rects.tools.height - regime.bottom)).toBeLessThan(2);
    expect(rects.tools.y - rects.host.y).toBe(regime.top);
    const button = places.getByRole('button', { name: 'Enter Pointer mountain story', exact: true });
    await button.scrollIntoViewIfNeeded();
    expect(await button.evaluate(node => { const r = node.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === node; })).toBe(true);
    const count = await page.evaluate(() => window.__pointerHud.actions.length);
    await button.click();
    await expect.poll(() => page.evaluate(() => window.__pointerHud.actions.length)).toBe(count + 1);
    report.checks.push({ action: 'responsive HUD geometry and pointer', regime, rects });
    await page.screenshot({ path: `${dir}/${regime.name.replaceAll(' ', '-')}.png` });
  }
  await page.setViewportSize({ width: 800, height: 600 });
  await page.locator('#root').evaluate(node => { node.style.width = '100%'; });
  const open = await measure();
  await minimap.getByRole('button').click();
  await expect(minimap).toHaveAttribute('data-open', 'false'); await expect(canvas).toBeHidden();
  const collapsed = await measure();
  expect(collapsed.places.height).toBeGreaterThan(open.places.height + 100);
  await minimap.getByRole('button').click();
  await expect(minimap).toHaveAttribute('data-open', 'true'); await expect(canvas).toBeVisible();
  report.checks.push({ action: 'minimap collapse frees Places space and reopens', open, collapsed });
  await page.evaluate(() => { window.__pointerHud.navigate = true; });
  const button = places.getByRole('button', { name: 'Enter Pointer mountain story', exact: true });
  await button.scrollIntoViewIfNeeded(); await button.click();
  await expect(host).toHaveAttribute('data-map-id', storyId);
  report.checks.push({ action: 'real pointer story navigation' });
  const back = () => host.getByRole('button', { name: 'Back Esc', exact: true }).click();
  await back(); await expect(host).toHaveAttribute('data-map-id', rootId);
  await places.locator('summary').click();
  await places.getByRole('button', { name: 'Pointer mountain story', exact: true }).click();
  await expect(host.getByRole('region', { name: 'Nearby place' })).toContainText('Pointer mountain story');
  await host.focus(); await page.keyboard.press('e');
  await expect(host).toHaveAttribute('data-map-id', storyId);
  report.checks.push({ action: 'keyboard E nearby story entry' });
  await back(); await expect(host).toHaveAttribute('data-map-id', rootId);
  // The new root must actually report its initial pose, rather than reuse an old sample.
  await expect.poll(() => page.evaluate(root => {
    const state = window.__pointerHud, p = state.positions.at(-1);
    return p?.mapId === root && Math.hypot(p.x - state.start.x, p.z - state.start.z) < .01;
  }, rootId)).toBe(true);
  const before = await page.evaluate(() => ({ entered: window.__pointerHud.entered.length,
    position: window.__pointerHud.positions.at(-1), pixel: window.__pointerHud.minimapPixel, target: window.__pointerHud.target }));
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + before.pixel[0] * box.width / 180, box.y + before.pixel[1] * box.height / 180);
  await expect.poll(() => page.evaluate(initial => {
    const p = window.__pointerHud.positions.at(-1); return p ? Math.hypot(p.x - initial.x, p.z - initial.z) : 0;
  }, before.position)).toBeGreaterThan(.5);
  const after = await page.evaluate(() => ({ entered: window.__pointerHud.entered.length, position: window.__pointerHud.positions.at(-1) }));
  expect(after.entered).toBe(before.entered);
  const distance = p => Math.hypot(p.x - before.target.x, p.z - before.target.z);
  expect(distance(after.position)).toBeLessThan(distance(before.position) - .2);
  report.checks.push({ action: 'actual minimap click moves pose toward target without entering', before, after });
  // Near is cleared while waypoints remain: wait for arrival before testing a new ground click.
  await expect(host.getByRole('region', { name: 'Nearby place' })).toContainText('Pointer mountain story');
  const gap = await page.evaluate(() => {
    const r = document.querySelector('.walking-map-tools').getBoundingClientRect();
    const point = { x: r.x - 24, y: r.y + r.height / 2 }, hit = document.elementFromPoint(point.x, point.y);
    return { ...point, canvasHit: hit instanceof HTMLCanvasElement && Boolean(hit.closest('.sgm-stage')),
      position: window.__pointerHud.positions.at(-1) };
  });
  expect(gap.canvasHit).toBe(true);
  await page.mouse.click(gap.x, gap.y);
  await expect.poll(() => page.evaluate(initial => {
    const p = window.__pointerHud.positions.at(-1); return p ? Math.hypot(p.x - initial.x, p.z - initial.z) : 0;
  }, gap.position)).toBeGreaterThan(.5);
  report.checks.push({ action: 'unshielded scene pointer travel beside HUD column', gap,
    after: await page.evaluate(() => window.__pointerHud.positions.at(-1)) });
  await page.screenshot({ path: `${dir}/after-scene-travel.png` });
  expect(report.errors).toEqual([]);
  report.passed = true;
} catch (error) {
  report.failure = String(error); throw error;
} finally {
  clearTimeout(deadline); await browser.close();
  report.closedAt = new Date().toISOString(); report.browserClosed = true;
  await writeFile(`${dir}/checks.json`, JSON.stringify(report, null, 2));
}
