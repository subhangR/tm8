#!/usr/bin/env node
/**
 * THE RENDER GATE — the only check in this package that can see a stylesheet.
 *
 * WHY IT EXISTS. `vitest` runs here with `css: false`. No stylesheet is ever
 * applied, so no test in this package — all 4,990 of them — can observe a
 * rendered pixel. Every CSS guard we have (`hex-ban`, `type-scale-ban`,
 * `token-reference-ban`, `tokens-verbatim`) is a grep over source text. They
 * prove a rule is WRITTEN. They cannot prove it RENDERS.
 *
 * That gap has a measured cost. In one week it let all of these ship green:
 *
 *   · the create-card box rendered 2px tall — `overflow: hidden` zeroes an
 *     item's automatic minimum size (Flexbox §4.5) and the flex column crushed
 *     it. Cards present in the DOM, text intact, height 2.
 *   · the active grid's rows were DIVIDED across its own height instead of
 *     sized from content — eleven rows of 11.8182px holding cards 87–156px
 *     tall, every card painting through the ones below it.
 *   · the conversation landed in the hidden sidebar's 280px grid track and
 *     overflowed it at 308px, beside a thousand empty pixels — because
 *     `display: none` removes a grid ITEM but not its TRACK.
 *   · the chat pane resolved to 2px when the row above it grew.
 *   · a drag handle 9px × 901px for a panel that was `display: none`.
 *
 * Not one of those is expressible as a string in a source file, and every one
 * is obvious in a browser in under a second. So the gate asserts GEOMETRY and
 * COMPUTED STYLE against the real built bundle, and it fails on classes of
 * defect rather than on named elements — a check that only knows the selectors
 * we thought of is a check that goes stale the week after it is written.
 *
 * WHAT IT IS NOT. It is not a screenshot test. There are no golden images to
 * churn, because a diff over pixels reports every intentional change as a
 * failure and gets muted within a month. Every assertion here is a statement
 * about a rule the design system already holds.
 *
 * USAGE
 *   TM8_AGENT_TOKEN=… node scripts/render-gate.mjs [--origin https://tm8.sh] [--space <id>]
 * Firefox only: Chromium's V8 segfaults on this kernel. The launcher needs
 *   LD_LIBRARY_PATH="$HOME/.cache/ms-playwright/firefox-1509/firefox:$HOME/.local/ff-libs/root/usr/lib/x86_64-linux-gnu"
 *
 * EXIT CODES  0 clean · 1 violations found · 2 could not run (no token, dead page)
 */
import { firefox } from '/home/tm8/prod-workspace/tm8/node_modules/.bun/node_modules/playwright-core/index.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const ORIGIN = arg('origin', 'https://tm8.sh');
const SPACE = arg('space', '019fbd5a-3c5b-71ea-9b91-1d3baa50da25');
const TOKEN = process.env.TM8_AGENT_TOKEN;
if (!TOKEN) {
  console.error('render-gate: no TM8_AGENT_TOKEN — cannot sign in, so nothing can be measured.');
  process.exit(2);
}

/* The routes worth holding to the rules. Add one when a screen ships; the
   gate is only as wide as this list, and that is stated rather than implied. */
