// BOARD V2 — real-browser evidence for the universal board (NOT a spec — .mjs
// is outside the test glob).
//
// WHY IT EXISTS. The v2 board's claims split into two families jsdom cannot
// touch: LAYOUT (one-row chrome; workflow columns banded under category
// overlines) and REAL DRAG — the vitest suite fires synthetic dragstart/drop
// events at handlers, which proves the dispatch and structurally cannot prove
// the card enters the browser's HTML5 drag loop from a genuine mouse gesture.
// `page.dragAndDrop` drives real input here.
//
//   npx vite --port 4671          # in this package
//   OUT=gate-evidence node e2e/capture-board-v2.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT ?? '/tmp/board-v2-shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 940 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:4671/e2e/board-v2-harness.html', { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="b2-column"]', { timeout: 15000 });
await page.waitForTimeout(600);

const columnKeys = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="b2-column"]')].map((c) => c.dataset.column));

// 1) THE CATEGORY BOARD. The closed four in reading order, one row of chrome,
//    no uncategorised column for a fully-categorised kind.
console.log('CATEGORY COLUMNS:', JSON.stringify(await columnKeys()));
console.log('CHROME:', JSON.stringify(await page.evaluate(() => {
  const bar = document.querySelector('.b2__bar').getBoundingClientRect();
  const cols = document.querySelector('.b2__cols').getBoundingClientRect();
  const boxes = [...document.querySelectorAll('.b2__bar > *')]
    .map((el) => el.getBoundingClientRect())
    .sort((a, b) => a.top - b.top);
  let barRows = 1;
  let floor = boxes[0].bottom;
  for (const b of boxes.slice(1)) {
    if (b.top >= floor - 0.5) { barRows += 1; floor = b.bottom; }
    else floor = Math.min(floor, b.bottom);
  }
  return { barHeight: Math.round(bar.height), barRows, boardHeight: Math.round(cols.height) };
})));
await page.screenshot({ path: `${OUT}/board-v2-categories.png` });

// 2) REAL DRAG COMMIT. The guide-lines task rides a genuine mouse drag from
//    In Progress to To Do; the drop seam writes `open`, the ruled mapping
//    derives to_do, and the settled read keeps the card there.
const GUIDE = 'Session tree guide lines';
const inTodo = () =>
  page.evaluate((title) => {
    const col = [...document.querySelectorAll('[data-testid="b2-column"]')]
      .find((c) => c.dataset.column === 'to_do');
    return col ? col.textContent.includes(title) : false;
  }, GUIDE);
console.log('BEFORE DRAG — guide in to_do:', await inTodo());
await page.dragAndDrop(
  `[data-testid="b2-card"]:has-text("${GUIDE}")`,
  '[data-testid="b2-column"][data-column="to_do"]',
);
await page.waitForTimeout(900);
console.log('AFTER DRAG — guide in to_do:', await inTodo());
await page.screenshot({ path: `${OUT}/board-v2-after-drag.png` });

// 3) THE UNIVERSAL KIND SELECTOR: docs land in the honest 'No status yet'
//    column, category columns stay empty rather than borrowing them.
await page.getByTestId('b2-kind').click();
await page.getByTestId('b2-kind-doc').click();
await page.waitForSelector('[data-testid="b2-column"][data-column="uncategorised"]', { timeout: 10000 });
await page.waitForTimeout(400);
console.log('DOC COLUMNS:', JSON.stringify(await columnKeys()));
console.log('DOCS:', JSON.stringify(await page.evaluate(() => {
  const count = (key) => {
    const col = [...document.querySelectorAll('[data-testid="b2-column"]')]
      .find((c) => c.dataset.column === key);
    return col ? col.querySelectorAll('[data-testid="b2-card"]').length : null;
  };
  return { uncategorised: count('uncategorised'), in_progress: count('in_progress') };
})));
await page.screenshot({ path: `${OUT}/board-v2-docs-uncategorised.png` });

// 4) A REFUSED MOVE, VISIBLY: a real drag of a doc onto Cancelled must render
//    the reason at the refusing column and move nothing.
await page.dragAndDrop(
  '[data-testid="b2-column"][data-column="uncategorised"] [data-testid="b2-card"]',
  '[data-testid="b2-column"][data-column="cancelled"]',
);
await page.waitForTimeout(400);
console.log('REFUSAL:', JSON.stringify(await page.evaluate(() => {
  const refusal = document.querySelector('[data-testid="b2-refusal"]');
  const cancelled = [...document.querySelectorAll('[data-testid="b2-column"]')]
    .find((c) => c.dataset.column === 'cancelled');
  return {
    visible: refusal !== null,
    text: refusal?.textContent ?? null,
    atRefusingColumn: refusal ? cancelled.contains(refusal) : false,
    cancelledCards: cancelled.querySelectorAll('[data-testid="b2-card"]').length,
  };
})));
await page.screenshot({ path: `${OUT}/board-v2-doc-refusal.png` });

// 5) WORKFLOW COLUMNS, BANDED. Back on tasks, the global default's states
//    become the columns with category overlines.
await page.getByTestId('b2-kind').click();
await page.getByTestId('b2-kind-task').click();
await page.waitForTimeout(400);
await page.getByTestId('b2-workflow-toggle').click();
await page.waitForSelector('[data-testid="b2-col-band"]', { timeout: 10000 });
await page.waitForTimeout(400);
console.log('WORKFLOW COLUMNS:', JSON.stringify(await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="b2-column"]')].map((c) => ({
    key: c.dataset.column,
    band: c.querySelector('[data-testid="b2-col-band"]')?.textContent ?? null,
    label: c.querySelector('.kit-pill')?.textContent ?? null,
    cards: c.querySelectorAll('[data-testid="b2-card"]').length,
  })))));
await page.screenshot({ path: `${OUT}/board-v2-workflow-bands.png` });

// 6) ARCHIVED IS A FILTER: toggling swaps the rows, never the columns.
await page.getByTestId('b2-workflow-toggle').click();
await page.waitForTimeout(300);
await page.getByTestId('b2-filter-archived').click();
await page.waitForTimeout(600);
console.log('ARCHIVED:', JSON.stringify({
  columns: await columnKeys(),
  cards: await page.evaluate(() => document.querySelectorAll('[data-testid="b2-card"]').length),
}));
await page.screenshot({ path: `${OUT}/board-v2-archived-filter.png` });

console.log('PAGE ERRORS:', JSON.stringify(errors));
await browser.close();
