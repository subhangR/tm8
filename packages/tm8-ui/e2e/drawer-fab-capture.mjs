/**
 * CAPTURES FOR THE DRAWER + FAB CHANGE, at the acceptance viewport.
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
 * Run: node e2e/drawer-fab-capture.mjs [--out gate-evidence]
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const outDir = argOf('--out') ?? 'gate-evidence';
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

const measure = (selector) =>
  ({ selector, min: MIN_TAP, eps: EPS },
  undefined);

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

/* 1 — A LIST SCREEN WITH ITS FAB. `task` is `quickCreate: true`. */
await open('k/tasks');
const tasks = await shoot('drawer-fab-01-tasks-with-fab', 'Tasks: header ＋ kept, FAB added, no tab bar');

/* 2 — THE DRAWER OPEN, over that same screen. */
await page.click('[data-testid="mobile-drawer-menu"]');
await page.waitForTimeout(400);
const drawer = await shoot('drawer-fab-02-drawer-open', 'the drawer: Chats · Destinations · the rail groups · Settings + account');

/* 3 — A LIST SCREEN FOR A NO-CREATE KIND: NO FAB AT ALL. `work_session` is
       `quickCreate: false` — a session is started, not authored. */
await open('k/sessions');
const sessions = await shoot('drawer-fab-03-sessions-no-fab', 'Sessions: no wired create, so NO FAB — absent, not inert');

/* 4 — AND ONE THE BRIEF NAMED BY NAME, so the rule reads as a rule rather than
       as one kind's special case. */
await open('k/commits');
const commits = await shoot('drawer-fab-04-commits-no-fab', 'Commits: observed, not authored — NO FAB');

await browser.close();
stop();

/* ── THE VERDICT, STATED RATHER THAN LEFT TO A READER OF FOUR PNGs ────────── */
const checks = [
  ['no tab bar on any frame', findings.every((f) => f.tabBar === null)],
  ['the ☰ is on every frame and clears the floor', findings.every((f) => f.menu && Math.min(f.menu.w, f.menu.h) >= MIN_TAP - EPS)],
  ['Tasks draws a FAB, and it clears the floor', !!tasks.fab && Math.min(tasks.fab.w, tasks.fab.h) >= MIN_TAP - EPS],
  ['the FAB sits inside the viewport', !!tasks.fab && tasks.fab.right <= 390 + EPS],
  ['Sessions draws NO FAB', sessions.fab === null],
  ['Commits draws NO FAB', commits.fab === null],
  ['the drawer opened, with rows and sections', drawer.drawerRows > 10 && drawer.drawerSections.length >= 3],
  ['nothing overflows on any frame', findings.every((f) => f.overflowCount === 0)],
  ['no frame regressed a tap target below the floor beyond the known list rows', findings.every((f) => f.tapUnderMin <= 3)],
];
console.log('\n════ VERDICT ════');
let bad = 0;
for (const [what, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
}
writeFileSync(`${outDir}/drawer-fab-capture.json`, JSON.stringify({ viewport: '390x844 dpr3 mobile', findings, checks }, null, 1));
console.log(`\nwrote ${outDir}/drawer-fab-capture.json and ${findings.length} PNGs`);
process.exit(bad === 0 ? 0 : 1);
