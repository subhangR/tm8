/** Minimap audit (task 01a1090f). MINIMAP_URL, MINIMAP_DIR, MINIMAP_BROWSER configure reproduction.
 * Light and dark captures, click-to-walk through the minimap, redraw rate while walking, the cost of one
 * paint, and scene fps with the minimap shown vs hidden (alternating windows). All fps are SwiftShader. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const dir = process.env.MINIMAP_DIR ?? '/tmp/story-minimap', base = process.env.MINIMAP_URL ?? 'http://127.0.0.1:4683/story-dev.html?full=1';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.MINIMAP_BROWSER, headless: true,
  args: ['--no-sandbox', '--single-process', '--no-zygote', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const report = { note: 'All fps/timings: SwiftShader software rendering on a shared host; not GPU evidence.', themes: {}, errors: [] };
const draws = (page) => page.evaluate(() => Number(document.querySelector('.sgm-minimap__canvas')?.dataset.draws ?? 0));
const fpsWindow = async (page, ms) => {
  await page.evaluate(() => { window.__frames = []; window.__record = true; });
  await page.waitForTimeout(ms);
  return page.evaluate(() => { window.__record = false; const f = window.__frames; return f.length > 2 ? (f.length - 1) * 1000 / (f.at(-1).at - f[0].at) : 0; });
};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  let theme = 'warm-up';
  page.on('pageerror', (error) => report.errors.push(`${theme}: ${error.message}`));
  await page.addInitScript(() => {
    localStorage.removeItem('tm8.story-game.v1');
    window.__THREE_DEVTOOLS__ = new EventTarget(); window.__frames = [];
    window.__THREE_DEVTOOLS__.addEventListener('observe', ({ detail: renderer }) => {
      if (!renderer.isWebGLRenderer) return;
      window.__renderer = renderer;
      const render = renderer.render.bind(renderer);
      renderer.render = (scene, camera) => { if (scene.isScene && window.__record) window.__frames.push({ at: performance.now() }); return render(scene, camera); };
    });
  });
  /* Warm Vite's dependency optimisation for the lazy scene so it cannot reload the page mid-audit.
     One page throughout: with --single-process, closing a page can take the browser with it. */
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Game', exact: true }).click();
  await page.waitForSelector('.sgm-stage canvas', { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(8000);
  for (theme of ['light', 'dark']) {
    await page.evaluate(() => localStorage.removeItem('tm8.story-game.v1'));
    await page.goto(theme === 'dark' ? `${base}&theme=dark` : base, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Game', exact: true }).click();
    await page.waitForFunction(() => window.__renderer?.info.render.frame > 2, null, { timeout: 120000 });
    await page.waitForTimeout(5000);
    const out = { draws: {} };
    out.draws.afterLoad = await draws(page);
    await page.screenshot({ path: `${dir}/${theme}-fresh.png` });
    await page.screenshot({ path: `${dir}/${theme}-fresh-minimap.png`, clip: await page.locator('.sgm-minimap__canvas').boundingBox() });

    /* Idle: nothing changes, nothing paints. */
    const idle0 = await draws(page);
    await page.waitForTimeout(3000);
    out.draws.idle3s = (await draws(page)) - idle0;

    /* Walking: paints follow the saved position, never above 10 Hz. */
    await page.getByTestId('story-game').focus();
    const walk0 = await draws(page), t0 = Date.now();
    await page.keyboard.down('w'); await page.waitForTimeout(2500); await page.keyboard.up('w');
    await page.keyboard.down('d'); await page.waitForTimeout(2000); await page.keyboard.up('d');
    await page.waitForTimeout(1200);
    out.draws.walk = { paints: (await draws(page)) - walk0, seconds: (Date.now() - t0) / 1000 };
    out.draws.walk.hz = out.draws.walk.paints / out.draws.walk.seconds;
    await page.screenshot({ path: `${dir}/${theme}-walked-minimap.png`, clip: await page.locator('.sgm-minimap__canvas').boundingBox() });

    /* Click the hub dot on the minimap: the player walks home. */
    const hub = await page.evaluate(async () => {
      const { buildWorld } = await import('/src/story/game/world.ts');
      const { STORY_FIXTURE } = await import('/src/story/fixture.ts');
      const { minimapModel } = await import('/src/story/game/minimap.ts');
      const { storyGameStore } = await import('/src/story/game/store.ts');
      const world = buildWorld(STORY_FIXTURE), save = storyGameStore.getState().saves[STORY_FIXTURE.id];
      const model = minimapModel(world, new Set(save?.revealed ?? []), { x: save?.x ?? 0, z: save?.z ?? 0, heading: 0 });
      const dot = model.dots.find((d) => d.hub);
      return { px: dot.px, py: dot.py, before: { x: save?.x, z: save?.z } };
    });
    const box = await page.locator('.sgm-minimap__canvas').boundingBox();
    await page.mouse.click(box.x + hub.px * box.width / 180, box.y + hub.py * box.height / 180);
    await page.waitForTimeout(9000);
    out.clickToWalk = { before: hub.before, after: await page.evaluate(async () => {
      const { storyGameStore } = await import('/src/story/game/store.ts');
      const { STORY_FIXTURE } = await import('/src/story/fixture.ts');
      const s = storyGameStore.getState().saves[STORY_FIXTURE.id]; return { x: s.x, z: s.z };
    }) };
    out.clickToWalk.distanceFromHubAfter = Math.hypot(out.clickToWalk.after.x, out.clickToWalk.after.z);

    /* Everything revealed: the full map, captured. */
    await page.evaluate(async () => {
      const { buildWorld } = await import('/src/story/game/world.ts');
      const { STORY_FIXTURE } = await import('/src/story/fixture.ts');
      const { storyGameStore } = await import('/src/story/game/store.ts');
      storyGameStore.getState().reveal(STORY_FIXTURE.id, buildWorld(STORY_FIXTURE).places.map((p) => p.id));
    });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${dir}/${theme}-revealed.png` });
    await page.screenshot({ path: `${dir}/${theme}-revealed-minimap.png`, clip: await page.locator('.sgm-minimap__canvas').boundingBox() });

    /* The cost of one full paint (2D canvas, CPU raster). */
    out.paintMs = await page.evaluate(async () => {
      const { buildWorld } = await import('/src/story/game/world.ts');
      const { STORY_FIXTURE } = await import('/src/story/fixture.ts');
      const { minimapModel } = await import('/src/story/game/minimap.ts');
      const { drawMinimap } = await import('/src/story/game/Minimap.tsx');
      const { readPalette } = await import('/src/story/game/palette.ts');
      const world = buildWorld(STORY_FIXTURE), all = new Set(world.places.map((p) => p.id));
      const c = document.createElement('canvas'); c.width = c.height = 360; const ctx = c.getContext('2d');
      const palette = readPalette(document.querySelector('[data-testid="story-game"]'));
      const n = 200, t = performance.now();
      for (let i = 0; i < n; i++) drawMinimap(ctx, minimapModel(world, all, { x: i % 20, z: 2, heading: i }), palette, 2);
      ctx.getImageData(0, 0, 1, 1);
      return { places: world.places.length, roads: world.roads.length, perPaint: (performance.now() - t) / n };
    });

    /* Scene fps, minimap shown vs hidden, alternating 5 s windows while standing still. */
    const fps = { shown: [], hidden: [] };
    await page.getByTestId('story-game').focus();
    for (let round = 0; round < 3; round++) {
      fps.shown.push(await fpsWindow(page, 5000));
      await page.keyboard.press('n');
      fps.hidden.push(await fpsWindow(page, 5000));
      await page.keyboard.press('n');
    }
    out.fps = fps;
    out.toggledBack = await page.getByTestId('story-game').getAttribute('data-minimap');
    report.themes[theme] = out;
  }
  await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
} finally { await browser.close(); }
