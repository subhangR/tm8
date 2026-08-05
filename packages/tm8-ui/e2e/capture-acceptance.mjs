/**
 * Capture the ACCEPTANCE region of the task detail panel from the SHIPPING
 * component under the SHIPPING stylesheet — jsdom has no layout engine, so the
 * vitest suite can prove the criteria are rendered and structurally cannot
 * prove they are legible.
 *
 * Usage: node e2e/capture-acceptance.mjs [origin]
 */
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:4612';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(`${origin}/e2e/entity-view-harness.html?kind=task`);
await page.waitForSelector('[data-testid="harness-ready"]');
await page.locator('[data-testid="list-tile"]').first().click();

const section = page.locator('[data-testid="acceptance-section"]').first();
await section.waitFor({ timeout: 20000 });

const box = await section.boundingBox();
const rows = await page.locator('[data-testid="acceptance-row"]').count();
const text = (await section.innerText()).replace(/\n/g, ' | ');
const boxes = await page
  .locator('[data-testid="acceptance-section"] input[type=checkbox]')
  .evaluateAll((els) =>
    els.map((e) => ({ checked: e.checked, disabled: e.disabled, w: e.getBoundingClientRect().width })),
  );
const grid = (await page.locator('[data-testid="subtree-grid"]').first().innerText()).replace(/\n/g, ' | ');
// Region order is a claim about DOCUMENT POSITION, which only a layout engine settles.
const order = await page.evaluate(() => {
  const y = (sel) => document.querySelector(sel)?.getBoundingClientRect().top ?? null;
  return {
    grid: y('[data-testid="subtree-grid"]'),
    description: y('[data-testid="task-description-editor"]'),
    acceptance: y('[data-testid="acceptance-section"]'),
    subtree: y('[data-testid="subtree-section"]'),
  };
});

// The READ evidence is captured BEFORE the write, so the region shot still
// shows the state the measurements above describe.
await section.screenshot({ path: 'gate-evidence/acceptance-region.png' });
await page.locator('[data-testid="entity-detail-panel"]').first().screenshot({ path: 'gate-evidence/acceptance-panel.png' });

/**
 * THE WRITE, ACTUALLY PERFORMED. The PR body claimed a real click → Save
 * round-tripped the entity through the seam, and nothing committed did it: this
 * script measured a region and stopped. A claim no artefact reproduces is not
 * evidence, so the round trip is now part of the capture.
 *
 * The version is read from the footer's own `v{n}` control, not from the seam,
 * because the point is that the SCREEN moved — a patch the panel never re-read
 * would leave that number where it was.
 */
const versionNow = async () => {
  const label = await page
    .locator('[data-testid="entity-detail-panel"] [aria-label^="Version "]')
    .first()
    .getAttribute('aria-label');
  return Number(/^Version (\d+)/.exec(label ?? '')?.[1] ?? NaN);
};

const versionBefore = await versionNow();
const firstOpen = page
  .locator('[data-testid="acceptance-row"]')
  .filter({ has: page.locator('input[type=checkbox]:not(:checked)') })
  .first();
const criterionText = (await firstOpen.innerText()).trim();
await firstOpen.locator('input[type=checkbox]').click();
await page.locator('[data-testid="authoring-save"]').first().click();
await page.waitForFunction(
  (was) => {
    const el = document.querySelector('[data-testid="entity-detail-panel"] [aria-label^="Version "]');
    return el !== null && Number(/^Version (\d+)/.exec(el.getAttribute('aria-label') ?? '')?.[1]) > was;
  },
  versionBefore,
  { timeout: 20000 },
);
const roundTrip = {
  criterion: criterionText,
  versionBefore,
  versionAfter: await versionNow(),
  checkedAfter: await page
    .locator('[data-testid="acceptance-section"] input[type=checkbox]')
    .evaluateAll((els) => els.map((e) => e.checked)),
  textAfter: (await section.innerText()).replace(/\n/g, ' | '),
};

console.log(JSON.stringify({ box, rows, text, boxes, grid, order, roundTrip }, null, 2));

await section.screenshot({ path: 'gate-evidence/acceptance-region-after-save.png' });
await browser.close();
