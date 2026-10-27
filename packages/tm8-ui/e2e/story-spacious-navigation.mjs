/** Navigation, real overview, duel, theme, reduced-motion and fallback checks. Same env as spacious audit. */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const dir = process.env.SPACIOUS_DIR ?? '/tmp/story-spacious';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SPACIOUS_BROWSER, headless: true,
  args: ['--no-sandbox', '--single-process', '--no-zygote', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const report = { checks: [], errors: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.removeItem('tm8.story-game.v1');
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener('observe', ({ detail }) => { if (detail.isWebGLRenderer) window.__renderer = detail; });
  });
  await page.goto(process.env.SPACIOUS_URL ?? 'http://127.0.0.1:4651/story-dev.html?full=1', { waitUntil: 'networkidle' });
  const target = await page.evaluate(async () => {
    const { spaciousFixture } = await import('/e2e/story-spacious-fixture.ts');
    const { buildWorld } = await import('/src/story/game/world.ts');
    const view = spaciousFixture(50), world = buildWorld(view);
    const root = world.places.find((p) => p.root && p.encounters.some((e) => e.phase === 'active'));
    window.__world = world;
    return { title: root.title, id: root.id, sessionId: root.encounters[0].id };
  });
  await page.getByRole('tab', { name: 'Game', exact: true }).click();
  await page.waitForFunction(() => window.__renderer?.info.render.frame > 3);
  const game = page.getByTestId('story-game');
  await game.focus(); await page.keyboard.press('m');
  assert.equal(await page.getByRole('button', { name: 'Back to explorer' }).getAttribute('aria-pressed'), 'true');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${dir}/overview-unexplored-50.png` });
  await page.keyboard.press('m');
  const started = Date.now();
  await page.getByRole('button', { name: new RegExp(target.title) }).click();
  await page.getByTestId('story-game-duel').waitFor({ timeout: 30000 });
  report.nearbyTripMs = Date.now() - started;
  await game.focus(); await page.keyboard.press('e');
  assert.match(await page.getByTestId('story-dev-log').textContent(), new RegExp(`open ${target.sessionId}`));
  await page.screenshot({ path: `${dir}/duel-after-travel.png` });
  await page.getByRole('button', { name: 'Return to map' }).click();
  assert.equal(await game.evaluate((el) => el === document.activeElement), true);
  report.checks.push('M toggles overview; quest travel discovers a real trainer; E opens the exact session; returning restores keyboard focus');
  // Jump the saved explorer to a real dependency bridge for a close-up.
  await page.getByRole('tab', { name: 'Graph', exact: true }).click();
  await page.evaluate(async () => {
    const { storyGameStore } = await import('/src/story/game/store.ts');
    const world = window.__world, road = world.roads.find((r) => r.family === 'blocks');
    const pts = road.points, point = pts[Math.floor(pts.length / 2)];
    storyGameStore.getState().reveal(world.storyId, world.places.map((p) => p.id));
    storyGameStore.getState().savePosition(world.storyId, point.x + 2, point.z + 2);
  });
  await page.getByRole('tab', { name: 'Game', exact: true }).click();
  await page.waitForTimeout(4500);
  if (await page.getByRole('button', { name: 'Return to map' }).count()) await page.getByRole('button', { name: 'Return to map' }).click();
  await page.screenshot({ path: `${dir}/after-50-bridge.png` });
  for (const width of [1440, 390]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate((dark) => document.querySelector('.cv2-root').setAttribute('data-theme', dark ? 'dark' : ''), dark);
    const toggle = page.getByRole('button', { name: 'Map overview' });
    if (await toggle.count()) await toggle.click();
    await page.waitForTimeout(2200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: `${dir}/overview-${dark ? 'dark' : 'light'}-${width}-reduced.png` });
  }
  report.checks.push('Desktop/mobile light/dark overview, reduced motion, no horizontal overflow');
  await page.evaluate(() => window.__renderer.getContext().getExtension('WEBGL_lose_context').loseContext());
  const flat = page.getByTestId('story-game-flat'); await flat.waitFor();
  const first = flat.getByRole('button').first(), expected = await first.textContent();
  await first.click();
  assert.match(await page.getByTestId('story-dev-log').textContent(), /open fx-/);
  report.checks.push(`Context loss yields native fallback and open port works: ${expected}`);
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
  await writeFile(`${dir}/navigation-report.json`, JSON.stringify(report, null, 2));
} finally { await browser.close(); }
