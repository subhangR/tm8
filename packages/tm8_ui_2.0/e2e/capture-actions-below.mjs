// Standalone pixel-evidence capture (NOT a spec — .mjs is outside the test glob).
// D3 acceptance: hover actions anchor BELOW the message row. The proof shot is
// the LAST message row in the feed — a bottom-anchored overlay there can clip
// against the scroll container or be occluded by the composer; a middle-row
// capture proves nothing. Run: node e2e/capture-actions-below.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:4612';
const OUT = 'gate-evidence';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1492, height: 812 } });
const page = await ctx.newPage();

// Surface scenario: live seam, working composer — post a message so the LAST
// row of the feed is a real message row with hover actions.
await page.goto(`${BASE}/e2e/m7-harness.html?scenario=surface`);
await page.getByRole('tab', { name: 'Chat' }).click();
const feed = page.getByRole('region', { name: 'Chat history' });
await feed.waitFor();

const input = page.locator('.chs-composer__input');
await input.click();
await input.fill('D3 acceptance: this must be the last row');
await input.press('Enter');
await page.waitForTimeout(400);

// Force the feed to OVERFLOW so it is a real internal scroll container. The
// overlay CSS under test is untouched; only the container is constrained.
await page.addStyleTag({ content: '.chs-feed { max-height: 320px; }' });
// Scroll the feed itself fully to the bottom — the clipping case under test.
await feed.evaluate((el) => { el.scrollTop = el.scrollHeight; });
await page.waitForTimeout(200);

const lastRow = page.locator('.chs-list > .chs-row').last();
await lastRow.hover();
await page.waitForTimeout(300);

const actions = lastRow.locator('.chs-actions');
await actions.waitFor({ state: 'visible' });

// Geometry check: overlay sits below the row's content and is fully inside
// the feed's visible box (not clipped, not under the composer).
const rowBox = await lastRow.boundingBox();
const actBox = await actions.boundingBox();
const feedBox = await feed.boundingBox();
const composerBox = await page.locator('.chs-composer').boundingBox();
console.log(JSON.stringify({ rowBox, actBox, feedBox, composerBox }, null, 2));
const belowRow = actBox.y > rowBox.y + rowBox.height - 12;
const insideFeed = actBox.y + actBox.height <= feedBox.y + feedBox.height + 1;
const clearOfComposer = !composerBox || actBox.y + actBox.height <= composerBox.y + 1;
console.log({ belowRow, insideFeed, clearOfComposer });

await page.screenshot({ path: `${OUT}/D3-actions-below-last-row-full.png` });
await page.screenshot({
  path: `${OUT}/D3-actions-below-last-row.png`,
  clip: {
    x: feedBox.x,
    y: Math.max(0, rowBox.y - 40),
    width: feedBox.width,
    height: Math.min(812 - Math.max(0, rowBox.y - 40), rowBox.height + 140),
  },
});
console.log('saved', `${OUT}/D3-actions-below-last-row.png`);

if (!belowRow || !insideFeed || !clearOfComposer) {
  console.error('D3 ACCEPTANCE FAILED');
  process.exitCode = 1;
}
await browser.close();
