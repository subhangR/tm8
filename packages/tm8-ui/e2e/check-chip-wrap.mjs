import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

/*
 * NO PHONE TEXT BREAKS MID-WORD (fix-wrap, verify finding F5): the measured
 * half of `src/mobile/chip-wrap.test.ts`.
 *
 * Opens a task page on the phone shell at 360/390/430 and walks every text
 * node. Text drawn as two or more line boxes each narrower than 1.5em is a word
 * broken letter by letter: the task facts strip drew "w/o/r/ki/n/g" that way
 * when `overflow-wrap: anywhere` reached a shrinking chip row. Also asserts
 * the strip's chips each draw one 44px line.
 *
 * Start Vite first (any port), then:
 *   CHIP_WRAP_BASE_URL=http://127.0.0.1:<port> node e2e/check-chip-wrap.mjs
 * CHROME_PATH points at a chrome-headless-shell when there is no system Chrome.
 */
const base = process.env.CHIP_WRAP_BASE_URL ?? 'http://127.0.0.1:4612';
const exe = process.env.CHROME_PATH;
const launch = () =>
  chromium.launch(
    exe
      ? { executablePath: exe, args: ['--no-sandbox', '--no-zygote', '--single-process', '--disable-gpu'] }
      : {},
  );

for (const width of [360, 390, 430]) {
  // One browser per viewport: `--single-process` cannot host a second context.
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(`${base}/mobile-audit.html#/s/sp-atelier/k/tasks`, { waitUntil: 'domcontentloaded' });
    await page.locator('.lp__tile, [data-testid*=row]').first().click({ timeout: 60_000 });
    await page.locator('.pn-controls .lp__rowdetail--chips').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(800);
    const m = await page.evaluate(() => {
      const broken = [];
      const walker = document.createTreeWalker(document.querySelector('.cv2-root'), NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent.trim();
        const el = n.parentElement;
        if (text.length < 4 || !el || !el.offsetParent) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const lines = [...range.getClientRects()].filter((r) => r.width > 0);
        const em = parseFloat(getComputedStyle(el).fontSize);
        if (lines.length >= 2 && lines.filter((r) => r.width < em * 1.5).length >= 2) {
          broken.push(`${text.slice(0, 30)} (.${String(el.className).split(' ')[0]}, ${lines.length} lines)`);
        }
      }
      const chips = [...document.querySelector('.pn-controls .lp__rowdetail--chips').children].map((c) =>
        Math.round(c.getBoundingClientRect().height),
      );
      return { broken, chips };
    });
    assert.deepEqual(m.broken, [], `${width}px: text broken letter by letter`);
    assert.ok(Math.max(...m.chips) <= 44, `${width}px: a facts chip grew to ${Math.max(...m.chips)}px tall`);
    console.log(`${width}px ok: ${m.chips.length} chips, tallest ${Math.max(...m.chips)}px, 0 broken words`);
  } finally {
    await browser.close();
  }
}
