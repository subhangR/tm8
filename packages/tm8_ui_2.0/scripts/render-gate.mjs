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
  /* AN EMPTY DOCUMENT IS NOT A DOCUMENT. `01a053f9` above is "Untitled doc" and
     its body is zero bytes — it renders the reader's designed empty state and
     exercises none of the doc surface: no outline, no prose column, no table,
     no fence, no diagram. It is kept because the empty state is worth auditing,
     and this second route is the one that audits a DOCUMENT.

     `01a04ee0` is "Frontend verification — what changed on 2026-08-29", the doc
     in the owner's 2026-08-31 report. It is a representative worst case rather
     than a convenient one: 6,085 characters, 5 headings, 3 tables, 2 code
     fences and prose dense with inline identifiers. Measured on the deployed
     bundle the day it was added, its body carried 168px of horizontal scroll
     contributed by a hidden tooltip — the defect that produced the report — so
     this route has already earned its place once. */
  { name: 'entity/doc-full', hash: `#/s/${SPACE}/e/01a04ee0-aec6-73dd-a7a9-5fdea46aead2` },
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

  // 7. THE PRIMARY REGION MUST OCCUPY THE HEIGHT AVAILABLE TO IT.
  //
  //    "chat, sessions, docs, tasks all entity views should be full height etc
  //    all — Entities must be full height" (owner, 2026-08-31). A rule, so it
  //    is checked as one: this app is a fixed-height shell, and a band of empty
  //    `--pn-paper` under the working area is the defect, whatever produced it
  //    — a `height: 52vh` left over from an older layout, a flex child that
  //    never got `flex: 1`, a grid row that sized to its content.
  //
  //    ═══ THIS RULE WAS WRONG TWICE AND BOTH CORRECTIONS ARE THE RULE ═══
  //
  //    DRAFT 1 WAS INERT. It skipped any element whose rect height disagreed
  //    with its `offsetHeight`, reading rule 1's transform lesson as "never
  //    trust a rect". That skipped `.cv2-root` on every route — the shell paints
  //    inside a ~1.1 scale (its zoom control), 864 layout px against 950
  //    viewport px — so the rule audited nothing while reporting green. Caught
  //    only by injecting a deliberate `height: 40vh` and watching it still pass.
  //    A check that cannot fail is not a check.
  //
  //    DRAFT 2 MEASURED A DEEP NODE AGAINST THE VIEWPORT FLOOR, and reported a
  //    correct layout as broken. It walked into `.tch-transcript`, stopped
  //    (a scroller), and compared THAT box's bottom to the bottom of the window:
  //
  //      region-not-full-height: div.tch-transcript — 170px of unused height
  //
  //    The 170px is the COMPOSER. Measured on the deployed build: the
  //    transcript runs 135..780 and `.tch-composer-wrap` runs 780..928 right
  //    under it, inside a `.tch-conversation` that ends at 941. Nothing is
  //    unused — the transcript occupies exactly the height available to it,
  //    which is the height its siblings leave. A rule that ignores what sits
  //    BELOW the box it is measuring will call every composer, footer and
  //    action bar in the product a defect.
  //
  //    AND IT WAS NON-DETERMINISTIC, which is the more dangerous half: it fired
  //    on three route/theme pairs in one run and none in another, over the same
  //    build. The cause was the 60% dominance gate sitting exactly on this
  //    layout's boundary — Home's conversation pane is ~61% of the working area
  //    and the fraction moves with how many active cards and NEEDS YOU rows
  //    happen to have loaded — so whether the walk descended one level further
  //    was decided by CONTENT. A gate whose verdict depends on what the server
  //    returned that second is not a gate.
  //
  //    ═══ SO THE QUESTION IS ASKED OF EVERY NODE, NOT OF ONE ═══
  //
  //    "Occupy the height available to it" is a statement about a box AND ITS
  //    CONTAINER, so that is what is measured: at each node down the spine, the
  //    DEAD BAND between the lowest edge of its own in-flow children and its own
  //    bottom edge. The viewport enters exactly once, at the root, where the
  //    container genuinely is the window.
  //
  //    This fixes both faults at their root rather than tuning around them:
  //
  //      · a sibling below the region now COUNTS as occupying the space, so the
  //        transcript-plus-composer arrangement is read correctly;
  //      · and the verdict no longer depends on how far the walk gets, because
  //        every node on the way is checked. The dominance test now only decides
  //        how DEEP the report points, never WHETHER there is one — so content
  //        drift can no longer flip the answer.
  //
  //    THE WALK still steps into the biggest visible in-flow child BY AREA.
  //    Height alone picks the wrong sibling on this app every time: Home's 72px
  //    icon rail and its 1350px working area are both full height, and
  //    "tallest" resolves that tie by DOM order — which handed an earlier draft
  //    the rail, and had it auditing a column of nine icons as the primary
  //    content region. Area breaks the tie the way a reader does.
  //
  //    AND IT STOPS AT A SCROLLER. An `overflow-y: auto` box IS the region; its
  //    content is routinely taller than the viewport (a 1783px tree inside a
  //    580px list body was the first thing this walk ever found) and the
  //    distance from the last child to the box's bottom means nothing there.
  //
  //    CENTRED CONTENT IS NOT A DEFECT, and the discriminator is symmetry. An
  //    empty state centred in a tall pane leaves a band at the TOP as well as
  //    the bottom; a pane whose content stops halfway leaves one only at the
  //    bottom. So a bottom band is reported only when it is more than twice the
  //    top one — which is exactly the difference between "laid out centred" and
  //    "ran out".
  //
  //    THE THRESHOLD IS 120px. The largest legitimate gutter under a region on
  //    any of these screens is the page's own 7px bottom padding plus a hairline
  //    and sub-pixel rounding — call it 12. The smallest band a reader calls
  //    "the screen stops halfway" is one card row of this dashboard (96px) plus
  //    its 8px gap: 104. 120 sits an order of magnitude above every legitimate
  //    gutter and below the smallest real band. Deliberately NOT a percentage of
  //    the viewport: the defect is an absolute band of dead paint, and a
  //    percentage would let a bigger one pass on a short window.
  //
  //    MEASUREMENT SPACES, since this rule mixes them on purpose: ratios and
  //    "is this a real region" use `offsetHeight` (rule 1's law, and a ratio is
  //    scale-invariant anyway); positions and bands use
  //    `getBoundingClientRect()`, and are only ever compared with OTHER rects.
  //    A layout height is never compared to a viewport height — that comparison
  //    is what produced the 86px phantom gap in draft 1.
  const FULL_HEIGHT_SLACK = 120;
  const viewportBottom = document.documentElement.clientHeight;
  const inFlow = (el) =>
    seen(el) && !['absolute', 'fixed'].includes(getComputedStyle(el).position);
  const area = (el) => el.offsetWidth * el.offsetHeight;
  const scrolls = (el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY);

  /** The empty bands a node leaves above and below its own in-flow children. */
  const bandsOf = (el, kids) => {
    const box = el.getBoundingClientRect();
    let top = Infinity;
    let bottom = -Infinity;
    for (const kid of kids) {
      const r = kid.getBoundingClientRect();
      if (r.height <= 0) continue;
      top = Math.min(top, r.top);
      bottom = Math.max(bottom, r.bottom);
    }
    if (bottom === -Infinity) return null;
    return { top: top - box.top, bottom: box.bottom - bottom };
  };

  const spineStart = document.querySelector('.cv2-root');
  if (spineStart) {
    /* THE VIEWPORT ENTERS ONCE, HERE. The app root's container IS the window,
       so this is the one place the two spaces legitimately meet — and it is the
       check that catches a globally short shell, which no inner band would. */
    const rootGap = viewportBottom - spineStart.getBoundingClientRect().bottom;
    if (rootGap > FULL_HEIGHT_SLACK) {
      out.push({
        rule: 'region-not-full-height',
        el: name(spineStart),
        detail: `the app root stops ${Math.round(rootGap)}px above the bottom of a ${viewportBottom}px viewport`,
      });
    } else {
      let region = spineStart;
      for (let depth = 0; depth < 40; depth += 1) {
        if (scrolls(region)) break;
        const kids = [...region.children].filter(inFlow);
        if (kids.length === 0) break;
        const bands = bandsOf(region, kids);
        if (bands && bands.bottom > FULL_HEIGHT_SLACK && bands.bottom > bands.top * 2) {
          out.push({
            rule: 'region-not-full-height',
            el: name(region),
            detail: `${Math.round(bands.bottom)}px of unused height below its content (${kids.length} children, ${Math.round(bands.top)}px above)`,
          });
          break;
        }
        const biggest = kids.reduce((a, b) => (area(b) > area(a) ? b : a));
        const dominant = biggest.offsetHeight >= region.offsetHeight * 0.6;
        if (!dominant && kids.length !== 1) break;
        // Below this a box is chrome, not a region — a 30px toolbar that
        // happens to be an only child must not become "the content region".
        if (biggest.offsetHeight < 40) break;
        region = biggest;
      }
    }
  }

  // 8. AN INVISIBLE BOX MUST NOT CONTRIBUTE SCROLL.
  //
  //    Suggested by the probe that found it, and it earns its place because it
  //    is the one horizontal-overflow rule that CANNOT fire on correct code.
  //
  //    THE FINDING IT GENERALISES: the doc reader had 168px of horizontal
  //    scroll, and nothing visible was overflowing. The cause was a tooltip —
  //    `visibility: hidden; opacity: 0`, anchored `left: 0` — on a control that
  //    had drifted to the right edge of its row. Prose was not being clipped;
  //    it was being SCROLLED SIDEWAYS by a box nobody can see. That is
  //    unreadable as a symptom (the page just feels wrong) and undiagnosable by
  //    eye, which is exactly the shape of defect this gate exists for.
  //
  //    WHY NOT A GENERAL HORIZONTAL-OVERFLOW RULE. Because a great deal of
  //    legitimate content overflows its box on purpose: every `overflow-x: auto`
  //    table and diagram in the product is a scroller BY DESIGN (this package's
  //    own law is that wide content scrolls in its own container), and every
  //    `text-overflow: ellipsis` box has `scrollWidth > clientWidth` WHENEVER IT
  //    IS TRUNCATING — that inequality is the mechanism that draws the ellipsis.
  //    Measured while chasing a report: `.lp__meta` on the docs list overflows
  //    by 29px, has ZERO element children and `text-overflow: ellipsis`, and is
  //    working exactly as designed. A rule that flagged it would be reporting
  //    correct code, and would be muted inside a week.
  //
  //    An INVISIBLE contributor has no such defence. Nothing legitimate is
  //    served by a box you cannot see making a box you can see scroll: if it is
  //    hidden it should be out of flow, `display: none`, or clipped by an
  //    ancestor. So the rule is narrow on purpose, and its narrowness is what
  //    makes it trustworthy.
  //
  //    `display: none` needs no mention — it generates no box and contributes
  //    no scroll. The two that do are `visibility: hidden` and `opacity: 0`,
  //    which are precisely the two a tooltip or a popover uses to stay mounted
  //    (for `aria-describedby`, and for a transition) while not being shown.
  for (const el of all) {
    if (el.scrollWidth <= el.clientWidth + 2) continue;
    const cs = getComputedStyle(el);
    if (!['auto', 'scroll', 'hidden'].includes(cs.overflowX)) continue;
    const box = el.getBoundingClientRect();
    let worst = null;
    for (const node of el.querySelectorAll('*')) {
      const style = getComputedStyle(node);
      if (style.display === 'none') continue;
      const invisible = style.visibility === 'hidden' || Number(style.opacity) === 0;
      if (!invisible) continue;
      /* Out of flow AND not positioned relative to this box cannot be what is
         stretching it — but an absolutely positioned child of THIS element very
         much can, which is the reported case, so position is not a filter here.
         The test is simply: does it stick out past the right edge? */
      const r = node.getBoundingClientRect();
      const past = r.right - box.right;
      if (past > 2 && (worst === null || past > worst.past)) worst = { node, past };
    }
    if (worst) {
      out.push({
        rule: 'invisible-box-causes-scroll',
        el: name(el),
        detail: `scrolls ${el.scrollWidth - el.clientWidth}px because ${name(worst.node)} — which is not visible — sits ${Math.round(worst.past)}px past its right edge`,
      });
    }
  }

  return out;
}

