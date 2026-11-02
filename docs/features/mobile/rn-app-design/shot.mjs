#!/usr/bin/env node
// Screenshots for self-review. Requires the repo's playwright (bun install at the repo root).
// Usage:
//   node shot.mjs dist/index.html --section s-chat          → shots/s-chat.png (full section, 1400px wide)
//   node shot.mjs dist/index.html --section s-chat --phones  → shots/s-chat/01.png… one per .phone (1:1)
//   node shot.mjs dist/index.html --all                      → one png per section
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Browser resolution, in order: (1) /home/tm8/prod-data/tools/browser/launch.json — a node-wide config written by the
// tooling lane ({ playwright, browser, executablePath, env, args }); (2) env TM8_SHOT_PLAYWRIGHT / TM8_SHOT_BROWSER /
// TM8_SHOT_EXECUTABLE; (3) the repo's playwright with its default chromium. The shared config lives OUTSIDE git so a
// fix there reaches every lane's worktree at once.
import { readFileSync } from 'node:fs';
function loadConfig() {
  const cfg = { playwright: process.env.TM8_SHOT_PLAYWRIGHT, browser: process.env.TM8_SHOT_BROWSER, executablePath: process.env.TM8_SHOT_EXECUTABLE, env: {}, args: [] };
  for (const f of ['/home/tm8/prod-data/tools/browser/launch.json', resolve(here, '.browser.json')]) {
    if (existsSync(f)) { try { Object.assign(cfg, JSON.parse(readFileSync(f, 'utf8'))); break; } catch (e) { console.error('bad ' + f + ': ' + e.message); } }
  }
  return cfg;
}
function loadPlaywright(cfg) {
  const candidates = [cfg.playwright, '/home/tm8/prod-data/tools/pw164/node_modules/playwright-core', resolve(here, '../../../../node_modules/playwright'), '/home/tm8/tm8/node_modules/playwright', '/home/tm8/tm8/node_modules/.bun/playwright@1.58.2/node_modules/playwright'].filter(Boolean);
  for (const c of candidates) { try { return require(c); } catch {} }
  try { return require('playwright'); } catch {}
  throw new Error('playwright not found; see the lane brief (shared tooling at /home/tm8/prod-data/tools)');
}
const cfg = loadConfig();
const pw = loadPlaywright(cfg);
const browserType = pw[cfg.browser || 'chromium'];
Object.assign(process.env, cfg.env || {});
const launchOpts = { headless: true, args: cfg.args || [] };
if (cfg.executablePath) launchOpts.executablePath = cfg.executablePath;
if (cfg.channel) launchOpts.channel = cfg.channel;
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) || 'dist/index.html';
const section = args.includes('--section') ? args[args.indexOf('--section') + 1] : null;
const phones = args.includes('--phones');
const all = args.includes('--all');
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(here, 'shots');
mkdirSync(outDir, { recursive: true });
const browser = await browserType.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(resolve(here, file)).href);
await page.waitForTimeout(300);
async function shootSection(id) {
  const el = page.locator('#' + id);
  if (!(await el.count())) { console.log(`no section #${id}`); return; }
  if (phones) {
    const dir = join(outDir, id); mkdirSync(dir, { recursive: true });
    const ph = el.locator('.phone');
    const n = await ph.count();
    for (let i = 0; i < n; i++) { const p = join(dir, String(i + 1).padStart(2, '0') + '.png'); await ph.nth(i).screenshot({ path: p }); }
    console.log(`${id}: ${n} phones → ${dir}`);
  } else {
    const p = join(outDir, id + '.png');
    await el.screenshot({ path: p });
    const box = await el.boundingBox();
    console.log(`${id}: ${Math.round(box.width)}×${Math.round(box.height)} → ${p}`);
  }
}
if (all) { const ids = await page.$$eval('section.doc-section', (els) => els.map((e) => e.id)); for (const id of ids) await shootSection(id); }
else if (section) await shootSection(section);
else { await page.screenshot({ path: join(outDir, 'index.png'), fullPage: true }); console.log('→ shots/index.png'); }
await browser.close();
