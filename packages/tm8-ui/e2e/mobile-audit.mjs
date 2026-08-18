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
import { chromium, firefox } from '@playwright/test';
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
 * OPENED STATES — the screens you only reach by DOING something.
 *
 * ROUTES above are all screen ROOTS. A baseline made only of roots has a hole
 * exactly where two of the four target surfaces live: entity DETAIL and the
 * launch/run surface are reached by tapping, never by an address the shell can
 * land on. With no before-state for them, "never worse than before" is
 * unenforceable for those lanes — there is no before.
 *
 * Each state is a route plus an ordered click chain, and an `expect` selector
 * that PROVES the state was actually reached. If `expect` never appears the row
 * is recorded as a PROBLEM rather than measured: a state that silently failed
 * to open measures the screen underneath it, which is fiction of exactly the
 * kind trap 2 exists to refuse.
 *
 * `steps` entries are tried in order; a step whose selector is absent is a
 * failure of the state, not something to skip past quietly.
 *
 * ON THE TAB CLICKS: the fixture's sessions and channels lists open on a "To
 * Do" tier that holds NO rows — the rows live under "In Progress". Landing on
 * the empty tier and clicking nothing would have produced a perfectly clean,
 * perfectly meaningless row.
 */
/*
 * NOT A STATE, AND THAT IS THE FINDING: no `MobileSheet` proved reachable from
 * any of these surfaces in the fixture. `.msheet-host` stays EMPTY throughout —
 * the list filter opens `div.lp__filtermenu`, a desktop-style dropdown, and the
 * one genuine sheet (EntityView's aux column, `entity-view-aux-sheet`) is
 * reached only by opening a RELATED entity from inside a detail screen, for
 * which the task detail offers no affordance here. A state that can never be
 * reached was NOT left in this table: a permanent failure line in every run
 * trains readers to skim the problem list, which is how a real failure gets
 * missed. It is reported as a gap for Lane B instead.
 */
