/** W7 asset-kit integration evidence: kit assets per place, DOM count badges at the kit anchors,
 * kit robots per running session, light and dark. W7_URL, W7_DIR, W7_BROWSER configure reproduction.
 * Every fps/timing number is SwiftShader software rendering, not GPU evidence. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const dir = process.env.W7_DIR ?? '/tmp/story-w7', base = process.env.W7_URL ?? 'http://127.0.0.1:4699/story-dev.html?full=1';
await mkdir(dir, { recursive: true });
/* Single-process SwiftShader chromium does not survive a second context: one browser per scenario. */
const launch = () => chromium.launch({ executablePath: process.env.W7_BROWSER, headless: true,
  args: ['--no-sandbox', '--single-process', '--no-zygote', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [], errors = [];
const SCENARIOS = [
  { name: 'fixture-light', theme: '', robots: null },
  { name: 'fixture-dark', theme: '&theme=dark', robots: null },
  { name: 'robots7-attention-light', theme: '', robots: { live: 7, attention: true } },
  { name: 'robots7-attention-dark', theme: '&theme=dark', robots: { live: 7, attention: true } },
];
for (const scenario of SCENARIOS) {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
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
            window.__scene = scene;
            if (window.__record) window.__frames.push({ at: performance.now(), ...renderer.info.render });
            renderer.info.reset();
          }
          return render(scene, camera);
        };
      });
    });
    await page.goto(base + scenario.theme, { waitUntil: 'networkidle' });
    const model = await page.evaluate(async (robots) => {
      const { STORY_FIXTURE } = await import('/src/story/fixture.ts');
      if (robots) { const { robotsFixture } = await import('/e2e/story-robots-fixture.ts'); robotsFixture(robots.live, robots.attention); }
      const { buildWorld } = await import('/src/story/game/world.ts');
      const { placeAsset, badgesOf } = await import('/src/story/game/place-asset.ts');
      const { robotsFor } = await import('/src/story/game/robots.ts');
      const { storyGameStore } = await import('/src/story/game/store.ts');
      const world = buildWorld(STORY_FIXTURE);
      storyGameStore.getState().reveal(STORY_FIXTURE.id, world.places.map((p) => p.id));
      const types = {}, cairnKinds = {};
      for (const p of world.places) { const a = placeAsset(p, world); types[a.type] = (types[a.type] ?? 0) + 1; if (a.type === 'unknown-cairn') cairnKinds[p.kind] = (cairnKinds[p.kind] ?? 0) + 1; }
      const badges = badgesOf(world), byKind = {};
      for (const b of badges) byKind[b.kind] = (byKind[b.kind] ?? 0) + 1;
      return { places: world.places.length, types, cairnKinds, badges: byKind, approxBadges: badges.filter((b) => b.approx).length, robots: robotsFor(STORY_FIXTURE, world).length, liveSessions: STORY_FIXTURE.page.sessions.filter((s) => s.live).length };
    }, scenario.robots);
    await page.getByRole('tab', { name: 'Game', exact: true }).click();
    await page.waitForFunction(() => window.__renderer?.info.render.frame > 2, null, { timeout: 120000 });
    await page.waitForTimeout(6000);
    const dom = () => page.evaluate(() => {
      const meshes = []; window.__scene.traverse((o) => { if (o.isInstancedMesh) meshes.push({ count: o.count, geometry: o.geometry.type }); });
      const badges = [...document.querySelectorAll('.sgm-badge')];
      return { instancedMeshes: meshes.length, badgeNodes: badges.length, visibleBadges: badges.filter((n) => n.style.display !== 'none').length,
        visibleBadgeText: badges.filter((n) => n.style.display !== 'none').map((n) => `${n.className.replace(/.*sgm-badge--/, '')}:${n.textContent}`),
        pips: document.querySelectorAll('.sgm-robot-pip').length, visiblePips: [...document.querySelectorAll('.sgm-robot-pip')].filter((n) => n.style.display !== 'none').length };
    });
    const ground = await dom();
    await page.screenshot({ path: `${dir}/${scenario.name}-ground.png` });
    await page.getByRole('button', { name: 'Map overview' }).click();
    await page.waitForTimeout(2500);
    await page.evaluate(() => { window.__record = true; });
    await page.waitForTimeout(5000);
    const overview = await dom();
    await page.screenshot({ path: `${dir}/${scenario.name}-overview.png` });
    const performance = await page.evaluate(() => {
      const frames = window.__frames.slice(2), gl = window.__renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      window.__record = false;
      return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), samples: frames.length,
        fps: (frames.length - 1) * 1000 / (frames.at(-1).at - frames[0].at), maxCalls: Math.max(...frames.map((f) => f.calls)), maxTriangles: Math.max(...frames.map((f) => f.triangles)) };
    });
    results.push({ scenario: scenario.name, model, ground, overview, performance });
    console.log(JSON.stringify(results.at(-1)));
  } finally { await browser.close(); }
}
await writeFile(`${dir}/report.json`, JSON.stringify({ results, errors }, null, 2));
console.log(JSON.stringify({ errors }, null, 2));
if (errors.length) process.exitCode = 1;
