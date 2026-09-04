// PHASE 8 — the row action cluster, measured in a REAL browser.
//
// WHY. jsdom loads no stylesheets, so every vitest beside this one can say
// WHICH controls are in the cluster and in what DOM order, and none of them can
// say that the order is the order a user SEES. Those are different claims: the
// cluster is a flex row, its members are absolutely-positioned-on-hover in one
// anatomy, and a `flex-direction` or an `order` property anywhere in the chain
// reverses the visible sequence while the DOM stays exactly as asserted. So the
// order below is read off `getBoundingClientRect().left`, not off the DOM.
//
// It also exercises the tick with a REAL mouse click through CDP rather than a
// JS `.click()`, for the reason PR #340 recorded: a scripted `.click()` does not
// produce the hover/focus state a pointer does, so it can report a control as
// working that a finger or a mouse cannot reach.
//
//   npx vite --port 4621          # in this package
//   OUT=<dir> node e2e/capture-cluster-order.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT ?? '/tmp/cluster-evidence';
const PORT = process.env.PORT ?? '4621';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/e2e/cluster-harness.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

/** Every cluster member, LEFT TO RIGHT by geometry, with its box. */
const readOrder = (columnLabel) =>
  page.evaluate((label) => {
    const col = [...document.querySelectorAll('.harness-col')]
      .find((c) => c.querySelector('.harness-cap')?.textContent === label);
    const cluster = col.querySelector('.lp__cluster');
    return [...cluster.children]
      .map((el) => {
        const box = el.getBoundingClientRect();
        const name =
          el.getAttribute('data-action')
          ?? (el.className.includes('lp__assignwrap') ? 'collections' : null)
          ?? el.getAttribute('aria-label')
          ?? el.querySelector('[aria-label]')?.getAttribute('aria-label')
          ?? el.tagName.toLowerCase();
        return { name, left: Math.round(box.left), w: Math.round(box.width), h: Math.round(box.height) };
      })
      .sort((a, b) => a.left - b.left);
  }, columnLabel);

for (const label of [
  'task · control-card · light',
  'work_session · session-tree · NO archive · light',
  'doc · standard · light',
]) {
  // Hover reveals the cluster in every anatomy; without it the boxes are real
  // but the opacity is 0, and a zero-opacity control is not evidence.
  const col = page.locator('.harness-col', { has: page.locator(`.harness-cap:text-is("${label}")`) });
  await col.locator('[data-testid="list-tile"]').first().hover();
  await page.waitForTimeout(200);
  const order = await readOrder(label);
  console.log(`\n${label}`);
  console.log('  visual order:', order.map((m) => m.name).join(' → '));
  console.log('  boxes:', JSON.stringify(order.map((m) => [m.name, m.w, m.h])));
  /* One shot per anatomy WHILE IT IS HOVERED — the full-page shot at the end
     can only ever show the last column hovered, and an un-hovered cluster is
     at opacity 0. */
  await col.screenshot({ path: `${OUT}/cluster-${label.split(' ')[0]}.png` });
}

// THE TICK, clicked with a real mouse. The harness logs what its executor was
// handed, so "complete → <id>" in the log is the whole claim: the verb reached
// `onComplete` and not the session-start dispatcher (which logs `complete → …`
// through `onAction` only if the dedicated prop was NOT used — so the two are
// told apart by the harness wiring, which passes both).
const taskCol = page.locator('.harness-col', {
  has: page.locator('.harness-cap:text-is("task · control-card · light")'),
});
await taskCol.locator('[data-testid="list-tile"]').first().hover();
await page.waitForTimeout(150);
await taskCol.locator('[data-action="complete"]').first().click();
await page.waitForTimeout(250);
console.log('\nTICK CLICK → harness log:', JSON.stringify(await taskCol.locator('.harness-log').textContent()));

// TERMINATE, same treatment, on the session anatomy.
const sessionCol = page.locator('.harness-col', {
  has: page.locator('.harness-cap:text-is("work_session · session-tree · NO archive · light")'),
});
await sessionCol.locator('[data-testid="list-tile"]').first().hover();
await page.waitForTimeout(150);
await sessionCol.locator('[data-action="terminate"]').first().click();
await page.waitForTimeout(250);
console.log('TERMINATE CLICK → harness log:', JSON.stringify(await sessionCol.locator('.harness-log').textContent()));

// NO OVERFLOW at the real 280px panel width: the cluster must not push the
// title out or wrap onto a second line. Measured against the PANEL, because
// `scrollWidth` lies under `overflow: hidden`.
console.log('\nFIT:', JSON.stringify(await page.evaluate(() => {
  const out = [];
  for (const col of document.querySelectorAll('.harness-col')) {
    const panel = col.querySelector('.harness-panel');
    const cluster = col.querySelector('.lp__cluster');
    if (!cluster) continue;
    const p = panel.getBoundingClientRect();
    const c = cluster.getBoundingClientRect();
    out.push({
      col: col.querySelector('.harness-cap').textContent.slice(0, 34),
      overflowRight: Math.round(c.right - p.right),
      clusterH: Math.round(c.height),
      members: cluster.children.length,
    });
  }
  return out;
})));

await page.screenshot({ path: `${OUT}/cluster-order.png`, fullPage: true });
console.log('\npage errors:', errors.length === 0 ? 'none' : errors);
await browser.close();
