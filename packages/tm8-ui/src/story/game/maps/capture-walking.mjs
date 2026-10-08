/** Synthetic renderer evidence: WALKING_URL and BASELINE_URL can target isolated builds. */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const out = resolve(process.argv[2] ?? 'walking-evidence');
await mkdir(out, { recursive: true });
const url = process.env.WALKING_URL ?? 'http://127.0.0.1:4627/src/story/game/maps/walking-dev.html';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--no-zygote', '--single-process', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
const errors = [], failures = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('requestfailed', r => failures.push({ url: r.url(), error: r.failure()?.errorText }));
page.on('response', r => { if (r.status() >= 400) failures.push({ url: r.url(), status: r.status() }); });
const state = () => page.locator('#verification-state').evaluate(e => ({ position: JSON.parse(e.dataset.position), camera: e.dataset.camera ? JSON.parse(e.dataset.camera) : null, action: e.dataset.action }));
async function open(map) {
  await page.goto(`${url}?map=${map}`);
  await expect(page.getByTestId('walking-map')).toHaveAttribute('data-renderer', 'webgl');
  await page.waitForFunction(() => document.querySelector('#verification-state')?.getAttribute('data-camera'));
  await page.addStyleTag({ content: '#verification-state,#verification-unmount{visibility:hidden}' });
}
for (const map of ['hub', 'taskland', 'office', 'library', 'factory', 'town']) {
  await open(map);
  await page.getByRole('button', { name: /^Map overview/ }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/walking-${map}.png` });
  checks.push({ map, renderer: 'webgl', ...await state() });
}
await open('hub');
await page.locator('.walking-places').evaluate(e => e.open = true);
await page.getByTitle('Walk to Taskland').click();
await expect(page.getByRole('region', { name: 'Nearby place' })).toContainText('Taskland', { timeout: 20000 });
expect((await state()).action).toBe('');
await page.screenshot({ path: `${out}/hub-portal-approach.png` });
await page.getByRole('region', { name: 'Nearby place' }).getByRole('button', { name: /Enter/ }).click();
expect((await state()).action).toBe('portal:portal:story:demo-story:taskland');
checks.push({ check: 'portal needs explicit Enter', passed: true });
await open('taskland');
await page.locator('.walking-places').evaluate(e => e.open = true);
await page.getByTitle('Walk to Build the harbour').click();
await expect(page.getByRole('region', { name: 'Nearby place' })).toContainText('Build the harbour', { timeout: 20000 });
await page.getByRole('region', { name: 'Nearby place' }).getByRole('button', { name: /Inspect/ }).click();
expect((await state()).action).toBe('inspect:task-foundation');
await page.screenshot({ path: `${out}/taskland-inspection.png` });
await page.getByTestId('walking-map').focus();
await page.keyboard.down('d'); await page.waitForTimeout(450); await page.keyboard.up('d');
await page.mouse.move(600, 450); await page.mouse.wheel(0, -100); await page.waitForTimeout(1200);
const beforeFlush = await state();
await page.keyboard.down('s'); await page.waitForTimeout(200);
await page.evaluate(() => document.getElementById('verification-unmount').click());
await page.keyboard.up('s');
const flushed = await state();
expect(flushed.position.z).toBeGreaterThan(beforeFlush.position.z);
checks.push({ check: 'final movement/camera flush', beforeFlush, flushed });
await page.goto(`${url}?map=taskland&resume=${encodeURIComponent(JSON.stringify({ start: flushed.position, camera: flushed.camera }))}`);
await page.waitForFunction(() => document.querySelector('#verification-state')?.getAttribute('data-camera'));
await page.waitForTimeout(1200);
const restored = await state();
expect(restored.position).toEqual(flushed.position);
expect(restored.camera).toEqual(flushed.camera);
await page.addStyleTag({ content: '#verification-state,#verification-unmount{visibility:hidden}' });
await page.screenshot({ path: `${out}/taskland-restored-camera.png` });
checks.push({ check: 'exact mount camera/position restore survives save rerenders', restored });
// Context loss must expose the same typed entity IDs in accessible controls.
await page.locator('.sgm-stage canvas').evaluate(canvas => canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })));
await expect(page.getByTestId('walking-map')).toHaveAttribute('data-renderer', 'dom');
await page.getByRole('button', { name: 'Inspect Build the harbour', exact: true }).click();
expect((await state()).action).toBe('inspect:task-foundation');
await page.screenshot({ path: `${out}/typed-dom-fallback.png` });
checks.push({ check: 'context-loss DOM fallback inspection', passed: true });
await page.goto(`${url}?view=story`);
await page.locator('.sgm-stage canvas').waitFor();
await page.getByRole('button', { name: /^Map overview/ }).click();
await page.waitForTimeout(4000);
await page.addStyleTag({ content: '#verification-state,#verification-unmount{display:none}' });
await page.screenshot({ path: `${out}/story-map-model.png` });
checks.push({ check: 'retained story rendered through MapRenderer', passed: true });
if (process.env.BASELINE_URL) {
  await page.goto(process.env.BASELINE_URL);
  await page.locator('.sgm-stage canvas').waitFor();
  await page.getByRole('button', { name: /^Map overview/ }).click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/story-baseline.png` });
  checks.push({ check: 'main baseline screenshot for geometry comparison', passed: true });
}
await writeFile(`${out}/browser-results.json`, JSON.stringify({ capturedAt: new Date().toISOString(), browser: browser.version(), renderer: 'ANGLE SwiftShader; visual correctness only', errors, failures, checks }, null, 2));
await browser.close();
console.log(JSON.stringify({ out, errors, failures, checks: checks.map(c => c.check ?? c.map) }, null, 2));
if (errors.length || failures.length) process.exitCode = 1;
