/**
 * mobile-audit — THE INSTRUMENT. Every lane in the mobile program is measured
 * with this and posts its numbers from this.
 *
 * Run it:  bun run audit:mobile          (starts vite, measures, writes JSON + PNGs)
 *          bun run audit:mobile -- --viewport phone-390 --route tasks
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, stated as the failure it prevents rather than the feature it
 * is: `vitest` cannot see a single defect this program fixes. jsdom loads no
 * stylesheets, so every layout assertion in this repo is an assertion about an
 * unstyled DOM. 401 green tests over a screen with content clipped off its right
 * edge is the normal state of affairs here, not a hypothetical. Nothing in the
 * unit suite is evidence about layout, and this file is what replaces it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MEASUREMENT THAT MATTERS, and the one that lies.
 *
 * The obvious overflow check is `document.scrollWidth > innerWidth`. IT DOES NOT
 * WORK HERE and it does not fail loudly — it reports "fine" on a broken screen.
 *
 * Both shells are laid out inside a container with `overflow: hidden`:
 * `.shell-root` on desktop, `.mobile-frame` on the phone. A hidden overflow
 * container does not extend its scrollable area; it CLIPS. So content pushed
 * past the right edge is not scrolled-to, it is destroyed — and `scrollWidth`
 * stays exactly equal to `innerWidth` while it happens. Measured on this very
 * fixture: the Tasks screen at 390px loses content to a right edge of 449px with
 * `scrollWidth === innerWidth === 390`.
 *
 * The check that actually sees it is PER-ELEMENT:
 *
 *     el.getBoundingClientRect().right > innerWidth
 *
 * That is the primary number this instrument reports. `scrollWidth` is reported
 * too, but only so a reader can watch it disagree — it is context, never proof.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO TRAPS THAT SILENTLY MEASURE THE WRONG THING.
 *
 * 1. NO BUNDLED BROWSER. This repo's playwright is 1.58.2 and its chromium
 *    revision is NOT installed, so a bare launch dies with "download new
 *    browsers". `channel: 'chrome'` uses the system Google Chrome instead.
 *    Do not run `playwright install` to make this go away — a different browser
 *    build is a different set of numbers, and the whole program is comparing
 *    numbers across lanes and across days.
 *
 * 2. NO COARSE POINTER, NO PHONE. `shellFor` forks on
 *    `(pointer: coarse) && width < 500`. A context without `isMobile`/`hasTouch`
 *    reports a FINE pointer at any width, so `shellFor` returns `'desktop'` and
 *    you carefully measure the desktop shell squeezed into 390px — a screen no
 *    user has. This script therefore ASSERTS the shell it landed in against the
 *    shell the viewport profile expects, and refuses to record a row that
 *    disagrees. A wrong number is worse than a missing one.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

/**
 * THE REF THE NUMBERS WERE TAKEN AT — captured by this script, never passed in.
 *
 * A measurement without its ref cannot be compared to anything later, and this
 * baseline is what eight other lanes are judged against. It was an env var the
 * caller had to remember, which is not a mechanism: forget it once and the file
 * records `null` while looking exactly like a good one.
 *
 * It captures three things, because "which commit" is three questions:
 *
 *   - `head`/`branch` — what was measured.
 *   - `behindMain` — how stale it already is. main moved three times during this
 *     lane's own build.
 *   - `dirty` — THE ONE THAT MATTERS MOST. A sha names a tree; uncommitted edits
 *     mean the sha is a lie and nobody can ever reproduce the run. A dirty
 *     baseline is not evidence, so it is recorded and shouted about rather than
 *     quietly rolled into the numbers.
 *
 * A sibling lane retracted a complete set of measurements taken in a shared
 * checkout sitting 678 commits behind main on code that had since been
 * rewritten. `branch` and `behindMain` in every output file are how that gets
 * caught by reading the file instead of by someone noticing.
 */
