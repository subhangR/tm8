/**
 * PIXEL VERIFICATION FOR THE LAUNCH CARD.
 *
 * The card's contract is "content-sized, shed a label, never clip a control".
 * jsdom cannot evaluate a container query or measure a box, so the vitest
 * suite is silent on all of it. This script drives the SHIPPING popup in
 * Chromium and MEASURES the claim: the card's height, and every interactive
 * control's box against the card's box. Menus may hang past the card (they
 * are drawn over the scrim), so only controls on the card itself are held to
 * its edge.
 *
 * Usage: node e2e/capture-launch-card.mjs [origin] [out-dir]
 *   Reads /home/tm8/prod-data/tools/browser/launch.json when it exists (the
 *   prod node's headless Chromium needs its libs and pkey shim).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const origin = process.argv[2] ?? 'http://127.0.0.1:4612';
const OUT = process.argv[3] ?? 'gate-evidence/launch-card';
mkdirSync(OUT, { recursive: true });

const KIT = '/home/tm8/prod-data/tools/browser/launch.json';
const kit = existsSync(KIT) ? JSON.parse(readFileSync(KIT, 'utf8')) : null;
const { chromium } = kit
  ? createRequire(import.meta.url)(kit.playwright)
  : await import('@playwright/test');

const ONLY = process.env.SHOTS ? new RegExp(process.env.SHOTS) : null;
const SHOTS = [
  { name: '1440x900-light-empty', w: 1440, h: 900, q: '?attach=0' },
  { name: '1440x900-dark-empty', w: 1440, h: 900, q: '?attach=0&theme=dark' },
  { name: '1440x900-light-attached', w: 1440, h: 900, q: '?text=1' },
  { name: '1440x900-dark-attached', w: 1440, h: 900, q: '?text=1&theme=dark' },
  { name: '1440x900-light-launching', w: 1440, h: 900, q: '?text=1&launch=1' },
  { name: '1440x900-dark-launching', w: 1440, h: 900, q: '?text=1&launch=1&theme=dark' },
  { name: '1440x900-model-menu', w: 1440, h: 900, q: '?open=nsx-model' },
  { name: '1440x900-advanced-drawer', w: 1440, h: 900, q: '?drawer=1' },
  { name: '1024x768-attached', w: 1024, h: 768, q: '?text=1' },
  { name: '800x700-attached', w: 800, h: 700, q: '?text=1' },
  { name: '390x844-phone', w: 390, h: 844, q: '?text=1' },
  /* SHORT VIEWPORTS: more than fits — the stage scrolls, the bands stay in. */
  { name: '1440x480-long-notes', w: 1440, h: 480, q: '?text=long' },
  { name: '1440x480-long-notes-drawer', w: 1440, h: 480, q: '?text=long&drawer=1' },
  { name: '390x600-phone-long-notes', w: 390, h: 600, q: '?text=long' },
  { name: '1440x480-long-notes-attach-menu', w: 1440, h: 480, q: '?text=long&open=lcd3-attach' },
  { name: '1440x480-long-notes-group-menu', w: 1440, h: 480, q: '?text=long&open=lcd3-group-doc' },
];

/* Measured in the page: the card's box, and every control/menu box that
   escapes it.

   A control inside an open menu is CLIPPED BY THE MENU'S OWN SCROLLER, and a
   row scrolled below that scroller's fold is reachable, not lost — comparing
   its raw rect to the card reported a 535px "overflow" for the model menu's
   30-row list on the first run. So each box is first clamped to every
   clipping ancestor between it and the card; an empty result means "scrolled
   out of a scroller" and is skipped, and only what survives is held against
   the card. 0.5px of slack keeps sub-pixel borders from crying wolf. */
const measure = () => {
  const card = document.querySelector('[data-testid="launch-card"]');
  const cb = card.getBoundingClientRect();
  const SLACK = 0.5;
  const clips = (el) => {
    const s = getComputedStyle(el);
    return /auto|scroll|hidden|clip/.test(s.overflowX + s.overflowY);
  };
  const out = [];
  for (const el of card.querySelectorAll('button, input, textarea, select, [role="radio"]')) {
    if (el.closest('[role="menu"], [role="dialog"]:not(.nsx-popup)')) continue;   // menus hang over the scrim
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;          // hidden by a container query — shed, not clipped
    let box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    for (let a = el.parentElement; a && a !== card; a = a.parentElement) {
      if (!clips(a)) continue;
      const ar = a.getBoundingClientRect();
      box = {
        left: Math.max(box.left, ar.left), right: Math.min(box.right, ar.right),
        top: Math.max(box.top, ar.top), bottom: Math.min(box.bottom, ar.bottom),
      };
    }
    if (box.right - box.left <= 0 || box.bottom - box.top <= 0) continue;   // scrolled out, still reachable
    const over = {
      left: cb.left - box.left, right: box.right - cb.right,
      top: cb.top - box.top, bottom: box.bottom - cb.bottom,
    };
    const worst = Math.max(over.left, over.right, over.top, over.bottom);
    if (worst > SLACK) {
      out.push({
        el: el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 28),
        overflowPx: Math.round(worst),
        side: Object.entries(over).sort((a, b) => b[1] - a[1])[0][0],
      });
    }
  }
  return {
    card: { w: Math.round(cb.width), h: Math.round(cb.height) },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    clipped: out,
  };
};

const browser = kit
  ? await chromium.launch({ executablePath: kit.executablePath, env: { ...process.env, ...kit.env }, args: kit.args })
  : await chromium.launch({ channel: 'chrome' });
let bad = 0;

for (const shot of SHOTS.filter((s) => !ONLY || ONLY.test(s.name))) {
  const page = await browser.newPage({ viewport: { width: shot.w, height: shot.h } });
  await page.goto(`${origin}/e2e/launch-card-harness.html${shot.q}`);
  await page.waitForSelector('[data-testid="harness-ready"]', { state: 'attached' });
  await page.waitForTimeout(250);            // menu fit (`useFitInside`) runs on a frame
  const m = await page.evaluate(measure);
  if (m.clipped.length > 0) bad += 1;
  console.log(`${shot.name}: card ${m.card.w}x${m.card.h} in ${m.viewport.w}x${m.viewport.h} — ${m.clipped.length === 0 ? 'nothing clipped' : `CLIPPED ${JSON.stringify(m.clipped)}`}`);
  await page.screenshot({ path: `${OUT}/${shot.name}.png` });
  await page.close();
}

await browser.close();
console.log(bad === 0 ? 'PASS — no control escapes the card at any width' : `FAIL — ${bad} viewport(s) clip a control`);
process.exit(bad === 0 ? 0 : 1);
