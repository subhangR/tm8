/** Matched graph fixtures. SPACIOUS_PHASE, URL, DIR, BROWSER configure reproduction.
 * Baseline overview uses only a camera override: the old UI has no whole-map framing. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const dir = process.env.SPACIOUS_DIR ?? '/tmp/story-spacious', phase = process.env.SPACIOUS_PHASE ?? 'after';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SPACIOUS_BROWSER, headless: true,
  args: ['--no-sandbox', '--single-process', '--no-zygote', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [], errors = [];
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.removeItem('tm8.story-game.v1');
      window.__THREE_DEVTOOLS__ = new EventTarget(); window.__frames = [];
      window.__THREE_DEVTOOLS__.addEventListener('observe', ({ detail: renderer }) => {
        if (!renderer.isWebGLRenderer) return;
        window.__renderer = renderer; renderer.info.autoReset = false;
        const render = renderer.render.bind(renderer);
        renderer.render = (scene, camera) => {
          if (scene.isScene) {
            if (window.__overview) {
              camera.position.set(120, 115, 120); camera.lookAt(0, 0, 0);
              camera.zoom = Math.min(renderer.domElement.clientWidth, renderer.domElement.clientHeight) / (window.__extent * 2.5);
              camera.updateProjectionMatrix();
            }
            if (window.__record) window.__frames.push({ at: performance.now(), ...renderer.info.render });
            renderer.info.reset();
          }
          return render(scene, camera);
        };
      });
    });
  for (const count of [12, 50, 125]) {
    console.log('fixture', count);
    await page.goto(process.env.SPACIOUS_URL ?? 'http://127.0.0.1:4651/story-dev.html?full=1', { waitUntil: 'networkidle' });
    const metrics = await page.evaluate(async (count) => {
      const { spaciousFixture } = await import('/e2e/story-spacious-fixture.ts');
      const { buildWorld } = await import('/src/story/game/world.ts');
      const { storyGameStore } = await import('/src/story/game/store.ts');
      const view = spaciousFixture(count), start = performance.now(), world = buildWorld(view);
      const buildMs = performance.now() - start;
      storyGameStore.getState().reveal(view.id, world.places.map((p) => p.id)); window.__extent = world.extent;
      let minDistance = Infinity;
      for (const a of world.places) for (const b of world.places) if (a.id !== b.id) minDistance = Math.min(minDistance, Math.hypot(a.x - b.x, a.z - b.z));
      return { count: world.places.length, roads: world.roads.length, extent: world.extent, minDistance, buildMs };
    }, count);
    await page.getByRole('tab', { name: 'Game', exact: true }).click();
    await page.waitForFunction(() => window.__renderer?.info.render.frame > 2, null, { timeout: 90000 });
    await page.waitForTimeout(6500);
    await page.screenshot({ path: `${dir}/${phase}-${count}-ground.png` });
    if (phase === 'after') await page.getByRole('button', { name: 'Map overview' }).click();
    else await page.evaluate(() => { window.__overview = true; });
    await page.waitForTimeout(3000);
    await page.evaluate(() => { window.__record = true; });
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `${dir}/${phase}-${count}-overview.png` });
    metrics.performance = await page.evaluate(() => {
      const frames = window.__frames.slice(2), gl = window.__renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), samples: frames.length,
        fps: (frames.length - 1) * 1000 / (frames.at(-1).at - frames[0].at), width: gl.drawingBufferWidth, height: gl.drawingBufferHeight,
        maxCalls: Math.max(...frames.map((f) => f.calls)), maxTriangles: Math.max(...frames.map((f) => f.triangles)) };
    });
    results.push(metrics);
  }
  await writeFile(`${dir}/${phase}-report.json`, JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
} finally { await browser.close(); }
