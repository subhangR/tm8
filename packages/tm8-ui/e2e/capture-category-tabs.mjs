// PHASE 7 / PHASE 9 — standalone pixel capture for the four category tabs,
// the archive filter, and completed-vs-archived. (NOT a spec — `.mjs` is
// outside the test glob, so CI never runs it.)
//
// WHY IT EXISTS. The ~3,890 vitest assertions beside this run in jsdom, which
// LOADS NO STYLESHEETS AND HAS NO LAYOUT ENGINE. Everything below is a fact
// only a real engine can report, and each one is a way this change could be
// green and still wrong:
//
//   1. FOUR tabs where there were three, in a 280px side panel. "In Progress"
//      and "Cancelled" are both longer than "Open", "Done" or "Archived", and
//      each tab now carries an exact count beside it (`Page.total`). A tab row
//      that wraps, clips or scrolls horizontally is invisible to every
//      assertion in this repo.
//   2. COMPLETED vs ARCHIVED — collision C2. The two facts shared one class
//      and one strikethrough, so an archived task rendered as finished. The
//      unit test asserts two DIFFERENT CLASS NAMES; only a rendering engine
//      can assert they LOOK different, which is the thing that was actually
//      broken.
//   3. TAB FOCUS. `:focus-visible` NEVER matches a synthetic `.click()`, so no
//      test in this package can see whether the tab row is keyboard-reachable
//      and shows a ring when it is. This drives real key events through CDP.
//
// USAGE:
//   npx vite --port 4731 --strictPort        # in packages/tm8-ui
//   OUT=gate-evidence/category-tabs node e2e/capture-category-tabs.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const OUT = process.env.OUT ?? '/tmp/category-tabs-shots';
const PORT = process.env.PORT ?? '4731';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(`http://localhost:${PORT}/e2e/category-tabs-harness.html`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="entity-list-panel"]');
await page.waitForTimeout(600);

const panels = page.locator('.harness-panel');
const light = panels.nth(0);
const dark = panels.nth(1);
const drive = panels.nth(2);

const shot = async (name, locator) => {
  const file = join(OUT, `${name}.png`);
  await (locator ?? page).screenshot({ path: file });
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  console.log(`SHOT ${name}  sha256:${sha}`);
};

// ── 1) THE TAB ROW FITS ─────────────────────────────────────────────────────
// Four tabs, each with a count, inside 280px. The failure modes are wrap (row
// height grows past one line) and clip (a tab's right edge past the row's).
const fit = await light.evaluate((panel) => {
  const row = panel.querySelector('[role="tablist"]') ?? panel.querySelector('.lp__tabs');
  const tabs = [...panel.querySelectorAll('[role="tab"]')];
  const rowBox = row.getBoundingClientRect();
  const boxes = tabs.map((t) => t.getBoundingClientRect());
  return {
    tabCount: tabs.length,
    words: tabs.map((t) => t.textContent.trim()),
    rowHeight: Math.round(rowBox.height),
    // WRAP DETECTOR: every tab shares one top edge iff the row is one line.
    distinctTops: [...new Set(boxes.map((b) => Math.round(b.top)))].length,
    // CLIP DETECTOR: the last tab's right edge inside the row's.
    overflowRight: Math.round(Math.max(...boxes.map((b) => b.right)) - rowBox.right),
    scrollOverflow: row.scrollWidth - row.clientWidth,
    /* INTRA-TAB WRAP DETECTOR — the one the first run of this script did NOT
       have, and the defect it missed. The row stayed one line tall while each
       TAB's own label broke across two ("In / Progress 2"), so `distinctTops`
       and `rowHeight` both looked healthy. A tab whose height exceeds one line
       box has wrapped inside itself. */
    tabHeights: boxes.map((b) => Math.round(b.height)),
    lineHeight: Math.round(parseFloat(getComputedStyle(tabs[0]).lineHeight) || 0),
    wrappedTabs: tabs
      .filter((t) => t.getBoundingClientRect().height > (parseFloat(getComputedStyle(t).lineHeight) || 14) + 8)
      .map((t) => t.textContent.trim()),
    panelWidth: Math.round(panel.getBoundingClientRect().width),
  };
}, undefined);
console.log('TAB ROW FIT:', JSON.stringify(fit));
console.log(`TAB FIT VERDICT: ${fit.wrappedTabs.length === 0 && fit.distinctTops === 1 ? 'PASS' : 'FAIL'} — ` +
  'no tab wraps inside itself, and the row is one line');

// The footer's fourth count must be READABLE, not ellipsed off the end.
const foot = await light.evaluate((panel) => {
  const el = panel.querySelector('[data-testid="list-footer"]');
  return {
    text: el.textContent.trim(),
    clipped: el.scrollWidth > el.clientWidth + 1,
    height: Math.round(el.getBoundingClientRect().height),
  };
});
console.log('FOOTER:', JSON.stringify(foot));

