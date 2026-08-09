/**
 * Capture the REORGANISED launch sheet (2026-08-09) from the shipping
 * component under the shipping stylesheet. jsdom proves DOM order; only a
 * layout engine settles the two claims that matter here:
 *   1. model / reasoning effort / permission mode are ABOVE THE FOLD, and
 *   2. a large teammate roster stays scroll-capped instead of pushing them
 *      off screen.
 *
 * Usage: node e2e/capture-launch-sheet.mjs [origin]
 */
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:4612';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });

for (const roster of ['small', 'big']) {
  await page.goto(`${origin}/e2e/launch-sheet-harness.html${roster === 'big' ? '?roster=big' : ''}`);
  await page.waitForSelector('[data-testid="harness-ready"]', { state: 'attached' });
  const sheet = page.locator('[data-testid="launch-sheet"]');
  await sheet.waitFor();

  const measurements = await page.evaluate(() => {
    const sheetBox = document.querySelector('[data-testid="launch-sheet"]').getBoundingClientRect();
    const body = document.querySelector('.ls__body');
    const y = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    };
    const roster = document.querySelector('.ls__roster');
    return {
      sheetBottom: Math.round(sheetBox.bottom),
      bodyScrollTop: body.scrollTop,
      tops: {
        teammateSearch: y('[data-testid="launch-teammate-search"]'),
        model: y('[data-testid="launch-model"]'),
        effort: y('[data-testid="launch-reasoning-effort"]'),
        permission: y('[data-testid="launch-access-mode"]'),
        directory: y('.ls__glyph'),
        sessionMode: y('[data-testid="launch-mode"]'),
        launchButton: y('.ls__launch'),
      },
      roster: roster
        ? { height: Math.round(roster.getBoundingClientRect().height), scrollHeight: roster.scrollHeight, rows: roster.querySelectorAll('[role="radio"]').length }
        : null,
    };
  });
  console.log(roster, JSON.stringify(measurements, null, 2));
  await sheet.screenshot({ path: `gate-evidence/launch-sheet-${roster}-roster.png` });

  if (roster === 'big') {
    await page.fill('[data-testid="launch-teammate-search"]', 'quill');
    await sheet.screenshot({ path: 'gate-evidence/launch-sheet-filtered.png' });
  }
}

await browser.close();
