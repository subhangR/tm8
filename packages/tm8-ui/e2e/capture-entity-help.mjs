/**
 * VISUAL PROOF for Entity Help (task 01a0e7d6): the projection room in light
 * and dark, on all three reels, plus the reduced-motion still — captured from
 * the harness with Playwright's bundled Chromium.
 *
 *   node e2e/capture-entity-help.mjs [origin] [outDir]
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:4612';
const out = process.argv[3] ?? 'gate-evidence/entity-help';
mkdirSync(out, { recursive: true });

/* THIS HOST has no system Chrome and no root: Playwright's bundled Chromium
   launches only with the extracted libraries on `LD_LIBRARY_PATH`
   (`~/.local/chromium-libs/usr/lib/x86_64-linux-gnu:~/.local/pw-min/lib`)
   and with the GPU and zygote out of the way, or the renderer crashes on the
   first navigation. Harmless anywhere else. */
const browser = await chromium.launch({
  args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process', '--use-gl=swiftshader'],
});
const shots = [
  ['light-story', 'kind=task&tab=story'],
  ['light-toolkit', 'kind=task&tab=toolkit'],
  ['light-constellation', 'kind=task&tab=constellation'],
  ['dark-story', 'theme=dark&kind=work_session&tab=story'],
  ['dark-toolkit', 'theme=dark&kind=work_session&tab=toolkit'],
  ['dark-constellation', 'theme=dark&kind=work_session&tab=constellation'],
  ['light-reduced-motion', 'kind=doc&tab=constellation&motion=reduced'],
  ['dark-baseline-credential', 'theme=dark&kind=credential&tab=story'],
];
/* ONE PAGE, reused: under `--single-process` closing a page closes the browser. */
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
for (const [name, query] of shots) {
  await page.goto(`${origin}/e2e/entity-help-harness.html?${query}`);
  await page.waitForSelector('[data-harness-ready]', { timeout: 30000 });
  await page.screenshot({ path: `${out}/${name}.png` });
  const facts = await page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="entity-help-overlay"]');
    const region = document.querySelector('[aria-label="Region B"]');
    const list = document.querySelector('[role="tablist"][aria-label="Home roots"]');
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    return {
      dialog: r(dialog),
      region: r(region),
      list: r(list),
      motion: dialog?.getAttribute('data-motion'),
      typed: [...document.querySelectorAll('.eh-term')].map((t) => t.getAttribute('data-typed')),
      stars: document.querySelectorAll('.eh-node').length,
      commands: document.querySelectorAll('[data-testid="toolkit-command"]').length,
    };
  });
  console.log(name, JSON.stringify(facts));
}
/* The menu, open, with a (?) on every row. */
await page.goto(`${origin}/e2e/entity-help-harness.html?kind=task`);
await page.waitForSelector('[data-harness-ready]');
await page.getByLabel('Choose which list to show').click();
await page.getByRole('button', { name: 'Help for Docs' }).hover();
await page.screenshot({ path: `${out}/light-menu-marks.png`, clip: { x: 0, y: 0, width: 520, height: 420 } });
await browser.close();
console.log('done →', out);
