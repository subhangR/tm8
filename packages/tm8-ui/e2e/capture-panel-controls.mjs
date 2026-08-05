/**
 * MEASURES the detail panel's control strip in a REAL browser — the check
 * jsdom structurally cannot perform, and the one the reported defect needed:
 * "the drop downs [are] in vertical, they should be in a single row".
 *
 * A vitest case can assert the class that selects the row layout. Only a
 * browser can say whether the four controls actually share one line, and only
 * a browser can catch the refusal caption that turns one row into two.
 *
 *   node e2e/capture-panel-controls.mjs [uiOrigin]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const ui = process.argv[2] ?? 'http://127.0.0.1:4661';
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

for (const kind of ['task', 'work_session', 'doc']) {
  await page.goto(`${ui}/e2e/entity-view-harness.html?kind=${kind}`, { waitUntil: 'networkidle' });
  // The detail region starts on the blank state; open the first row, the way
  // a user reaches the panel.
  await page.waitForSelector('[data-testid="list-tile"]', { timeout: 15_000 });
  await page.locator('[data-testid="list-tile"]').first().click();
  await page.waitForSelector('[data-testid="entity-detail-panel"]', { timeout: 15_000 });

  report[kind] = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="entity-detail-panel"]');
    const band = document.querySelector('[data-testid="panel-controls"]');
    const strip = document.querySelector('.lp__rowdetail');
    const tabs = document.querySelector('[data-testid="panel-toolbar"]');
    const body = panel?.querySelector('.pn-body');
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) };
    };

    // THE ROW TEST: every direct child of the strip must share one line band.
    let rows = null;
    if (strip) {
      const tops = [...strip.children].map((c) => Math.round(c.getBoundingClientRect().top));
      rows = { distinctTops: [...new Set(tops)].length, children: tops.length };
    }

    return {
      bandPresent: band != null,
      stripTop: box(strip)?.top ?? null,
      stripHeight: box(strip)?.h ?? null,
      tabsBottom: tabs ? Math.round(tabs.getBoundingClientRect().bottom) : null,
      bodyTop: box(body)?.top ?? null,
      /* below the tabs and above the body, or (terminal) above the tabs */
      placement: !strip
        ? 'none'
        : box(strip).top >= (tabs?.getBoundingClientRect().bottom ?? 0)
          ? 'below-tabs'
          : 'above-tabs',
      rows,
    };
  });

  await page.screenshot({ path: `${OUT}/panel-controls-${kind}.png` });
}

report.pageErrors = errors;
console.log(JSON.stringify(report, null, 2));
await browser.close();
