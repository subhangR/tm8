/**
 * Lane 7 probe — open the phone Sessions tab, tap a session, and measure the
 * terminal surface. BEFORE/AFTER instrument for the phone terminal.
 *
 * Usage: node e2e/lane7-probe.mjs <port> <outDir>
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.argv[2];
const OUT = process.argv[3] || 'probe';
const url = `http://127.0.0.1:${PORT}/mobile-audit.html`;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const log = {};
log.shell = await page.evaluate(() => document.querySelector('[data-shell]')?.getAttribute('data-shell') ?? 'NONE');

for (const t of await page.$$('.mobile-tabs__tab')) {
  if ((await t.textContent())?.trim() === 'Sessions') { await t.tap(); break; }
}
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/01-sessions-list.png` });

/* Find the session row. The list is `lp__` (list panel); rows carry the entity
   id on a data attribute or are the only clickable things in the scroller. */
const rowInfo = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('[data-testid="list-tile"]')) {
    const r = el.getBoundingClientRect();
    out.push({
      text: (el.textContent || '').trim().slice(0, 50),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  return out;
});
log.rows = rowInfo;

/* Tap the title of the first LIVE session tile — a running verdict is the only
   one that mounts LiveTerminal (SessionCanvas's verdict switch). */
const titles = await page.$$('[data-testid="list-tile"] .pn-st__titleText');
if (titles.length) {
  await titles[0].tap();
  await page.waitForTimeout(2500);
}
log.tapped = titles.length ? (await titles[0].textContent()) : null;
log.hash = await page.evaluate(() => location.hash);
await page.screenshot({ path: `${OUT}/02-session-detail.png` });

log.terminal = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const rect = (el) => el ? (({ x, y, width, height, right, bottom }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height), right: Math.round(right), bottom: Math.round(bottom) }))(el.getBoundingClientRect()) : null;
  const host = q('.term-host');
  const cs = host ? getComputedStyle(host) : null;
  const firstRow = q('.xterm-rows > div');
  return {
    vw: document.documentElement.clientWidth,
    body: rect(q('.pn-terminal-body')),
    stage: rect(q('.pn-terminal-stage')),
    host: rect(host),
    hostZoom: cs?.zoom, hostMinHeight: cs?.minHeight, hostTouchAction: cs?.touchAction,
    evDetail: rect(q('.ev-detail')),
    xterm: rect(q('.xterm')),
    xtermRows: document.querySelectorAll('.xterm-rows > div').length,
    cellH: firstRow ? firstRow.getBoundingClientRect().height : null,
    screenText: (q('.xterm-screen') || {}).textContent?.slice(0, 80) ?? null,
    modBar: rect(q('.term-mod')),
    visualViewport: window.visualViewport ? { w: Math.round(window.visualViewport.width), h: Math.round(window.visualViewport.height) } : null,
  };
});

log.census = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const over = []; let worst = 0; const small = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    if (r.right > worst) worst = r.right;
    if (r.right > vw + 0.5) over.push({ p: el.tagName + '.' + String(el.className).split(' ')[0], right: Math.round(r.right) });
  }
  const taps = document.querySelectorAll('button,a[href],[role="button"],input,select,textarea');
  for (const el of taps) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    if (Math.min(r.width, r.height) < 44) small.push({ p: el.tagName + '.' + String(el.className).split(' ')[0], w: Math.round(r.width), h: Math.round(r.height), t: (el.textContent || '').trim().slice(0, 18) });
  }
  return { vw, overflowCount: over.length, worstRight: Math.round(worst), over: over.slice(0, 10), tapTotal: taps.length, tapUnder44: small.length, small: small.slice(0, 16) };
});

log.errors = errors.slice(0, 8);
writeFileSync(`${OUT}/probe.json`, JSON.stringify(log, null, 2));
console.log(JSON.stringify(log, null, 1));
await browser.close();
