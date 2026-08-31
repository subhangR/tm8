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
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const text = (el.innerText || '').trim();
    if (r.width > 24 && r.height > 0 && r.height < 8 && text.length > 12 && el.children.length > 0) {
      out.push({ rule: 'crushed', el: name(el), detail: `${Math.round(r.width)}x${Math.round(r.height)} holding ${text.length} chars` });
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

  // 4. THE PAGE MUST NOT SCROLL SIDEWAYS. Wide content scrolls in its own box.
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 2) {
    out.push({ rule: 'horizontal-page-scroll', el: 'document', detail: `${de.scrollWidth} > ${de.clientWidth}` });
  }

  // 5. A NAME CLIPPED BY ITS OWN COUNT — the house law, checked as geometry.
  //    An element whose text is ellipsised while a sibling number sits beside
  //    it at full width is exactly the ruling this package keeps by hand.
  for (const el of all) {
    if (el.children.length) continue;
    const cs = getComputedStyle(el);
    if (cs.textOverflow !== 'ellipsis') continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const sib = [...(el.parentElement?.children ?? [])].find(
      (s) => s !== el && /^[\d\s·,.]+$/.test((s.textContent || '').trim()) && (s.textContent || '').trim(),
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
