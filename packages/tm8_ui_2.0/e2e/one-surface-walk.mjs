/**
 * ONE-SURFACE WALK — Lane 2's own instrument, beside the audit harness and not
 * inside it.
 *
 * ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
 *
 * `mobile-audit.mjs` measures OVERFLOW, and overflow on Tasks/Sessions/Channels
 * is already 0 once #332 and #333 have landed. It was 0 before this lane
 * started and it is 0 after. A number that cannot move is not evidence about
 * work that moved something, and reporting it as a win would be a lie told with
 * a true number.
 *
 * What was actually wrong survives a zero: at 390px the Tasks list rendered
 * ~200px wide with the empty desktop detail pane behind it and half the screen
 * blank. Nothing crossed the right edge. It simply was not a phone layout — it
 * was a desktop layout that had stopped overflowing.
 *
 * So this measures the ARRANGEMENT, in four numbers that move exactly when the
 * defect does:
 *
 *   surfaces        how many of {list, detail, aux} have a box at once.
 *                   THE HEADLINE. The rule is one surface at a time, so the
 *                   only correct value on a phone is 1. It was 2.
 *   listWidthFrac   the list's width over the viewport's. A full-width screen
 *                   is 1.0; the defect measured ~0.51.
 *   fillFrac        the screen body's height over the content region's. The
 *                   blank bottom half was ~0.5 here.
 *   titleWidthPx    the widest row title's box — how much of a task's name a
 *                   viewer can actually read before the ellipsis.
 *
 * ── AND WHY IT IS A SEPARATE FILE ──────────────────────────────────────────
 *
 * The harness's README states the rule plainly: an instrument that also changes
 * the thing it measures is worthless, and a lane editing the harness to improve
 * its own number should stop. This lane needs a measurement the harness does not
 * take, so it brings its own rather than reaching into the shared one. The
 * overflow numbers this lane reports still come from `mobile-audit.mjs`,
 * unmodified.
 *
 * ── THE WALK ───────────────────────────────────────────────────────────────
 *
 * Numbers do not prove that BACK works. So this also drives the thing:
 * Tasks → open a row → up → Sessions → open a row → up, screenshotting each
 * step, and checking at every one that the header chevron and the ADDRESS agree.
 * That agreement is the whole back contract — the chevron pops the screen stack
 * and `GateApp`'s sync writes the URL, so if the two ever disagreed a shared
 * link would open a different screen than the one the viewer was on.
 *
 * The traps below are the harness's, and they are repeated here rather than
 * imported because each one silently produces a plausible wrong answer:
 *   - `--channel=chrome`: the bundled chromium revision is not installed.
 *   - `isMobile` AND `hasTouch`, or `shellFor` returns 'desktop' and every
 *     number describes a shell no user has.
 *   - never `--port 0`: `vite.config.ts` sets `strictPort`, so vite falls back
 *     to 5173 and can serve ANOTHER LANE'S dev server. Bind, read, release, pin.
 *   - measure against `documentElement.clientWidth`, never `innerWidth`, which
 *     Chrome widens under emulation to swallow exactly what we are looking for.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const label = process.argv.includes('--label')
  ? process.argv[process.argv.indexOf('--label') + 1]
  : 'walk';
const outDir = 'mobile-audit';
const shotDir = `${outDir}/walk-${label}`;
mkdirSync(shotDir, { recursive: true });

/* The fixture space and the route paths are the HARNESS'S, copied verbatim from
   `mobile-audit.mjs`. A space id that the fixture seam does not know resolves
   to the Home screen instead of refusing, so a wrong constant here does not
   error — it silently measures Home three times and reports it as Tasks. */
const SPACE = 'sp-atelier';
const SCREENS = [
  { name: 'tasks', path: 'k/tasks' },
  { name: 'sessions', path: 'k/sessions' },
  { name: 'channels', path: 'channels' },
];
const VP = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

/* Bind an ephemeral socket, read what the OS gave us, release it, then PIN it.
   The race between release and vite's bind is real but tiny; `--strictPort`
   turns losing it into a loud failure rather than a silent fallback to 5173. */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

