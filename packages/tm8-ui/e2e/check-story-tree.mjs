/** Run with the Vite dev server. Snapshots, when supplied, are local read-only captures. */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base = process.env.STORY_TREE_BASE_URL ?? 'http://127.0.0.1:18853';
const out = process.env.STORY_TREE_EVIDENCE ?? '/tmp/story-tree-evidence';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.STORY_TREE_BROWSER ? { executablePath: process.env.STORY_TREE_BROWSER } : {}),
  args: ['--no-sandbox', '--disable-gpu', '--no-zygote', '--single-process'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const report = { layouts: [], interactions: [], snapshots: [], errors };
const go = async query => {
  await page.goto(`${base}/e2e/story-tree-harness.html${query}`);
  await page.getByRole('tablist', { name: 'Entity kinds' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
};
try {
  for (const width of [1440, 1200, 900, 600, 390]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 950 });
    await go(dark ? '?dark' : '');
    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth, width: innerWidth,
      tabsTop: document.querySelector('[aria-label="Entity kinds"]').getBoundingClientRect().top,
      viewStripHeight: document.querySelector('.sty-viewbar').getBoundingClientRect().height,
      rowCount: document.querySelectorAll('[data-tree-title]').length,
    }));
    assert(dimensions.scrollWidth <= width + 1, `Horizontal overflow at ${width}`);
    // Preserve the original compact-header budget below the new view switch.
    assert(dimensions.tabsTop - dimensions.viewStripHeight < (width >= 900 ? 120 : 230), `Header too tall at ${width}: ${dimensions.tabsTop}`);
    if ([1440, 390].includes(width)) await page.screenshot({ path: `${out}/${dark ? 'dark' : 'light'}-${width}.png` });
    report.layouts.push({ width, dark, ...dimensions });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await go('');
  const branch = page.locator('.syt-disclosure[aria-expanded]').first();
  await branch.click();
  const child = page.locator('.syt-list .syt-list [data-tree-title]').first();
  const childId = await child.getAttribute('data-tree-title');
  const row = page.locator(`[data-tree-node="${childId}"]`).first();
  await row.getByRole('button', { name: /^Create under/ }).first().click();
  const editor = page.getByLabel('New entity title');
  assert(await editor.evaluate(e => e === document.activeElement));
  await editor.fill('A draft that survives live updates');
  await page.getByLabel('Entity kind', { exact: true }).selectOption('doc');
  await page.getByRole('tab', { name: /^Documents/ }).click();
  await page.getByRole('searchbox').fill('no-match');
  await page.getByLabel('Sort siblings').selectOption('activity');
  await page.getByRole('button', { name: 'Live refresh', exact: true }).click();
  assert.equal(await editor.inputValue(), 'A draft that survives live updates');
  assert.equal(await page.getByLabel('Entity kind', { exact: true }).inputValue(), 'doc');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('form', { name: 'Create entity' }).waitFor({ state: 'detached' });
  const result = JSON.parse(await page.getByTestId('action-result').textContent());
  assert.deepEqual({ kind: result.kind, parentId: result.parentId }, { kind: 'doc', parentId: childId });
  report.interactions.push('draft + kind survive kind/search/sort/live refresh; exact document creation parent');

  await page.getByRole('button', { name: '▷ Launch on story' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add anything' });
  await dialog.getByLabel('What to add').fill('Review this story');
  await dialog.getByRole('button', { name: 'Spawn session', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  const launch = JSON.parse(await page.getByTestId('action-result').textContent());
  assert.equal(launch.intent, 'spawn'); assert(launch.onId); assert.equal(launch.text, 'Review this story');
  report.interactions.push('existing launch sheet submits exact story subject and prompt');

  await go('?large');
  assert.equal(await page.locator('[data-tree-title]').count(), 24);
  const start = performance.now();
  await page.getByRole('button', { name: 'Expand Workstream 1', exact: true }).click();
  assert.equal(await page.locator('[data-tree-title]').count(), 49);
  await page.getByRole('button', { name: 'Show 25 more · 25 remaining' }).click();
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Workstream 1 · Task 26');
  assert.match(await page.locator('.syt-notice').textContent(), /Loaded 25 more entities/);
  await page.getByRole('searchbox').fill('Workstream 24 · Task 50');
  assert.equal(await page.locator('[data-tree-title]').count(), 2);
  assert(await page.getByRole('button', { name: 'Workstream 24 · Task 50', exact: true }).isVisible());
  report.interactions.push({ largeTree: 1224, expandPageAndSearchMs: Math.round(performance.now() - start), initialRows: 24, expandedRows: 49 });
  await page.screenshot({ path: `${out}/large-tree-search.png` });

  for (const snapshot of (process.env.STORY_TREE_SNAPSHOTS ?? '').split(',').filter(Boolean)) {
    await go(`?snapshot=${encodeURIComponent(snapshot)}`);
    const initial = await page.locator('[data-tree-title]').count();
    assert(initial <= 25);
    const start = performance.now();
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    const expanded = await page.locator('[data-tree-title]').count();
    const maxSiblings = await page.locator('.syt-list').evaluateAll(lists => Math.max(...lists.map(list => [...list.children].filter(li => li.hasAttribute('data-tree-node')).length)));
    assert(maxSiblings <= 25, `${snapshot}: more than 25 siblings`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `${out}/${snapshot}.png` });
    report.snapshots.push({ snapshot, initial, expanded, maxSiblings, expandMs: Math.round(performance.now() - start) });
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(`${out}/browser-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
