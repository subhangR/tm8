/**
 * capture-chat-composer — IS THE PHONE'S COMPOSER FOOT ONE SMOOTH ROW, AND WHAT
 * DOES IT COST THE CANVAS?
 *
 * WHY AN INSTRUMENT AND NOT A TEST. Every field below is layout, and jsdom
 * loads no stylesheets: `getBoundingClientRect()` there is all zeros, so the
 * whole suite is green whether the foot is one 48px row or three wrapped ones
 * with Send pushed past the frame. Same reasoning as `capture-chat-scroll.mjs`,
 * and the same 390x844 phone context — `isMobile`/`hasTouch` matter, without
 * them `shellFor` hands back the desktop shell and the numbers describe a
 * screen nobody has.
 *
 * THE FIELDS THAT MATTER:
 *
 *   `footRows` — distinct `top` values among the foot's children. Anything
 *     above 1 means the row wrapped, which is the defect the touch floor
 *     introduced and the scrolling strip was meant to end.
 *   `footHeight` / `pickHeight` — the chrome this row spends. The report is
 *     "too height"; these are the number behind it.
 *   `overflowRight` — the worst right edge inside the composer against the
 *     frame's 390. `.mobile-frame` is `overflow: hidden`, so anything over is
 *     CLIPPED, not scrolled to.
 *   `teammateValueShown` — whether the teammate trigger still spends width on
 *     its name when the avatar beside it already answers "which teammate".
 *   `tray` — the entity chip strip above the composer: present, its height, and
 *     whether its own chips overflow.
 *
 * THE FIXTURE'S LABELS ARE SHORT ("Sonnet 4.5"), and the reported screen ran
 * "Opus 5 Teammate". `--long` overwrites the trigger values with realistic ones
 * before measuring, because the squeeze is what this is about and short labels
 * do not squeeze.
 *
 * Run it:  node e2e/capture-chat-composer.mjs [turns] [--shots <dir>] [--long]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const TURNS = Number(args.find((a) => /^\d+$/.test(a)) ?? 12);
const shotsAt = args.indexOf('--shots');
const SHOTS = shotsAt === -1 ? null : args[shotsAt + 1];
const LONG = args.includes('--long');

/** Port 0 so this can never bind a port another lane's vite is serving — a busy
 *  `--port` dies silently and the driver then measures somebody else's tree. */
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
/* THE SWEEP IS THE POINT, not 390 alone. `.tch-picks` scrolls, so a foot that
   overflows at 320 looks identical at 390 to one that does not — the defect
   exists at both and MANIFESTS at one, which is the argument
   `chat-home.css`'s own tray note makes for measuring more than one width.
   320 is the narrowest phone still shipped, 430 the widest common one. */
