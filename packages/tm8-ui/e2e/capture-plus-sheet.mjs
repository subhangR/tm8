/**
 * capture-plus-sheet — IS THE PHONE CARD CLEAN, AND IS ＋ THE MOCKUP'S SHEET?
 *
 * Chat v2 mockup 01a14cba (t-clean-composer): the card holds only the field
 * and the foot; a staged file and an enabled skill are listed in the ＋ sheet
 * as "Attached to this message · N" (48px rows, ✕ each), then the Add grid of
 * 72px tiles four to a row, and N is the badge on ＋. Per phone width this
 * stages a file by drop, enables a skill through the sheet, and reads the
 * sheet and the card. The desktop reading at 1440 is the regression guard:
 * chips and pills in the card, the team chip in the foot, no sheet body.
 *
 * Run it:  node e2e/capture-plus-sheet.mjs [--shots <dir>]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
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


/** Stage one file the way a drop does, then enable a skill through the sheet. */
async function stage(page) {
  await page.waitForSelector('.ri-card textarea', { timeout: 20_000 });
  await page.evaluate(() => {
    const area = document.querySelector('.ri-card textarea');
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(412 * 1024)], 'screenshot-drawer.png', { type: 'image/png' }));
    area.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
}

async function probe(page, label, shot) {
  await stage(page);
  const round = (n) => Math.round(n * 10) / 10;
  await page.click('[data-testid="tch-add"]');
  await page.click('[data-testid="tch-add-skills"]');
  await page.click('[data-testid="tch-add-skill-skill-1"]');
  await page.click('.tch-addsheet__back');
  await page.waitForTimeout(150);
  if (shot && SHOTS) await page.screenshot({ path: `${SHOTS}/${shot}-sheet.png` });
  const sheet = await page.evaluate(() => {
    const round = (n) => Math.round(n * 10) / 10;
    const body = document.querySelector('[data-testid="tch-add-body"]');
    const rect = (el) => { const r = el.getBoundingClientRect(); return { w: round(r.width), h: round(r.height) }; };
    const labels = [...body.querySelectorAll('.tch-addsheet__label')].map((l) => l.textContent);
    const rows = [...body.querySelectorAll('.tch-addsheet__item')].map((r) => ({
      ...rect(r), name: r.querySelector('b').textContent, meta: r.querySelector('i').textContent,
      x: rect(r.querySelector('.tch-addsheet__x')),
    }));
    const tiles = [...body.querySelectorAll('.tch-addsheet__tile')].map((t) => ({ t: t.textContent, ...rect(t) }));
    const cols = new Set(tiles.map((_, i) => Math.round(body.querySelectorAll('.tch-addsheet__tile')[i].getBoundingClientRect().left))).size;
    const fonts = [...body.querySelectorAll('*')].map((el) => getComputedStyle(el).fontSize);
    return {
      labels, rows, tiles, cols,
      overflowX: round(body.scrollWidth - body.clientWidth),
      fontSizes: [...new Set(fonts)],
    };
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const card = await page.evaluate(() => {
    const card = document.querySelector('.tch-composer');
    const plus = card.querySelector('[data-testid="tch-add"]').getBoundingClientRect();
    const badge = card.querySelector('[data-testid="tch-add-badge"]');
    const b = badge?.getBoundingClientRect();
    return {
      chipsInCard: card.querySelectorAll('.ri-attachments__list, .tch-turnpills, .tch-team, .ri-attachment').length,
      toolbar: [...card.querySelectorAll('button[aria-label]')].map((x) => x.getAttribute('aria-label')),
      badge: badge ? { text: badge.textContent, w: b.width, h: b.height, dx: Math.round(b.right - plus.right), dy: Math.round(b.top - plus.top) } : null,
      cardHeight: Math.round(card.getBoundingClientRect().height * 10) / 10,
    };
  });
  console.log(`\n== ${label} ==\n${JSON.stringify({ card, sheet })}`);
}

async function probeDesktop(page) {
  await stage(page);
  await page.click('[data-testid="tch-add"]');
  await page.click('[data-testid="tch-add-skill-skill-1"]');
  await page.keyboard.press('Escape');
  const card = await page.evaluate(() => {
    const card = document.querySelector('.tch-composer');
    return {
      attachmentChips: card.querySelectorAll('.ri-attachment').length,
      turnpills: card.querySelectorAll('.tch-turnpills .tch-pill').length,
      teamChip: Boolean(card.querySelector('.tch-team')),
      badge: card.querySelector('[data-testid="tch-add-badge"]')?.textContent ?? null,
      sheetBody: Boolean(document.querySelector('[data-testid="tch-add-body"]')),
    };
  });
  console.log(`\n== DESKTOP 1440 ==\n${JSON.stringify(card)}`);
}

for (const width of [360, 390, 430]) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${base}/chat-dev.html?shell=mobile&turns=4&attach=1`);
  await probe(page, `PHONE ${width}`, `phone-${width}`);
  await ctx.close();
}
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${base}/chat-dev.html?turns=4&attach=1`);
await probeDesktop(page);
} finally {
  await browser?.close();
  vite.stop();
}