/**
 * WAIT FOR THE PAGE TO COME TO REST, rather than for a number.
 *
 * THE GATE USED TO `waitForTimeout(11000)` AND AUDIT WHATEVER HAD ARRIVED, and
 * that is how a geometry gate becomes a coin flip. Measured on the deployed
 * build while chasing a transcript violation: the same route, the same build,
 * audited twice, gave `.tch-conversation` a 13px bottom band in one run and a
 * 279px one in another — because in one the twelve turns had landed and in the
 * other they had not. The same eleven seconds left `entity/task` with a fully
 * populated list once and an empty tree the next time.
 *
 * A rule cannot be made deterministic while the thing it measures is not. So
 * the wait is now a CONDITION: sample a geometry signature until it stops
 * changing for `SETTLE_QUIET_MS`, and if it never does inside `SETTLE_CAP_MS`,
 * report the route as unmeasured rather than auditing noise. "I could not
 * measure this" is a third outcome beside pass and fail, and it is the honest
 * one — the alternative is a violation list that changes when nothing did.
 *
 * THE SIGNATURE IS GEOMETRY, NOT MARKUP. A spinner swapping a class changes the
 * DOM without changing the layout; a transcript arriving changes both. What
 * this rule set asks about is boxes, so boxes are what has to hold still: the
 * count of laid-out elements and a digest of every box taller than a hairline.
 * Text length rides along because a re-flow that changes no box heights can
 * still change what a text rule reads.
 */
