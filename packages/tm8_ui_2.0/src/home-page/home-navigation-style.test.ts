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
  /* The workspace map's own contract retired with the map (2026-08-30). It
     pinned `.hp-overview`'s 38% ceiling, the families scroller, the head's
     `flex: none`, the map's forced-colours selected state, the Kinetic classes
     on its rows, the count budget and its container-query ladder. Those are
     claims about a surface Home no longer draws; the taxonomy lives in the
     rail now, and the rail's half of every one of those rules is kept below.
     Every deleted assertion is listed in the PR body. */

  it('keeps the surviving surfaces in forced colours', () => {
    expect(metricsCss).toMatch(/@media \(forced-colors: active\)[\s\S]*\.enav-metric--live/);
    expect(metricsCss).toContain('.enav-metric__unit');
  });

  it('introduces no literal colours outside the token sheet', () => {
    expect(homeCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(metricsCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('sizes Home from its parent, never from the viewport', () => {
    expect(homeCss).not.toMatch(/calc\(\s*100vh/i);
  });
});
});

/**
 * THE NAME BEATS THE COUNT (owner ruling, 2026-08-29).
 *
 * His expanded rail rendered a nav row as `: 577 · 471 new · 17 live` — the
 * word "Sessions" squeezed off its own row by its own counters. The rail sized
 * the count to its content and left the name as the only thing that could
 * absorb a deficit, so the name is what died.
 *
 * The map carried the same law and the same fix; the map is gone (2026-08-30)
 * and its half of these assertions went with it. What remains is the RAIL,
 * which is now the one home for the kind list — so these matter more than
 * before, not less: they are no longer one of two renderings pinned, they are
 * the only one.
 *
 * Each is a silent regression if it breaks: the layout still renders, it just
 * renders the wrong word missing, and jsdom cannot see it.
 */
describe('a name is never truncated by its own count', () => {
  it('never clips a count, because a sliced number is a wrong number', () => {
    /* `overflow: hidden` on a count is the trap this pins shut. An ellipsis
       tells the reader a WORD was cut; nothing tells them `577` was cut to
       `57`, and both render as a perfectly plausible number. */
    const cap = homeCss.match(
      /\.cv2-root \.hr-rail__row > \.hr-rail__metrics[\s\S]*?\{([^}]*)\}/s,
    )?.[1] ?? '';
    expect(cap).toContain('flex: none');
    expect(cap).toContain('white-space: nowrap');
    expect(cap).not.toContain('overflow: hidden');
    expect(cap).not.toMatch(/max-width/);
    for (const selector of [
      '.cv2-root .hr-rail__grouphead > .enav-metrics',
      '.cv2-root .hr-rail__row > .hr-rail__metrics',
    ]) {
      expect(homeCss).toContain(selector);
    }
  });

  it('lets every name take the remaining room and clip inside it', () => {
    const block = homeCss.match(/\.cv2-root \.hr-rail__label\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(block).toContain('flex: 1 1 auto');
    expect(block).toContain('min-width: 0');
    expect(block).toContain('text-overflow: ellipsis');
    /* `WORK2281`: the group eyebrow shrank to nothing and its letters kept
       painting across the gap into the count, because nothing clipped them. */
    const eyebrow = homeCss.match(/\.cv2-root \.hr-rail__eyebrow\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(eyebrow).toContain('overflow: hidden');
    expect(eyebrow).toContain('text-overflow: ellipsis');
  });

  /* `gives each row ONE number by never passing the unseen count to a row`
     is DELETED, not fixed, and the reversal is deliberate.

     It encoded an owner ruling from 2026-08-29 — "2078 new out of 2283 was
     never the fact anyone wanted" — by asserting neither source passes
     `unseen`. The 2026-08-30 target design puts `N new` on every row, and the
     ruling behind it is sharper than the one it replaces: `N new` is not a
     quantity, it is UNATTENDED WORK, and it changes what you do next. That is
     the test colour and prominence have to pass, and a count of unread rows
     passes it where a raw total does not.

     So the assertion is removed rather than inverted. Inverting it would claim
     the new behaviour was always required; deleting it with this note records
     that a ruling was superseded by a later one, which is the only form in
     which the next reader can tell the difference. The rail is unchanged and
     still passes no `unseen` — that is now HomeRail's business, not a rule
     this file pins for both surfaces. */

  it('gives a name every remaining pixel and lets the count keep its own', () => {
    /* The map's version of this law was measured last cycle and the card
       inherits it: mark fixed, noun takes the room and ellipses inside it,
       count intrinsic and never sliced. */
    const noun = homeCss.match(/\.cv2-root \.hp-group__noun\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(noun).toContain('flex: 1 1 auto');
    expect(noun).toContain('min-width: 0');
    expect(noun).toContain('text-overflow: ellipsis');
    const count = homeCss.match(
      /\.cv2-root \.hp-group__item > \.enav-metrics\s*\{([^}]*)\}/s,
    )?.[1] ?? '';
    expect(count).toContain('flex: none');
    expect(count).not.toContain('overflow: hidden');
    expect(count).not.toMatch(/max-width/);
  });

  it('gives the left column a scroll region rather than a silent clip', () => {
    /* `.hp-overview` was `max-height: 38%` + `overflow: hidden` and cut the
       WORK card mid-row with no scrollbar and no keyboard path. Four cards now
       stack where that one did, so the column must scroll. `min-height: 0` is
       what makes `overflow-y` reachable inside a grid item. */
    const side = homeCss.match(/\.cv2-root \.hp-side\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(side).toContain('overflow-y: auto');
    expect(side).toContain('min-height: 0');
    expect(homeCss).not.toMatch(/\.hp-side[^{]*\{[^}]*overflow: hidden/);
  });

  it('splits the canvas four/eight, which is the brief as screen area', () => {
    const home = homeCss.match(/\.cv2-root \.hp-home\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(home).toContain('grid-template-columns: 4fr 8fr');
    expect(home).toContain('min-height: 0');
  });
});