const ROUTES = [
  { name: 'home', hash: `#/s/${SPACE}/home` },
  { name: 'home/tasks', hash: `#/s/${SPACE}/home/k/tasks` },
  { name: 'board', hash: `#/s/${SPACE}/board` },
  { name: 'graph', hash: `#/s/${SPACE}/graph` },
  { name: 'settings', hash: `#/s/${SPACE}/settings` },
  /* THE ENTITY VIEWS, added 2026-08-31 with the full-height rule — the owner's
     "chat, sessions, docs, tasks all entity views should be full height etc
     all". A rule about a class of defect still only sees the routes it is
     pointed at, and the four screens the ruling names were none of them.

     THE IDS ARE REAL AND THEREFORE PERISHABLE. They came from
     `tm8 entity query --kind <k> --space <SPACE> --limit 2` against this same
     space; if one is archived the route reports DID NOT RENDER, which is a
     loud, correct failure rather than a silent skip — but it is a failure about
     the FIXTURE, not the screen. Re-fetch with that command before assuming a
     regression. A `--entity` flag would be the better shape if this list needs
     to move often. */
  { name: 'entity/task', hash: `#/s/${SPACE}/e/01a054d8-5e57-7ad4-9035-f30195868b78` },
  { name: 'entity/session', hash: `#/s/${SPACE}/e/01a04f57-0462-7b98-81bb-3704850aad11` },
  { name: 'entity/doc', hash: `#/s/${SPACE}/e/01a053f9-5ede-7478-b018-2e035256686f` },
  /* Chat is not an `/e/` screen: a conversation lives on Home, in its own
     berth, so the route that audits it is Home's chat address. */
  { name: 'home/chat', hash: `#/s/${SPACE}/home/chat` },
];

/**
 * THE RULES, evaluated in the page. Each returns violations; each is a class of
 * defect, not a named element.
 */
