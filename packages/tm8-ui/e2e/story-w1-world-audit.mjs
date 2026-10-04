/** W1 world-model evidence: Library/Code Factory, sites, districts on the fixture and a 125-place source.
 * SwiftShader software rendering only — timings are not GPU evidence. W1_URL, W1_DIR, W1_BROWSER configure it. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const dir = process.env.W1_DIR ?? '/tmp/story-w1', base = process.env.W1_URL ?? 'http://127.0.0.1:5177/story-dev.html?full=1';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.W1_BROWSER, headless: true,
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
        if (scene.isScene) { if (window.__record) window.__frames.push({ at: performance.now(), ...renderer.info.render }); renderer.info.reset(); }
        return render(scene, camera);
      };
    });
  });
  // Warm the dev server: the first load optimises three/fiber and reloads the page, which would reset the hooks mid-run.
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Game', exact: true }).click();
  await page.waitForTimeout(25000);
  const runs = [
    { name: 'fixture-light', theme: '', count: 0 },
    { name: 'fixture-dark', theme: '&theme=dark', count: 0 },
    { name: 'spacious-125-light', theme: '', count: 125 },
  ];
  const only = process.env.W1_RUNS?.split(',');
  for (const run of runs.filter((r) => !only || only.includes(r.name))) {
    console.log('run', run.name);
    await page.goto(base + run.theme, { waitUntil: 'networkidle' });
    const metrics = await page.evaluate(async (count) => {
      const { STORY_FIXTURE } = await import('/src/story/fixture.ts');
      const { buildWorld } = await import('/src/story/game/world.ts');
      const { storyGameStore } = await import('/src/story/game/store.ts');
      // The spacious fixture mutates the shared STORY_FIXTURE in place, which is what the page renders.
      const view = count ? (await import('/e2e/story-spacious-fixture.ts')).spaciousFixture(count) : STORY_FIXTURE;
      const start = performance.now(), world = buildWorld(view), buildMs = performance.now() - start;
      const times = [];
      for (let i = 0; i < 5; i++) { const t = performance.now(); buildWorld(view); times.push(performance.now() - t); }
      if (count) storyGameStore.getState().reveal(view.id, world.places.map((p) => p.id));
      let minGap = Infinity;
      for (const a of world.places) for (const b of world.places) if (a.id !== b.id) minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.z - b.z) - a.footprint - b.footprint);
      const landmarks = world.places.filter((p) => p.members.length).map((p) => ({ id: p.id, shape: p.shape, members: p.members.length, memberKinds: [...new Set(p.members.map((m) => m.kind))] }));
      const tasks = world.places.filter((p) => p.attachments);
      const sited = world.places.filter((p) => p.parentId).length;
      const standalone = view.page.nodes.filter((n) => ['doc', 'artifact', 'drawing', 'file', 'pull_request', 'commit'].includes(n.kind) && world.byId.has(n.id)).length;
      return { count: world.places.length, nodes: view.page.nodes.length, roads: world.roads.length, extent: world.extent, minGap, buildMs, warmMs: times,
        landmarks, standaloneMadeOrCode: standalone, tasks: tasks.length, sited, withWorker: tasks.filter((p) => p.hasWorker).length,
        shelves: tasks.reduce((s, p) => s + p.attachments.library.count, 0), mail: tasks.reduce((s, p) => s + p.attachments.mailbox.count, 0),
        approxMail: tasks.filter((p) => p.attachments.mailbox.approx).length, districts: world.districts,
        byDistrict: Object.fromEntries(world.districts.map((d) => [d.id, tasks.filter((p) => p.district === d.id).length])) };
    }, run.count);
    await page.getByRole('tab', { name: 'Game', exact: true }).click();
    await page.waitForFunction(() => window.__renderer?.info.render.frame > 2, null, { timeout: 120000 });
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `${dir}/${run.name}-ground.png` });
    await page.getByRole('button', { name: 'Map overview' }).click();
    await page.waitForTimeout(3000);
    await page.evaluate(() => { window.__frames = []; window.__record = true; });
    await page.waitForTimeout(6000);
    await page.evaluate(() => { window.__record = false; });
    await page.screenshot({ path: `${dir}/${run.name}-overview.png` });
    metrics.performance = await page.evaluate(() => {
      const frames = window.__frames.slice(2), gl = window.__renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), samples: frames.length,
        fps: frames.length > 1 ? (frames.length - 1) * 1000 / (frames.at(-1).at - frames[0].at) : null,
        maxCalls: Math.max(...frames.map((f) => f.calls)), maxTriangles: Math.max(...frames.map((f) => f.triangles)) };
    });
    results.push({ run: run.name, ...metrics });
  }
  await writeFile(`${dir}/report${only ? '-' + only.join('-') : ''}.json`, JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
} finally { await browser.close(); }