const STATES = [
  {
    name: 'tasks-detail',
    path: 'k/tasks',
    steps: [{ click: 'button.pn-tt__title' }],
    expect: '.mobile-header__back',
    note: 'Lane B — entity detail, pushed onto the phone screen stack',
  },
  {
    /* Session rows are `div.pn-st[data-testid=list-tile]` — a DIV, not the
       `button.pn-tt__title` a task row uses. `list-tile` is the one selector
       both kinds share. */
    name: 'sessions-run',
    path: 'k/sessions',
    steps: [{ click: 'button.lp__tab', text: 'In Progress' }, { click: '[data-testid="list-tile"]' }],
    expect: '.mobile-header__back',
    note: 'Lane C — the run / session surface',
  },
  {
    /* NAMED FOR WHAT IT ACTUALLY OPENS. `filter-trigger` does NOT open a
       MobileSheet on the phone — it opens `div.lp__filtermenu`, a dropdown, and
       `.msheet-host` stays empty. That is worth measuring precisely because a
       desktop-style dropdown on a phone is the kind of thing this program
       exists to find; calling the row `-sheet` would have hidden it. */
    name: 'tasks-filter-menu',
    path: 'k/tasks',
    steps: [{ click: '[data-testid="filter-trigger"]' }],
    expect: '[data-testid="filter-menu"]',
    note: 'the list filter surface — a dropdown menu on phone, NOT a mobile sheet',
  },
  {
    name: 'sessions-launch',
    path: 'k/sessions',
    steps: [{ click: '[data-testid="list-quick-start"]' }],
    expect: '.msheet__panel, [role="dialog"], .mobile-header__back',
    note: 'Lane C — the launch affordance',
  },
  {
    name: 'home-composer-focused',
    path: 'home',
    steps: [{ focus: '.tch-composer textarea, .tch-composer [contenteditable="true"], textarea' }],
    expect: null,
    note: 'Lane A — composer focused (keyboard-up proxy)',
  },
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

  /*
   * THE VISUALLY-HIDDEN PATTERN, which the three checks above CANNOT see.
   *
   * The docblock on `tappable` says the 1x1 `input.tch-attach__input` behind the
   * attach button is excluded. It was not. It survived every run and kept
   * reporting itself as the smallest target on Home, because it is not hidden by
   * `visibility`, `opacity` or `pointer-events` — it is hidden by the standard
   * screen-reader-only recipe:
   *
   *     position:absolute; width:1px; height:1px; overflow:hidden;
   *     clip-path: inset(50%);            (.tch-attach__input)
   *     clip: rect(0,0,0,0);              (.chs-visually-hidden)
   *
   * Such an element is deliberately reachable by assistive tech and deliberately
   * un-hittable by a thumb. Counting it makes the headline worse for a control
   * that is fine, and NO LANE CAN EVER CLOSE IT — the fix would be to break the
   * accessible name. That is the signature of a bad metric.
   */
  const visuallyHidden = (el, r) => {
    const s = getComputedStyle(el);
    const clipped = s.clipPath !== 'none' || (s.clip !== 'auto' && s.clip !== '');
    return clipped && s.position === 'absolute' && r.width <= 1 && r.height <= 1;
  };

  /*
   * INERT vs SMALL. A `disabled` control or one with `pointer-events:none` does
   * nothing when tapped at ANY size, so failing it for being under 44px answers
   * the wrong question. These are LEDGERED SEPARATELY rather than dropped: "a
   * big button that does nothing" is a real defect, just not this threshold's.
   */
  const inertOf = (el) => {
    const s = getComputedStyle(el);
    if (s.pointerEvents === 'none') return 'pointer-events:none';
    if (el.hasAttribute('disabled')) return 'disabled';
    if (el.getAttribute('aria-disabled') === 'true') return 'aria-disabled';
    return null;
  };

  const candidates = [...document.querySelectorAll(INTERACTIVE)]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => rendered(r));

  const hidden = candidates.filter(({ el, r }) => visuallyHidden(el, r));
  const hiddenSet = new Set(hidden.map(({ el }) => el));
  const inert = candidates.filter(({ el }) => !hiddenSet.has(el) && inertOf(el));
  const inertSet = new Set(inert.map(({ el }) => el));

  /* The headline population: rendered, not screen-reader-only, not inert. */
  const targets = candidates.filter(({ el }) => !hiddenSet.has(el) && !inertSet.has(el) && tappable(el));

  const describeTap = ({ el, r }) => ({
    w: Math.round(r.width), h: Math.round(r.height),
    path: pathOf(el), text: (el.textContent || '').trim().slice(0, 30),
  });

  const small = targets
    .filter(({ r }) => Math.min(r.width, r.height) < MIN_TAP)
    .map(describeTap);

  /*
   * REAL HIT-TESTING. ">=44px" is necessary, not sufficient: an overlay or a
   * full-width sibling can swallow the tap while the geometry looks perfect.
   * `elementFromPoint` at the target's own centre is the only thing that knows.
   * LEDGERED, NOT FAILED — an occluded target is a different defect from a small
   * one, and silently excluding it would hide a real bug rather than report it.
   */
  const occluded = [];
  for (const t of targets) {
    const cx = t.r.left + t.r.width / 2;
    const cy = t.r.top + t.r.height / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > document.documentElement.clientHeight) continue;
    const hit = document.elementFromPoint(cx, cy);
    if (hit && hit !== t.el && !t.el.contains(hit) && !hit.contains(t.el)) {
      occluded.push({ ...describeTap(t), blockedBy: pathOf(hit) });
    }
  }

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
    /* Ledgered, never counted against MIN_TAP — see the predicates above. Each
       is a separate question a reader may want to ask, and a zero here is as
       meaningful as a zero in the headline. */
    tapTargetsHiddenCount: hidden.length,
    tapTargetsHidden: hidden.map(describeTap).slice(0, 8),
    tapTargetsInertCount: inert.length,
    tapTargetsInert: inert.map((t) => ({ ...describeTap(t), reason: inertOf(t.el) })).slice(0, 8),
    tapTargetsOccludedCount: occluded.length,
    tapTargetsOccluded: occluded.slice(0, 8),
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
/**
 * A FREE PORT, CHOSEN HERE AND THEN PINNED — never `--port 0`.
 *
 * `--port 0` looked like the clean way to say "pick one". It is not: vite does
 * not honour it, silently falls back to its DEFAULT port, and then either dies
 * on a collision or — much worse — a `strictPort`-less run lands on a port
 * another lane's dev server already holds and the harness measures SOMEBODY
 * ELSE'S APP while reporting confidently. Lanes run in parallel worktrees on
 * this machine, so that is a live hazard, not a theoretical one.
 *
 * So the port is obtained by binding an ephemeral socket, reading what the OS
 * gave us, and releasing it. There is a race between the release and vite's
 * bind, and `--strictPort` is what makes that race SAFE: if anything took the
 * port in between, vite exits loudly instead of quietly serving from elsewhere.
 * A crash is a fine outcome; a silent wrong-app measurement is not.
 */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startVite() {
  const existing = process.env.AUDIT_BASE;
  if (existing) return { base: existing, stop: () => {} };
  const port = await freePort();
  const proc = spawn('./node_modules/.bin/vite', ['--port', String(port), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
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

/**
 * THE ENGINE — system Chrome by default, Firefox where Chrome does not exist.
 *
 * Trap 1 above says "do not run `playwright install` to make this go away",
 * and that still stands: a different browser build is a different set of
 * numbers. This does NOT relax that rule — it names the engine, records it in
 * the report, and leaves the default exactly where it was.
 *
 * It exists because on some hosts there IS no system Chrome and the bundled
 * chromium cannot run at all: nine missing system libs, and once those are
 * staged into a userspace prefix the process still SIGSEGVs immediately after
 * its DRM probe, with no root available to install the real packages. On such
 * a host the choice is not "Chrome or Firefox", it is "Firefox or no
 * measurement", and no measurement is how a program starts trusting jsdom
 * again.
 *
 * WHAT A READER MUST NOT DO WITH THIS: compare a Firefox row to a Chrome row.
 * Font metrics differ, so tap-target heights and right edges differ by a pixel
 * or two, and a before/after diff across engines would report that noise as
 * movement. `engine` is in the report so that comparison is refused by
 * inspection. Before and after must be taken on the SAME engine.
 *
 * Firefox reports `(pointer: coarse)` truthfully under `hasTouch: true`
 * (measured on this host, with and without the Gecko RDM prefs below), so
 * trap 2's shell assertion keeps its teeth — a wrong-shell row is still
 * refused rather than recorded.
 */
const ENGINE = process.env.AUDIT_BROWSER === 'firefox' ? 'firefox' : 'chrome';
const browser = ENGINE === 'firefox'
  ? await firefox.launch({
      firefoxUserPrefs: { 'ui.primaryPointerCapabilities': 0x01, 'ui.allPointerCapabilities': 0x01 },
    })
  : await chromium.launch({ channel: 'chrome' });
/**
 * SETTLE — wait for the screen to EXIST, never for a fixed number of ms.
 *
 * `screenFor` renders a `.mobile-empty` "Loading…" node until `data.ready`, so
 * a fixed wait is a coin flip: too short and you photograph that node and
 * measure a screen that never rendered — which cannot overflow and cannot have
 * a small button, so it scores PERFECT. That exact failure produced a full set
 * of clean-looking dead screens earlier in this program.
 *
 * So: wait for the pending node to be GONE and for the frame to hold real
 * content. `networkidle` says the seam answered; it says nothing about React
 * having committed. Fonts are awaited last because a font swap moves every text
 * box, which is precisely what gets measured.
 */
async function settle(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await page.evaluate(() => {
      const frame = document.querySelector('.mobile-frame') || document.querySelector('.shell-root');
      if (!frame) return { ready: false, why: 'no shell root yet' };
      const pending = [...frame.querySelectorAll('.mobile-empty')]
        .some((n) => /loading|hydrating/i.test(n.textContent || ''));
      if (pending) return { ready: false, why: 'mobile-empty still says Loading' };
      return { ready: true };
    });
    if (state.ready || Date.now() > deadline) {
      if (!state.ready) return state.why;
      break;
    }
    await page.waitForTimeout(250);
  }
  try { await page.evaluate(() => document.fonts.ready); } catch { /* older engines */ }
  await page.waitForTimeout(300);
  return null;
}

const rows = [];
const problems = [];

for (const vp of VIEWPORTS) {
  if (onlyViewport && vp.name !== onlyViewport) continue;
  /* `isMobile` is a Chromium-only option — Firefox throws on it outright. It
     drives the mobile viewport-meta emulation, NOT the pointer type, so
     dropping it on Firefox does not weaken trap 2: `hasTouch` is what makes
     `(pointer: coarse)` true, and the shell assertion below still refuses any
     row that landed in the wrong shell. */
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    ...(ENGINE === 'firefox' ? {} : { isMobile: vp.isMobile }),
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
    await settle(page);

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

  /* ── THE OPENED STATES ────────────────────────────────────────────────────
     Phones only. A pushed detail screen or a portalled sheet is a phone
     arrangement; driving the same chain on desktop would exercise the panel
     stack, which is a different lane's surface and a different set of numbers. */
  if (vp.expectShell === 'mobile') {
    for (const st of STATES) {
      if (onlyRoute && st.name !== onlyRoute) continue;
      pageErrors.length = 0;
      const url = `${base}/mobile-audit.html#/s/${SPACE}/${st.path}`;
      await page.goto('about:blank');
      await page.goto(url, { waitUntil: 'networkidle' });
      const stall = await settle(page);
      if (stall) problems.push(`${vp.name}/${st.name}: never settled — ${stall}`);

      let failed = null;
      for (const step of st.steps) {
        try {
          if (step.focus) {
            const el = page.locator(step.focus).first();
            await el.waitFor({ state: 'visible', timeout: 8000 });
            await el.focus();
          } else {
            /* `text` narrows a repeated selector to the one that matters — the
               fixture's row-bearing tier, not the empty one it opens on. */
            const loc = step.text
              ? page.locator(step.click).filter({ hasText: step.text }).first()
              : page.locator(step.click).first();
            await loc.waitFor({ state: 'visible', timeout: 8000 });
            await loc.click({ timeout: 8000 });
          }
          await page.waitForTimeout(600);
        } catch (e) {
          failed = `step ${JSON.stringify(step)} — ${String(e).split('\n')[0].slice(0, 120)}`;
          break;
        }
      }

      /* THE PROOF THE STATE OPENED. Without it this row measures the screen
         underneath, which looks exactly like a real row and is fiction. */
      let opened = failed === null;
      if (opened && st.expect) {
        opened = await page.locator(st.expect).first().isVisible().catch(() => false);
        if (!opened) failed = `expected ${st.expect} to be visible after the chain`;
      }
      if (failed) problems.push(`${vp.name}/${st.name}: state NOT reached — ${failed}`);

      await settle(page);
      const m = await page.evaluate(measureInPage, { MIN_TAP, EPS });
      const shellOk = m.shell === vp.expectShell;
      if (!shellOk) problems.push(`${vp.name}/${st.name}: expected ${vp.expectShell} shell, got '${m.shell}'`);
      if (pageErrors.length) problems.push(`${vp.name}/${st.name}: page error — ${pageErrors[0]}`);

      let shot = null;
      if (!noShots) {
        shot = `screens/${vp.name}__state-${st.name}.png`;
        await page.screenshot({ path: `${outDir}/${shot}`, fullPage: false });
      }

      rows.push({
        viewport: vp.name,
        route: `state:${st.name}`,
        url: `#/s/${SPACE}/${st.path}`,
        expectShell: vp.expectShell,
        shellOk,
        phoneRole: 'state',
        stateOpened: opened,
        stateFailure: failed,
        note: st.note,
        screenshot: shot,
        pageErrors: pageErrors.slice(0, 3),
        ...m,
      });

      console.log(
        `${vp.name.padEnd(13)} ${('state:' + st.name).padEnd(24)} overflow=${String(m.overflowCount).padStart(4)}` +
        `  worstRight=${String(m.worstRightEdge).padStart(5)}` +
        `  taps<${MIN_TAP}=${String(m.tapTargetsUnderMin).padStart(3)}/${String(m.tapTargetsTotal).padStart(3)}` +
        `  [${m.shell}]${opened ? '' : '  ⚠ STATE NOT REACHED'}`,
      );
    }
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
  /* Which rendering engine produced these numbers. Rows from different engines
     are NOT comparable — see the ENGINE docblock. */
  engine: ENGINE,
  /*
   * THE BASIS, so a later run can be RECONCILED rather than naively subtracted.
   *
   * The route set and the census rules WILL move between before and after — a
   * route that is a refusal card today becomes a real screen the moment one is
   * approved, and it arrives carrying elements, some of them under 44px. Diffed
   * blind, that improvement reads as a regression and the after-run cries wolf
   * at exactly the work that was ordered.
   *
   * So both are recorded. A route present in one run and absent in the other is
   * a SCOPE CHANGE. A census rule that differs makes the two counts
   * incomparable outright and the run must be retaken, not reconciled.
   */
  basis: {
    routes: ROUTES.map((r) => ({ name: r.name, path: r.path, phone: r.phone })),
    states: STATES.map((r) => ({ name: r.name, path: r.path, note: r.note })),
    viewports: VIEWPORTS.map((v) => v.name),
    census: {
      interactiveSelector: 'button, a[href], input, select, textarea, summary, [role=button|tab|link|menuitem|checkbox|switch], [tabindex]:not([tabindex="-1"])',
      excluded: [
        'not rendered (zero box / off-page)',
        'visibility:hidden, opacity:0, pointer-events:none',
        'visually-hidden (position:absolute + clip/clip-path + <=1px) — screen-reader-only inputs',
        'inert: disabled / aria-disabled / pointer-events:none (ledgered separately, never failed)',
      ],
      ledgeredNotFailed: ['tapTargetsHidden', 'tapTargetsInert', 'tapTargetsOccluded'],
      overflowMeasure: 'per-element getBoundingClientRect().right > innerWidth + EPS — scrollWidth is context, never proof',
    },
  },
  problems,
  rows,
};
writeFileSync(`${outDir}/${label}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(`\nwrote ${outDir}/${label}.json  (${rows.length} rows)`);
if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S) — rows above marked WRONG SHELL are not evidence:`);
  for (const p of problems) console.log('  ! ' + p);
}
