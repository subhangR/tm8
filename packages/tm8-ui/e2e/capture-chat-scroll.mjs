/**
 * capture-chat-scroll — CAN THE READER REACH THE CONVERSATION, AND WHERE DOES
 * IT OPEN?
 *
 * WHY THIS EXISTS AS AN INSTRUMENT AND NOT AS A TEST. Both questions are pure
 * layout, and jsdom answers neither: it loads no stylesheets and lays nothing
 * out, so `scrollHeight`, `clientHeight` and every rect in that environment are
 * 0. The whole tm8-ui suite was green across both of the defects this measures.
 * `phone-chat-defects.test.tsx` guards the SOURCE lines in CI; this produces the
 * numbers that say whether the surface actually behaves.
 *
 * THE TWO FIELDS THAT MATTER:
 *
 *   `firstTurnHiddenAboveTop` — scroll the transcript as far up as it will go,
 *     then measure how much of the FIRST turn is still above the box's own top
 *     edge. Anything above 0 is history no gesture can reach. This is the field
 *     that caught `justify-content: center` on a scroller (task 01a01c3f): a
 *     centred flex column distributes NEGATIVE free space too, parking half the
 *     overflow above `scrollTop: 0`. It read 2607 on a 30-turn thread at 390px
 *     and reads -18 (the transcript's own top padding) with the rule gone.
 *
 *   `openedAtBottom` — a chat opens at its newest turn or it is wrong. Read
 *     false on the same build: there was no scroll code on the screen at all.
 *
 * `?turns=N` IS LOAD-BEARING. The 3-turn fixture FITS inside an 844px phone, so
 * a scroller with no overflow has no defect to show and every field above reads
 * healthy. Absence measured as health is the failure mode `MobileShell`'s own
 * docblock records for the inbox; the length is what makes this a measurement.
 *
 * Run it:  node e2e/capture-chat-scroll.mjs [turns] [--shots <dir>]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const TURNS = Number(args.find((a) => /^\d+$/.test(a)) ?? 30);
const shotsAt = args.indexOf('--shots');
const SHOTS = shotsAt === -1 ? null : args[shotsAt + 1];

/** Port 0 so this can never bind a port another lane's vite is serving — a
 *  busy `--port` dies silently and the driver then measures somebody else's
 *  tree, which is a whole class of wrong answer. */
function startVite() {
  const proc = spawn('./node_modules/.bin/vite', ['--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`vite silent in 30s:\n${buf}`)), 30_000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    proc.stderr.on('data', (d) => (buf += d));
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`vite exited ${code}:\n${buf}`));
    });
  });
  return { base, stop: () => proc.kill('SIGTERM') };
}

const vite = startVite();
const base = await vite.base;
const browser = await chromium.launch({ channel: 'chrome' });
/* `isMobile`/`hasTouch` as well as the viewport: without them `shellFor` hands
   back the DESKTOP shell at 390px and every number is about a screen no user
   has. Same reasoning as `capture-list-chrome.mjs`. */
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function read(url, label, shot) {
  await page.goto(url);
  await page.waitForSelector('.tch-transcript', { timeout: 20_000 });
  await page.waitForTimeout(1200);
  if (shot && SHOTS) await page.screenshot({ path: `${SHOTS}/${shot}.png` });
  const probe = await page.evaluate(() => {
    const el = document.querySelector('.tch-transcript');
    if (!el) return { error: 'no .tch-transcript' };
    const max = el.scrollHeight - el.clientHeight;
    const settled = el.scrollTop;
    el.scrollTop = 0;
    const first = el.firstElementChild;
    const firstRect = first?.getBoundingClientRect();
    const boxRect = el.getBoundingClientRect();
    const out = {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      maxScrollTop: max,
      overflows: max > 0,
      settledScrollTop: Math.round(settled),
      openedAtBottom: max <= 0 ? null : Math.abs(settled - max) <= 2,
      justifyContent: getComputedStyle(el).justifyContent,
      firstTurnHiddenAboveTop: Math.round(boxRect.top - (firstRect?.top ?? boxRect.top)),
      firstTurnText: (first?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 48),
    };
    el.scrollTop = settled;
    return out;
  });
  console.log(`\n== ${label} ==\n${JSON.stringify(probe, null, 2)}`);
  if (shot && SHOTS) {
    await page.evaluate(() => { document.querySelector('.tch-transcript').scrollTop = 0; });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/${shot}-at-beginning.png` });
  }
  return probe;
}

await read(`${base}/chat-dev.html?shell=mobile&turns=${TURNS}`, `PHONE · ${TURNS} turns`, 'phone-chat-opened');
await read(`${base}/chat-dev.html?shell=mobile&empty=1`, 'PHONE · new conversation', 'phone-chat-welcome');
await read(`${base}/chat-dev.html?turns=${TURNS}`, `DESKTOP · ${TURNS} turns`);

await browser.close();
vite.stop();
