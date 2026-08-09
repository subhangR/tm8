/**
 * Pixel evidence for the LaunchSheet select restyle: the three CONFIGURATION
 * dropdowns (+ session mode) must render themed (card bg, line border,
 * chevron) instead of native white chrome — in BOTH themes.
 *
 * Usage: node e2e/capture-select-styling.mjs [origin]
 */
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:4699';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });

await page.goto(`${origin}/e2e/launch-sheet-harness.html`);
await page.waitForSelector('[data-testid="harness-ready"]', { state: 'attached' });
const sheet = page.locator('[data-testid="launch-sheet"]');
await sheet.waitFor();

for (const theme of ['dark', 'light']) {
  await page.evaluate((t) => {
    const root = document.querySelector('.cv2-root');
    if (t === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
  }, theme);

  const styles = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="launch-model"]');
    const cs = getComputedStyle(sel);
    return {
      appearance: cs.appearance,
      backgroundColor: cs.backgroundColor,
      hasChevron: cs.backgroundImage.startsWith('url("data:image/svg'),
      borderColor: cs.borderTopColor,
      color: cs.color,
      colorScheme: cs.colorScheme,
    };
  });
  console.log(theme, JSON.stringify(styles, null, 2));
  await sheet.screenshot({ path: `gate-evidence/select-styling-${theme}.png` });
}

await browser.close();
