/**
 * MEASURE THE COLLAPSED DEFAULT IN A REAL BROWSER.
 *
 * The vitest suites prove the row counts, but they run in jsdom, which has no
 * layout engine and no stylesheets — it cannot tell you that the caret is
 * actually drawn, that opening a subtree does not overflow the column, or that
 * the shipped shell (not a component in isolation) lands collapsed. This mounts
 * the WHOLE shell over the fixture seam via `work-tab-harness`, which is
 * gate-free, and measures rather than eyeballs.
 *
 * Usage: node e2e/measure-tree-collapse.mjs [origin]
 */
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:4655';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const target = process.argv[3] ?? '/e2e/entity-view-harness.html?kind=task';
await page.goto(`${origin}${target}`);
await page.waitForSelector('.lp__tree', { timeout: 15000 });
await page.waitForTimeout(600);

/** Every disclosure control, by the accessible-name grammar all four tiles share. */
const CONTROLS = 'button[aria-label*=" child"], [role="button"][aria-label*=" child"]';

const snapshot = async () =>
  page.evaluate((sel) => {
    const tiles = [...document.querySelectorAll('[data-testid="list-tile"]')];
    const controls = [...document.querySelectorAll(sel)];
    const panel = document.querySelector('.lp__scroll') ?? document.querySelector('.lp');
    return {
      tiles: tiles.length,
      depths: [...new Set(tiles.map((t) => t.getAttribute('data-depth')))].sort(),
      childGroups: document.querySelectorAll('[data-testid="list-tile-children"]').length,
      controls: controls.map((c) => ({
        label: c.getAttribute('aria-label'),
        expanded: c.getAttribute('aria-expanded'),
        // A control nobody can hit is not an affordance. Real box, on screen.
        w: Math.round(c.getBoundingClientRect().width),
        h: Math.round(c.getBoundingClientRect().height),
      })),
      // The point of collapsing: the list must not be a wall. Measured as
      // "does the panel need to scroll to show what it drew".
      overflowsX: panel ? panel.scrollWidth > panel.clientWidth + 1 : null,
    };
  }, CONTROLS);

const before = await snapshot();
console.log('COLLAPSED (as landed):', JSON.stringify(before, null, 2));

// Open the first shut subtree, exactly as a viewer would.
const shut = page.locator(`${CONTROLS}`).filter({ hasNot: page.locator('nothing') });
const firstShut = page.locator('[aria-expanded="false"][aria-label*=" child"]').first();
const hadShut = (await firstShut.count()) > 0;
if (hadShut) {
  const label = await firstShut.getAttribute('aria-label');
  await firstShut.click();
  await page.waitForTimeout(300);
  const after = await snapshot();
  console.log(`\nAFTER CLICKING "${label}":`, JSON.stringify(after, null, 2));

  // And that it SURVIVES A RELOAD — the "maintains that" half of the ruling.
  await page.reload();
  await page.waitForSelector('.lp__tree', { timeout: 15000 });
  await page.waitForTimeout(600);
  const reloaded = await snapshot();
  console.log('\nAFTER RELOAD:', JSON.stringify(reloaded, null, 2));
} else {
  console.log('\nNO SHUT SUBTREE FOUND — the fixture list may be flat here.');
}

await page.screenshot({ path: 'e2e/out/tree-collapse.png', fullPage: false });
await browser.close();
console.log('\nshut controls found:', shut === null ? 0 : undefined);
