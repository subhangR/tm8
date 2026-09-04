/**
 * COUNTS THE ROWS in Home's left-column header, in a real browser.
 *
 * The deliverable is "five rows become four", which is a statement about how
 * many distinct line bands the header's controls occupy. jsdom returns zeros
 * from `getBoundingClientRect`, so no vitest case in this package can count a
 * row; this is the only instrument that can.
 *
 * It also carries the WIDTH argument that settled the original proposal.
 * Home's column is `minmax(210px, 280px)`, so every row is swept across that
 * range and reported with its NATURAL width — the width its children want on
 * one line. A row whose natural width exceeds the column cannot take on more
 * content, however much vertical space merging it would save.
 *
 * `.cv2-root` carries a CSS `zoom`, which multiplies every length inside it
 * while `getBoundingClientRect` answers in real screen px. Every number is
 * therefore divided by the cumulative zoom of the ancestor chain: a CSS claim
 * made off the raw rect is ~10% too large.
 *
 *   node e2e/measure-home-header.mjs [uiOrigin]
 */
import { chromium } from '@playwright/test';

const ui = process.argv[2] ?? 'http://127.0.0.1:4671';
const WIDTHS = [210, 240, 280];

const browser = await chromium.launch({
  // The system Chrome: only `chromium-1208` is in the playwright cache here
  // and its headless shell is absent, which is a launch error, not a fallback.
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const report = {};
for (const arm of ['legacy', 'shipped'])
for (const width of WIDTHS) {
  await page.goto(
    `${ui}/e2e/home-header-harness.html?w=${width}&kind=task${arm === 'legacy' ? '&legacy=1' : ''}`,
    { waitUntil: 'networkidle' },
  );
  await page.waitForSelector('[data-testid="tch-hosted-list"]', { timeout: 25_000 });
  await page.waitForSelector('.lp__tierrow', { timeout: 25_000 });

  report[`${arm}:${width}`] = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const column = q('[data-testid="home-column"]');

    let zoom = 1;
    for (let el = column; el; el = el.parentElement) {
      const z = parseFloat(getComputedStyle(el).zoom || '1');
      if (Number.isFinite(z) && z !== 1) zoom *= z;
    }
    const css = (n) => Math.round((n / zoom) * 10) / 10;
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: css(r.top), h: css(r.height), w: css(r.width) };
    };
    /* What this row's children want on ONE line: their own widths plus the
       gaps and padding the stylesheet declares. The flex `spacer` is excluded
       — it is slack, not content. */
    const natural = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const gap = parseFloat(cs.columnGap || cs.gap || '0') || 0;
      const pad = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
      const kids = [...el.children].filter((c) => !c.classList.contains('lp__spacer'));
      const sum = kids.reduce((n, c) => n + c.getBoundingClientRect().width, 0);
      return css(sum + gap * Math.max(0, kids.length - 1) + pad);
    };

    /* THE ROW COUNT — by vertical OVERLAP, never by equal `top`.
       `align-items: center` gives two controls on ONE line different top
       edges whenever they differ in height: the switcher is 24px tall inside a
       29.2px bar, so its top sits 2.6px lower than the tablist's and any
       top-equality test (even a 2px tolerance) reports them as two rows. That
       is how this script FIRST reported five rows for a four-row header.
       Two controls share a row iff their vertical spans intersect. */
    const controls = [
      ['roots', q('.tch-roots')],
      ['viewSwitcher', q('.tch-rootbar .lp__views') ?? q('.lp__views')],
      ['kindSelector', q('.lp__selector')],
      ['search', q('.lp__searchrow')],
      ['tiers', q('.lp__tierrow')],
      ['filters', q('.lp__filters')],
    ].filter(([, el]) => el != null);

    const spans = controls
      .map(([name, el]) => {
        const r = el.getBoundingClientRect();
        return { name, top: r.top, bottom: r.bottom };
      })
      .sort((a, b) => a.top - b.top);
    const bands = [];
    for (const span of spans) {
      const band = bands.find((b) => span.top < b.bottom && b.top < span.bottom);
      if (band) {
        band.members.push(span.name);
        band.bottom = Math.max(band.bottom, span.bottom);
      } else {
        bands.push({ top: span.top, bottom: span.bottom, members: [span.name] });
      }
    }

    const header = q('.tch-sidebar');
    const body = q('.tch-panel-host .lp__body');

    return {
      zoom: Math.round(zoom * 1000) / 1000,
      columnWidth: css(column.getBoundingClientRect().width),
      rowCount: bands.length,
      rows: bands.map((b) => ({ top: css(b.top), controls: b.members })),
      /* Everything above the first list row is chrome; the point of deleting a
         row is the pixels the list gets back. */
      headerHeight:
        header && body
          ? css(body.getBoundingClientRect().top - header.getBoundingClientRect().top)
          : null,
      boxes: {
        rootbar: box(q('.tch-rootbar')),
        roots: box(q('.tch-roots')),
        views: box(q('.lp__views')),
        kindSelector: box(q('.lp__selector')),
        search: box(q('.lp__searchrow')),
        tiers: box(q('.lp__tierrow')),
        filters: box(q('.lp__filters')),
      },
      naturalWidth: {
        rootbar: natural(q('.tch-rootbar')),
        tiers: natural(q('.lp__tierrow')),
        filters: natural(q('.lp__filters')),
      },
      clipped: {
        rootcellLabel: (() => {
          // The kind label ellipsizes by design; report WHETHER it is doing so,
          // because "it fits" and "it fits because it truncated" differ.
          const el = q('.tch-rootcell--kind .tch-rootcell__label');
          return el ? el.scrollWidth > el.clientWidth + 1 : null;
        })(),
        tiers: (() => {
          const el = q('.lp__tierrow');
          return el ? el.scrollWidth > el.clientWidth + 1 : null;
        })(),
        filters: (() => {
          const el = q('.lp__filters');
          return el ? el.scrollWidth > el.clientWidth + 1 : null;
        })(),
      },
      switcherPositions: [...document.querySelectorAll('.lp__views > *')].length,
      kindLabel: q('.tch-rootcell--kind .tch-rootcell__label')?.textContent?.trim() ?? null,
      duplicateKindCells: document.querySelectorAll('.lp__kind').length,
    };
  });
}

