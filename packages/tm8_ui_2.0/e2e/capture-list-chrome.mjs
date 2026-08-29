/**
 * capture-list-chrome — WHAT THE ENTITY LIST SPENDS ITS SCREEN ON.
 *
 * `mobile-audit.mjs` answers "does anything clip, and can a thumb hit it". It
 * cannot answer the question this lane was opened on, which is a BUDGET: how
 * many of the phone's 844px does the viewer look at before reaching the first
 * row, and which band spent them. That is a per-element measurement of a named
 * list of bands, and it belongs beside the instrument rather than inside it —
 * the audit is a fixed set of numbers eight lanes compare across days, and a
 * lane-specific column added to it is a lane editing the shared baseline.
 *
 * IT USES THE SAME FIXTURE AND THE SAME BROWSER, deliberately: same
 * `/mobile-audit.html` mount past the auth gate, same `channel: 'chrome'`, same
 * `isMobile`/`hasTouch` (without which `shellFor` hands back the DESKTOP shell
 * at 390px and every number below is about a screen no user has). The shell it
 * landed in is asserted before anything is recorded.
 *
 * `getBoundingClientRect().height`, NOT `offsetHeight` and NOT the computed
 * `height`: the first is an integer that hides the sub-pixel a `1px` border
 * adds, and the last reports what the rule ASKED for, which on a min-height box
 * is exactly the number that stops being true when the content grows.
 *
 * Run it:  node e2e/capture-list-chrome.mjs --out /tmp/before
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

const SPACE = 'sp-atelier';
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

/** The three the acceptance names. All three mount the same `EntityListPanel`. */
const ROUTES = [
  { name: 'tasks', path: 'k/tasks' },
  { name: 'sessions', path: 'k/sessions' },
  { name: 'channels', path: 'channels' },
];

/**
 * THE BANDS, in the order the panel stacks them. Named rather than discovered:
 * a band that renders at zero height still has to appear in the table as a
 * zero, because "0" and "absent from the report" are different findings and
 * only one of them is evidence.
 */
const BANDS = [
  ['.mobile-frame__header', 'app header'],
  ['.lp__selector', 'kind cell'],
  ['.lp__actions', 'new-task band'],
  ['.lp__searchrow', 'search'],
  ['.lp__tierrow', 'lifecycle tabs'],
  ['.lp__filterbar', 'filter bar'],
  ['.lp__lensnote', 'lens note'],
  ['.lp__body', 'THE LIST'],
  ['.lp__foot', 'footer'],
];

function measureInPage({ BANDS }) {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { present: false, h: 0, top: 0, bottom: 0 };
    const r = el.getBoundingClientRect();
    const display = getComputedStyle(el).display;
    return {
      present: true,
      display,
      h: Math.round(r.height * 10) / 10,
      top: Math.round(r.top * 10) / 10,
      bottom: Math.round(r.bottom * 10) / 10,
    };
  };

  const bands = BANDS.map(([sel, label]) => ({ sel, label, ...box(sel) }));

  /* THE FIRST ROW IS THE ANSWER, and it is measured rather than derived: a band
     may be `display: none`, may overlap, or may be laid out by a grid that
     places it somewhere the source order does not predict. Everything above the
     first row's top edge is chrome, whatever drew it. */
  const firstRow =
    document.querySelector('[data-testid="list-tile"]') ??
    document.querySelector('.lp__body > * > *');
  const firstRowTop = firstRow ? Math.round(firstRow.getBoundingClientRect().top * 10) / 10 : null;

  const vh = document.documentElement.clientHeight;

  /* How many rows actually fit, which is the number the budget buys. Measured
     off the tallest row present so a mixed list is not flattered by its
     shortest one. */
  const tiles = [...document.querySelectorAll('[data-testid="list-tile"]')];
  const rowH = tiles.length
    ? Math.max(...tiles.map((t) => t.getBoundingClientRect().height))
    : null;
  const listH = document.querySelector('.lp__body')?.getBoundingClientRect().height ?? 0;

  return {
    viewportHeight: vh,
    shell: document.querySelector('.mobile-frame') ? 'mobile' : 'desktop-or-none',
    bands,
    firstRowTop,
    chromeShare: firstRowTop === null ? null : Math.round((firstRowTop / vh) * 1000) / 10,
    listHeight: Math.round(listH * 10) / 10,
    tallestRow: rowH === null ? null : Math.round(rowH * 10) / 10,
    rowsThatFit: rowH ? Math.floor(listH / rowH) : null,
    tilesRendered: tiles.length,
  };
}

const argv = process.argv.slice(2);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const outDir = argOf('--out') ?? 'list-chrome';

const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); } catch { return null; } };
const ref = { head: git('rev-parse', '--short', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD') };

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startVite() {
  if (process.env.AUDIT_BASE) return { base: process.env.AUDIT_BASE, stop: () => {} };
  const port = await freePort();
  const proc = spawn('./node_modules/.bin/vite', ['--port', String(port), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('vite did not report a URL in 30s:\n' + buf)), 30_000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    proc.stderr.on('data', (d) => { buf += d; });
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`vite exited ${c}:\n${buf}`)); });
  });
  return { base, stop: () => proc.kill('SIGTERM') };
}

const { base, stop } = await startVite();
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({
  viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
  deviceScaleFactor: VIEWPORT.deviceScaleFactor,
  isMobile: VIEWPORT.isMobile,
  hasTouch: VIEWPORT.hasTouch,
});
const page = await ctx.newPage();
const rows = [];

for (const route of ROUTES) {
  await page.goto('about:blank');
  await page.goto(`${base}/mobile-audit.html#/s/${SPACE}/${route.path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  try { await page.evaluate(() => document.fonts.ready); } catch { /* older engines */ }
  await page.waitForTimeout(300);

  const m = await page.evaluate(measureInPage, { BANDS });
  if (m.shell !== 'mobile') throw new Error(`${route.name}: landed in ${m.shell}, not the phone shell`);
  rows.push({ route: route.name, ...m });

  await page.screenshot({ path: `${outDir}/${route.name}-390x844.png` });

  console.log(`\n── ${route.name} ${'─'.repeat(46)}`);
  for (const b of m.bands) {
    const state = !b.present ? 'not rendered' : b.display === 'none' ? 'display:none' : `${b.h}px`;
    console.log(`  ${b.label.padEnd(16)} ${b.sel.padEnd(24)} ${state}`);
  }
  console.log(`  first row top: ${m.firstRowTop}px  (${m.chromeShare}% of ${m.viewportHeight})`);
  console.log(`  list ${m.listHeight}px · row ${m.tallestRow}px · fits ~${m.rowsThatFit} rows`);
}

writeFileSync(`${outDir}/list-chrome.json`, JSON.stringify({ ref, viewport: VIEWPORT, rows }, null, 2));
console.log(`\nwrote ${outDir}/list-chrome.json`);

await browser.close();
stop();
