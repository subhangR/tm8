// THE HOME TASK-LIST CHROME — pixel capture for the four reported defects.
// (NOT a spec — `.mjs` is outside the test glob, so CI never runs it.)
//
// Every number below is one a REAL LAYOUT ENGINE has to report. The vitest
// suite beside this runs in jsdom: no stylesheets, no layout, no compositing.
// It cannot see a left edge, a border-radius, a used height, or a contrast
// ratio, and all four reported complaints are exactly those things:
//
//   1. "when panel is dragged extreme and extreme ... not organized" — the
//      chrome is byte-identical at 240 and 560 because Home passed `compact`
//      as a literal. Measured as DEAD SPACE in the filter row.
//   2. "Filter People Collections and Arrow Downwards ... not organized" —
//      five stacked rows on four different left edges, and three control
//      heights inside one row.
//   3. "round buttons ... doesn't look much clean" — the sort control's
//      width/height ratio. A ratio of 1.0 at a 999px radius IS a circle, and
//      nothing in the source asks for one.
//   4. contrast — composited foreground over composited background, in BOTH
//      palettes, which is the only way to show the dark theme came along.
//
// USAGE:
//   npx vite --port 4733 --strictPort        # in packages/tm8-ui
//   OUT=/tmp/shots/before MODE=literal node e2e/capture-list-header-chrome.mjs
//   OUT=/tmp/shots/after  MODE=derived node e2e/capture-list-header-chrome.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const OUT = process.env.OUT ?? '/tmp/panel-chrome-shots';
const PORT = process.env.PORT ?? '4733';
const MODE = process.env.MODE ?? 'literal';
const LABEL = process.env.LABEL ?? MODE;
mkdirSync(OUT, { recursive: true });

/* THE FLAGS ARE NOT OPTIONAL, and each earns its place separately.
   `--no-zygote`: the zygote process segfaults (signal 11) before the first
   frame. `--single-process` + `--no-sandbox` + `--disable-dev-shm-usage`: the
   set proven to render this harness green in the Playwright docker image
   (mcr.microsoft.com/playwright:v1.58.2-noble, `--network host`); with
   `--no-zygote` alone the renderer still dies part way through the module
   graph. Override with CHROME_ARGS if your host needs less. */
const ARGS = (process.env.CHROME_ARGS ?? '--no-zygote --no-sandbox --disable-dev-shm-usage --single-process').split(' ');
const browser = await chromium.launch({ args: ARGS });
/* A 1720px viewport at dsf 2 rasters ~3440px wide and crashes the renderer on
   this host. The harness grid wraps, so a narrower window stacks the four
   panels instead — and an element screenshot scrolls its target into view, so
   nothing is lost by not having them all on one line. */
const ctx = await browser.newContext({ viewport: { width: 880, height: 760 }, deviceScaleFactor: Number(process.env.DSF ?? 2) });
const page = await ctx.newPage();
page.on('crash', () => console.error('PAGE CRASHED'));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

/* RETRIED, because the first navigation after a cold start races vite's
   dependency optimizer: it finishes mid-load, forces a full reload, and the
   in-flight navigation lands as ERR_ABORTED with nothing else to say. The
   second attempt runs against a warm server. */
const url = `http://localhost:${PORT}/e2e/list-header-chrome-harness.html?compact=${MODE}`;
for (let attempt = 1; ; attempt += 1) {
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
    await page.waitForSelector('[data-testid="entity-list-panel"]', { state: 'attached', timeout: 45000 });
    break;
  } catch (e) {
    if (attempt >= 4) throw e;
    console.log(`nav attempt ${attempt} failed (${String(e).split('\n')[0]}), retrying`);
    await page.waitForTimeout(2500);
  }
}
await page.waitForFunction(() => document.querySelectorAll('.harness-panel').length === 4, null, { timeout: 45000 });
await page.waitForTimeout(1200);

const shot = async (name, locator) => {
  const file = join(OUT, `${name}.png`);
  await (locator ?? page).screenshot({ path: file });
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  console.log(`SHOT ${name}  sha256:${sha}`);
};

/* Everything the page needs to answer a contrast question about ITSELF:
   `getComputedStyle` hands back `rgba()`, so an alpha has to be composited
   against what is actually behind it before a ratio means anything. This is
   the step that separates a token name from a pixel.

   DECLARED INSIDE THE EVALUATED FUNCTION, not injected as a string and
   `eval`-ed. The first version did the latter and threw `parse is not defined`
   on first use: `const` in a direct eval is block-scoped TO THE EVAL, so none
   of these were visible to the code that called them. `page.evaluate`
   serialises the whole callback anyway, so there was never a reason to pass
   them separately. */