function gitRef(outDir) {
  const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); } catch { return null; } };
  /*
   * WHAT "DIRTY" HAS TO MEAN: the sha does not name the tree that was measured.
   * That is TRACKED modifications, and only those — hence `-uno`.
   *
   * Two false positives had to go, and a check that always fires is a check
   * nobody reads:
   *   - this run rewrites `<outDir>/<label>.json` inside the repo, so a bare
   *     `--porcelain` called every run dirty. Excluded by pathspec.
   *   - a worktree needs an untracked `node_modules` symlink to run at all, so
   *     counting untracked paths called every worktree dirty too.
   *
   * Dropping untracked files does not open a hole: an untracked file can only
   * affect the render if something imports it, and that importer is a tracked
   * file which would then show as modified. The count is still reported, so a
   * reader can see what was set aside rather than take it on trust.
   */
  const status = git('status', '--porcelain', '-uno', '--', ':(exclude)' + outDir);
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', ':(exclude)' + outDir);
  return {
    head: git('rev-parse', 'HEAD'),
    headShort: git('rev-parse', '--short', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    behindMain: Number(git('rev-list', '--count', 'HEAD..origin/main') ?? -1),
    dirty: status === null ? null : status.length > 0,
    dirtyFiles: status ? status.split('\n').slice(0, 20) : [],
    untrackedCount: untracked ? untracked.split('\n').length : 0,
  };
}

/**
 * The fixture's space. `mobile-audit-entry.tsx` arms the FIXTURE seam, whose
 * world is a fixed, checked-in set of entities — so this id is a constant and
 * not a discovery step. That determinism is the point: a baseline taken against
 * a live node would move every time somebody filed a task.
 */
const SPACE = 'sp-atelier';

/**
 * VIEWPORT PROFILES.
 *
 * The two phones are the program's targets. The other two are here because
 * several lanes will be editing SHARED stylesheets, and desktop is in daily use
 * — a mobile fix that lands a regression on the desktop shell has to be caught
 * by the same run that proved the mobile fix, or it is caught by a human
 * noticing, which is not a mechanism.
 *
 * `expectShell` is an assertion, not a label. See trap 2 above.
 *
 * ON tablet-768: coarse pointer at 768px is WIDER than shellFor's 500px cut, so
 * it gets the DESKTOP shell. That is the current design and this lane does not
 * change it — the row is recorded so that whoever revisits the cut has the
 * before-number in hand.
 */
const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, expectShell: 'mobile' },
  { name: 'phone-430', width: 430, height: 932, deviceScaleFactor: 3, isMobile: true, hasTouch: true, expectShell: 'mobile' },
  { name: 'tablet-768', width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true, expectShell: 'desktop' },
  { name: 'desktop-1440', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false, expectShell: 'desktop' },
];

/**
 * DESTINATIONS — every address the shell can land on, as the URL a shared link
 * would carry. Enumerated from `routes/codec.ts` (the encoder) and checked
 * against `MobileShell.tsx`'s tab bar, so this list is the app's, not mine.
 *
 * `phone` marks what the PHONE renders as a real screen — the five tabs. The
 * rest still get measured on a phone, because a shared link genuinely lands
 * there and the honest "no phone layout yet" card is itself a screen that can
 * overflow. Recording them is how we prove the refusal is well-behaved.
 *
 * `workspace` is on this list and stays a refusal card by OWNER RULING: the
 * three-column panel stack gets no phone port. It is measured, not ported.
 */
const ROUTES = [
  { name: 'home', path: 'home', phone: 'screen', note: 'Home tab — ChatHomeSurface' },
  { name: 'tasks', path: 'k/tasks', phone: 'screen', note: 'Tasks tab — EntityView' },
  { name: 'sessions', path: 'k/sessions', phone: 'screen', note: 'Sessions tab — EntityView' },
  { name: 'channels', path: 'channels', phone: 'screen', note: 'Channels tab — channel EntityView' },
  { name: 'inbox', path: 'inbox', phone: 'screen', note: 'Inbox tab — InboxView' },
  { name: 'workspace', path: 'workspace', phone: 'refusal', note: 'Work tab — no phone port (owner ruling)' },
  { name: 'feed', path: 'feed', phone: 'refusal', note: '' },
  { name: 'graph', path: 'graph', phone: 'refusal', note: '' },
  { name: 'files', path: 'files', phone: 'refusal', note: '' },
  { name: 'git', path: 'git', phone: 'refusal', note: '' },
  { name: 'messages', path: 'messages', phone: 'refusal', note: '' },
  { name: 'board', path: 'board', phone: 'refusal', note: '' },
  { name: 'craft', path: 'craft', phone: 'refusal', note: '' },
  { name: 'settings', path: 'settings', phone: 'refusal', note: '' },
];

