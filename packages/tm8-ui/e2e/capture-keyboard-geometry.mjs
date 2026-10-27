/**
 * capture-keyboard-geometry — DOES THE PHONE CHAT MATCH COMPOSER-STATES §1? (t-safe)
 *
 * Per width (360/390/430) on the empty phone chat, two states:
 *
 *   down — 844px tall, `--mobile-safe-bottom: 34px` (an iPhone home indicator).
 *          The dock should sit 10 + 34 above the bottom, and the hero should be
 *          a 58px mark, a 22/28 h1 and a 14px caption.
 *   up   — 544px tall (a 300px keyboard that resized the viewport, as Android
 *          does under `interactive-widget=resizes-content`), with the frame
 *          marked `data-keyboard="up"`. The dock should sit 10 above the bottom
 *          with no safe-area term, the mark and caption should be gone, and the
 *          h1 should be 17px muted.
 *
 * The harness mounts no `.mobile-frame`, so the probe wraps the surface in
 * one (`display: contents`, inside `.cv2-root`, as the app nests it). `MobileFrame` sets that attribute in the app; the
 * keyboard-geometry unit test covers that part. This file only measures layout.
 *
 * Run it:  node e2e/capture-keyboard-geometry.mjs [--shots <dir>]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const shotsAt = args.indexOf('--shots');
const SHOTS = shotsAt === -1 ? null : args[shotsAt + 1];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

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
let browser;
try {
  browser = await chromium.launch();

  async function read(page) {
    return page.evaluate(() => {
      const round = (n) => Math.round(n * 10) / 10;
      const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
      const card = document.querySelector('.tch-composer');
      const mark = document.querySelector('.tch-welcome__mark');
      const h1 = document.querySelector('.tch-welcome h1');
      const p = document.querySelector('.tch-welcome p');
      const h1cs = getComputedStyle(h1);
      return {
        viewport: innerHeight,
        dockGap: round(innerHeight - card.getBoundingClientRect().bottom),
        cardTop: round(card.getBoundingClientRect().top),
        mark: vis(mark) ? round(mark.getBoundingClientRect().height) : 'hidden',
        h1: `${h1cs.fontSize}/${h1cs.lineHeight} ${h1cs.color}`,
        h1Bottom: round(h1.getBoundingClientRect().bottom),
        caption: vis(p) ? `${getComputedStyle(p).fontSize} "${p.textContent}"` : 'hidden',
        sideScroll: document.documentElement.scrollWidth > innerWidth,
      };
    });
  }

  for (const width of [360, 390, 430]) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`${base}/chat-dev.html?shell=mobile&empty=1`);
    await page.waitForSelector('.tch-welcome h1', { timeout: 20_000 });
    await page.waitForSelector('.tch-composer', { timeout: 20_000 });
    await page.evaluate(() => {
      const root = document.querySelector('.cv2-root');
      root.style.setProperty('--mobile-safe-bottom', '34px');
      /* The frame the app would mount: one element BETWEEN the root and the
         surface. The surface's parent is `.cv2-root` itself, so marking the
         parent made the root the frame and `.cv2-root .mobile-frame[...]`
         never matched — every "up" number was the down layout. A new
         `display: contents` wrapper is a descendant and moves nothing. */
      const surface = root.querySelector('.tch-root');
      const frame = document.createElement('div');
      frame.className = 'mobile-frame';
      frame.style.display = 'contents';
      surface.before(frame);
      frame.append(surface);
    });
    await page.waitForTimeout(150);
    const down = await read(page);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/kbd-down-${width}.png` });

    await page.setViewportSize({ width, height: 544 });
    await page.evaluate(() => document.querySelector('.mobile-frame').setAttribute('data-keyboard', 'up'));
    await page.locator('.ri-card textarea').first().focus();
    await page.waitForTimeout(150);
    /* Refuse to report an "up" row the keyboard rules did not reach. */
    const matched = await page.evaluate(() => !!document.querySelector(".cv2-root[data-shell='mobile'] .mobile-frame[data-keyboard='up'] .tch-composer-wrap"));
    if (!matched) throw new Error(`phone ${width}: the data-keyboard='up' selector matches nothing — the "up" numbers would be the down layout`);
    const up = await read(page);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/kbd-up-${width}.png` });
    console.log(`\n== PHONE ${width} ==\ndown ${JSON.stringify(down)}\nup   ${JSON.stringify(up)}`);
    await ctx.close();
  }

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/chat-dev.html?empty=1`);
  await page.waitForSelector('.tch-welcome h1', { timeout: 20_000 });
  await page.waitForTimeout(150);
  console.log(`\n== DESKTOP 1440 ==\n${JSON.stringify(await read(page))}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-1440.png` });
} finally {
  await browser?.close();
  vite.stop();
}
