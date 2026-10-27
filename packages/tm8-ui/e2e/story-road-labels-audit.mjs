/** Road destination signs on the story fixture. ROADS_URL, ROADS_DIR, ROADS_BROWSER configure reproduction.
 * Places the player on the road segment farthest from every other road, then captures ground (light, dark),
 * overview and off-road frames. Runs under SwiftShader: no number here is GPU evidence. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const dir = process.env.ROADS_DIR ?? '/tmp/story-road-labels', base = process.env.ROADS_URL ?? 'http://127.0.0.1:4673/story-dev.html?full=1';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.ROADS_BROWSER, headless: true,
  args: ['--no-sandbox', '--single-process', '--no-zygote', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [], errors = [];
const signs = (page) => page.$$eval('.sgm-roadsign', (nodes) => nodes.map((n) => ({
  shown: getComputedStyle(n).display !== 'none', title: n.querySelector('.sgm-roadsign__title')?.textContent,
  steps: n.querySelector('.sgm-roadsign__steps')?.textContent, dir: n.style.getPropertyValue('--sgm-dir'), opacity: n.style.opacity })));
try {
  // One page for every capture: --single-process SwiftShader does not reliably give a second page a WebGL context.
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.removeItem('tm8.story-game.v1');
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener('observe', ({ detail: renderer }) => { if (renderer.isWebGLRenderer) window.__renderer = renderer; });
  });
  // side: world units off the road's centre line, to the left of travel.
  for (const { theme, side, name, overview } of [
    { theme: 'light', side: 0, name: 'light-on-road', overview: true }, { theme: 'dark', side: 0, name: 'dark-on-road' },
    { theme: 'light', side: 1.6, name: 'light-verge' }, { theme: 'light', side: 3.2, name: 'light-off-road' }]) {
    console.log('capture', name);
    await page.goto(`${base}${theme === 'dark' ? '&theme=dark' : ''}`, { waitUntil: 'networkidle' });
    const probe = await page.evaluate(async (side) => {
      const { STORY_FIXTURE } = await import('/src/story/fixture.ts');
      const { buildWorld } = await import('/src/story/game/world.ts');
      const { segmentDistance } = await import('/src/story/game/roads.ts');
      const { roadLabels, ROAD_LABEL_THRESHOLD } = await import('/src/story/game/road-labels.ts');
      const { storyGameStore } = await import('/src/story/game/store.ts');
      const world = buildWorld(STORY_FIXTURE);
      const clearance = (r, p) => Math.min(...world.roads.filter((o) => o !== r).flatMap((o) => o.points.slice(1).map((q, i) => segmentDistance(p, o.points[i], q))));
      const best = world.roads.flatMap((r) => r.points.slice(1).map((q, i) => {
        const a = r.points[i], mid = { x: (a.x + q.x) / 2, z: (a.z + q.z) / 2 };
        const len = Math.hypot(q.x - a.x, q.z - a.z);
        return { road: r, mid: { x: mid.x - (q.z - a.z) / len * side, z: mid.z + (q.x - a.x) / len * side }, len, room: clearance(r, mid) };
      })).filter((s) => s.len > 4).sort((x, y) => y.room - x.room)[0];
      storyGameStore.getState().reveal(STORY_FIXTURE.id, world.places.map((p) => p.id));
      storyGameStore.getState().savePosition(STORY_FIXTURE.id, best.mid.x, best.mid.z);
      return { road: best.road.id, x: best.mid.x, z: best.mid.z, threshold: ROAD_LABEL_THRESHOLD, model: roadLabels(world, best.mid.x, best.mid.z) };
    }, side);
    await page.getByRole('tab', { name: 'Game', exact: true }).click();
    await page.waitForFunction(() => window.__renderer?.info.render.frame > 2, null, { timeout: 90000 });
    await page.waitForTimeout(6500);
    await page.screenshot({ path: `${dir}/${name}.png` });
    const result = { name, theme, side, probe, signs: await signs(page) };
    if (overview) {
      await page.getByRole('button', { name: 'Map overview' }).click();
      await page.waitForTimeout(3000);
      result.overview = await signs(page);
      await page.screenshot({ path: `${dir}/${theme}-overview.png` });
    }
    results.push(result);
  }
  await writeFile(`${dir}/report.json`, JSON.stringify({ renderer: 'SwiftShader (software)', results, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
} finally { await browser.close(); }
