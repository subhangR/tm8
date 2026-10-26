/**
 * settings-taps-census — every interactive control in the phone's stacked
 * Settings, section by section, with its hit box (`getBoundingClientRect` of
 * the ELEMENT, CONTRACT §6) and whether the open section scrolls sideways.
 *
 *   cd packages/tm8-ui && node e2e/settings-taps-census.mjs --base http://127.0.0.1:<port> [--exe <chrome>] [--out f.json]
 *
 * One browser per viewport: the headless shell needs `--single-process` on
 * hosts without system Chrome, and a second context crashes it.
 */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:5199');
const EXE = arg('--exe', undefined);
const OUT = arg('--out', undefined);
const MIN = 44;
const WIDTHS = [360, 390, 430];

const census = () => {
  const root = document.querySelector('[data-testid="settings-stacked"]');
  if (!root) return { error: 'no stacked settings' };
  const SEL = 'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="radio"], [tabindex]:not([tabindex="-1"])';
  const vw = document.documentElement.clientWidth;
  const targets = [...root.querySelectorAll(SEL)]
    .map((el) => ({ el, r: el.getBoundingClientRect(), s: getComputedStyle(el) }))
    .filter(({ r, s }) => r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.pointerEvents !== 'none' && Number(s.opacity) !== 0)
    .map(({ el, r }) => ({
      cls: `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`,
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 28),
      w: Math.round(r.width), h: Math.round(r.height),
    }));
  const scrollers = [...root.querySelectorAll('*')].filter((el) => {
    if (el.scrollWidth <= el.clientWidth + 1) return false;
    const ox = getComputedStyle(el).overflowX;
    return ox === 'auto' || ox === 'scroll';
  }).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')} ${el.scrollWidth}/${el.clientWidth}`);
  const over = [...root.querySelectorAll('*')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1; }).length;
  return { targets, scrollers, over, docX: document.documentElement.scrollWidth > vw + 1 };
};

const report = {};
for (const width of WIDTHS) {
  const browser = await chromium.launch({
    ...(EXE ? { executablePath: EXE } : { channel: 'chrome' }),
    args: ['--no-sandbox', '--no-zygote', '--single-process', '--disable-gpu'],
  });
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/mobile-audit.html#/s/sp-atelier/settings`);
  await page.waitForSelector('[data-testid="settings-stacked"]', { timeout: 30000 });
  await page.waitForTimeout(800);
  const rows = await page.$$eval('.set-stack__row[data-section]:not(.set-stack__row--off)', (els) => els.map((e) => e.getAttribute('data-section')));
  const per = { list: await page.evaluate(census) };
  for (const id of rows) {
    await page.click(`.set-stack__row[data-section="${id}"]`);
    await page.waitForSelector('[data-testid="settings-back"]');
    await page.waitForTimeout(500);
    per[id] = await page.evaluate(census);
    await page.click('[data-testid="settings-back"]');
    await page.waitForSelector('.set-stack');
  }
  report[width] = per;
  await browser.close();
}

for (const [width, per] of Object.entries(report)) {
  console.log(`\n=== ${width}px ===`);
  for (const [id, m] of Object.entries(per)) {
    if (m.error) { console.log(`${id}: ${m.error}`); continue; }
    const small = m.targets.filter((t) => Math.min(t.w, t.h) < MIN);
    console.log(`${id.padEnd(18)} controls=${String(m.targets.length).padStart(3)} under${MIN}=${small.length} over=${m.over} docX=${m.docX} scrollers=${m.scrollers.length}`);
    for (const t of small) console.log(`    ${t.w}x${t.h}  ${t.cls}  "${t.label}"`);
    for (const s of m.scrollers) console.log(`    SCROLLS-X ${s}`);
  }
}
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
