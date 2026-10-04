/** Graph / Tree / Game integration against the fixture page; no server writes. */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.STORY_VIEWS_BASE_URL ?? 'http://127.0.0.1:4641';
const out = process.env.STORY_VIEWS_EVIDENCE ?? '/tmp/story-views-evidence';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.STORY_VIEWS_BROWSER ? { executablePath: process.env.STORY_VIEWS_BROWSER } : {}),
  args: ['--no-sandbox', '--no-zygote', '--single-process', '--enable-unsafe-swiftshader'],
});
const report = { layouts: [], checks: [], errors: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => report.errors.push(error.message));
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  const tab = name => page.getByRole('tablist', { name: 'Story view' }).getByRole('tab', { name, exact: true });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  for (const width of [1440, 390]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`${base}/story-dev.html?full=1${dark ? '&theme=dark' : ''}`, { waitUntil: 'networkidle' });
    await tab('Graph').click();
    await page.getByLabel('The graph', { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const prefix = `${dark ? 'dark' : 'light'}-${width}`;
    assert.equal(await overflow(), false, `${prefix}: Graph overflow`);
    await page.screenshot({ path: `${out}/${prefix}-graph.png` });
    await tab('Graph').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await tab('Tree').evaluate(el => el === document.activeElement), true);
    await page.getByRole('region', { name: 'In this story' }).waitFor();
    assert.equal(await overflow(), false, `${prefix}: Tree overflow`);
    await page.screenshot({ path: `${out}/${prefix}-tree.png` });
    if (report.layouts.length === 0) {
      assert.equal(requests.some(url => url.includes('/story/game/scene')), false, '3D scene loaded before Game');
      report.checks.push('Graph and Tree never request the 3D scene');
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await tab('Tree').getAttribute('aria-selected'), 'true');
      const title = page.locator('[data-tree-title]').first();
      const entityId = await title.getAttribute('data-tree-title');
      await title.click();
      assert.match(await page.getByTestId('story-dev-log').textContent(), new RegExp(`open ${entityId}`));
      report.checks.push('Tree persists across reload and opens the exact entity through the page port');
    }
    await tab('Tree').focus();
    await page.keyboard.press('ArrowRight');
    await page.getByTestId('story-game').waitFor();
    assert.equal(await tab('Game').evaluate(el => el === document.activeElement), true);
    await page.locator('.sgm canvas').waitFor();
    await page.waitForTimeout(2500);
    assert.equal(await overflow(), false, `${prefix}: Game overflow`);
    await page.screenshot({ path: `${out}/${prefix}-game.png` });
    report.layouts.push({ width, dark, graph: true, tree: true, gameCanvas: true, overflow: false });
    await tab('Graph').click();
    assert.equal(await page.locator('.sgm canvas').count(), 0);
  }
  // The legacy value is deliberately unchanged; reload it as an old saved preference.
  await page.evaluate(() => {
    const id = document.querySelector('[data-story-id]').getAttribute('data-story-id');
    localStorage.setItem('tm8.story-game.v1', JSON.stringify({ mode: { [id]: 'story' }, saves: { [id]: { x: 8, z: 6, revealed: ['kept'], visited: ['kept'] } } }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await tab('Graph').getAttribute('aria-selected'), 'true');
  await tab('Tree').click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tm8.story-game.v1')));
  assert.deepEqual(Object.values(saved.saves)[0], { x: 8, z: 6, revealed: ['kept'], visited: ['kept'] });
  report.checks.push('Legacy story mode opens Graph; switching to Tree retains the game save');
  assert.deepEqual(report.errors, []);
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