const report = await page.evaluate(() => {

  const parse = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const composite = (fg, bg) => ({
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1,
  });
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b);
    return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100;
  };
  /* The painted background BEHIND an element: walk up until something is not
     transparent. An element whose own background is rgba(0,0,0,0) is showing
     its ancestor's paint, and that ancestor is what a ratio is against. */
  const backdrop = (el) => {
    let node = el, acc = null;
    while (node) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) { acc = acc ? composite(acc, bg) : bg; if (acc.a >= 1) return acc; }
      node = node.parentElement;
    }
    return acc ?? { r: 255, g: 255, b: 255, a: 1 };
  };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  const inkRatio = (el) => {
    const fg = parse(getComputedStyle(el).color);
    const bg = backdrop(el);
    const composited = composite(fg, bg);
    return { fg: hex(composited), bg: hex(bg), ratio: ratio(composited, bg) };
  };
    const round = (n) => Math.round(n * 10) / 10;

    return [...document.querySelectorAll('.harness-panel')].map((panel) => {
      const pane = panel.getBoundingClientRect();
      const q = (sel) => panel.querySelector(sel);
      const left = (el) => (el ? round(el.getBoundingClientRect().left - pane.left) : null);
      const box = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          w: round(b.width),
          h: round(b.height),
          radius: cs.borderTopLeftRadius,
          left: round(b.left - pane.left),
          right: round(pane.right - b.right),
        };
      };

      const searchRow = q('.lp__searchrow');
      const tierRow = q('.lp__tierrow');
      const filters = q('.lp__filters');
      const firstTile = q('[data-testid="list-tile"]');
      const foot = q('[data-testid="list-footer"]') ?? q('.lp__foot');
      const chips = [...panel.querySelectorAll('.lp__chip')];
      const sortChip = q('[data-testid="sort-trigger"]');
      const tabs = [...panel.querySelectorAll('[role="tab"]')];
      const activeTab = q('.lp__tab--active');
      const inactiveTab = tabs.find((t) => !t.classList.contains('lp__tab--active'));
      const stateDot = q('.lp__statedot');
      const hollow = q('.pn-stat--hollow .pn-stat__dot');
      const caret = q('.lp__chip-caret');

      /* THE LEFT EDGES. One gutter or several — the single biggest reason a
         stack of rows reads as unaligned. Measured from the panel's own box,
         so it is independent of where the harness put the panel. */
      const gutters = {
        search: left(searchRow),
        lifecycle: left(tierRow),
        filters: chips.length ? left(chips[0]) : null,
        body: left(firstTile),
        footer: left(foot),
      };
      const distinctGutters = [...new Set(Object.values(gutters).filter((v) => v !== null))];

      /* DEAD SPACE — the gap the reporter saw between the last chip and the
         sort control at a wide panel. `.lp__spacer` is `flex: 1`, so its used
         width IS the unused width of the row. */
      const spacer = q('.lp__spacer');
      const deadSpace = spacer ? round(spacer.getBoundingClientRect().width) : null;

      const controlHeights = {
        search: box(searchRow)?.h ?? null,
        lifecycle: box(tierRow)?.h ?? null,
        chip: chips.length ? box(chips[0]).h : null,
        tab: tabs.length ? round(tabs[0].getBoundingClientRect().height) : null,
      };

      /* THE CIRCLE TEST. Nothing declares a circle; a 999px radius on a box
         whose width equals its height IS one. */
      const sort = box(sortChip);
      const sortIsCircle = sort ? Math.abs(sort.w - sort.h) <= 2 && parseFloat(sort.radius) > sort.h / 2 : null;

      const selectedVsRail = (() => {
        if (!activeTab || !tierRow) return null;
        const fg = parse(getComputedStyle(activeTab).backgroundColor);
        const rail = parse(getComputedStyle(tierRow).backgroundColor);
        if (!fg || !rail) return null;
        const face = composite(fg, rail);
        const cs = getComputedStyle(activeTab);
        return {
          fillVsRail: ratio(face, rail),
          boxShadow: cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 60),
          borderColor: cs.borderTopWidth === '0px' ? 'none' : cs.borderTopColor,
        };
      })();

      const ring = (() => {
        if (!hollow) return null;
        const cs = getComputedStyle(hollow);
        const stroke = parse(cs.borderTopColor);
        const alpha = parseFloat(cs.opacity);
        const bg = backdrop(hollow);
        const painted = composite({ ...stroke, a: (stroke.a ?? 1) * alpha }, bg);
        return {
          size: round(hollow.getBoundingClientRect().width),
          opacity: alpha,
          painted: hex(painted),
          ratio: ratio(painted, bg),
        };
      })();

      return {
        theme: panel.dataset.harnessTheme,
        width: Number(panel.dataset.harnessWidth),
        gutters,
        gutterCount: distinctGutters.length,
        distinctGutters,
        controlHeights,
        heightCount: [...new Set(Object.values(controlHeights).filter(Boolean))].length,
        radii: {
          search: box(searchRow)?.radius,
          lifecycle: box(tierRow)?.radius,
          chip: chips.length ? box(chips[0]).radius : null,
          tab: tabs.length ? getComputedStyle(tabs[0]).borderTopLeftRadius : null,
        },
        sort: sort ? { w: sort.w, h: sort.h, radius: sort.radius, label: sortChip.textContent.trim() } : null,
        sortIsCircle,
        deadSpace,
        contrast: {
          inactiveTabLabel: inactiveTab ? inkRatio(inactiveTab.querySelector('.lp__tab-word') ?? inactiveTab) : null,
          inactiveTabCount: inactiveTab?.querySelector('.lp__tab-count')
            ? inkRatio(inactiveTab.querySelector('.lp__tab-count')) : null,
          activeTabCount: activeTab?.querySelector('.lp__tab-count')
            ? inkRatio(activeTab.querySelector('.lp__tab-count')) : null,
          chipCaret: caret ? inkRatio(caret) : null,
        },
        selectedVsRail,
        ring,
        /* WCAG 2.2 SC 2.5.8 — 24x24 CSS px for a pointer target. The mark
           inside is aria-hidden decoration; the BUTTON around it is the
           control, so the button's box is what the criterion measures. */
        stateDotTarget: stateDot
          ? (() => {
              const b = stateDot.getBoundingClientRect();
              const cs = getComputedStyle(stateDot, '::before');
              const grown = cs.content !== 'none' && cs.position === 'absolute'
                ? { w: round(b.width - parseFloat(cs.left || '0') * 2), h: round(b.height - parseFloat(cs.top || '0') * 2) }
                : null;
              return { w: round(b.width), h: round(b.height), hitArea: grown };
            })()
          : null,
      };
    });
});