/**
 * THE MINIMUM TAP TARGET, in CSS px.
 *
 * 44 is Apple's HIG figure and the one this program was briefed against. It is
 * a floor on the SMALLER SIDE of the hit rect: a control 200x20 fails, because
 * a thumb misses vertically just as easily as horizontally.
 */
const MIN_TAP = 44;

/**
 * Sub-pixel slack. Fractional layout routinely lands a rect at
 * `right === innerWidth + 0.0001`, and a zero-tolerance comparison turns that
 * into a defect report that no lane can ever close. Half a pixel is invisible
 * and is never a real clipping bug.
 */
const EPS = 0.5;

/* ── the in-page measurement ───────────────────────────────────────────────
 *
 * Runs inside the page. Everything it returns is a number or a string, because
 * it crosses a serialization boundary — no DOM nodes escape this function.
 */
function measureInPage({ MIN_TAP, EPS }) {
  /** A short, human-readable path to an element, for the offender lists. */
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      const cls = (typeof n.className === 'string' ? n.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      parts.unshift(n.tagName.toLowerCase() + cls.map((c) => '.' + c).join(''));
    }
    return parts.join(' > ');
  };

  /* Rendered means it has a box. `display:none` yields an all-zero rect, and a
     zero-area element cannot clip anything — including it would inflate every
     count with invisible nodes and make the number useless for comparison. */
  const rendered = (r) => r.width > 0 || r.height > 0;

  const all = [...document.querySelectorAll('*')];

  /*
   * THE VIEWPORT REFERENCE — `documentElement.clientWidth`, NOT `innerWidth`,
   * and this is the second lie this instrument had to be repaired for.
   *
   * Under Chrome's mobile emulation `window.innerWidth` is not the viewport: it
   * is the LAYOUT viewport, and Chrome WIDENS the layout viewport to swallow
   * content that overflows the initial containing block. Measured on this
   * fixture at a 768x1024 device: `clientWidth` 768, `scrollWidth` 918, and
   * `innerWidth` ALSO 918 — grown to exactly match the overflow.
   *
   * So `right > innerWidth` compares content against a viewport that already
   * expanded to contain it. The worse the overflow, the more innerWidth grows to
   * hide it, and the count falls toward zero. An instrument that reports
   * "improved" as a screen gets more broken is worse than no instrument, and it
   * is precisely the failure mode — a plausible number measured against the
   * wrong reference — that this whole file exists to refuse.
   *
   * `documentElement.clientWidth` is the visible layout box and does not grow.
   * It agreed with the requested device width at every viewport tested.
   * `innerWidth` is still reported below, so a reader can watch it disagree.
   */
  const vw = document.documentElement.clientWidth;

  const over = [];
  let worstRight = 0;
  let worstLeft = 0;
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (!rendered(r)) continue;
    if (r.right > worstRight) worstRight = r.right;
    if (r.left < worstLeft) worstLeft = r.left;
    if (r.right > vw + EPS) over.push({ el, right: r.right, path: pathOf(el), text: (el.textContent || '').trim().slice(0, 40) });
  }

  /* ROOTS: an overflowing element usually drags its ancestors over with it, so
     the raw count is inflated by parents that are only guilty by containment.
     A root is an offender with no offending ancestor — the handful of elements
     a lane actually has to fix. The raw count stays the headline because it is
     the number that is comparable across runs; roots are the diagnosis. */
  const overSet = new Set(over.map((o) => o.el));
  const roots = over
    .filter((o) => { for (let p = o.el.parentElement; p; p = p.parentElement) if (overSet.has(p)) return false; return true; })
    .sort((a, b) => b.right - a.right)
    .slice(0, 12)
    .map(({ right, path, text }) => ({ right: Math.round(right), path, text }));

  const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="checkbox"], [role="switch"], [tabindex]:not([tabindex="-1"])';
  /*
   * A TAP TARGET IS SOMETHING A THUMB CAN ACTUALLY HIT, which is narrower than
   * "matches an interactive selector".
   *
   * The first run of this instrument reported the smallest target on Home as a
   * 1x1 `input.tch-attach__input` — the hidden file input behind an attach
   * button. It is invisible and un-tappable by construction; the BUTTON is the
   * target. Counting it made the headline number worse for a control that is
   * fine, and no lane could ever have closed it.
   *
   * So the three ways an element is present-but-not-tappable are excluded:
   * `visibility: hidden` and `opacity: 0` cannot be seen, and
   * `pointer-events: none` refuses the touch outright. Anything else that has a
   * box counts, including controls that are merely too small — which is the
   * point.
   */
  const tappable = (el) => {
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.pointerEvents !== 'none' && Number(s.opacity) !== 0;
  };
  const targets = [...document.querySelectorAll(INTERACTIVE)]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ el, r }) => rendered(r) && tappable(el));
  const small = targets
    .filter(({ r }) => Math.min(r.width, r.height) < MIN_TAP)
    .map(({ el, r }) => ({ w: Math.round(r.width), h: Math.round(r.height), path: pathOf(el), text: (el.textContent || '').trim().slice(0, 30) }));

  return {
    /** The reference every right edge below is compared against. */
    viewportWidth: vw,
    viewportHeight: document.documentElement.clientHeight,
    /* Reported so the disagreement is visible rather than theoretical: on an
       overflowing mobile-emulated page this grows to equal `scrollWidth`. */
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    /* THE HEADLINE. Everything above it is context. */
    overflowCount: over.length,
    worstRightEdge: Math.round(worstRight),
    /* Secondary, and it earns its place: the first run of this instrument found
       the phone header's title starting at a NEGATIVE x — clipped off the LEFT.
       A right-edge-only instrument would have photographed that and called it 0. */
    worstLeftEdge: Math.round(worstLeft),
    overflowRoots: roots,
    tapTargetsTotal: targets.length,
    tapTargetsUnderMin: small.length,
    tapTargetsSmallest: small.sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h)).slice(0, 12),
    /* What the page believes about itself, so a reader can tell a real 0 from a
       0 taken off a boot error or the wrong shell. */
    shell: document.querySelector('.mobile-frame') ? 'mobile' : document.querySelector('.shell-root') ? 'desktop' : 'none',
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    hash: location.hash,
    /* A refusal card is a legitimate screen; a BLANK one is a broken harness.
       Recording the first line lets a reader see which they are looking at. */
    firstText: (document.body.innerText || '').trim().split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 160),
  };
}

