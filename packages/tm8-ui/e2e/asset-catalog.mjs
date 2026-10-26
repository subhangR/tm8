/** Story game asset catalog screenshots. CATALOG_URL, CATALOG_DIR, SPACIOUS_BROWSER configure reproduction.
 * Every sheet in both themes plus ink-only silhouette sheets; records draw calls and frame time honestly. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.CATALOG_URL ?? 'http://127.0.0.1:4651/asset-catalog-dev.html', dir = process.env.CATALOG_DIR ?? '/tmp/asset-catalog';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SPACIOUS_BROWSER, headless: true,
  args: ['--no-sandbox', '--single-process', '--no-zygote', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const shots = process.env.CATALOG_ONLY ? JSON.parse(process.env.CATALOG_ONLY) : [
  ['types', ''], ['types', 'theme=dark'], ['types', 'silhouette=1'],
  ['states', ''], ['states', 'theme=dark'], ['states', 'silhouette=1'],
  ['containers', ''], ['containers', 'theme=dark'],
  ['plot', ''], ['plot', 'theme=dark'], ['plot', 'sockets=1'],
  ['kit', ''], ['overview', ''], ['overview', 'theme=dark'], ['overview', 'silhouette=1'],
];
const results = [], errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    window.__THREE_DEVTOOLS__ = new EventTarget(); window.__frames = [];
    window.__THREE_DEVTOOLS__.addEventListener('observe', ({ detail: r }) => {
      if (!r.isWebGLRenderer) return;
      r.info.autoReset = false; const render = r.render.bind(r);
      r.render = (s, c) => { if (s.isScene) { window.__frames.push({ at: performance.now(), calls: r.info.render.calls, triangles: r.info.render.triangles }); r.info.reset(); } return render(s, c); };
    });
  });
  for (const [sheet, extra] of shots) {
    const name = `${sheet}${extra ? '-' + extra.replace(/=.*/, '').replace('theme', 'dark') : ''}`;
    await page.goto(`${base}?sheet=${sheet}${extra ? '&' + extra : ''}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__frames.length > 20, null, { timeout: 60000 });
    await page.evaluate(() => { window.__frames = []; });
    await page.waitForTimeout(2500);
    const m = await page.evaluate(() => {
      const f = window.__frames, span = f.length > 1 ? f.at(-1).at - f[0].at : 0;
      return { frames: f.length, fps: span ? +(1000 * (f.length - 1) / span).toFixed(1) : 0, calls: f.at(-1)?.calls, triangles: f.at(-1)?.triangles, zoom: document.documentElement.dataset.catalogZoom, gameplayZoom: document.documentElement.dataset.gameplayZoom };
    });
    await page.screenshot({ path: `${dir}/${name}.png` });
    results.push({ name, ...m }); console.log(name, JSON.stringify(m));
  }
} finally { await browser.close(); }
await writeFile(`${dir}/metrics.json`, JSON.stringify({ results, errors }, null, 2));
console.log('errors', errors.length, errors.slice(0, 5));