// ── 2) EACH TAB, DRIVEN BY REAL CLICKS ──────────────────────────────────────
// Also the proof that CANCELLED left Done: the Done tab must NOT hold the
// cancelled row, and the Cancelled tab must, and only the Done one is struck.
for (const word of ['To Do', 'In Progress', 'Done', 'Cancelled']) {
  await light.getByRole('tab', { name: new RegExp(`^${word}`) }).click();
  await page.waitForTimeout(220);
  const rows = await light.evaluate((panel) =>
    [...panel.querySelectorAll('[data-testid="list-tile"] .pn-tt__title')].map((e) => e.textContent.trim()));
  const struck = await light.evaluate((panel) =>
    [...panel.querySelectorAll('[data-testid="list-tile"]')]
      .filter((t) => getComputedStyle(t.querySelector('.pn-tt__title') ?? t).textDecorationLine.includes('line-through'))
      .map((t) => t.querySelector('.pn-tt__title')?.textContent.trim()));
  console.log(`TAB ${word.padEnd(12)} rows=${JSON.stringify(rows)} struck=${JSON.stringify(struck)}`);
  await shot(`2-tab-${word.toLowerCase().replace(/\s+/g, '-')}`, light);
}

// ── 3) COMPLETED vs ARCHIVED ARE DIFFERENT PIXELS ───────────────────────────
// Collision C2, measured by a rendering engine. The archive filter COMPOSES
// with whichever category tab is open — the question the old tab row could not
// ask at all — so this walks both archived rows by driving the tab underneath
// the chip and reading the computed style of each.
await drive.locator('[data-testid="filter-trigger"]').click();
await page.getByRole('menuitemcheckbox', { name: 'Archived only' }).click();
await page.waitForTimeout(300);

const treatments = {};
for (const [word, title, key] of [
  ['To Do', 'Archived, never started', 'archivedToDo'],
  ['Done', 'Archived after finishing', 'archivedDone'],
]) {
  await drive.getByRole('tab', { name: new RegExp(`^${word}`) }).click();
  await page.waitForTimeout(250);
  treatments[key] = await page.evaluate((wanted) => {
    const panel = document.querySelectorAll('.harness-panel')[2];
    const tile = [...panel.querySelectorAll('[data-testid="list-tile"]')]
      .find((el) => el.textContent.includes(wanted));
    if (!tile) return { title: wanted, present: false };
    const titleEl = tile.querySelector('.pn-tt__title') ?? tile;
    return {
      title: wanted,
      present: true,
      classes: tile.className,
      textDecorationLine: getComputedStyle(titleEl).textDecorationLine,
      tileOpacity: getComputedStyle(tile).opacity,
    };
  }, title);
  await shot(`3-archived-${word.toLowerCase().replace(/\s+/g, '-')}`, drive);
}
console.log('ARCHIVED TREATMENTS:', JSON.stringify(treatments, null, 1));

// The one-line verdict this whole file exists for.
const c2 =
  treatments.archivedToDo?.textDecorationLine === 'none' &&
  treatments.archivedToDo?.tileOpacity === '0.62' &&
  treatments.archivedDone?.textDecorationLine?.includes('line-through') &&
  treatments.archivedDone?.tileOpacity === '0.62';
console.log(`C2 VERDICT: ${c2 ? 'PASS' : 'FAIL'} — archived-to_do is dimmed and NOT struck; ` +
  'archived-done is dimmed AND struck (two orthogonal axes, two treatments)');

// ── 4) :focus-visible, DRIVEN BY REAL KEYS ──────────────────────────────────
// A synthetic `.click()` NEVER produces `:focus-visible`. Tab in from the
// document and read whether the focused tab actually matches the selector.
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('Tab');
let focusReport = null;
for (let i = 0; i < 40; i += 1) {
  focusReport = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el.getAttribute('role') !== 'tab') return null;
    return {
      word: el.textContent.trim(),
      focusVisible: el.matches(':focus-visible'),
      outlineWidth: getComputedStyle(el).outlineWidth,
      boxShadow: getComputedStyle(el).boxShadow,
    };
  });
  if (focusReport) break;
  await page.keyboard.press('Tab');
}
console.log('KEYBOARD FOCUS ON A TAB:', JSON.stringify(focusReport));
await shot('4-tab-focus-visible', page);

// ── 5) THE REFERENCE SHOTS ──────────────────────────────────────────────────
await shot('1-four-tabs-light', light);
await shot('1-four-tabs-dark', dark);
await shot('0-full-harness', page);

console.log('PAGE ERRORS:', errors.length === 0 ? 'none' : JSON.stringify(errors, null, 1));
await browser.close();
if (errors.length > 0) process.exit(1);