/* ── driver ──────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const onlyViewport = argOf('--viewport');
const onlyRoute = argOf('--route');
const outDir = argOf('--out') ?? 'mobile-audit';
const label = argOf('--label') ?? 'run';
const noShots = argv.includes('--no-screenshots');

/**
 * PORT 0 MEANS "PICK ONE". Lanes run in parallel worktrees on this machine and
 * the charter port 4612 is somebody else's dev server most days; a fixed port
 * makes the instrument fail for the second lane to run it. `--strictPort` is
 * deliberately NOT used with an ephemeral port — we let the OS choose and read
 * the choice back off vite's banner.
 */
async function startVite() {
  const existing = process.env.AUDIT_BASE;
  if (existing) return { base: existing, stop: () => {} };
  const proc = spawn('./node_modules/.bin/vite', ['--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const base = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('vite did not report a URL in 30s:\n' + buf)), 30_000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    proc.stderr.on('data', (d) => { buf += d; });
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`vite exited ${c}:\n${buf}`)); });
  });
  return { base, stop: () => proc.kill('SIGTERM') };
}

const ref = gitRef(outDir);
console.log(`ref: ${ref.headShort} on ${ref.branch}  (${ref.behindMain} behind origin/main)${ref.dirty ? '  ** DIRTY TREE **' : ''}\n`);

