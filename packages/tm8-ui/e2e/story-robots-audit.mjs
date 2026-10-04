/** Robots evidence: robot count per live session, constant draw-call growth, attention pip, robot click.
 * ROBOTS_URL, ROBOTS_DIR, ROBOTS_BROWSER configure reproduction. SwiftShader numbers only. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const dir = process.env.ROBOTS_DIR ?? '/tmp/story-robots', base = process.env.ROBOTS_URL ?? 'http://127.0.0.1:4677/story-dev.html?full=1';
await mkdir(dir, { recursive: true });
/* Single-process SwiftShader chromium does not survive a second context: one browser per scenario. */
const launch = () => chromium.launch({ executablePath: process.env.ROBOTS_BROWSER, headless: true,
  args: ['--no-sandbox', '--single-process', '--no-zygote', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [], errors = [];
const ONLY = process.env.ROBOTS_ONLY;
const SCENARIOS = [
  { name: 'live0', live: 0, attention: false, theme: '' },
  { name: 'live3', live: 3, attention: false, theme: '' },
  { name: 'live7-attention', live: 7, attention: true, theme: '' },
  { name: 'live7-attention-dark', live: 7, attention: true, theme: '&theme=dark' },
  { name: 'live7-attention-reduced', live: 7, attention: true, theme: '', reduced: true },
];
for (const scenario of SCENARIOS.filter((s) => !ONLY || s.name === ONLY)) {
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, reducedMotion: scenario.reduced ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${scenario.name}: ${error.message}`));
    await page.addInitScript(() => {
      localStorage.removeItem('tm8.story-game.v1');
      window.__THREE_DEVTOOLS__ = new EventTarget(); window.__frames = [];
      window.__THREE_DEVTOOLS__.addEventListener('observe', ({ detail: renderer }) => {
        if (!renderer.isWebGLRenderer) return;
        window.__renderer = renderer; renderer.info.autoReset = false;
        const render = renderer.render.bind(renderer);
        renderer.render = (scene, camera) => {
          if (scene.isScene) {
            window.__camera = camera; window.__scene = scene;
            if (window.__record) window.__frames.push({ at: performance.now(), ...renderer.info.render });
            renderer.info.reset();
          }
          return render(scene, camera);
        };
      });
    });
    await page.goto(base + scenario.theme, { waitUntil: 'networkidle' });
    const setup = await page.evaluate(async ({ live, attention }) => {
      const { robotsFixture } = await import('/e2e/story-robots-fixture.ts');
      const { buildWorld } = await import('/src/story/game/world.ts');
      const { robotsFor } = await import('/src/story/game/robots.ts');
      const view = robotsFixture(live, attention), world = buildWorld(view);
      const robots = robotsFor(view, world);
      return { storyId: view.id, liveSessions: view.page.sessions.filter((s) => s.live).length, robots: robots.map((r) => ({ id: r.id, reason: r.stand.reason, placeId: r.stand.placeId, attention: r.attention, x: r.stand.x, z: r.stand.z })),
        placeTitle: (id) => world.byId.get(id)?.title, titles: Object.fromEntries(robots.filter((r) => r.stand.placeId).map((r) => [r.id, world.byId.get(r.stand.placeId).title])) };
    }, scenario);
    await page.getByRole('tab', { name: 'Game', exact: true }).click();
    await page.waitForFunction(() => window.__renderer?.info.render.frame > 2, null, { timeout: 120000 });
    await page.waitForTimeout(5000);
    const counts = await page.evaluate(() => {
      const meshes = []; window.__scene.traverse((o) => { if (o.isInstancedMesh) meshes.push({ count: o.count, geometry: o.geometry.type }); });
      return { instancedMeshes: meshes.length, pips: document.querySelectorAll('.sgm-robot-pip').length,
        visiblePips: [...document.querySelectorAll('.sgm-robot-pip')].filter((n) => n.style.display !== 'none').length };
    });
    await page.screenshot({ path: `${dir}/${scenario.name}-ground.png` });
    await page.getByRole('button', { name: 'Map overview' }).click();
    await page.waitForTimeout(2500);
    await page.evaluate(() => { window.__record = true; });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${dir}/${scenario.name}-overview.png` });
    const performance = await page.evaluate(() => {
      const frames = window.__frames.slice(2), gl = window.__renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      window.__record = false;
      return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), samples: frames.length,
        fps: (frames.length - 1) * 1000 / (frames.at(-1).at - frames[0].at), maxCalls: Math.max(...frames.map((f) => f.calls)), minCalls: Math.min(...frames.map((f) => f.calls)), maxTriangles: Math.max(...frames.map((f) => f.triangles)) };
    });
    let click = null;
    const target = setup.robots.find((r) => r.placeId);
    if (target) {
      // Click the robot in the overview: project its torso and press there; the approach card must then name its place.
      const point = await page.evaluate(({ x, z }) => {
        const THREE_V = window.__camera.position.constructor; const v = new THREE_V(x, .7, z).project(window.__camera);
        const canvas = window.__renderer.domElement, rect = canvas.getBoundingClientRect();
        return { x: rect.left + (v.x * .5 + .5) * rect.width, y: rect.top + (-v.y * .5 + .5) * rect.height };
      }, target);
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(scenario.reduced ? 4000 : 11000);
      // Arrival shows the approach card, or the trainer plate when a session works at that place; the save records where the player ended.
      const landed = await page.evaluate(({ id }) => {
        const card = document.querySelector('.sgm-approach')?.textContent ?? null, duel = document.querySelector('.sgm-duel__opponent')?.textContent ?? null;
        const save = JSON.parse(localStorage.getItem('tm8.story-game.v1') ?? '{}').saves?.[id] ?? null;
        return { card, duel, save: save && { x: save.x, z: save.z } };
      }, { id: setup.storyId });
      const distance = landed.save ? Math.hypot(landed.save.x - target.x, landed.save.z - target.z) : null;
      click = { robot: target.id, placeTitle: setup.titles[target.id], ...landed, distanceToRobot: distance,
        hit: distance !== null && distance < 2.5 && (!!landed.card?.includes(setup.titles[target.id]) || !!landed.duel) };
      await page.screenshot({ path: `${dir}/${scenario.name}-after-click.png` });
    }
    results.push({ scenario: scenario.name, liveSessions: setup.liveSessions, robots: setup.robots, counts, performance, click });
    await writeFile(`${dir}/report.json`, JSON.stringify({ results, errors }, null, 2));
  } finally { await browser.close(); }
}
console.log(JSON.stringify({ results, errors }, null, 2));
if (errors.length) process.exitCode = 1;
