/** Synthetic WebGL proof of explicit resume preservation and invalid-start repair. */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'resume-evidence');
await mkdir(out, { recursive: true });
const url = process.env.WALKING_URL ?? 'http://127.0.0.1:4627/src/story/game/maps/walking-dev.html';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--no-zygote', '--single-process', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
const errors = [], failures = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('requestfailed', r => failures.push({ url: r.url(), error: r.failure()?.errorText }));
page.on('response', r => { if (r.status() >= 400) failures.push({ url: r.url(), status: r.status() }); });
const state = () => page.locator('#verification-state').evaluate(e => ({ position: JSON.parse(e.dataset.position), camera: e.dataset.camera ? JSON.parse(e.dataset.camera) : null, saves: Number(e.dataset.saves) }));
async function open(resume) {
  await page.goto(`${url}?map=taskland${resume ? `&resume=${encodeURIComponent(JSON.stringify(resume))}` : ''}`);
  await expect(page.getByTestId('walking-map')).toHaveAttribute('data-renderer', 'webgl');
  await page.locator('.sgm-stage canvas').waitFor();
  // The initial attributes contain the inputs. Wait for real Player saves instead.
  await page.waitForFunction(() => Number(document.querySelector('#verification-state')?.getAttribute('data-saves')) >= 2, null, { timeout: 30000 });
  await page.addStyleTag({ content: '#verification-state,#verification-unmount{visibility:hidden}' });
}
try {
  await open();
  const geometry = await page.evaluate(async () => {
    const { buildMapModel, smallFixture } = await import('/src/story/game/map-model/index.ts');
    const { walkingEntrance } = await import('/src/story/game/map-model/walking-world.ts');
    const fixture = smallFixture(), model = buildMapModel(fixture, { type: 'taskland', scope: fixture.scope });
    const place = model.places[0];
    return { place: { x: place.x, z: place.z, radius: place.radius }, entrance: walkingEntrance(model) };
  });
  expect((await state()).position).toEqual(geometry.entrance);
  checks.push({ check: 'fresh typed map uses its clear conventional entrance', expected: geometry.entrance, actual: await state() });
  await page.screenshot({ path: `${out}/fresh-map-entrance.png` });
  for (const where of ['inside', 'near']) {
    const start = { x: geometry.place.x + (where === 'near' ? geometry.place.radius + 0.2 : 0), z: geometry.place.z };
    const camera = { zoom: 27, position: [start.x + 24, 23, start.z + 24], target: [start.x, 0.3, start.z] };
    await open({ start, camera });
    const restored = await state();
    expect(restored.position).toEqual(start);
    expect(restored.camera).toEqual(camera);
    await page.screenshot({ path: `${out}/resume-${where}-footprint.png` });
    await page.evaluate(() => document.getElementById('verification-unmount').click());
    const flushed = await state();
    expect(flushed.position).toEqual(start);
    expect(flushed.camera).toEqual(camera);
    await open({ start: flushed.position, camera: flushed.camera });
    const reloaded = await state();
    expect(reloaded.position).toEqual(start);
    expect(reloaded.camera).toEqual(camera);
    await page.getByTestId('walking-map').focus();
    await page.keyboard.down('d');
    await page.waitForTimeout(400);
    await page.evaluate(() => document.getElementById('verification-unmount').click());
    await page.keyboard.up('d');
    const moved = await state();
    expect(moved.position.x).toBeGreaterThan(start.x);
    checks.push({ check: `exact position/camera ${where} footprint survives saves, final flush and reload; movement can escape`, expected: { start, camera }, restored, flushed, reloaded, moved });
  }
  const invalid = { start: { x: 1e7, z: -1e7 }, camera: { zoom: 27, position: [200, 50, 200], target: [1e7, 0, -1e7] } };
  await open(invalid);
  const repaired = await state();
  expect(repaired.position).toEqual(geometry.entrance);
  expect(repaired.camera).not.toEqual(invalid.camera);
  checks.push({ check: 'out-of-bounds explicit start repairs to entrance and discards stale camera', invalid, repaired });
  await page.screenshot({ path: `${out}/outside-resume-repair.png` });
  expect(errors).toEqual([]);
  expect(failures).toEqual([]);
} finally {
  await writeFile(`${out}/resume-browser-results.json`, JSON.stringify({ capturedAt: new Date().toISOString(), browser: browser.version(), renderer: 'ANGLE SwiftShader; visual correctness only', errors, failures, checks }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ out, errors, failures, checks: checks.map(c => c.check) }, null, 2));