const SETTLE_QUIET_MS = 1200;
const SETTLE_CAP_MS = 25000;

async function settle(page) {
  const signature = () => {
    let digest = 0;
    let boxes = 0;
    for (const el of document.querySelectorAll('body *')) {
      const h = el.offsetHeight;
      if (h < 4) continue;
      boxes += 1;
      /* Rounded, so sub-pixel jitter from a font metric settling is not read as
         motion — the question is whether the LAYOUT moved, not whether a
         fractional pixel did. */
      digest = (digest * 31 + Math.round(h) + Math.round(el.offsetWidth) * 7 + Math.round(el.offsetTop) * 13) | 0;
    }
    return `${boxes}:${digest}:${(document.body.innerText || '').length}`;
  };
  const started = Date.now();
  let last = null;
  let steadySince = Date.now();
  while (Date.now() - started < SETTLE_CAP_MS) {
    const current = await page.evaluate(signature);
    if (current === last) {
      if (Date.now() - steadySince >= SETTLE_QUIET_MS) return true;
    } else {
      last = current;
      steadySince = Date.now();
    }
    await page.waitForTimeout(200);
  }
  return false;
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
    const settled = await settle(page);

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
    /* AND REFUSE TO AUDIT A PAGE THAT NEVER CAME TO REST, for the same reason
       it refuses to pass a dead one: the geometry of a half-hydrated screen is
       not this build's geometry, and reporting it either way is a claim about
       something that was never on screen. Loud, and its own outcome. */
    if (!settled) {
      console.error(`  ✗ ${route.name} [${theme}] — NEVER SETTLED in ${SETTLE_CAP_MS}ms; not audited`);
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