const { base, stop } = await startVite();
mkdirSync(outDir, { recursive: true });
if (!noShots) mkdirSync(`${outDir}/screens`, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const rows = [];
const problems = [];

for (const vp of VIEWPORTS) {
  if (onlyViewport && vp.name !== onlyViewport) continue;
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

  for (const route of ROUTES) {
    if (onlyRoute && route.name !== onlyRoute) continue;
    pageErrors.length = 0;
    const url = `${base}/mobile-audit.html#/s/${SPACE}/${route.path}`;

    /* A hash-only change does not reload, and the shell would keep whatever it
       last rendered while this script measured it as the new route. Loading
       about:blank between destinations forces a real boot every time — slower,
       and the only way each row is independent of the row before it. */
    await page.goto('about:blank');
    await page.goto(url, { waitUntil: 'networkidle' });
    /* Settle. `networkidle` says the fixture seam has answered; it says nothing
       about React having committed the screen and fonts having swapped in — and
       a font swap moves every text box, which is exactly what we measure. */
    await page.waitForTimeout(1200);
    try { await page.evaluate(() => document.fonts.ready); } catch { /* older engines */ }
    await page.waitForTimeout(300);

    const m = await page.evaluate(measureInPage, { MIN_TAP, EPS });

    /* THE REFUSAL. A row measured in the wrong shell looks exactly like a real
       row and is pure fiction — see trap 2. Record the failure instead. */
    const shellOk = m.shell === vp.expectShell;
    if (!shellOk) problems.push(`${vp.name}/${route.name}: expected ${vp.expectShell} shell, got '${m.shell}' (coarsePointer=${m.coarsePointer})`);
    if (pageErrors.length) problems.push(`${vp.name}/${route.name}: page error — ${pageErrors[0]}`);
    /* The reference must be the width we asked the device for. If the page's own
       layout box has drifted from it, every right-edge comparison in this row is
       against something other than the screen named in the label. */
    if (m.viewportWidth !== vp.width) {
      problems.push(`${vp.name}/${route.name}: layout viewport is ${m.viewportWidth}px, asked for ${vp.width}px — this row's edges are measured against the wrong screen`);
    }

    let shot = null;
    if (!noShots) {
      shot = `screens/${vp.name}__${route.name}.png`;
      await page.screenshot({ path: `${outDir}/${shot}`, fullPage: false });
    }

    rows.push({
      viewport: vp.name,
      route: route.name,
      url: `#/s/${SPACE}/${route.path}`,
      expectShell: vp.expectShell,
      shellOk,
      phoneRole: route.phone,
      note: route.note,
      screenshot: shot,
      pageErrors: pageErrors.slice(0, 3),
      ...m,
    });

    const flag = shellOk ? '' : '  ⚠ WRONG SHELL';
    console.log(
      `${vp.name.padEnd(13)} ${route.name.padEnd(10)} overflow=${String(m.overflowCount).padStart(4)}` +
      `  worstRight=${String(m.worstRightEdge).padStart(5)}  scrollW=${String(m.scrollWidth).padStart(5)}/${m.viewportWidth}` +
      `  taps<${MIN_TAP}=${String(m.tapTargetsUnderMin).padStart(3)}/${String(m.tapTargetsTotal).padStart(3)}  [${m.shell}]${flag}`,
    );
  }
  await ctx.close();
}

await browser.close();
stop();

/* A DIRTY TREE IS A PROBLEM, not a footnote: the sha in this file would name a
   tree that is not the one measured, and nobody could reproduce the run. */
if (ref.dirty) problems.push(`working tree is DIRTY at ${ref.headShort} — this run is not reproducible and its ref is a lie (${ref.dirtyFiles.length} changed path(s))`);
if (ref.behindMain > 50) problems.push(`HEAD is ${ref.behindMain} commits behind origin/main — measuring code main has moved past`);

const report = {
  label,
  /* Captured by this script, never passed in — see `gitRef`. No timestamp: it
     would change the file on every run and make `git diff` on the committed
     baseline useless for seeing whether the NUMBERS moved. */
  ref,
  minTapPx: MIN_TAP,
  epsilonPx: EPS,
  space: SPACE,
  problems,
  rows,
};
writeFileSync(`${outDir}/${label}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(`\nwrote ${outDir}/${label}.json  (${rows.length} rows)`);
if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S) — rows above marked WRONG SHELL are not evidence:`);
  for (const p of problems) console.log('  ! ' + p);
}
