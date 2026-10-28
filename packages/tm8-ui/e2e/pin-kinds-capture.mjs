/**
 * CAPTURES FOR THE PIN KINDS SHEET (task 01a14ccc), at 360, 390 and 430.
 *
 * Same fixture harness and launcher as `drawer-fab-capture.mjs`. Per width: the
 * drawer scrolled to Pinned, the sheet open over it, one switch flipped, and
 * the drawer again after the sheet closes — with the sheet's stacking, the
 * overflow rule and the 44px floor measured beside each frame.
 *
 * Run: node e2e/pin-kinds-capture.mjs [--out gate-evidence]
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

const { base, stop } = await startVite();
mkdirSync(outDir, { recursive: true });
const findings = [];
/* Vite is stopped however this ends — a browser that fails to launch must not
   leave a dev server running on a host every lane shares. */
let browser;
try {
  browser = await chromium.launch();

  /** The audit's two rules plus the boxes this change is about, run in the page. */
  const probe = (page) =>
    page.evaluate(
      ({ min, eps }) => {
        const vw = document.documentElement.clientWidth;
        const overflow = [];
        const small = [];
        for (const el of document.querySelectorAll('.mdrawer *, .msheet *')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.right > vw + eps) overflow.push(`${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60));
        }
        for (const el of document.querySelectorAll(
          '.mdrawer__pinkinds, [data-testid="mobile-drawer-pin-kinds"], .mpins__row--toggle, .msheet__close',
        )) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (Math.min(r.width, r.height) < min - eps) small.push({ el: el.className, w: r.width, h: r.height });
        }
        const box = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            w: +r.width.toFixed(1),
            h: +r.height.toFixed(1),
            top: +r.top.toFixed(1),
            z: getComputedStyle(el).zIndex,
          };
        };
        /* Is the sheet the topmost thing at its own centre? */
        const panel = document.querySelector('.msheet__panel');
        let sheetOnTop = null;
        if (panel) {
          const r = panel.getBoundingClientRect();
          sheetOnTop = panel.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        }
        return {
          vw,
          overflow: overflow.slice(0, 6),
          overflowCount: overflow.length,
          small,
          pinKinds: box('[data-testid="mobile-drawer-pin-kinds"]'),
          sheet: box('.msheet'),
          sheetOnTop,
          switches: document.querySelectorAll('.mpins__row--toggle').length,
          fixed: document.querySelectorAll('.mpins__fixed').length,
          pinned: [...document.querySelectorAll('[data-testid="mobile-drawer-pinned"] .mdrawer__tree')].map(
            (n) => n.dataset.kind,
          ),
        };
      },
      { min: MIN_TAP, eps: EPS },
    );

  for (const width of [360, 390, 430]) {
    const ctx = await browser.newContext({
      viewport: { width, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/mobile-audit.html#/s/${SPACE}/k/tasks`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.click('[data-testid="mobile-drawer-menu"]');
    await page.waitForTimeout(400);
    await page.locator('[data-testid="mobile-drawer-pin-kinds"]').scrollIntoViewIfNeeded();
    const shot = async (name) => {
      await page.screenshot({ path: `${outDir}/pin-kinds-${width}-${name}.png` });
      const m = await probe(page);
      findings.push({ width, frame: name, ...m });
      console.log(`${width} ${name}: ${JSON.stringify(m)}`);
      return m;
    };
    await shot('1-drawer-pinned');
    await page.click('[data-testid="mobile-drawer-pin-kinds"]');
    await page.waitForTimeout(400);
    await shot('2-sheet');
    const off = page.locator('.mpins__row--toggle[aria-checked="false"]').first();
    const kind = await off.getAttribute('data-kind');
    await off.click();
    await page.waitForTimeout(300);
    const toggled = await shot('3-toggled-' + kind);
    await page.click('.msheet__close');
    await page.waitForTimeout(300);
    const after = await shot('4-back-in-drawer');
    const stored = await page.evaluate((s) => localStorage.getItem(`tm8.workspace.rail-pins:${s}`), SPACE);
    findings.push({
      width,
      kind,
      stored,
      pinnedAfter: after.pinned.includes(kind),
      drawerStillOpen: !!(await page.$('.mdrawer')),
    });
    console.log(`${width}: pinned ${kind}; storage=${stored}; inDrawer=${after.pinned.includes(kind)}`);
    await ctx.close();
  }
} finally {
  await browser?.close();
  stop();
}
writeFileSync(`${outDir}/pin-kinds-findings.json`, JSON.stringify(findings, null, 2));