function auditInPage() {
  const out = [];
  const seen = (el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0;
  };
  const name = (el) =>
    `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}` +
    `${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;

  const all = [...document.querySelectorAll('body *')].filter(seen);

  // 1. THE CRUSH. A box that has real content and has been squeezed to nothing
  //    is the §4.5 failure and the divided-rows failure, both of which shipped.
  //
  //    MEASURED IN LAYOUT PIXELS, NOT COMPOSITED ONES, and the first version of
  //    this rule got that wrong. `getBoundingClientRect()` returns the box AFTER
  //    every ancestor transform, so anything inside a zoomed-out canvas reports
  //    a fraction of its real size. It flagged eleven graph node labels at
  //    "116x7" — their true layout box is 284x20, inside a canvas at
  //    scale 0.372. The screen did have a real defect (it opened so far out that
  //    10px type painted at 3.7px) but this rule was not the thing that found
  //    it, and a rule that fires on every correct element in every scaled
  //    subtree is a rule that gets muted. `offsetWidth`/`offsetHeight` are
  //    layout values and ignore transforms entirely.
  for (const el of all) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const text = (el.innerText || '').trim();
    if (w > 24 && h > 0 && h < 8 && text.length > 12 && el.children.length > 0) {
      out.push({ rule: 'crushed', el: name(el), detail: `${w}x${h} layout px holding ${text.length} chars` });
    }
  }

  // 2. PAINTING THROUGH. Siblings in the same container overlapping vertically
  //    by more than a hairline — how the divided grid rows presented.
  const groups = new Map();
  for (const el of all) {
    const p = el.parentElement;
    if (!p) continue;
    const cs = getComputedStyle(p);
    if (cs.display !== 'grid' && cs.display !== 'flex') continue;
    if (cs.position === 'absolute' || cs.position === 'fixed') continue;
    (groups.get(p) ?? groups.set(p, []).get(p)).push(el);
  }
  for (const [parent, kids] of groups) {
    if (getComputedStyle(parent).flexDirection === 'row') continue;
    const boxes = kids
      .map((k) => ({ k, r: k.getBoundingClientRect() }))
      .filter(({ k, r }) => r.height > 12 && getComputedStyle(k).position === 'static');
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i].r;
        const b = boxes[j].r;
        const vOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const hOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        if (vOverlap > 4 && hOverlap > 4 && Math.abs(a.top - b.top) > 4) {
          out.push({ rule: 'overlapping-siblings', el: `${name(boxes[i].k)} / ${name(boxes[j].k)}`, detail: `${Math.round(vOverlap)}px vertical overlap inside ${name(parent)}` });
        }
      }
    }
  }

  // 3. A CONTROL THAT CANNOT MOVE ANYTHING. A resizer or separator whose target
  //    is display:none — the 9x901px handle that painted over the cards.
  for (const el of all) {
    const controls = el.getAttribute('aria-controls');
    if (!controls) continue;
    const target = document.getElementById(controls);
    if (!target) {
      out.push({ rule: 'controls-nothing', el: name(el), detail: `aria-controls="${controls}" names no element` });
    } else if (!seen(target)) {
      out.push({ rule: 'controls-hidden', el: name(el), detail: `its target #${controls} is not rendered` });
    }
  }

  // 4. THE PAGE MUST NOT SCROLL, IN EITHER DIRECTION. Wide or tall content
  //    scrolls in its OWN box; this is an app shell, not a document. A page
  //    scrollbar means some region escaped its container, and it takes the
  //    shell's own chrome off the screen with it.
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 2) {
    out.push({ rule: 'horizontal-page-scroll', el: 'document', detail: `${de.scrollWidth} > ${de.clientWidth}` });
  }
  if (de.scrollHeight > de.clientHeight + 2) {
    out.push({ rule: 'vertical-page-scroll', el: 'document', detail: `${de.scrollHeight} > ${de.clientHeight}` });
  }

  // 5. A NAME CLIPPED BY ITS OWN COUNT — the house law, checked as geometry.
  //    An element whose text is ellipsised while a sibling number sits beside
  //    it at full width is exactly the ruling this package keeps by hand.
  for (const el of all) {
    if (el.children.length) continue;
    const cs = getComputedStyle(el);
    if (cs.textOverflow !== 'ellipsis') continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    /* A HIDDEN SIBLING IS NOT COMPETING FOR THE LINE. `textContent` reads
       through `display: none`, so the first version of this rule kept
       reporting the rail's "Pull requests" as clipped beside 135 AFTER the
       container query had already stopped drawing 135. The count has to be
       ON SCREEN to be the thing taking the room. */
    const sib = [...(el.parentElement?.children ?? [])].find(
      (s) =>
        s !== el
        && seen(s)
        && s.getBoundingClientRect().width > 0
        && /^[\d\s·,.]+$/.test((s.textContent || '').trim())
        && (s.textContent || '').trim(),
    );
    if (sib) out.push({ rule: 'name-clipped-by-count', el: name(el), detail: `"${(el.textContent || '').slice(0, 28)}…" clipped beside "${(sib.textContent || '').trim()}"` });
  }

  // 6. TOKENS MUST RESOLVE AT RUNTIME. The static guard proves a name is
  //    defined somewhere; this proves the cascade actually delivers a value on
  //    this page, which is the half a grep cannot reach.
  /* READ THE TOKENS OFF THE ELEMENT THAT CARRIES THEM. The first version of
     this rule probed `document.documentElement` and reported all ten tokens
     unresolved on every route — a hundred false violations, because this
     package scopes its palette to `.cv2-root`, not `:root`. A check aimed at
     the wrong element does not report "no answer", it reports "everything is
     broken", which is the loudest possible way to be useless. If the root is
     missing that is itself the finding, and a different one. */
  const scope = document.querySelector('.cv2-root');
  const REQUIRED = ['--pn-ink', '--pn-paper', '--pn-line', '--pn-brand', '--pn-run', '--pn-wait', '--pn-ui', '--pn-prose', '--pn-fs-body', '--pn-space-2'];
  if (!scope) {
    out.push({ rule: 'no-token-scope', el: 'document', detail: 'no .cv2-root on this page, so no token resolves anywhere in it' });
  } else {
    const cs = getComputedStyle(scope);
    for (const t of REQUIRED) {
      if (!cs.getPropertyValue(t).trim()) {
        out.push({ rule: 'token-unresolved', el: '.cv2-root', detail: `${t} resolves to nothing on this page` });
      }
    }
  }

  // 7. THE PRIMARY REGION MUST REACH THE FLOOR OF THE VIEWPORT.
  //
  //    "chat, sessions, docs, tasks all entity views should be full height etc
  //    all — Entities must be full height" (owner, 2026-08-31). That is a RULE,
  //    so it is checked as one rather than screen by screen: this app is a
  //    fixed-height shell, and on every route there is one region that is the
  //    working area. A band of empty `--pn-paper` between the bottom of that
  //    region and the bottom of the window is the defect, whatever produced it
  //    — a `height: 52vh` left over from an older layout, a flex child that
  //    never got `flex: 1`, a grid row that sized to its content.
  //
  //    HOW THE REGION IS FOUND, and this is the part that decides whether the
  //    rule is useful or noise. The gate's own history has the counter-example:
  //    a rule aimed at the wrong element does not report "no answer", it
  //    reports "everything is broken" (see the token probe below, which read
  //    `documentElement` and flagged ten tokens on every route). So the region
  //    is not a selector list — it is found by walking the SPINE:
  //
  //      from `.cv2-root`, step into the BIGGEST visible in-flow child by AREA,
  //      and keep stepping while that child is either (a) at least 60% of its
  //      parent's height — it still IS the region, not a part of it — or (b)
  //      its parent's only in-flow child, in which case it is the whole of what
  //      the parent holds and must fill it.
  //
  //    (b) is what catches the actual reported defect: a full-height host with
  //    one short panel inside it. Without it the walk stops at the host, whose
  //    own bottom is at the floor, and reports nothing. (a) is what stops the
  //    walk descending into a short list inside a tall panel — a list with
  //    three rows in a 700px scroller is correct, and a rule that fired on it
  //    would be muted within a week.
  //
  //    BY AREA AND NOT BY HEIGHT, because on this app height alone picks the
  //    wrong sibling every time: Home's 72px icon rail and its 1350px working
  //    area are BOTH full height, and "tallest" resolves that tie by DOM order,
  //    which handed the rule the rail. It then walked down the rail and audited
  //    a column of nine icons as "the primary content region". Area breaks the
  //    tie the way a reader does.
  //
  //    AND THE WALK STOPS AT A SCROLLER. An `overflow-y: auto` box IS the
  //    region; the content inside it is routinely taller than the viewport (a
  //    1783px tree inside a 580px list body was the first thing this walk found)
  //    and its bottom edge is meaningless as a layout claim. Descending past a
  //    scroller measures the scrollable content, not the screen.
  //
  //    THE TWO MEASUREMENTS ARE IN DIFFERENT SPACES ON PURPOSE, and getting
  //    that wrong made the first version of this rule silently inert.
  //
  //    Rule 1's lesson is "`getBoundingClientRect` is post-transform, so use
  //    `offsetHeight` for layout questions". The first draft of THIS rule read
  //    that as "never trust a rect" and skipped any element whose rect height
  //    disagreed with its `offsetHeight`. That skipped `.cv2-root` itself on
  //    every route — the shell paints inside a ~1.1 scale (its zoom control),
  //    so the root measures 864 layout px and 950 viewport px — and the rule
  //    audited nothing at all while reporting green. Measured with a deliberate
  //    `height: 40vh` injected into the shell: still green. A check that cannot
  //    fail is not a check.
  //
  //    The correct reading is that the two questions live in different spaces:
  //
  //      · IS THIS CHILD THE REGION? — a RATIO between two boxes in the same
  //        subtree. `offsetHeight`, per rule 1; and a ratio is scale-invariant
  //        anyway, so the two never disagree about this.
  //      · DOES IT REACH THE FLOOR? — a question about the VIEWPORT, which is
  //        composited space by definition. `getBoundingClientRect().bottom`
  //        against `clientHeight` is the only honest pair; comparing a layout
  //        height to a viewport height is what produced the 86px phantom gap.
  //
  //    The two are never compared with each other, which is what makes mixing
  //    them safe here and unsafe in rule 1.
  //
  //    THE THRESHOLD IS 120px, and the arithmetic is: the largest legitimate
  //    gutter under a region on any of these screens is the page's own bottom
  //    padding, 7px, plus a hairline and sub-pixel rounding — call it 12. The
  //    smallest band a reader calls "the screen stops halfway" is one card row
  //    of this dashboard, 96px, plus its 8px gap: 104. 120 sits above every
  //    legitimate gutter by an order of magnitude and below the smallest real
  //    band, so nothing in between can be argued about. It is deliberately NOT
  //    a percentage of the viewport: the defect is an absolute band of dead
  //    paint, and on a short window a percentage would let a bigger one pass.
  const FULL_HEIGHT_SLACK = 120;
  const viewportBottom = document.documentElement.clientHeight;
  const inFlow = (el) =>
    seen(el) && !['absolute', 'fixed'].includes(getComputedStyle(el).position);

  const area = (el) => el.offsetWidth * el.offsetHeight;
  const scrolls = (el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY);

  const spineStart = document.querySelector('.cv2-root');
  if (spineStart) {
    let region = spineStart;
    for (let depth = 0; depth < 40; depth += 1) {
      if (scrolls(region)) break;
      const kids = [...region.children].filter(inFlow);
      if (kids.length === 0) break;
      const biggest = kids.reduce((a, b) => (area(b) > area(a) ? b : a));
      const dominant = biggest.offsetHeight >= region.offsetHeight * 0.6;
      if (!dominant && kids.length !== 1) break;
      // Below this a box is chrome, not a region — a 30px toolbar that happens
      // to be an only child must not become "the primary content region".
      if (biggest.offsetHeight < 40) break;
      region = biggest;
    }
    const box = region.getBoundingClientRect();
    const gap = viewportBottom - box.bottom;
    if (gap > FULL_HEIGHT_SLACK) {
      out.push({
        rule: 'region-not-full-height',
        el: name(region),
        detail: `${Math.round(gap)}px of unused height below it (bottom at ${Math.round(box.bottom)} in a ${viewportBottom}px viewport)`,
      });
    }
  }

  return out;
}

