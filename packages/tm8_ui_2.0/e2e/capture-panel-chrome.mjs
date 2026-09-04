/**
 * capture-panel-chrome — WHAT THE ENTITY DETAIL PANEL SPENDS ITS SCREEN ON.
 *
 * `capture-list-chrome.mjs` answers the budget question for the LIST screen.
 * This is its counterpart for the screen you land on after tapping a row, and
 * it exists for the same reason: "the chrome is too tall" is not a measurement,
 * and a lane that reports a fix without a per-band number has reported a
 * feeling. The ruling this serves (2026-08-20) named ~260px of a 844px screen
 * spent before the body, and ~90px of it in the chip band.
 *
 * SAME FIXTURE, SAME BROWSER, SAME VIEWPORT as the list instrument, and the
 * shell it landed in is asserted before anything is recorded — without
 * `isMobile`/`hasTouch`, `shellFor` hands back the DESKTOP shell at 390px and
 * every number below is about a screen no user has.
 *
 * `getBoundingClientRect().height`, not `offsetHeight` and not the computed
 * `height`, for the reasons the list instrument states: the first hides the
 * sub-pixel a 1px border adds, and the last reports what the rule ASKED for,
 * which on a min-height box is the number that stops being true first.
 *
 * A BAND THAT IS GONE IS RECORDED AS GONE, not omitted. "0" and "absent from
 * the report" are different findings and only one of them is evidence — which
 * matters more here than on the list, because this change REMOVES a band and a
 * missing row would read as an instrument that failed to find it.
 *
 * Run it:  node e2e/capture-panel-chrome.mjs --out /tmp/panel-after
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

const SPACE = 'sp-atelier';
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

/**
 * Two kinds, because they are two different panel anatomies: a task carries the
 * chip band and two primaries; a channel carries the bar without the band, so
 * the bar's removal is visible in isolation rather than inside the band's
 * arithmetic. A fix measured on one anatomy is a fix measured on half the panel.
 *
 * `k/sessions` is NOT here and that is a fixture fact, not a choice: the audit
 * fixture's session list is EMPTY (`panel-empty`), so there is no row to open
 * and the instrument would report a timeout as though the panel had failed.
 * Recorded rather than silently dropped — the work_session panel's phone
 * geometry is unmeasured by this run and nothing here should be read as
 * covering it.
 */
const ROUTES = [
  { name: 'task', path: 'k/tasks' },
  { name: 'channel', path: 'channels' },
];

/** The bands, in the order the panel stacks them. */
const BANDS = [
  ['.mobile-frame__header', 'app header'],
  ['.pn-head', 'title row'],
  ['.pn-panelbar', 'panel bar'],
  ['.pn-tabs', '  · tab strip'],
  ['.pn-panelbar__end', '  · action cluster'],
  ['.pn-controls', 'chip band'],
  ['.lp__rowdetail--chips', '  · the chips'],
];

function measureInPage({ BANDS }) {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { present: false, h: 0 };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      present: true,
      display: cs.display,
      h: Math.round(r.height * 10) / 10,
      top: Math.round(r.top * 10) / 10,
      bottom: Math.round(r.bottom * 10) / 10,
      /* The wrap is the whole of the chip band's height, so the report has to
         say how many lines it is rather than only how tall. */
      lines: el.children.length
        ? new Set([...el.children].map((c) => Math.round(c.getBoundingClientRect().top))).size
        : 0,
    };
  };

  const bands = BANDS.map(([sel, label]) => ({ sel, label, ...box(sel) }));

  /*
   * THE BODY'S TOP EDGE IS THE ANSWER, measured rather than derived: a band may
   * be `display:none`, may overlap, or may be placed by a grid somewhere source
   * order does not predict. Everything above it is chrome, whatever drew it.
   */
  const body =
    document.querySelector('.pn-body') ??
    document.querySelector('[data-testid="subtree-body"]') ??
    document.querySelector('.pn-work-session-content');
  const bodyTop = body ? Math.round(body.getBoundingClientRect().top * 10) / 10 : null;

  /*
   * EVERY CONTROL IN THE BAND, WITH ITS OWN RECT. "Thin" must not have been
   * bought by shrinking a tap target, and the only way to show that is to
   * report the smaller side of each control rather than the band's total.
   */
  const chips = [...document.querySelectorAll('.pn-controls .lp__rowdetail--chips > *')].map(
    (el) => {
      const r = el.getBoundingClientRect();
      return {
        cls: el.className.toString().split(' ')[0],
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    },
  );

  const strip = document.querySelector('.pn-controls .lp__rowdetail--chips');

  return {
    viewportHeight: document.documentElement.clientHeight,
    shell: document.querySelector('.mobile-frame') ? 'mobile' : 'desktop-or-none',
    bands,
    bodyTop,
    chromeShare:
      bodyTop === null ? null : Math.round((bodyTop / document.documentElement.clientHeight) * 1000) / 10,
    chips,
    /* Reachability, for the scroller: nothing may be DESTROYED past the edge,
       which is what `scrollWidth > clientWidth` on the band's own element
       distinguishes from a clip. RULE R3 forbids citing a document-level
       number; this is the per-element one. */
    chipScroll: strip
      ? { scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth }
      : null,
    /* Witnesses, so "the strip is gone" and "the instrument did not find it"
       are two different readings of this report. */
    hasTabs: document.querySelector('[data-testid="panel-tabs"]') !== null,
    hasActionBar: document.querySelector('[data-testid="panel-action-bar"]') !== null,
    hasFab: document.querySelector('[data-testid="entity-fab"]') !== null,
  };
}

