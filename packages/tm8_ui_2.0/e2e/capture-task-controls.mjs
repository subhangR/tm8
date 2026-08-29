/**
 * Drives the task panel's control strip in a REAL browser and reports what it
 * sees — the check jsdom structurally cannot perform.
 *
 *   node e2e/capture-task-controls.mjs [uiOrigin]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const ui = process.argv[2] ?? 'http://127.0.0.1:4699';
const OUT = 'gate-evidence';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--single-process'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const report = {};
const url = (q) => `${ui}/e2e/task-controls-harness.html${q}`;

/** Is it actually on screen and big enough to hit? Layout, not existence. */
async function usable(locator) {
  const box = await locator.boundingBox();
  if (!box) return { visible: false };
  return { visible: box.width > 0 && box.height > 0, w: Math.round(box.width), h: Math.round(box.height) };
}

// ---- 1. A working task: all three controls present, sized, and dispatching --
await page.goto(url('?status=working'), { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="row-state-select"]', { timeout: 15_000 });

report.state = await usable(page.locator('[data-testid="row-state-select"]'));
report.priority = await usable(page.locator('[data-testid="row-value-select"]'));
report.assign = await usable(page.locator('[data-testid="row-assign-trigger"]'));

report.stateOptions = await page.$$eval(
  '[data-testid="row-state-select"] option',
  (os) => os.map((o) => o.value),
);
report.priorityOptions = await page.$$eval(
  '[data-testid="row-value-select"] option',
  (os) => os.map((o) => o.value),
);

// The grid must NOT restate what the strip owns.
report.gridText = await page.locator('[data-testid="subtree-grid"]').innerText().catch(() => '');
report.gridRepeatsPriority = /URGENT|HIGH|MEDIUM|LOW/.test(report.gridText);

await page.selectOption('[data-testid="row-value-select"]', 'high');
await page.selectOption('[data-testid="row-state-select"]', 'blocked');
await page.click('[data-testid="row-assign-trigger"]');
await page.waitForTimeout(150);
report.assignMenu = await page.$$eval('.lp__assignmenu button', (bs) => bs.map((b) => b.textContent.trim()));
await page.locator('.lp__assignmenu button').first().click();

await page.screenshot({ path: `${OUT}/task-controls-working.png` });

// ---- 2. A DONE task: `open` is offered, and it takes the WORK verb ---------
await page.goto(url('?status=done'), { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="row-state-select"]');
report.doneCurrent = await page.inputValue('[data-testid="row-state-select"]');
report.doneOffersOpen = (
  await page.$$eval('[data-testid="row-state-select"] option', (os) => os.map((o) => o.value))
).includes('open');
await page.selectOption('[data-testid="row-state-select"]', 'open');
await page.waitForTimeout(120);
report.reopenLog = await page.locator('[data-testid="harness-log"]').innerText();
await page.screenshot({ path: `${OUT}/task-controls-done-reopen.png` });

// ---- 3. An ARCHIVED task: the tombstone's Restore actually restores --------
await page.goto(url('?archived=1'), { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="panel-tombstone"]');
report.archivedHasStrip = (await page.locator('[data-testid="row-state-select"]').count()) > 0;
const restore = page.locator('[data-testid="tombstone-restore"]');
report.restore = await usable(restore);
report.restoreIsButton = await restore.evaluate((el) => el.tagName);
await restore.click();
await page.waitForTimeout(120);
report.restoreLog = await page.locator('[data-testid="harness-log"]').innerText();
await page.screenshot({ path: `${OUT}/task-controls-archived.png` });

report.pageErrors = errors;
console.log(JSON.stringify(report, null, 2));
await browser.close();