const browser = await firefox.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/firefox-1509/firefox/firefox`,
  headless: true,
});
let failures = 0;
let checked = 0;

for (const theme of ['light', 'dark']) {
  for (const route of ROUTES) {
    const ctx = await browser.newContext({
      viewport: { width: 1512, height: 950 },
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
      colorScheme: theme,
    });
    await ctx.addInitScript((t) => {
      const sessionId = t.slice('tm8s_'.length).split('.')[0];
      localStorage.setItem(
        'tm8ui.auth.passes.v1',
        JSON.stringify({ [location.origin]: { token: t, sessionId, expiresAt: '2026-12-31T00:00:00.000+00:00', signedInAt: '2026-08-29T20:08:08.128+00:00', account: { handle: 'tarkesh', displayName: 'Tharak', accountId: '019fd18d-19de-7c65-9a23-657b9926b186', identityId: 'id_fa66226d-f157-4f51-b5ad-77ec0c359879', isOwner: false, isNodeAdmin: true } } }),
      );
    }, TOKEN);
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/${route.hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(11000);

    /* REFUSE TO PASS A DEAD PAGE. An error boundary and an empty document both
       audit perfectly cleanly, which would report a broken screen as green —
       the single most dangerous way for a gate like this to fail. */
    const dead = await page.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      if (/hit an error|Something went wrong|Unexpected Application Error/i.test(t)) return 'error boundary';
      if (document.querySelectorAll('*').length < 60) return 'empty document';
      return null;
    });
    if (dead) {
      console.error(`  ✗ ${route.name} [${theme}] — DID NOT RENDER: ${dead}`);
      failures += 1;
      await ctx.close();
      continue;
    }

    const violations = await page.evaluate(auditInPage);
    checked += 1;
    if (violations.length === 0) {
      console.log(`  ✓ ${route.name} [${theme}]`);
    } else {
      failures += violations.length;
      console.error(`  ✗ ${route.name} [${theme}] — ${violations.length} violation(s)`);
      for (const v of violations) console.error(`      ${v.rule}: ${v.el} — ${v.detail}`);
    }
    await ctx.close();
  }
}
await browser.close();

console.log(`\nrender-gate: ${checked} route/theme pairs rendered, ${failures} violation(s)`);
process.exit(failures > 0 ? 1 : 0);
