/**
 * CAPTURES FOR THE CHATS-ROW CHANGE (task 01a0a5f2), at the acceptance
 * viewport.
 *
 * THE REPORT IS A MEASUREMENT, so this makes it one. The complaint was that the
 * drawer's inline conversation list pushed the entity menus below the fold, and
 * "below the fold" is a number: where the first Entities group label sits once
 * the drawer opens. `firstEntityLabelTop` is that number, checked against the
 * frame rather than eyeballed off a PNG — with the list moved to its own sheet
 * the Chats section is two fixed rows, so the number no longer grows with the
 * space's conversation count.
 *
 * 390x844, dpr 3, `isMobile`/`hasTouch` — the same profile `mobile-audit.mjs`
 * calls `phone-390`, and it mounts through the SAME `mobile-audit.html` fixture
 * harness, so these frames are the app the instrument measures rather than a
 * hand-arranged page. The fixture seam is why no sign-in stands in the way.
 *
 * IT MEASURES WHILE IT SHOOTS. A screenshot proves a thing was drawn; it cannot
 * prove the FAB clears 44px or that the drawer overflows nothing. So each frame
 * carries an assertion beside it, using the audit's own two rules:
 *
 *   - overflow is `getBoundingClientRect().right > documentElement.clientWidth`,
 *     never `scrollWidth` (which lies inside the frame's `overflow: hidden`) and
 *     never `innerWidth` (which Chrome's mobile emulation widens to swallow it).
 *   - a tap target's floor is on its SMALLER side.
 *
 * Run: node e2e/chats-row-capture.mjs [--out chats-evidence]
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const outDir = argOf('--out') ?? 'chats-evidence';
const SPACE = 'sp-atelier';
const MIN_TAP = 44;
const EPS = 0.5;

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/* The audit's own launcher, verbatim in spirit: an explicitly chosen port plus
   `--strictPort`, never `--port 0` — vite does not honour 0, falls back to its
   default, and a `strictPort`-less run can land on ANOTHER lane's dev server and
   photograph somebody else's app while reporting confidently. */
async function startVite() {
  const port = await freePort();
  const proc = spawn('./node_modules/.bin/vite', ['--port', String(port), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`vite silent in 30s:\n${buf}`)), 30_000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (m) {
        clearTimeout(t);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    proc.stderr.on('data', (d) => (buf += d));
    proc.on('exit', (c) => {
      clearTimeout(t);
      reject(new Error(`vite exited ${c}:\n${buf}`));
    });
  });
  return { base, stop: () => proc.kill('SIGTERM') };
}

const { base, stop } = await startVite();
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
const findings = [];

