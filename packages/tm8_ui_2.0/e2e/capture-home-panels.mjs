// Standalone pixel-evidence capture (NOT a spec — .mjs is outside the test glob).
// Task 01a00ac2: Home's column A resizes, and collapses with the icon rail.
//
// WHY THIS EXISTS AT ALL. Every assertion in panel-resize.test.tsx is about a
// NUMBER — the custom property, the storage key, the clamp. None of them can
// see the LAYOUT, because jsdom loads no stylesheets: the grid track that reads
// `--hp-list`, the absolutely-positioned handle, the collapsed 10px column and
// the hidden sidebar are all invisible to vitest by construction. This drives
// the real browser and MEASURES them.
//
// Run: bunx vite --port 4633 & bunx node e2e/capture-home-panels.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.CAPTURE_BASE ?? 'http://127.0.0.1:4633';
const OUT = 'gate-evidence';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1492, height: 812 } });
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.localStorage.setItem('tm8-ui:real-seam', '0');
  window.localStorage.setItem(
    'tm8ui.auth.passes.v1',
    JSON.stringify({
      [window.location.origin]: {
        token: 'tm8s_capture.secret',
        account: {
          handle: '@capture',
          displayName: 'Capture',
          accountId: 'acct-capture',
          identityId: 'id-capture',
          isOwner: true,
          isNodeAdmin: true,
        },
        sessionId: 'sess-capture',
        expiresAt: '2027-01-01T00:00:00.000Z',
        signedInAt: '2026-08-16T00:00:00.000Z',
      },
    }),
  );
});

const shoot = async (name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('saved', `${OUT}/${name}.png`);
};

/** The real, laid-out geometry — the whole point of running a browser. */
const measure = () =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), visible: r.width > 0 && r.height > 0 };
    };
    return {
      rail: box('.hr-rail'),
      list: box('.tch-sidebar'),
      centre: box('.tch-conversation') ?? box('.tch-center'),
      sep: box('.hp-listsep'),
      reveal: box('.hp-listreveal'),
      listVar: getComputedStyle(document.querySelector('.hp-host')).getPropertyValue('--hp-list'),
      sidebarVis: document.querySelector('.tch-sidebar')
        ? getComputedStyle(document.querySelector('.tch-sidebar')).visibility
        : null,
    };
  });

const report = (label, m) => {
  console.log(`\n── ${label}`);
  console.log(JSON.stringify(m, null, 2));
};

await page.goto(`${BASE}/#/s/sp-atelier/home`);
await page.getByTestId('home-page').waitFor();
await page.getByTestId('home-rail').waitFor();
/* The list column mounts with the chat surface, a beat after the page — wait
   for the thing being measured, or the first report reads `null` and looks
   like a missing column. */
await page.locator('.tch-sidebar').waitFor();

const atRest = await measure();
report('AT REST (default 340)', atRest);
await shoot('home-panels-01-rest');

const sep = page.getByTestId('panel-resizer-left');
/* RE-READ THE HANDLE EVERY TIME. It MOVES with the column it resizes, so a
   bounding box captured once is stale the moment the first drag lands — press
   at the old x and the gesture grabs empty centre and silently does nothing,
   which reads in the report as "the clamp held" when nothing was ever
   dragged. (Cost one bogus ceiling result while writing this.) */
async function dragBy(dx) {
  const box = await sep.boundingBox();
  const y = box.y + Math.min(200, box.height / 2);
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, y, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(120);
}

// ── The drag. Pointer, not keyboard: this is the gesture people use, and it is
//    the one that has to line up with the edge it moves.
await dragBy(160);
const dragged = await measure();
report('AFTER DRAG +160 (expect 500)', dragged);
await shoot('home-panels-02-dragged');

// ── The ceiling: drag far past the ruled 560 maximum and confirm it stops.
await dragBy(900);
const maxed = await measure();
report('AFTER DRAG TO THE FAR RIGHT (expect the 560 ceiling)', maxed);
await shoot('home-panels-03-ceiling');

// ── The floor: drag far past the ruled 240 minimum. It must CLAMP, not close.
await dragBy(-900);
const floored = await measure();
report('AFTER DRAG TO THE FAR LEFT (floor 240, must NOT close)', floored);
await shoot('home-panels-04-floor');

// ── Focus mode: the chevron takes the rail and column A together.
await page.getByTestId('hp-list-collapse').click({ force: true });
await page.getByTestId('hp-list-reveal').waitFor();
const collapsed = await measure();
report('COLLAPSED (rail + A gone, reveal strip remains)', collapsed);
await shoot('home-panels-05-collapsed');

// ── And back, through the persistent affordance.
await page.getByTestId('hp-list-reveal').click();
await page.getByTestId('home-rail').waitFor();
const restored = await measure();
report('RESTORED via the reveal strip', restored);
await shoot('home-panels-06-restored');

// ── Dark theme, because the strip and chevron are new chrome with new borders.
await page.evaluate(() => {
  for (const el of document.querySelectorAll('.cv2-root')) el.setAttribute('data-theme', 'dark');
  document.documentElement.setAttribute('data-theme', 'dark');
});
await shoot('home-panels-07-dark');

await browser.close();
