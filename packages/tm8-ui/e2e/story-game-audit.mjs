/** Run against story-dev.html to capture 50 places, measure actual render frames, and audit cleanup/fallback.
 * STORY_GAME_URL, STORY_GAME_BROWSER and STORY_GAME_ARTIFACT_DIR override host, browser and output.
 * SwiftShader timings are software-renderer measurements, never proof of integrated-GPU performance.
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const dir = process.env.STORY_GAME_ARTIFACT_DIR ?? '/tmp/story-game-audit';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.STORY_GAME_BROWSER ? { executablePath: process.env.STORY_GAME_BROWSER } : {}),
  headless: true, args: ['--no-sandbox', '--single-process', '--no-zygote', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors = [], report = {};
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__auditFrames = [];
    window.__THREE_DEVTOOLS__.addEventListener('observe', ({ detail: renderer }) => {
      if (!renderer.isWebGLRenderer) return;
      window.__auditRenderer = renderer;
      renderer.info.autoReset = false;
      const render = renderer.render.bind(renderer);
      renderer.render = (scene, camera) => {
        if (scene.isScene) {
          if (window.__auditRecording) window.__auditFrames.push({ at: performance.now(), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles });
          renderer.info.reset();
        }
        return render(scene, camera);
      };
    });
  });
  const url = process.env.STORY_GAME_URL ?? 'http://127.0.0.1:4618/story-dev.html?full=1';
  await page.goto(url, { waitUntil: 'networkidle' });
  report.places = await page.evaluate(async () => {
    const { STORY_FIXTURE: view } = await import('/src/story/fixture.ts');
    const { storyGameStore: store } = await import('/src/story/game/store.ts');
    const { buildWorld } = await import('/src/story/game/world.ts');
    let count = buildWorld(view).places.length;
    while (count < 50) {
      view.page.nodes.push({ ...view.page.nodes[1], id: `audit-${count}`, title: `Audit landmark ${count}`, rootIds: [] });
      count = buildWorld(view).places.length;
    }
    store.getState().reveal(view.id, buildWorld(view).places.map((p) => p.id));
    return count;
  });
  await page.getByRole('tab', { name: 'Game', exact: true }).first().click();
  await page.waitForTimeout(6000);
  await page.evaluate(() => { window.__auditFrames = []; window.__auditRecording = true; });
  await page.waitForTimeout(12000);
  report.performance = await page.evaluate(() => {
    window.__auditRecording = false;
    const frames = window.__auditFrames.slice(1), renderer = window.__auditRenderer;
    const ms = frames.slice(1).map((f, i) => f.at - frames[i].at).sort((a, b) => a - b);
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, samples: frames.length,
      fps: (frames.length - 1) * 1000 / (frames.at(-1).at - frames[0].at),
      medianFrameMs: ms[Math.floor(ms.length / 2)], p95FrameMs: ms[Math.floor(ms.length * .95)],
      maxDrawCalls: Math.max(...frames.map((f) => f.calls)), maxTriangles: Math.max(...frames.map((f) => f.triangles)),
      memory: { ...renderer.info.memory },
    };
  });
  await page.screenshot({ path: `${dir}/world-50.png` });
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('tm8.story-game.v1')));
  await page.getByTestId('story-game').focus();
  await page.keyboard.down('d'); await page.waitForTimeout(1100); await page.keyboard.up('d'); await page.waitForTimeout(1200);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('tm8.story-game.v1')));
  report.walkingPersisted = JSON.stringify(before.saves) !== JSON.stringify(after.saves);
  await page.getByRole('tab', { name: 'Story', exact: true }).first().click();
  await page.waitForTimeout(700);
  report.afterUnmount = await page.evaluate(() => ({ ...window.__auditRenderer.info.memory }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Game', exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${dir}/mobile-reduced.png` });
  report.mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  // Lose an existing context: the persistent map must degrade to its native list.
  await page.evaluate(() => window.__auditRenderer.getContext().getExtension('WEBGL_lose_context').loseContext());
  await page.getByTestId('story-game-flat').waitFor();
  report.contextLossFallback = true;
  await page.getByTestId('story-game-flat').getByRole('button').first().click();
  report.fallbackOpen = await page.getByTestId('story-dev-log').textContent();
  report.errors = errors;
  await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.walkingPersisted || report.mobileOverflow || errors.length) process.exitCode = 1;
} finally { await browser.close(); }