const port = await freePort();
const vite = spawn('./node_modules/.bin/vite', ['--port', String(port), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite did not start in 40s')), 40_000);
  vite.stdout.on('data', (d) => {
    if (String(d).includes('ready in') || String(d).includes('Local:')) {
      clearTimeout(t);
      setTimeout(resolve, 600);
    }
  });
});
const base = `http://127.0.0.1:${port}`;

/**
 * Runs INSIDE the page.
 *
 * "Visible" is `getClientRects().length && width > 0` — a `display: none`
 * region yields no rects, which is the same answer the audit harness's overflow
 * pass gives it, so the two instruments agree about what is on screen.
 */
function measure() {
  const vw = document.documentElement.clientWidth;
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && el.getClientRects().length ? { w: r.width, h: r.height, right: r.right } : null;
  };

  const list = box('.ev-list') ?? box('.chv-main');
  const detail = box('.ev-detail') ?? box('.chv-aside');
  const auxCol = box('.ev-aux');
  /* The aux inside a SHEET is not a third column — it is a cover over one
     surface. Counting it would score a working sheet as the defect it
     replaced, so surfaces counts COLUMNS and the sheet is reported apart. */
  const inSheet = !!document.querySelector('.msheet .ev-aux');

  const region = document.querySelector('.mobile-frame__content');
  const body = document.querySelector('.ev-root') ?? document.querySelector('.chv-root');
  const regionH = region ? region.getBoundingClientRect().height : 0;
  const bodyH = body ? body.getBoundingClientRect().height : 0;

  const titles = [...document.querySelectorAll('.lp__title, .lp__tile-main .lp__row1 button')]
    .map((el) => el.getBoundingClientRect().width)
    .filter((w) => w > 0);

  const seen = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || !el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && Number(s.opacity) !== 0;
  };

  /*
   * (2) FOREIGN-PANE PIXELS — the criterion author's formulation, and the
   * sharpest of the four because it names the defect rather than a symptom of
   * it. The INACTIVE pane is the one the viewer did not ask for: with nothing
   * selected that is the detail column (whose empty state drew "…your
   * attention." under the list); with something selected it is the list.
   *
   * Counted as ELEMENTS rather than pixels — a pixel count would be dominated
   * by whichever container happened to be largest, while the question is how
   * much of another pane is on screen at all. The target is 0 and the only
   * honest value on one surface is 0.
   */
  const root = document.querySelector('.ev-root');
  const mode = root?.getAttribute('data-mode') ?? null;
  const foreignPane = root
    ? (mode === 'detail' ? root.querySelector('.ev-list') : root.querySelector('.ev-detail'))
    : null;
  const foreignPaneElements = foreignPane
    ? [foreignPane, ...foreignPane.querySelectorAll('*')].filter(seen).length
    : 0;

  /*
   * (3) TRUNCATION WITH SLACK — text ellipsised while the screen still had
   * room. `scrollWidth > clientWidth` is the ellipsis; the slack is the gap
   * between the element's right edge and the viewport's. A title cut at 200px
   * on a 390px screen has ~190px of slack and is the defect; a title cut at
   * the true edge of a full-width screen is honest and scores 0.
   */
  const truncatedWithSlack = [...document.querySelectorAll('.ev-root *, .chv-root *')]
    .filter((el) => {
      if (!seen(el)) return false;
      if (el.scrollWidth <= el.clientWidth + 1) return false;
      const r = el.getBoundingClientRect();
      return vw - r.right > 24;
    }).length;

  /*
   * (1) CONTENT WIDTH RATIO — measured on the CARD the viewer sees (`.lp`),
   * not on its containing section.
   *
   * These differ, and the difference is the defect's mechanism. `.ev-list` is
   * `flex: 1; min-width: 0` in a row whose detail column is a rigid 380px with
   * an 8px resizer, so at 390px the SECTION is solved to 2px — a ratio of
   * 0.005. The card inside it refuses to go below `.lp`'s 200px floor and
   * simply overflows its own parent, which is why the eye sees 200px while the
   * box model says 2. Reporting the section alone would score the screen as
   * catastrophically worse than it looks; reporting the card alone would hide
   * why. Both are recorded.
   */
  const card = box('.lp') ?? box('.pn-panel');

  return {
    viewportWidth: vw,
    surfaces: [list, detail, auxCol && !inSheet ? auxCol : null].filter(Boolean).length,
    cardWidthFrac: card ? +(card.w / vw).toFixed(3) : null,
    listWidthFrac: list ? +(list.w / vw).toFixed(3) : null,
    detailWidthFrac: detail ? +(detail.w / vw).toFixed(3) : null,
    fillFrac: regionH ? +(bodyH / regionH).toFixed(3) : null,
    titleWidthPx: titles.length ? Math.round(Math.max(...titles)) : null,
    foreignPaneElements,
    truncatedWithSlack,
    sheetOpen: !!document.querySelector('.msheet'),
    auxInSheet: inSheet,
    resizers: document.querySelectorAll('.kit-resizer').length,
    /* The address, so the walk can prove the chevron and the URL agree. */
    hash: location.hash,
    mode: document.querySelector('.ev-root')?.getAttribute('data-mode') ?? null,
    hasBackChevron: !!document.querySelector('.mobile-header__back'),
  };
}

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: VP.width, height: VP.height }, ...VP });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

