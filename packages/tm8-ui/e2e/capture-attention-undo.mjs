/**
 * PIXEL PROOF FOR THE UNDO TOAST (Attention v2 S0).
 *
 * jsdom asserted that the toast is in the DOM and that Undo sends the right
 * version. It cannot assert the part that actually broke first: the toast is a
 * flex row with a background, and its first draft reached for `--pn-surface-2`,
 * a token that does not exist — which renders a TRANSPARENT box that the unit
 * suite passes with flying colours. So this harness looks at it, in both themes,
 * and measures that the label and the button share one line.
 *
 *   DOCK_OUT=<dir> node e2e/capture-attention-undo.mjs
 *
 * Needs the harness served (see capture-attention-dock.mjs): port 4681.
 */
import { chromium } from '@playwright/test';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const SP = process.env.DOCK_OUT ?? await mkdtemp(join(tmpdir(), 'tm8-undo-'));
const BASE = 'http://127.0.0.1:4681/e2e/attention-dock-harness.html';
console.log('shots →', SP);

/* THE SYSTEM CHROME, by channel.
   Playwright's default is `chrome-headless-shell`, which this machine's cache
   does not carry, and its `chromium-1208` entry is INCOMPLETE — the launch dies
   in dlopen looking for a Framework that was never unpacked. Rather than
   download a third browser, drive the Chrome that is already installed.
   Override with PW_CHANNEL / PW_CHROMIUM. */
const b = await chromium.launch({
  ...(process.env.PW_CHROMIUM
    ? { executablePath: process.env.PW_CHROMIUM }
    : { channel: process.env.PW_CHANNEL ?? 'chrome' }),
  args: ['--no-sandbox', '--disable-gpu'],
});
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

for (const theme of ['light', 'dark']) {
  const ctx = await b.newContext({ viewport: { width: 760, height: 760 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  await p.goto(theme === 'dark' ? `${BASE}?theme=dark` : BASE, { waitUntil: 'load' });
  await p.waitForTimeout(1200);

  // The `pending` case has row `a` still open and auto-opens its sheet.
  const box = p.locator('[data-panel-box=pending]');
  const row = box.locator('[data-testid=attention-request-a]');
  await row.waitFor();
  check(`${theme}: row starts open`, (await row.getAttribute('data-status')) === 'open');

  await box.locator('[data-testid=attention-resolve-a]').click();
  await box.locator('[data-testid=attention-confirm-a]').click();

  const toast = box.locator('[data-testid=attention-undo]');
  await toast.waitFor({ timeout: 4000 });
  await p.waitForTimeout(250);
  await p.screenshot({ path: join(SP, `undo-toast-${theme}.png`), animations: 'disabled' });

  check(`${theme}: row now settled`, (await row.getAttribute('data-status')) === 'resolved');

  // GEOMETRY — the half jsdom cannot see.
  const g = await toast.evaluate((el) => {
    const act = el.querySelector('[data-testid=attention-undo-act]');
    const t = el.querySelector('.att-req__undo-text');
    const r = (x) => { const b = x.getBoundingClientRect(); return { t: b.top, b: b.bottom, h: b.height, w: b.width, l: b.left, r: b.right }; };
    const cs = getComputedStyle(el);
    return {
      toast: r(el), act: r(act), text: r(t),
      bg: cs.backgroundColor, border: cs.borderTopWidth,
      textContent: el.textContent.replace(/\s+/g, ' ').trim(),
    };
  });
  console.log(`  ${theme} geom:`, JSON.stringify(g));

  check(`${theme}: toast is visible (has size)`, g.toast.h > 10 && g.toast.w > 100, `${g.toast.w}x${g.toast.h}`);
  // THE TOKEN BUG THIS EXISTS TO CATCH: a bad var() yields transparent.
  check(`${theme}: toast has a real background`, g.bg !== 'rgba(0, 0, 0, 0)' && g.bg !== 'transparent', g.bg);
  check(`${theme}: toast has its hairline`, parseFloat(g.border) > 0, g.border);
  check(`${theme}: one line — label and button share a row`,
    g.act.t < g.text.b && g.text.t < g.act.b, `text ${g.text.t}-${g.text.b} vs act ${g.act.t}-${g.act.b}`);
  check(`${theme}: button is inside the toast`, g.act.r <= g.toast.r + 1 && g.act.l >= g.toast.l - 1);
  check(`${theme}: says what happened`, /Request resolved\./.test(g.textContent), g.textContent);

  // UNDO puts it back.
  await box.locator('[data-testid=attention-undo-act]').click();
  await p.waitForTimeout(600);
  check(`${theme}: Undo re-opened the row`, (await row.getAttribute('data-status')) === 'open');
  check(`${theme}: the offer cleared`, (await toast.count()) === 0);
  await p.screenshot({ path: join(SP, `undo-after-${theme}.png`), animations: 'disabled' });
  await ctx.close();
}

await b.close();
console.log(failures === 0 ? '\nALL PIXEL CHECKS PASSED' : `\n${failures} PIXEL CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
