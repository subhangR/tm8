import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

// Start Vite first. No authentication or writes: this drives actual list components.
const base = process.env.MOBILE_LIST_BASE_URL ?? 'http://127.0.0.1:4612';
const output = process.env.MOBILE_LIST_OUTPUT ?? '/tmp/tm8-mobile-list-evidence';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  args: process.env.MOBILE_LIST_SINGLE_PROCESS === '1'
    ? ['--no-zygote', '--single-process', '--disable-gpu', '--disable-software-rasterizer'] : [],
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    for (const kind of ['task', 'session']) {
      for (const theme of ['light', 'dark']) {
        const prefix = kind === 'task' ? 'pn-tt' : 'pn-st';
        const opener = kind === 'task' ? '.pn-tt__ind' : '.pn-st__btn--ind';
        await page.goto(`${base}/e2e/mobile-lists-harness.html?kind=${kind}&theme=${theme}`);
        const tile = page.locator(`.${prefix}`).first();
        await tile.waitFor();
        await page.evaluate(() => document.fonts.ready);
        const cluster = tile.locator(`.${prefix}__actions`);
        assert.equal(await cluster.locator(':scope > *').count(), 1, 'collapsed rows render only the disclosure');
        await tile.hover();
        const collapsed = await tile.boundingBox();
        const main = await tile.locator(`.${prefix}__main`).boundingBox();
        const toggle = await tile.locator(opener).boundingBox();
        assert.ok(toggle.width >= 44 && toggle.height >= 44, 'disclosure meets touch size');
        assert.ok(toggle.y >= main.y && toggle.y + toggle.height <= main.y + main.height + 1, 'hover cannot translate disclosure outside title row');
        assert.ok(main.height <= 56, 'collapsed title row remains compact');
        await page.screenshot({ path: `${output}/${kind}-${width}-${theme}-closed.png` });
        await tile.locator(opener).tap();
        assert.equal(await tile.getAttribute('data-details'), 'open');
        const actions = await cluster.boundingBox();
        const title = await tile.locator(kind === 'task' ? '.pn-tt__title' : '.pn-st__title').boundingBox();
        assert.ok(actions.y >= title.y + title.height - 1, 'expanded actions are below the title');
        const controls = await cluster.locator(':scope > *').evaluateAll((els) => els.map((el) => {
          const r = el.getBoundingClientRect();
          return { width: r.width, height: r.height, x: r.x, right: r.right };
        }));
        assert.ok(controls.length > 1, 'expanded row exposes its actions');
        assert.ok(controls.every((r) => r.width >= 44 && r.height >= 44 && r.x >= 0 && r.right <= width), 'actions remain reachable and inside viewport');
        assert.equal(await tile.locator('.lp__flow').count(), 0, 'disclosure does not open launch options');
        await page.screenshot({ path: `${output}/${kind}-${width}-${theme}-open.png` });
        if (kind === 'task') {
          assert.equal(await tile.locator('[data-testid="row-date-input"]').count(), 0);
          await tile.getByRole('button', { name: 'Add dates' }).tap();
          assert.equal(await tile.locator('[data-testid="row-date-input"]').count(), 2);
        }
        const overflow = await tile.locator('button,input,select,.pn-lane').evaluateAll((els) => els.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.left < 0 || r.right > innerWidth + 1);
        }).map((el) => el.className));
        assert.deepEqual(overflow, [], 'controls and branch names stay inside viewport');
        await tile.locator(opener).tap();
        assert.equal(await cluster.locator(':scope > *').count(), 1);
        assert.ok(Math.abs((await tile.boundingBox()).height - collapsed.height) < 1, 'collapse restores row height');
        console.log(`${kind} ${width} ${theme}: passed`);
      }
    }
  }
  // Same components still expose their hover cluster in a desktop host.
  await page.setViewportSize({ width: 1000, height: 844 });
  for (const kind of ['task', 'session']) {
    await page.goto(`${base}/e2e/mobile-lists-harness.html?kind=${kind}&desktop=1`);
    const tile = page.locator(kind === 'task' ? '.pn-tt' : '.pn-st').first();
    await tile.waitFor();
    await tile.hover();
    assert.ok(await tile.locator('.lp__cluster > *').count() > 1);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
