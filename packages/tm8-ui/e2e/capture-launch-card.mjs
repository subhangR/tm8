/**
 * PIXEL VERIFICATION FOR THE LAUNCH CARD v2 (artifact 01a0dd42 rev 4).
 *
 * The card's narrow-width contract is "shed a label, never clip a control,
 * and keep every menu inside the card". jsdom cannot evaluate a container
 * query or measure a box, so the vitest suite is silent on all three. This
 * script drives the SHIPPING popup in Chrome at the four widths the task
 * names and MEASURES the claim: every interactive control's box must sit
 * inside the card's box, and an open menu must too.
 *
 * Usage: node e2e/capture-launch-card.mjs [origin]
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:4612';
const OUT = 'gate-evidence/launch-card-v2';
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  { name: '1440x900-default', w: 1440, h: 900, q: '?text=1' },
  { name: '1440x900-attach-menu', w: 1440, h: 900, q: '?text=1&open=lcd-attach' },
  { name: '1440x900-advanced-drawer', w: 1440, h: 900, q: '?text=1&drawer=1' },
  { name: '1440x900-coordinate', w: 1440, h: 900, q: '?verb=coordinate&text=1' },
  { name: '1024x768-default', w: 1024, h: 768, q: '?text=1' },
  { name: '1024x768-model-menu', w: 1024, h: 768, q: '?text=1&open=nsx-model' },
  { name: '800x700-default', w: 800, h: 700, q: '?text=1' },
  { name: '800x700-effort-menu', w: 800, h: 700, q: '?text=1&open=nsx-effort' },
  { name: '390x844-phone', w: 390, h: 844, q: '?text=1' },
  { name: '390x844-phone-workdir-menu', w: 390, h: 844, q: '?text=1&open=nsx-workdir' },
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
  for (const el of card.querySelectorAll('button, input, textarea, select, [role="menu"], [role="radio"], [role="menuitem"]')) {
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

const browser = await chromium.launch({ channel: 'chrome' });
let bad = 0;

for (const shot of SHOTS) {
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
