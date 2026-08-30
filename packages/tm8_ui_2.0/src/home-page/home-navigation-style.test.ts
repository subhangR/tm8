import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const homeCss = strip(readFileSync(new URL('./home-page.css', import.meta.url), 'utf8'));
const metricsCss = strip(
  readFileSync(new URL('../navigation/entity-navigation-metrics.css', import.meta.url), 'utf8'),
);
const pageTsx = strip(readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8'));
const railTsx = strip(readFileSync(new URL('../views/HomeRail.tsx', import.meta.url), 'utf8'));

describe('Home entity navigation surface contract', () => {
  it('keeps the workspace map bounded by its parent instead of viewport math', () => {
    const overview = homeCss.match(/\.cv2-root \.hp-overview\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(overview).toContain('max-height: 38%');
    expect(homeCss).not.toMatch(/calc\(\s*100vh/i);
    /* The CARD is not the scroller — the families region inside it is, so the
       surface's name and its "Open Workspace" escape hatch cannot scroll away
       from a reader looking down a full map. */
    expect(overview).toContain('overflow: hidden');
    const families = homeCss.match(/\.cv2-root \.hp-overview__families\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(families).toContain('overflow-y: auto');
    expect(families).toContain('overscroll-behavior: contain');
    expect(families).toContain('min-height: 0');
    const head = homeCss.match(/\.cv2-root \.hp-overview__head\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(head).toContain('flex: none');
  });

  it('uses the shared Kinetic interaction grammar', () => {
    expect(pageTsx).toContain('hp-overview k-enter');
    expect(pageTsx).toContain('hp-overview__kind k-press');
    expect(pageTsx).toContain('k-btn k-btn--secondary k-btn--sm');
  });

  it('preserves selected state and count meaning in forced colours', () => {
    expect(homeCss).toMatch(/@media \(forced-colors: active\)[\s\S]*\.hp-overview__kind\[aria-current='page'\]/);
    expect(metricsCss).toMatch(/@media \(forced-colors: active\)[\s\S]*\.enav-metric--live/);
    expect(metricsCss).toContain('.enav-metric__unit');
  });

  it('introduces no literal colours outside the token sheet', () => {
    expect(homeCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(metricsCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

/**
 * THE NAME BEATS THE COUNT (owner ruling, 2026-08-29).
 *
 * His expanded rail rendered a nav row as `: 577 · 471 new · 17 live` — the
 * word "Sessions" squeezed off its own row by its own counters — and the map's
 * cards cut nine of nineteen nouns to `Tas…`, `Do…`, `Pul…`, `Wor…`, `Co…`.
 * Both surfaces sized the count to its content and left the name as the only
 * thing that could absorb a deficit, so the name is always what died.
 *
 * These pin the three structural halves of the fix, because each one is a
 * silent regression: a layout still renders, it just renders the wrong word
 * missing, and jsdom cannot see it.
 */
describe('a name is never truncated by its own count', () => {
  it('never clips a count, because a sliced number is a wrong number', () => {
    /* One shared rule covers the map row, both group heads and the rail row. */
    const cap = homeCss.match(
      /\.cv2-root \.hp-overview__kind > \.enav-metrics[\s\S]*?\{([^}]*)\}/s,
    )?.[1] ?? '';
    expect(cap).toContain('flex: none');
    expect(cap).toContain('white-space: nowrap');
    /* `overflow: hidden` on a count is the trap this pins shut. An ellipsis
       tells the reader a WORD was cut; nothing tells them `577` was cut to
       `57`, and both render as a perfectly plausible number. */
    expect(cap).not.toContain('overflow: hidden');
    expect(cap).not.toMatch(/max-width/);
    for (const selector of [
      '.cv2-root .hp-overview__family-head > .enav-metrics',
      '.cv2-root .hr-rail__grouphead > .enav-metrics',
      '.cv2-root .hr-rail__row > .hr-rail__metrics',
    ]) {
      expect(homeCss).toContain(selector);
    }
  });

  it('states the width at which the count gives way, and drops it whole', () => {
    /* THE LESSON FROM `--tt-actions-reserve` (brief, 2026-08-29): a correct
       rule shipped without a width budget became the worst defect on screen —
       a 203px reserve inside a 211px row left 36px for the title. So the rule
       that reserves room for a count has to name the width where it stops
       being affordable, and the remedy at that width has to be the law's own:
       the badge goes, the noun stays. */
    expect(homeCss).toContain('container-name: hp-family');
    const family = homeCss.match(/\.cv2-root \.hp-overview__family\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(family).toContain('container-type: inline-size');
    const budget = homeCss.match(
      /@container hp-family \(max-width: \d+px\)\s*\{([^}]*\}[^}]*)\}/s,
    )?.[1] ?? '';
    expect(budget).toContain('.hp-overview__kind > .enav-metrics');
    expect(budget).toContain('display: none');
  });

  /* THE BUG THIS ENCODES, because prose could not hold it.
   *
   * `minmax()` sizes the card's BORDER box. `container-type: inline-size`
   * queries its CONTENT box. On this card they differ by 42px — measured with a
   * `@container (min-width: N)` ladder, which reported 175 against a 220px grid
   * track, not derived from padding (the card is `content-box`, so the naive
   * sum is wrong by 20px).
   *
   * Shipped once in the other order — a 200px floor with a 219px budget — it
   * meant auto-fit was free to build columns the budget then emptied, and
   * between ~901px and ~1250px the map showed nineteen nouns and NOT ONE COUNT.
   * A comment saying "keep these in step" would not have caught it; three
   * reviewers checking each other's arithmetic did not catch it. The inequality
   * is the fix, so the inequality is the test.
   */
  it('keeps the count budget below the narrowest column the grid can build', () => {
    const CONTAINER_DELTA_PX = 42;
    const floor = Number(
      homeCss.match(/repeat\(auto-fit,\s*minmax\((\d+)px,\s*1fr\)\)/)?.[1] ?? NaN,
    );
    const backstop = Number(
      homeCss.match(/@container hp-family \(max-width: (\d+)px\)/)?.[1] ?? NaN,
    );
    expect(Number.isFinite(floor), 'grid floor not found').toBe(true);
    expect(Number.isFinite(backstop), 'count backstop not found').toBe(true);
    /* The floor expressed in the units the query reads. If the backstop ever
       reaches this, the count disappears at a width the grid produces every
       day, and the map becomes a comparison surface with nothing to compare. */
    expect(backstop).toBeLessThan(floor - CONTAINER_DELTA_PX);
  });

  it('binds the wide-noun budget to registry data, not to a selector list', () => {
    /* The one card whose noun can genuinely collide with a count drops the
       count; the busy card whose nouns are short keeps it. Which is which is
       decided from `labelPlural` in `HomePage.tsx` so it cannot rot as labels
       change, and the stylesheet only reads the answer. */
    expect(homeCss).toMatch(
      /@container hp-family \(max-width: \d+px\)\s*\{\s*\.cv2-root \.hp-overview__family\[data-noun='wide'\]/,
    );
    expect(pageTsx).toContain("data-noun={hasWideNoun(group) ? 'wide' : undefined}");
    expect(pageTsx).toContain('item.config.labelPlural.length');
    /* No kind literal decides this (§15.2) — only the label's own length. */
    expect(pageTsx).not.toMatch(/data-noun=\{[^}]*===/);
  });

  it('spends no row height on badge chrome the digits did not need', () => {
    /* A 1px border + 3px padding + an 18px floor turned a 26px word into a
       47px row, and seven of those do not fit under the map's 38% ceiling —
       which is how the WORK card came to be cut mid-row by the panel's bottom
       edge. The pill is the height, so the pill goes. */
    const flat = homeCss.match(
      /\.cv2-root \.hp-overview__kind \.enav-metric--new,\s*\.cv2-root \.hp-overview__kind \.enav-metric--live\s*\{([^}]*)\}/s,
    )?.[1] ?? '';
    expect(flat).toContain('min-height: 0');
    expect(flat).toContain('border: 0');
    expect(flat).toContain('padding: 0');
    /* The word and the run colour stay: the metrics sheet's own contract is
       that an activity count never makes colour carry the meaning alone. */
    expect(metricsCss).toContain('.enav-metric__unit');
  });

  it('lets every name take the remaining room and clip inside it', () => {
    for (const name of ['.hp-overview__kind-name', '.hr-rail__label', '.hp-overview__family h3']) {
      const block = homeCss.match(
        new RegExp(`\\.cv2-root ${name.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 's'),
      )?.[1] ?? '';
      expect(block, name).toContain('flex: 1 1 auto');
      expect(block, name).toContain('min-width: 0');
      expect(block, name).toContain('text-overflow: ellipsis');
    }
    /* `WORK2281`: the group eyebrow shrank to nothing and its letters kept
       painting across the gap into the count, because nothing clipped them. */
    const eyebrow = homeCss.match(/\.cv2-root \.hr-rail__eyebrow\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(eyebrow).toContain('overflow: hidden');
    expect(eyebrow).toContain('text-overflow: ellipsis');
  });

  it('gives each row ONE number by never passing the unseen count to a row', () => {
    /* A total AND an "N new" pill is the pair that starved the nouns, and
       "2078 new" out of 2283 was not a fact anyone asked for. The exact unseen
       count still reads in each button's accessible name (`entityNavigationLabel`). */
    for (const source of [pageTsx, railTsx]) {
      expect(source).not.toMatch(/unseen=\{/);
    }
    expect(homeCss).not.toMatch(/\.hp-overview__kind \.enav-metric--total\s*\{\s*display: none/);
  });

  it('gives the map one noun per line', () => {
    const kinds = homeCss.match(/\.cv2-root \.hp-overview__kinds\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(kinds).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(kinds).not.toContain('repeat(2');
  });
});
