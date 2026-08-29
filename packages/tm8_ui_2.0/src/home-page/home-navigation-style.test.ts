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
    expect(overview).toContain('overflow-y: auto');
    expect(overview).toContain('overscroll-behavior: contain');
    expect(homeCss).not.toMatch(/calc\(\s*100vh/i);
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
  it('caps every count box so it cannot reach into the name', () => {
    /* One shared rule covers the map row, both group heads and the rail row. */
    const cap = homeCss.match(
      /\.cv2-root \.hp-overview__kind > \.enav-metrics[\s\S]*?\{([^}]*)\}/s,
    )?.[1] ?? '';
    expect(cap).toContain('max-width: 33%');
    expect(cap).toContain('overflow: hidden');
    for (const selector of [
      '.cv2-root .hp-overview__family-head > .enav-metrics',
      '.cv2-root .hr-rail__grouphead > .enav-metrics',
      '.cv2-root .hr-rail__row > .hr-rail__metrics',
    ]) {
      expect(homeCss).toContain(selector);
    }
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
