// Pixel capture for the four onboarding empty states.
//   npx vite --port 4623   # in this package
//   OUT=/tmp/onboarding-shots node e2e/capture-onboarding-empty.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT ?? '/tmp/onboarding-shots';
const PORT = process.env.PORT ?? '4623';
mkdirSync(OUT, { recursive: true });

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' });
} catch {
  browser = await chromium.launch(); // fall back to bundled chromium
}
const ctx = await browser.newContext({ viewport: { width: 1500, height: 960 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://localhost:${PORT}/e2e/onboarding-empty-harness.html`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="harness-ready"]', { timeout: 15000 });
await page.waitForSelector('[data-testid="board-screen"]', { timeout: 15000 });
await page.waitForSelector('[data-testid="files-explorer"]', { timeout: 15000 });
await page.waitForTimeout(700);

for (const [testid, name] of [
  ['cap-work', 'work'],
  ['cap-board', 'board'],
  ['cap-files', 'files'],
  ['cap-projects', 'projects'],
]) {
  const el = page.getByTestId(testid);
  await el.screenshot({ path: `${OUT}/after-${name}.png` });
  console.log(`shot after-${name}.png`);
}

// A few assertions so the run is evidence, not just images.
console.log('CHECKS:', JSON.stringify(await page.evaluate(() => ({
  workLede: !!document.querySelector('[data-testid="empty-center-firstrun"]'),
  workNewTask: [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('New task')),
  boardNewTask: !!document.querySelector('[data-testid="bd-new-task"]'),
  boardFirstRun: !!document.querySelector('[data-testid="bd-firstrun"]'),
  filesNoProjectHint: !!document.querySelector('[data-testid="fx-no-projects"]'),
  projectsEmpty: !!document.querySelector('[data-testid="empty-region"]'),
}))));

console.log('PAGE ERRORS:', errors.length, errors.slice(0, 4));
await browser.close();
