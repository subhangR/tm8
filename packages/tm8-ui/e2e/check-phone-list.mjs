import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

// Start Vite first (any port): PHONE_LIST_BASE_URL=http://127.0.0.1:<port> node e2e/check-phone-list.mjs
const base = process.env.PHONE_LIST_BASE_URL ?? 'http://127.0.0.1:4612';
const output = process.env.PHONE_LIST_OUTPUT ?? '/tmp/tm8-phone-list-evidence';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch();
const report = [];
try {
  for (const width of [360, 390, 430]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const kind of ['chat', 'work_session', 'doc', 'task', 'channel']) {
      for (const theme of ['dark', 'light']) {
        await page.goto(`${base}/e2e/phone-list-harness.html?kind=${kind}&theme=${theme}`);
        await page.locator('[data-testid="phone-list-row"]').first().waitFor();
        // Expand the first session's workers, so the densest row is measured.
        if (kind === 'work_session') await page.locator('.pl-kids').first().tap();
        const m = await page.evaluate(() => {
          const list = document.querySelector('.pl-list');
          const els = [list, ...document.querySelectorAll('.pl-r, .pl-kr, .pl-hd, .pl-item')];
          const overflow = els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className);
          const right = Math.max(...[...document.querySelectorAll('.pl *')].map((el) => el.getBoundingClientRect().right));
          const rows = [...document.querySelectorAll('.pl-r')].map((el) => el.getBoundingClientRect().height);
          const targets = [...document.querySelectorAll('.pl-ib, .pl-srch input, .pl-kids, .pl-kr, .pl-r')]
            .map((el) => { const r = el.getBoundingClientRect(); return { c: el.className, w: r.width, h: r.height }; })
            .filter((t) => t.w < 44 || t.h < 44);
          const fs = getComputedStyle(document.querySelector('.pl-srch input')).fontSize;
          return { overflow, right, minRow: Math.min(...rows), targets, fs, vw: innerWidth };
        });
        assert.deepEqual(m.overflow, [], `${kind}@${width} sideways overflow`);
        assert.ok(m.right <= m.vw + 0.5, `${kind}@${width} content right edge ${m.right} > ${m.vw}`);
        assert.ok(m.minRow >= 56, `${kind}@${width} row ${m.minRow} < 56`);
        assert.deepEqual(m.targets, [], `${kind}@${width} sub-44 targets`);
        assert.equal(m.fs, '16px', 'search input is 16px (no iOS zoom)');
        report.push(`${width} ${kind} ${theme}: minRow ${m.minRow.toFixed(0)} right ${m.right.toFixed(1)}/${m.vw}`);
        await page.screenshot({ path: `${output}/${kind}-${width}-${theme}.png` });
      }
    }
    // Press and hold → action sheet; ⚙ → sort & filter sheet.
    await page.goto(`${base}/e2e/phone-list-harness.html?kind=task`);
    const row = page.locator('[data-testid="phone-list-row"]').first();
    const box = await row.boundingBox();
    await page.mouse.move(box.x + 40, box.y + 20);
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.up();
    await page.locator('[data-testid="phone-list-actions"]').waitFor();
    await page.screenshot({ path: `${output}/task-${width}-actions.png` });
    await page.goto(`${base}/e2e/phone-list-harness.html?kind=task`);
    await page.locator('[data-testid="phone-list-tune"]').tap();
    await page.locator('[data-testid="phone-list-filter-sheet"]').waitFor();
    await page.screenshot({ path: `${output}/task-${width}-filter.png` });
    for (const state of ['loading', 'empty', 'paging']) {
      await page.goto(`${base}/e2e/phone-list-harness.html?kind=doc&state=${state}`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${output}/doc-${width}-${state}.png` });
    }
    assert.deepEqual(errors, [], 'no page errors');
    await page.close();
  }
  console.log(report.join('\n'));
  console.log(`ok — screenshots in ${output}`);
} finally {
  await browser.close();
}