const argv = process.argv.slice(2);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const outDir = argOf('--out') ?? 'panel-chrome';

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

  /* A ROUTE WITH NO ROWS IS REPORTED, NOT WAITED ON. The fixture's session list
     is empty, and a 30s locator timeout reads as a broken panel rather than as
     an empty list — two different findings. */
  if (await page.locator('[data-testid="panel-empty"]').count()) {
    console.log(`\n── ${route.name} ${'─'.repeat(46)}\n  NO ROWS IN THE FIXTURE — nothing measured`);
    rows.push({ route: route.name, skipped: 'fixture list is empty' });
    continue;
  }

  /* THE TILE'S TITLE IS THE SELECT CONTROL, not the tile root: the card holds
     several independent controls and a handler on the whole card would make
     every one of them a navigation. Clicking the root does nothing.
     THREE ANATOMIES, THREE CLASS NAMES — the task card, the session-tree row
     and the standard tile each name their title differently, and a selector
     that knew only the first timed out on `k/sessions` rather than reporting
     that it had measured one kind. */
  await page
    .locator(
      '[data-testid="list-tile"] .pn-tt__title, [data-testid="list-tile"] .pn-st__title, [data-testid="list-tile"] .lp__title',
    )
    .first()
    .click();
  await page.waitForSelector('[data-testid="entity-detail-panel"]');
  await page.waitForTimeout(800);
  try { await page.evaluate(() => document.fonts.ready); } catch { /* older engines */ }
  await page.waitForTimeout(300);

  const m = await page.evaluate(measureInPage, { BANDS });
  if (m.shell !== 'mobile') throw new Error(`${route.name}: landed in ${m.shell}, not the phone shell`);
  rows.push({ route: route.name, ...m });

  await page.screenshot({ path: `${outDir}/${route.name}-390x844.png` });

  console.log(`\n── ${route.name} ${'─'.repeat(46)}`);
  for (const b of m.bands) {
    const state = !b.present
      ? 'NOT RENDERED'
      : b.display === 'none'
        ? 'display:none'
        : `${b.h}px${b.lines > 1 ? ` (${b.lines} lines)` : ''}`;
    console.log(`  ${b.label.padEnd(20)} ${b.sel.padEnd(26)} ${state}`);
  }
  console.log(`  body top: ${m.bodyTop}px  (${m.chromeShare}% of ${m.viewportHeight})`);
  console.log(`  tabs:${m.hasTabs} actionBar:${m.hasActionBar} fab:${m.hasFab}`);
  if (m.chips.length) {
    console.log(`  chips: ${m.chips.map((c) => `${c.cls} ${c.w}x${c.h}`).join(' · ')}`);
    console.log(`  chip strip scroll: ${JSON.stringify(m.chipScroll)}`);
  }
}

writeFileSync(`${outDir}/panel-chrome.json`, JSON.stringify({ ref, viewport: VIEWPORT, rows }, null, 2));
console.log(`\nwrote ${outDir}/panel-chrome.json`);

await browser.close();
stop();
