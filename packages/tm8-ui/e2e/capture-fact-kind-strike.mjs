// FACT KINDS ARE NOT COMPLETED WORK — standalone pixel capture (NOT a spec;
// `.mjs` is outside the test glob).
//
// WHY IT EXISTS. The unit tests beside this run in jsdom, which loads no
// stylesheets and computes no style. They can prove a class is or is not on an
// element; they cannot prove a TITLE IS NOT STRUCK THROUGH, which is the whole
// claim. That gap is not hypothetical here — the defect this captures (every
// artifact, memory, file, message and commit rendered as completed work,
// because migration 152 seeds those kinds into `status_category = 'done'` so a
// fact about the past cannot hold a `depends_on` open) shipped past ~3,900
// green tests and was found by looking at prod.
//
// `getComputedStyle(el).textDecorationLine` in a real engine also answers the
// half a class check cannot: `text-decoration` INHERITS down from an ancestor
// block, so a rule on a row wrapper strikes a title carrying no class at all.
//
//   npx vite --port 4620                      # in this package
//   node e2e/capture-fact-kind-strike.mjs
//
// On a host with no system Chrome, point CHROME at a downloaded build:
//   CHROME=~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
//   CHROME_FLAGS=--single-process node e2e/capture-fact-kind-strike.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT ?? 'gate-evidence/fact-kind-strike';
const PORT = process.env.PORT ?? '4620';
mkdirSync(OUT, { recursive: true });

const launch = process.env.CHROME
  ? { executablePath: process.env.CHROME, args: (process.env.CHROME_FLAGS ?? '').split(' ').filter(Boolean) }
  : { channel: 'chrome' };
const browser = await chromium.launch(launch);
const ctx = await browser.newContext({ viewport: { width: 1420, height: 760 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${PORT}/e2e/fact-kind-strike-harness.html`, {
  waitUntil: 'networkidle',
});
await page.waitForSelector('.lp__title, .pn-tt__title');

/** Every rendered row title, with the decoration a real engine computes. */
const rows = await page.evaluate(() =>
  [...document.querySelectorAll('.lp__title, .pn-tt__title, .pn-st__title')].map((el) => ({
    title: (el.textContent ?? '').trim(),
    decoration: getComputedStyle(el).textDecorationLine,
    // The archived axis, which SURVIVES: two facts, two treatments (C2).
    dimmed: Number(getComputedStyle(el).opacity) < 1
      || el.closest('.pn-tt--archived, .pn-st--archived') !== null
      || el.classList.contains('lp__title--archived'),
  })),
);
console.log('ROWS:', JSON.stringify(rows, null, 1));

const struck = rows.filter((r) => r.decoration.includes('line-through'));
console.log('STRUCK:', JSON.stringify(struck));
console.log('DIMMED:', JSON.stringify(rows.filter((r) => r.dimmed).map((r) => r.title)));
if (errors.length) console.log('PAGE ERRORS:', JSON.stringify(errors));

await page.screenshot({ path: `${OUT}/00-light.png` });
await page.goto(`http://127.0.0.1:${PORT}/e2e/fact-kind-strike-harness.html?theme=dark`, {
  waitUntil: 'networkidle',
});
await page.waitForSelector('.lp__title, .pn-tt__title');
await page.screenshot({ path: `${OUT}/01-dark.png` });

await browser.close();
// The gate: no row title in either list may compute a line-through, and at
// least the archived task must still come back dimmed — a run where NOTHING is
// dimmed is a harness that failed to render, not a clean result.
if (struck.length > 0) {
  console.error(`FAIL — ${struck.length} title(s) struck through`);
  process.exit(1);
}
if (!rows.some((r) => r.dimmed)) {
  console.error('FAIL — nothing dimmed; the archived row did not render (C2 unverified)');
  process.exit(1);
}
console.log(`PASS — ${rows.length} titles, none struck through`);