console.log(`\n===== ${LABEL.toUpperCase()} =====`);
for (const p of report) {
  console.log(`\n--- ${p.width}px · ${p.theme} ---`);
  console.log(` gutters            ${JSON.stringify(p.gutters)}  → ${p.gutterCount} distinct ${p.gutterCount === 1 ? 'PASS' : 'FAIL'}`);
  console.log(` control heights    ${JSON.stringify(p.controlHeights)}  → ${p.heightCount} distinct`);
  console.log(` radii              ${JSON.stringify(p.radii)}`);
  console.log(` sort control       ${JSON.stringify(p.sort)}  circle=${p.sortIsCircle} ${p.sortIsCircle ? 'FAIL' : 'PASS'}`);
  console.log(` dead space in row  ${p.deadSpace}px`);
  console.log(` selected vs rail   ${JSON.stringify(p.selectedVsRail)}`);
  console.log(` hollow ring        ${JSON.stringify(p.ring)}  ${p.ring && p.ring.ratio >= 3 ? 'PASS' : 'FAIL'} (bar 3.0)`);
  console.log(` state dot target   ${JSON.stringify(p.stateDotTarget)}`);
  for (const [k, v] of Object.entries(p.contrast)) {
    if (!v) continue;
    const bar = k === 'chipCaret' ? 3.0 : 4.5;
    console.log(`  ${k.padEnd(18)} ${v.fg} on ${v.bg}  ${String(v.ratio).padStart(5)}  ${v.ratio >= bar ? 'PASS' : 'FAIL'} (bar ${bar})`);
  }
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify({ label: LABEL, mode: MODE, report }, null, 2));

const panels = page.locator('.harness-panel');
for (let i = 0; i < report.length; i += 1) {
  const p = report[i];
  await shot(`${p.theme}-${p.width}`, panels.nth(i));
}
await shot('all', page.locator('.harness-grid'));

console.log('\nPAGE ERRORS:', errors.length === 0 ? 'none' : JSON.stringify(errors, null, 1));
await browser.close();
if (errors.length > 0) process.exit(1);