/**
 * WHICH WIDTHS THE COLUMN ACTUALLY TAKES.
 *
 * `minmax(210px, 280px)` permits any width in that range, but a grid track
 * only shrinks below its max when the container cannot afford it. Below 760px
 * the stylesheet collapses Home to a single column, so the two-column layout
 * only ever renders above that — and this sweep says what the track measures
 * there. Without it, "the label ellipsizes at 240" is an unweighted finding:
 * a defect if 240 happens, a note about a floor if it does not.
 */
await page.goto(`${ui}/e2e/home-header-harness.html?w=auto&kind=task`, {
  waitUntil: 'networkidle',
});
await page.waitForSelector('[data-testid="tch-hosted-list"]', { timeout: 25_000 });
const columnSweep = [];
for (const vw of [760, 800, 900, 1100, 1400, 1920]) {
  await page.setViewportSize({ width: vw, height: 900 });
  await page.waitForTimeout(120);
  columnSweep.push(
    await page.evaluate((viewport) => {
      const sidebar = document.querySelector('.tch-sidebar');
      let zoom = 1;
      for (let el = sidebar; el; el = el.parentElement) {
        const z = parseFloat(getComputedStyle(el).zoom || '1');
        if (Number.isFinite(z) && z !== 1) zoom *= z;
      }
      const label = document.querySelector('.tch-rootcell--kind .tch-rootcell__label');
      return {
        viewport,
        sidebarWidth: Math.round((sidebar.getBoundingClientRect().width / zoom) * 10) / 10,
        kindLabelClipped: label ? label.scrollWidth > label.clientWidth + 1 : null,
      };
    }, vw),
  );
}

/**
 * THE LONGEST LABELS AT THE REAL WIDTH.
 *
 * Moving the switcher onto the header line spends ~81px that the kind cell
 * used to have, and the cell's label is the tab's whole identity. "Tasks" is
 * the short case; the risk lives in the long plurals, so each root kind is
 * mounted at the width the sweep above proved is the real one.
 */
await page.setViewportSize({ width: 1400, height: 900 });
const labelSweep = [];
for (const kind of ['task', 'work_session', 'doc']) {
  await page.goto(`${ui}/e2e/home-header-harness.html?w=280&kind=${kind}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForSelector('[data-testid="tch-hosted-list"]', { timeout: 25_000 });
  labelSweep.push(
    await page.evaluate((k) => {
      const label = document.querySelector('.tch-rootcell--kind .tch-rootcell__label');
      const views = document.querySelector('.tch-rootbar .lp__views');
      return {
        kind: k,
        label: label?.textContent?.trim() ?? null,
        clipped: label ? label.scrollWidth > label.clientWidth + 1 : null,
        shortfallPx: label ? Math.max(0, label.scrollWidth - label.clientWidth) : null,
        switcherPositions: views ? views.children.length : 0,
      };
    }, kind),
  );
}

console.log(JSON.stringify({ report, columnSweep, labelSweep, errors }, null, 2));
await browser.close();
