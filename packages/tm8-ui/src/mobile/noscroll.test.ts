import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * NOTHING ON THE PHONE SCROLLS SIDEWAYS (t-noscroll) — the half of the proof
 * that can run in vitest.
 *
 * jsdom implements no layout: `scrollWidth` and `clientWidth` are 0 on every
 * element at every width, so a "scrollWidth <= clientWidth at 360/390/430"
 * assertion here would pass on any stylesheet, including one with no fix in
 * it. The measured half is `bun run audit:mobile`, which loads the real shell
 * in Chrome at 360/390/430 and exits non-zero when a phone screen scrolls
 * sideways. This file pins the rules that make that true, and ratchets the
 * rest of the package: a new `overflow-x: auto` anywhere must either be
 * neutralised on the phone or be recorded as desktop-only below.
 *
 * Comments are stripped first: the stylesheets EXPLAIN the scrollers they
 * remove, and a match on prose would pass a rule that is not there.
 */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const here = (p: string) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'));

const noscroll = here('./mobile-noscroll.css');
const frame = here('./mobile.css');

const P = ".cv2-root[data-shell='mobile']";

/** Every innermost `selector { body }` in a stylesheet, selectors split on
    top-level commas. At-rule headers never match: their bodies hold braces. */
function rules(css: string): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? '')
      .split(/,(?![^(]*\))/)
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    out.push({ selectors, body: m[2] ?? '' });
  }
  return out;
}

/** The declarations that apply to `selector` in `css`, from every rule that
    lists it — so a selector grouped with others is still found. */
function bodiesFor(css: string, selector: string): string[] {
  return rules(css)
    .filter((r) => r.selectors.includes(selector))
    .map((r) => r.body);
}

function declares(css: string, selector: string, decl: RegExp): boolean {
  return bodiesFor(css, selector).some((b) => decl.test(b));
}

describe('the shell cannot be panned sideways', () => {
  it('clips the frame rather than hiding it, keeping `hidden` as the fallback', () => {
    /* `hidden` is a scroll container: focusing a field past the right edge
       scrolls the whole frame left. `clip` has no scroll position. The order
       matters — the fallback first, so engines that know `clip` take it. */
    const body = bodiesFor(frame, '.mobile-frame').join('\n');
    expect(body).toMatch(/overflow:\s*hidden;\s*overflow:\s*clip;/);
  });

  it('lets no region widen the frame’s one column', () => {
    expect(declares(frame, '.mobile-frame > *', /min-width:\s*0/)).toBe(true);
  });

  it.each([
    '.mobile-frame__content',
    '.tch-transcript',
    '.mdrawer__scroll',
    '.msheet__body',
    '.pn-body',
    '.lp__body',
  ])('makes the vertical scroller %s scroll one way only', (cls) => {
    /* `overflow-y: auto` computes `overflow-x` to `auto` too, so each of these
       was a sideways scroller until it said otherwise. */
    expect(declares(noscroll, `${P} ${cls}`, /overflow-x:\s*hidden/)).toBe(true);
  });
});

describe('long content wraps', () => {
  it('breaks long words everywhere on the phone, lowering min-content', () => {
    /* `anywhere`, not `break-word`: only `anywhere` lowers the min-content
       width that flex and grid items refuse to shrink below. */
    expect(declares(noscroll, P, /overflow-wrap:\s*anywhere/)).toBe(true);
  });

  it.each(['pre', '.md-fence__pre', '.md-mermaid__source', '.pn-debug__pre', '.gov-pre', '.auth-evidence', '.tch-explain__source'])(
    'wraps the preformatted block %s instead of scrolling it',
    (sel) => {
      const body = bodiesFor(noscroll, `${P} ${sel}`).join('\n');
      expect(body).toMatch(/white-space:\s*pre-wrap/);
      expect(body).toMatch(/overflow-x:\s*visible/);
    },
  );

  it('wraps diff lines beside their numbers', () => {
    expect(declares(noscroll, `${P} .kit-diff__body`, /overflow-x:\s*hidden/)).toBe(true);
    expect(declares(noscroll, `${P} .kit-diff__row`, /min-width:\s*0/)).toBe(true);
    expect(declares(noscroll, `${P} .kit-diff__code`, /white-space:\s*pre-wrap/)).toBe(true);
  });

  it('fits markdown tables to the column', () => {
    expect(declares(noscroll, `${P} .md-tablewrap`, /overflow-x:\s*visible/)).toBe(true);
    expect(declares(noscroll, `${P} .md-table`, /table-layout:\s*fixed/)).toBe(true);
  });
});

