/**
 * Capture the KIND MARKS from the shipping surfaces.
 *
 * The vitest suite proves every kind HAS artwork and that no two kinds share
 * it (`domain/registry.test.ts`). It structurally cannot prove the marks are
 * legible or distinguishable — that is an eyes question, and jsdom has no
 * eyes. This is how you answer it: the real components, the real stylesheet,
 * at the sizes they ship at.
 *
 * Three captures:
 *   kind-icons-sheet.png    every mark at 16 / 13 / 32px, built by importing
 *                           the registry data through the dev server
 *   kind-icons-switcher.png the list panel's kind switcher — every kind at
 *                           once, in the product
 *   kind-icons-connections.png  the Connections tab, the surface whose
 *                           unreadable marks started this
 *
 * Usage: npx vite --port 4614 & node e2e/capture-kind-icons.mjs [origin] [outDir]
 */
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:4614';
const outDir = process.argv[3] ?? 'gate-evidence';
const browser = await chromium.launch({ channel: 'chrome' });

// -- 1. the contact sheet, straight from the registry ------------------------
{
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(`${origin}/e2e/entity-view-harness.html`);
  await page.evaluate(async () => {
    const { KIND_ART, VIEW_ART } = await import('/src/domain/kind-art.ts');
    const svg = (paths, size, sw = 1.4) =>
      `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${paths
          .map((d) => `<path d="${d}"/>`)
          .join('')}</svg>`;
    const rows = [
      ...Object.entries(KIND_ART),
      ...Object.entries(VIEW_ART).map(([k, v]) => [`view:${k}`, v]),
    ];
    document.body.innerHTML = `<style>
      body{background:#111214;color:#d8d4cc;font:14px ui-sans-serif,system-ui;margin:0;padding:20px}
      .g{display:grid;grid-template-columns:repeat(5,1fr);gap:12px 8px}
      .c{border:1px solid #2a2b2e;border-radius:8px;padding:9px}
      .r{display:flex;align-items:center;gap:12px;height:34px;color:#b9b4ab}
      .n{font:11px ui-monospace,monospace;color:#8a857c;margin-top:5px}
    </style><div class="g">${rows
      .map(
        ([n, p]) =>
          `<div class="c"><div class="r">${svg(p, 16)}${svg(p, 13)}${svg(p, 32, 1.2)}</div><div class="n">${n}</div></div>`,
      )
      .join('')}</div>`;
  });
  await page.screenshot({ path: `${outDir}/kind-icons-sheet.png`, fullPage: true });
  await page.close();
}

// -- 2. the kind switcher — every kind, in the product ----------------------
{
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(`${origin}/e2e/entity-view-harness.html?kind=work_session`);
  await page.waitForSelector('[data-testid="harness-ready"]');
  await page.locator('.lp__kind').first().click();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${outDir}/kind-icons-switcher.png`,
    clip: { x: 0, y: 0, width: 340, height: 700 },
  });
  await page.close();
}

// -- 3. the Connections tab — the reported surface --------------------------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(`${origin}/e2e/entity-view-harness.html?kind=task`);
  await page.waitForSelector('[data-testid="harness-ready"]');
  await page.locator('[data-testid="list-tile"]').first().click();
  await page.waitForSelector('[data-testid="panel-header"]');
  await page.getByRole('tab', { name: /connections/i }).first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/kind-icons-connections.png` });
  await page.close();
}

await browser.close();
console.log(`captured 3 shots into ${outDir}/`);