const steps = [];
async function settle() {
  await page.waitForTimeout(900);
  try { await page.evaluate(() => document.fonts.ready); } catch { /* older engines */ }
  await page.waitForTimeout(250);
}
async function record(name) {
  await settle();
  const m = await page.evaluate(measure);
  await page.screenshot({ path: `${shotDir}/${name}.png` });
  steps.push({ step: name, ...m });
  const s = `surfaces=${m.surfaces} foreign=${m.foreignPaneElements} card=${m.cardWidthFrac} fill=${m.fillFrac} trunc=${m.truncatedWithSlack} title=${m.titleWidthPx} sheet=${m.sheetOpen} chevron=${m.hasBackChevron} mode=${m.mode}`;
  console.log(`  ${name.padEnd(26)} ${s}\n${' '.repeat(29)}${m.hash}`);
  return m;
}

/* One screen's failure must not cost the other two their measurements. A walk
   that dies on `channels` and takes `tasks` and `sessions` down with it means
   re-running everything to learn one thing — and the numbers it did collect
   were real. Failures are recorded and the walk continues. */
const walkErrors = [];
for (const { name: screen, path } of SCREENS) {
  try {
  console.log(`\n### ${screen}`);
  await page.goto('about:blank');
  await page.goto(`${base}/mobile-audit.html#/s/${SPACE}/${path}`, { waitUntil: 'networkidle' });
  const landed = await record(`${screen}-1-list`);
  /* A wrong address lands on Home and measures beautifully. Say so loudly
     rather than publish three copies of the Home screen as three screens. */
  if (!landed.hash.includes(path)) {
    console.log(`  !! LANDED SOMEWHERE ELSE: wanted ${path}, got ${landed.hash} — row is not evidence`);
  }

  /* Drill in by TAPPING A ROW, not by navigating to its address. The address
     would prove the router works and say nothing about whether a thumb can get
     there — and "can you open a task on a phone" is the question. */
  /* `.pn-tt__title` too: the Tasks list renders a TREE, whose rows are not
     `.lp__title` at all. Selecting only the flat-list class silently found no
     rows there and skipped the drill-in — reporting nothing where the walk's
     whole subject is whether drilling in works. */
  const row = page.locator('.lp__title, .pn-tt__title').first();
  if ((await row.count()) === 0) {
    console.log('  (no rows to open — skipping the drill-in for this screen)');
    continue;
  }

  /*
   * TAP THE LEFT EDGE OF THE TITLE, not its centre.
   *
   * Playwright clicks an element's centre, and since #333 the row's action
   * cluster is a REAL control on touch rather than a hover-only reveal — so it
   * sits over the right-hand part of the title and intercepts the press. The
   * centre of a long title lands under it and the click times out.
   *
   * Deliberately NOT `force: true`. Force dispatches at the centre anyway and
   * merely stops asking whether anything is in the way, which would send this
   * walk's press to the cluster's button while reporting a successful row tap.
   * An offset click is a real press on a part of the row a thumb can reach.
   */
  const tap = async (locator) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('row has no box');
    /* A real press, at the row's LEFT edge, through real hit-testing — this is
       where a thumb goes for a name, and the cluster lives at the other end.
       `page.mouse` rather than `locator.click` because the locator API insists
       on the element's centre, which for a long title is under the cluster. */
    const x = box.x + 5;
    const y = box.y + box.height / 2;
    const hit = await page.evaluate(
      ([px, py]) => {
        const el = document.elementFromPoint(px, py);
        return el ? `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').slice(0, 2).join('.')}` : 'none';
      },
      [x, y],
    );
    /* WHAT ACTUALLY RECEIVES THE PRESS, recorded rather than assumed. If a
       control other than the row is sitting where a thumb aims for the name,
       that is a finding about the row — not a reason to force the click and
       report a tap that never happened. */
    console.log(`    tap at (${Math.round(x)},${Math.round(y)}) hits ${hit}`);
    await page.mouse.click(x, y);
  };
  await tap(row);
  const opened = await record(`${screen}-2-detail`);

  /* THE CONTRACT, CHECKED RATHER THAN ASSUMED: drilling in must have written
     the address. If it did not, the chevron below would pop a stack the URL
     never knew about, and a shared link from this screen would be wrong. */
  if (!/\/e\//.test(opened.hash)) {
    console.log(`  !! DRILL-IN DID NOT WRITE AN ENTITY ADDRESS: ${opened.hash}`);
  }

  /*
   * THE SHEET (AC3). The Discussion tab is an AUX target — on the desktop it
   * opens the third column, and on the phone it must become a sheet. Driven
   * rather than asserted about: a sheet that renders into a null host returns
   * null silently, so "the code is there" proves nothing at all.
   */
  const discussion = page.getByRole('tab', { name: /Discussion/ }).first();
  if ((await discussion.count()) > 0) {
    await discussion.click();
    const sheet = await record(`${screen}-2b-sheet`);
    if (!sheet.sheetOpen) console.log('  !! DISCUSSION DID NOT OPEN A SHEET');
    if (!sheet.auxInSheet) console.log('  !! AUX RENDERED AS A COLUMN, NOT IN THE SHEET');
    /* Dismiss by the backdrop — the gesture with no button behind it, and the
       one most likely to be wired wrong. A sheet you cannot close by tapping
       away is a trap on a device with no Escape key. */
    await page.mouse.click(195, 40);
    const closed = await record(`${screen}-2c-sheet-dismissed`);
    if (closed.sheetOpen) console.log('  !! BACKDROP TAP DID NOT DISMISS THE SHEET');
  } else {
    console.log('  (no Discussion tab on this screen)');
  }

  /* UP, via the header chevron — `useScreenStack().pop`, never history.back().
     Lane N's ruling, and the seam both shells share. */
  const chevron = page.locator('.mobile-header__back');
  if ((await chevron.count()) === 0) {
    console.log('  !! NO BACK CHEVRON WITH A DETAIL OPEN');
  } else {
    await chevron.click();
    const up = await record(`${screen}-3-back`);
    if (/\/e\//.test(up.hash)) console.log(`  !! CHEVRON DID NOT LEAVE THE ENTITY: ${up.hash}`);
  }

  /* And the phone's OWN back gesture, from the same place, to prove the two
     agree. Re-open, then walk the browser's history instead of the chrome. */
  await tap(row);
  await settle();
  await page.goBack();
  const back = await record(`${screen}-4-browser-back`);
  if (/\/e\//.test(back.hash)) console.log(`  !! BROWSER BACK DID NOT LEAVE THE ENTITY: ${back.hash}`);
  if (back.surfaces !== 1) console.log(`  !! BROWSER BACK LEFT ${back.surfaces} SURFACES`);
  } catch (e) {
    const msg = `${screen}: ${String(e).split('\n')[0]}`;
    walkErrors.push(msg);
    console.log(`  !! WALK FAILED — ${msg}`);
  }
}

writeFileSync(`${outDir}/walk-${label}.json`, JSON.stringify({ label, steps, errors, walkErrors }, null, 2));
if (walkErrors.length) console.log(`\nwalk failures: ${walkErrors.length}\n  ${walkErrors.join('\n  ')}`);
console.log(`\npageerrors: ${errors.length}${errors.length ? `\n  ${errors.join('\n  ')}` : ''}`);
console.log(`wrote ${outDir}/walk-${label}.json and ${shotDir}/*.png`);

await browser.close();
vite.kill();