async function open(path) {
  /* about:blank between destinations: a hash-only change does not reload, and
     the shell would keep whatever it last rendered while this script
     photographed it as the new route. */
  await page.goto('about:blank');
  await page.goto(`${base}/mobile-audit.html#/s/${SPACE}/${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  try {
    await page.evaluate(() => document.fonts.ready);
  } catch {
    /* older engines */
  }
  await page.waitForTimeout(300);
}

/** The audit's two rules, run in the page. */
async function probe() {
  return page.evaluate(
    ({ min, eps }) => {
      const vw = document.documentElement.clientWidth;
      const overflow = [];
      const small = [];
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > vw + eps) overflow.push(`${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60));
      }
      for (const el of document.querySelectorAll('button, a, [role="button"], input, select')) {
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.pointerEvents === 'none' || st.opacity === '0') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (Math.min(r.width, r.height) < min - eps)
          small.push({ el: `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60), w: +r.width.toFixed(1), h: +r.height.toFixed(1) });
      }
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) };
      };
      return {
        viewportWidth: vw,
        overflowCount: overflow.length,
        overflowRoots: overflow.slice(0, 6),
        tapUnderMin: small.length,
        smallest: small.slice(0, 6),
        fab: box('.ev-fab'),
        drawerPanel: box('.mdrawer__panel'),
        menu: box('.mobile-header__menu'),
        tabBar: box('.mobile-tabs'),
        drawerRows: document.querySelectorAll('.mdrawer__row').length,
        /* Can you reach the entity menus without scrolling? That IS the report.
           `Work` is the first Entities group; measure its label against the
           panel's visible height. */
        firstEntityLabelTop: (() => {
          const n = [...document.querySelectorAll('.mdrawer__label')].find((e) => e.textContent === 'Work');
          return n ? +n.getBoundingClientRect().top.toFixed(1) : null;
        })(),
        drawerScrollHeight: (() => {
          const n = document.querySelector('.mdrawer__scroll');
          return n ? { client: n.clientHeight, scroll: n.scrollHeight } : null;
        })(),
        sheetRows: document.querySelectorAll('.mthreads__row').length,
        sheet: box('[data-testid="mobile-threads-sheet"] .msheet__panel'),
        drawerSections: [...document.querySelectorAll('.mdrawer__label')].map((n) => n.textContent),
        title: document.querySelector('.mobile-header__title')?.textContent ?? null,
      };
    },
    { min: MIN_TAP, eps: EPS },
  );
}

async function shoot(name, note) {
  const p = `${outDir}/${name}.png`;
  await page.screenshot({ path: p });
  const m = await probe();
  findings.push({ frame: name, note, ...m });
  console.log(`\n── ${name}  (${note})`);
  console.log(`   overflow=${m.overflowCount}  taps<${MIN_TAP}=${m.tapUnderMin}  title=${JSON.stringify(m.title)}`);
  console.log(`   tabBar=${JSON.stringify(m.tabBar)}  menu=${JSON.stringify(m.menu)}  fab=${JSON.stringify(m.fab)}`);
  if (m.drawerPanel) console.log(`   drawer=${JSON.stringify(m.drawerPanel)}  rows=${m.drawerRows}  sections=${JSON.stringify(m.drawerSections)}`);
  if (m.overflowCount) console.log(`   OVERFLOW ROOTS: ${JSON.stringify(m.overflowRoots)}`);
  if (m.tapUnderMin) console.log(`   UNDER FLOOR: ${JSON.stringify(m.smallest)}`);
  return m;
}


/* 1 — THE DRAWER, over a list screen. THE FRAME THE REPORT IS ABOUT: the Chats
       section is two fixed rows now, so "Destinations" and the first entity
       group are on screen without a scroll however many conversations exist. */
await open('k/tasks');
await page.click('[data-testid="mobile-drawer-menu"]');
await page.waitForTimeout(400);
const drawer = await shoot('chats-01-drawer', 'the drawer: Chats is two rows, entities reachable without scrolling');

/* 2 — THE CONVERSATION LIST, opened from that Chats row. Where the population
       that used to push the menu down now lives. */
await page.click('[data-testid="mobile-drawer-chats"]');
await page.waitForTimeout(500);
const sheet = await shoot('chats-02-sheet', 'the conversations sheet, full-height, opened from the drawer');

await browser.close();
stop();

const checks = [
  ['the drawer opened with its sections', drawer.drawerSections.length >= 3],
  ['the first entity group is ON SCREEN with the drawer freshly opened', drawer.firstEntityLabelTop !== null && drawer.firstEntityLabelTop < 844],
  ['the Chats row is there', drawer.drawerSections[0] === 'Chats'],
  ['the sheet opened and listed conversations', sheet.sheet !== null && sheet.sheetRows >= 1],
  ['nothing overflows on either frame', findings.every((f) => f.overflowCount === 0)],
];
console.log('\n════ VERDICT ════');
let bad = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`);
  if (!ok) bad++;
}
console.log(JSON.stringify(findings, null, 2));
writeFileSync(`${outDir}/findings.json`, JSON.stringify(findings, null, 2));
process.exit(bad ? 1 : 0);