const WIDTHS = [320, 360, 390, 430];
let ctx;
let page;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function read(url, label, shot) {
  await page.goto(url);
  await page.waitForSelector('.ri-card__foot', { timeout: 20_000 });
  if (LONG) {
    await page.evaluate(() => {
      const long = {
        'tch-teammate': 'Opus 5 1M Teammate',
        'tch-model': 'Claude Opus 4.6 (1M context)',
      };
      for (const [id, text] of Object.entries(long)) {
        const el = document.querySelector(`[data-testid='${id}'] .tch-pick__value`);
        if (el) el.textContent = text;
      }
    });
  }
  await page.waitForTimeout(900);
  if (shot && SHOTS) await page.screenshot({ path: `${SHOTS}/${shot}.png` });

  const probe = await page.evaluate(() => {
    const round = (n) => Math.round(n * 10) / 10;
    const foot = document.querySelector('.ri-card__foot');
    if (!foot) return { error: 'no .ri-card__foot' };
    const footRect = foot.getBoundingClientRect();
    const kids = [...foot.children].filter((k) => k.getBoundingClientRect().width > 0);
    /* ROWS BY OVERLAP, NOT BY `top`. The foot's children are different heights
       and centre-align, so distinct `top` values count three rows for one row of
       three controls. Two items share a row when their vertical spans overlap. */
    const bands = [];
    for (const k of kids) {
      const r = k.getBoundingClientRect();
      const band = bands.find((b) => r.top < b.bottom && r.bottom > b.top);
      if (band) {
        band.top = Math.min(band.top, r.top);
        band.bottom = Math.max(band.bottom, r.bottom);
      } else bands.push({ top: r.top, bottom: r.bottom });
    }

    const pick = document.querySelector('.tch-pick__trigger');
    const send = document.querySelector('.tch-send');
    const attach = foot.querySelector('.tch-attach, .hon-disabled');
    const picks = document.querySelector('.tch-picks');
    const card = document.querySelector('.tch-composer');
    const cardRect = card?.getBoundingClientRect();

    /* The frame clips at `overflow: hidden`, so the honest reference is the
       composer CARD's own box — anything painting past it is either clipped by
       an ancestor or spilling onto the paper. */
    let worstRight = 0;
    let offender = null;
    if (cardRect) {
      for (const el of card.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        /* SKIP WHAT SCROLLS. `.tch-picks` is a scrolling strip by design, so its
           children sitting past its right edge is the arrangement working, not
           an overflow — counting them reported 79px of "overflow" that no
           reader can see. What a scroller owes is that IT fits; its content is
           reachable by the finger. */
        if (picks && picks.contains(el) && el !== picks) continue;
        if (r.right > worstRight) {
          worstRight = r.right;
          offender = `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
        }
      }
    }

    const teammateValue = document.querySelector("[data-testid='tch-teammate'] .tch-pick__value");
    const tray = document.querySelector('.tch-tray');
    const trayTabs = document.querySelector('.tch-tray__tabs');

    return {
      footRows: bands.length,
      footHeight: round(footRect.height),
      footChildren: kids.map((k) => `${k.tagName.toLowerCase()}.${[...k.classList].join('.') || '—'}`),
      pickHeight: pick ? round(pick.getBoundingClientRect().height) : null,
      sendHeight: send ? round(send.getBoundingClientRect().height) : null,
      attachHeight: attach ? round(attach.getBoundingClientRect().height) : null,
      picksScrollable: picks ? picks.scrollWidth - picks.clientWidth : null,
      cardWidth: cardRect ? round(cardRect.width) : null,
      cardRight: cardRect ? round(cardRect.right) : null,
      worstRight: round(worstRight),
      overflowRight: cardRect ? round(worstRight - cardRect.right) : null,
      overflowOffender: offender,
      teammateValueShown: teammateValue
        ? getComputedStyle(teammateValue).display !== 'none'
        : null,
      teammateValueWidth: teammateValue
        ? round(teammateValue.getBoundingClientRect().width)
        : null,
      tray: tray
        ? {
            height: round(tray.getBoundingClientRect().height),
            chips: document.querySelectorAll('.tch-tray__tab').length,
            tabsScrollOverflow: trayTabs ? trayTabs.scrollWidth - trayTabs.clientWidth : null,
          }
        : null,
      /* What the transcript is left with once the chrome has taken its cut. */
      transcriptHeight: round(
        document.querySelector('.tch-transcript')?.getBoundingClientRect().height ?? 0,
      ),
    };
  });
  console.log(`\n== ${label} ==\n${JSON.stringify(probe, null, 2)}`);
  return probe;
}

for (const width of WIDTHS) {
  ctx = await browser.newContext({
    viewport: { width, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  page = await ctx.newPage();
  await read(
    `${base}/chat-dev.html?shell=mobile&turns=${TURNS}`,
    `PHONE ${width} · ${TURNS} turns`,
    `phone-composer-${width}`,
  );
  await read(
    `${base}/chat-dev.html?shell=mobile&empty=1`,
    `PHONE ${width} · new conversation`,
    `phone-composer-welcome-${width}`,
  );
  await ctx.close();
}

/* The desktop reading is the regression guard: none of this may move it. */
ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
page = await ctx.newPage();
await read(`${base}/chat-dev.html?turns=${TURNS}`, `DESKTOP 1440 · ${TURNS} turns`, 'desktop-composer');

await browser.close();
vite.stop();
