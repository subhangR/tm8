/**
 * capture-composer-fit — DOES THE PHONE COMPOSER MATCH COMPOSER-STATES §2 + §6?
 *
 * jsdom lays nothing out, so the 22n+10 field, the 5-line cap, "no scrollbar"
 * and "the foot never scrolls sideways" are only measurable in a browser.
 * Same fixture and phone context as `capture-chat-composer.mjs`.
 *
 * Per width it types 1, 3, 5 and 7 lines and reads the field's height, its
 * computed `overflow-y`, whether a scrollbar takes width, and the card's
 * height; then reads the foot: rows, height, each pill's width, Send's box
 * and disc, and the worst right edge against the card (with `--long` labels
 * the pills must ellipsize, not push). The desktop reading at 1440 is the
 * regression guard.
 *
 * Run it:  node e2e/capture-composer-fit.mjs [--long] [--shots <dir>]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const LONG = args.includes('--long');
const shotsAt = args.indexOf('--shots');
const SHOTS = shotsAt === -1 ? null : args[shotsAt + 1];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** Port 0: a busy `--port` dies silently and the driver measures another lane's tree. */
function startVite() {
  const proc = spawn('./node_modules/.bin/vite', ['--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const base = new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`vite silent in 30s:\n${buf}`)), 30_000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    proc.stderr.on('data', (d) => (buf += d));
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`vite exited ${code}:\n${buf}`)); });
  });
  return { base, stop: () => proc.kill('SIGTERM') };
}

const vite = startVite();
const base = await vite.base;
/* Stop vite however this ends — a launch failure (missing system libs on a
   headless host) would otherwise orphan it. */
let browser;
try {
browser = await chromium.launch();

async function probe(page, label, shot) {
  await page.waitForSelector('.ri-card textarea', { timeout: 20_000 });
  if (LONG) {
    await page.evaluate(() => {
      const values = document.querySelectorAll('.ri-card__foot .tch-pop__value');
      const long = ['Research deep', 'Opus 5.5 · High effort'];
      [...values].filter((v) => !v.closest('.tch-attach')).forEach((v, i) => { if (long[i]) v.textContent = long[i]; });
    });
  }
  const area = page.locator('.ri-card textarea').first();
  const field = {};
  for (const lines of [1, 3, 5, 7]) {
    await area.fill(Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n'));
    await page.waitForTimeout(80);
    field[lines] = await page.evaluate(() => {
      const a = document.querySelector('.ri-card textarea');
      const card = a.closest('.ri-card');
      const cs = getComputedStyle(a);
      return {
        height: a.getBoundingClientRect().height,
        lineHeight: cs.lineHeight,
        overflowY: cs.overflowY,
        capped: a.hasAttribute('data-capped'),
        scrollbarWidth: a.offsetWidth - a.clientWidth,
        card: Math.round(card.getBoundingClientRect().height * 10) / 10,
      };
    });
    if (shot && SHOTS && (lines === 3 || lines === 7)) await page.screenshot({ path: `${SHOTS}/${shot}-${lines}l.png` });
  }
  await area.fill('Ship the Return fix first');
  const foot = await page.evaluate(() => {
    const round = (n) => Math.round(n * 10) / 10;
    const foot = document.querySelector('.ri-card__foot');
    const card = foot.closest('.ri-card');
    const kids = [...foot.children].filter((k) => k.getBoundingClientRect().width > 1);
    const bands = [];
    for (const k of kids) {
      const r = k.getBoundingClientRect();
      const band = bands.find((b) => r.top < b.bottom && r.bottom > b.top);
      if (band) { band.top = Math.min(band.top, r.top); band.bottom = Math.max(band.bottom, r.bottom); }
      else bands.push({ top: r.top, bottom: r.bottom });
    }
    const cardRect = card.getBoundingClientRect();
    let worst = 0;
    for (const el of card.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && r.right > worst) worst = r.right;
    }
    const scrollers = [...foot.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1
      && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)).map((el) => el.className);
    const box = (sel) => {
      const el = foot.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: round(r.width), h: round(r.height) };
    };
    const send = foot.querySelector('.tch-send');
    const sendCs = send ? getComputedStyle(send) : null;
    return {
      rows: bands.length,
      footHeight: round(foot.getBoundingClientRect().height),
      order: kids.map((k) => `${k.className.split(' ')[0]}@${round(k.getBoundingClientRect().left)}`),
      attach: box('.tch-attach'),
      mode: box('.tch-picks .tch-pop__trigger'),
      model: box('.tch-pick--model .tch-pop__trigger'),
      send: box('.tch-send'),
      sendDisc: sendCs ? `${sendCs.backgroundClip} pad ${sendCs.padding}` : null,
      cardInner: round(foot.clientWidth),
      overflowRight: round(worst - cardRect.right),
      sideScrollers: scrollers,
    };
  });
  console.log(`\n== ${label} ==\n${JSON.stringify({ field, foot })}`);
}

for (const width of [360, 390, 430]) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${base}/chat-dev.html?shell=mobile&turns=4`);
  await probe(page, `PHONE ${width}${LONG ? ' (long labels)' : ''}`, `phone-${width}`);
  await ctx.close();
}
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${base}/chat-dev.html?turns=4`);
await probe(page, 'DESKTOP 1440', 'desktop');
} finally {
  await browser?.close();
  vite.stop();
}