describe('no scrollbars on the phone', () => {
  it('hides them on every element, not only the named three', () => {
    /* `scrollbar-width` does not inherit, so the universal selector is the only
       way the transcript, drawer and sheets AND every shared component's
       scroller are covered. */
    expect(declares(noscroll, `${P} *`, /scrollbar-width:\s*none/)).toBe(true);
    expect(declares(noscroll, `${P} *::-webkit-scrollbar`, /display:\s*none/)).toBe(true);
  });
});

/* ── THE RATCHET ───────────────────────────────────────────────────────────── */

/**
 * Every rule in the package that makes something a SIDEWAYS scroller
 * (`overflow-x: auto|scroll`) must be one of:
 *
 *   - neutralised on the phone by a `.cv2-root[data-shell='mobile']` rule for
 *     the same class that sets `overflow-x` to something a thumb cannot pan, or
 *   - recorded here as DESKTOP-ONLY, with the reason the phone never draws it.
 *
 * A new scroller that is neither fails, and the failure names it — so the
 * person adding it decides, instead of the phone finding out.
 */
const DESKTOP_ONLY: Record<string, string> = {
  '.b2__cols': 'board — a refusal card on the phone (mobile-audit ROUTES)',
  '.bd__cols': 'board — a refusal card on the phone',
  '.crf-hsw__tabs': 'craft — a refusal card on the phone',
  '.cpt__tabs': 'craft — a refusal card on the phone',
  '.project-browser__roots': 'project browser — desktop settings only',
  '.pr-body': 'prompts screen — no phone route',
  '.pr-text': 'prompts screen — no phone route',
  '.stg-scroll': 'story graph — no phone layout',
  '.syt-tabs': 'story tree — no phone layout (generic entity page on phone)',
  '.tws-browser .lp__tierscroll': 'tab workspace — no phone port (owner ruling)',
  '.tws-ts-scroll': 'tab workspace — no phone port (owner ruling)',
  '.tws-strip-scroll': 'tab workspace — no phone port (owner ruling)',
  '.stylew__xterm': 'theme widgets — desktop settings only',
};

/**
 * Phone scrollers another lane owns and is removing. Not held to the honesty
 * check below: once the owner's change lands the entry simply stops matching.
 */
const OWNED_ELSEWHERE: Record<string, string> = {
  [`${P} .tch-picks`]: 't-composer removes the composer foot scroller (coordinator, 2026-10-18)',
};

const SRC = fileURLToPath(new URL('..', import.meta.url));

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...cssFiles(p));
    else if (name.endsWith('.css')) out.push(p);
  }
  return out;
}

/** `.cv2-root .x .y` → `.x .y`: the part a phone override would also name. */
const subject = (sel: string) => sel.replace(/^\.cv2-root(\[[^\]]*\])?\s+/, '').trim();

describe('every sideways scroller in the package is handled on the phone', () => {
  const all = cssFiles(SRC).map((f) => ({ file: relative(SRC, f), css: strip(readFileSync(f, 'utf8')) }));

  /* Every phone-scoped rule that stops a sideways scroll, by subject. */
  const neutralised = new Set<string>();
  for (const { css } of all) {
    for (const r of rules(css)) {
      if (!/overflow(-x)?:\s*(visible|hidden|clip)\b/.test(r.body)) continue;
      for (const s of r.selectors) if (s.startsWith(P + ' ')) neutralised.add(subject(s));
    }
  }

  const offenders: string[] = [];
  for (const { file, css } of all) {
    for (const r of rules(css)) {
      if (!/overflow-x:\s*(auto|scroll)/.test(r.body)) continue;
      for (const s of r.selectors) {
        /* Phone-scoped scrollers are offenders outright; only desktop rules
           can be neutralised or exempted. */
        if (s in OWNED_ELSEWHERE) continue;
        if (s.startsWith(P)) {
          offenders.push(`${file}: ${s} — a phone rule that scrolls sideways`);
          continue;
        }
        if (/:hover|:focus|::-webkit/.test(s)) continue;
        const subj = subject(s);
        if (neutralised.has(subj) || subj in DESKTOP_ONLY) continue;
        offenders.push(`${file}: ${s}`);
      }
    }
  }

  it('has no unhandled `overflow-x: auto|scroll` rule', () => {
    expect(offenders, 'neutralise each on the phone in mobile-noscroll.css, or record it in DESKTOP_ONLY with a reason').toEqual([]);
  });

  it('keeps DESKTOP_ONLY honest — every entry still names a live scroller', () => {
    const live = new Set<string>();
    for (const { css } of all) {
      for (const r of rules(css)) {
        if (!/overflow-x:\s*(auto|scroll)/.test(r.body)) continue;
        for (const s of r.selectors) live.add(subject(s));
      }
    }
    expect(Object.keys(DESKTOP_ONLY).filter((k) => !live.has(k))).toEqual([]);
  });
});
