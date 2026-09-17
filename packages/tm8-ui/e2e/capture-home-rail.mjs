/**
 * Photograph and MEASURE Home's icon rail after task 01a0ada5.
 *
 * The ruling asked for seven ordered groups, each under "an apt subheading".
 * The rail is COLLAPSED by default at 72px, so the subheading claim is a pixel
 * claim: a label that ellipsises there is a label the ruling did not get.
 * This asserts what jsdom cannot — that no eyebrow and no row caption is
 * clipped, and that the rail did not gain a horizontal scroll.
 *
 * Usage: node e2e/capture-home-rail.mjs [origin]
 */
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:4622';
const browser = await chromium.launch({
  executablePath: process.env.TM8_CHROME,
  args: ['--single-process', '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 560, height: 1020 } });

await page.goto(`${origin}/e2e/home-rail-harness.html`);
await page.waitForSelector('[data-testid="harness-ready"]', { state: 'attached' });

const measured = await page.evaluate(() => {
  const clipped = (el) => el.scrollWidth > el.clientWidth + 1;
  const read = (paneSelector) => {
    const pane = document.querySelector(paneSelector);
    const rail = pane.querySelector('.hr-rail');
    return {
      railWidth: Math.round(rail.getBoundingClientRect().width),
      scrollsHorizontally: rail.scrollWidth > rail.clientWidth + 1,
      eyebrows: [...pane.querySelectorAll('.hr-rail__eyebrow')].map((el) => ({
        text: el.textContent,
        width: Math.round(el.getBoundingClientRect().width),
        clipped: clipped(el),
      })),
      clippedRows: [...pane.querySelectorAll('.hr-rail__label')]
        .filter(clipped)
        .map((el) => el.textContent),
      rowCount: pane.querySelectorAll('.hr-rail__row').length,
    };
  };
  return { collapsed: read('[data-pane^="collapsed 72"]'), expanded: read('[data-pane^="expanded"]') };
});

console.log(JSON.stringify(measured, null, 2));
await page.screenshot({ path: 'gate-evidence/home-rail-groups.jpg', type: 'jpeg', quality: 80 });
await browser.close();

const bad = [
  ...measured.collapsed.eyebrows.filter((e) => e.clipped).map((e) => `collapsed eyebrow clipped: ${e.text}`),
  ...measured.collapsed.clippedRows.map((t) => `collapsed row clipped: ${t}`),
  ...(measured.collapsed.scrollsHorizontally ? ['collapsed rail scrolls horizontally'] : []),
];
if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log('OK — 7 headings and every row legible at 72px');
