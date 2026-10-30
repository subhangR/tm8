/**
 * THE LAUNCH CARD'S CONNECTORS AND FOCUS, MEASURED IN CHROMIUM (D3 + D1).
 *
 * For 0 and 2 connectors, light and dark, at 1440x900: a screenshot, the
 * card's height on every frame from mount until the catalog has landed (a
 * jump is two different heights), what the connectors slot says, and the
 * notes box's focus outline and inner padding. Then, with 2 connectors and
 * the catalog read held 3 s: pick qa_beta, close the card, reopen it, and
 * record whether the pick came back, whether "Checking connectors…" showed
 * until the read, and the reopened card's heights frame by frame.
 *
 * Usage: node e2e/capture-launch-card-connectors.mjs [origin] [out-dir]
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const origin = process.argv[2] ?? 'http://127.0.0.1:4612';
const OUT = process.argv[3] ?? 'gate-evidence/launch-card-connectors';
mkdirSync(OUT, { recursive: true });

const KIT = '/home/tm8/prod-data/tools/browser/launch.json';
const kit = existsSync(KIT) ? JSON.parse(readFileSync(KIT, 'utf8')) : null;
const { chromium } = kit
  ? createRequire(import.meta.url)(kit.playwright)
  : await import('@playwright/test');

/* Installed before the page's scripts: the card's height on every frame. */
const TRACK = () => {
  window.__heights = [];
  const tick = () => {
    const card = document.querySelector('[data-testid="launch-card"]');
    if (card) {
      const h = Math.round(card.getBoundingClientRect().height);
      if (window.__heights.at(-1) !== h) window.__heights.push(h);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const inspect = () => {
  const card = document.querySelector('[data-testid="launch-card"]');
  const slot = document.querySelector('[data-testid="lcd3-connectors"]');
  const notes = document.querySelector('[data-testid="lcd3-notes"]');
  const title = document.querySelector('.lcd3-subject__t');
  const n = notes ? getComputedStyle(notes) : null;
  return {
    card: card ? Math.round(card.getBoundingClientRect().height) : null,
    slot: slot ? { hidden: slot.hidden, text: (slot.textContent ?? '').trim().slice(0, 120) } : null,
    legend: !!card?.querySelector('legend'),
    compact: !!card?.querySelector('[data-testid="mcp-compact"]'),
    notesFocused: document.activeElement === notes,
    notesOutline: n ? `${n.outlineStyle} ${n.outlineWidth} ${n.outlineColor}` : null,
    notesPadding: n ? `${n.paddingTop} ${n.paddingRight} ${n.paddingBottom} ${n.paddingLeft}` : null,
    title: title ? { shown: Math.round(title.getBoundingClientRect().width), full: title.scrollWidth, truncated: title.scrollWidth > title.clientWidth } : null,
    heights: window.__heights,
  };
};

const browser = kit
  ? await chromium.launch({ executablePath: kit.executablePath, env: { ...process.env, ...kit.env }, args: kit.args })
  : await chromium.launch({ channel: 'chrome' });

const results = {};
for (const mcp of ['0', '2']) {
  for (const theme of ['light', 'dark']) {
    const name = `1440x900-${theme}-${mcp}-connectors`;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(TRACK);
    await page.goto(`${origin}/e2e/launch-card-harness.html?attach=0&mcp=${mcp}${theme === 'dark' ? '&theme=dark' : ''}`);
    await page.waitForSelector('[data-testid="harness-ready"]', { state: 'attached' });
    await page.waitForTimeout(700);
    results[name] = await page.evaluate(inspect);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    await page.close();
  }
}

/* PICK, CLOSE, REOPEN — the read held 1.5 s so the wait is visible. */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(TRACK);
  await page.goto(`${origin}/e2e/launch-card-harness.html?attach=0&mcp=2&mcpDelay=3000`);
  await page.waitForSelector('[data-testid="harness-ready"]', { state: 'attached' });
  await page.waitForTimeout(3300);
  const firstOpen = await page.evaluate(() => window.__heights.slice());
  const chip = page.locator('[data-testid="mcp-chip-toggle-qa_beta"]');
  const picked = (await chip.count()) > 0;
  if (picked) await chip.click();
  const pressedBefore = picked ? await chip.getAttribute('aria-pressed') : null;
  await page.locator('[data-testid="harness-close"]').click({ force: true });
  await page.waitForSelector('[data-testid="launch-card"]', { state: 'detached' });
  await page.evaluate(() => { window.__heights = []; });
  await page.locator('[data-testid="harness-reopen"]').click({ force: true });
  await page.waitForSelector('[data-testid="launch-card"]');
  const checking = await page.locator('[data-testid="mcp-compact-checking"]').count() > 0;
  const launchRefusal = await page.locator('#lcd-refusal').count() > 0 ? await page.locator('#lcd-refusal').textContent() : null;
  const launchHeld = await page.locator('[data-testid="nsx-send"]').getAttribute('aria-disabled');
  await page.screenshot({ path: `${OUT}/1440x900-light-reopen-checking.png` });
  await page.waitForTimeout(3300);
  const launchAfterRead = await page.locator('[data-testid="nsx-send"]').getAttribute('aria-disabled');
  const checkingAfterRead = await page.locator('[data-testid="mcp-compact-checking"]').count() > 0;
  const pressedAfter = picked ? await page.locator('[data-testid="mcp-chip-toggle-qa_beta"]').getAttribute('aria-pressed') : null;
  const summary = await page.locator('[data-testid="mcp-picker-summary"]').first().textContent().catch(() => null);
  await page.screenshot({ path: `${OUT}/1440x900-light-reopen-settled.png` });
  results.reopen = {
    firstOpenHeights: firstOpen, picked, pressedBefore, reopenHeights: await page.evaluate(() => window.__heights),
    checkingOnReopen: checking, launchHeld, launchAfterRead, refusalOnReopen: launchRefusal?.trim() ?? null, checkingAfterRead, pressedAfter, summary: summary?.trim() ?? null,
  };
  await page.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
