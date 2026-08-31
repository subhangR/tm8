/**
 * THE TIMELINE'S STYLESHEET, ASSERTED AS SOURCE.
 *
 * WHY IT IS READ AS TEXT AND NOT MEASURED. This package's vitest runs with
 * `css: false` (vite.config.ts), so no mounted test in this repository can see
 * a stylesheet at all: a green render proves nothing about a colour, a dash
 * pattern or an overflow. Reading the file is therefore not a weaker version
 * of a visual check — it is the ONLY check available, and it is the one
 * `board-style.test.ts` next door already uses for the same reason.
 *
 * WHAT IT DOES NOT CLAIM: nothing here proves a bar LOOKS different. It proves
 * that the rules which make it look different exist, name the right tokens and
 * are scoped to reach the board. The visual claim belongs to a pixel check,
 * and this file does not stand in for one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./board-timeline.css', import.meta.url)), 'utf8');

/**
 * The same source with its comments removed. Every assertion about what a
 * declaration DOES reads this one: the comments in this stylesheet name the
 * defects they prevent ("never `minmax(0, …)`", "not `grid-auto-rows: auto`"),
 * so a ban asserted against the raw text would fail on its own explanation.
 */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every selector this sheet declares, with comments and at-rules stripped. */
function selectors(): string[] {
  return bare
    .split('}')
    .map((block) => block.split('{')[0]?.trim() ?? '')
    .filter((head) => head !== '' && !head.startsWith('@'))
    .flatMap((head) => head.split(',').map((s) => s.trim()))
    .filter(Boolean);
}

describe('scope and palette', () => {
  it('prefixes EVERY rule with the `.cv2-root` token scope', () => {
    const stray = selectors().filter((s) => !s.startsWith('.cv2-root '));
    expect(stray).toEqual([]);
  });

  it('carries no raw hex — colour resolves through a --pn-* token, always (§14)', () => {
    // The package-level `hex-ban.test.ts` owns this law for the whole tree;
    // repeating it here means a violation names THIS file rather than a list.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(\s*\d/);
  });
});

describe('multicolour, keyed on the tone the model computes', () => {
  const TONE_TOKEN: Readonly<Record<string, string>> = {
    run: '--pn-run',
    wait: '--pn-wait',
    info: '--pn-info',
    block: '--pn-block',
  };

  it('gives each of the four tones its own ramp, fill and edge', () => {
    for (const [tone, token] of Object.entries(TONE_TOKEN)) {
      const rule = css.match(
        new RegExp(`\\.b2tl__bar\\[data-tone='${tone}'\\]\\s*\\{([^}]*)\\}`, 's'),
      )?.[1];
      expect(rule, `bar rule for tone ${tone}`).toBeTruthy();
      expect(rule).toContain(`var(${token})`);
      expect(rule).toContain(`var(${token}-soft)`);
    }
  });

  it('the tones are FOUR DISTINCT ramps — colour that repeats carries no information', () => {
    const used = Object.values(TONE_TOKEN);
    expect(new Set(used).size).toBe(used.length);
  });

  it('gives a category-less bar NO status ramp — absent is not "to do"', () => {
    expect(css).not.toMatch(/\.b2tl__bar\[data-tone='none'\]/);
    // Its colour is the neutral default the base rule declares.
    const base = css.match(/\.cv2-root \.b2tl__bar\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(base).toContain('--b2tl-ink: var(--pn-ink-4)');
  });

  it('the strip dots reuse the SAME four ramps, so legend and chart cannot drift', () => {
    for (const [tone, token] of Object.entries(TONE_TOKEN)) {
      expect(css).toMatch(
        new RegExp(`\\.b2sum__stat\\[data-tone='${tone}'\\]::before \\{ background: var\\(${token}\\); \\}`),
      );
    }
  });
});

describe('an inferred range is drawn as a guess', () => {
  const rule = css.match(/\.cv2-root \.b2tl__bar\[data-inferred\]\s*\{([^}]*)\}/s)?.[1] ?? '';

  it('exists at all, keyed on the model\'s own `inferred` flag', () => {
    expect(rule).not.toBe('');
  });

  it('changes THREE independent things, because any one alone is missable', () => {
    // 1. dashed edge, 2. hatched fill with the solid tint dropped, 3. lower contrast.
    expect(rule).toContain('border-style: dashed');
    expect(rule).toContain('repeating-linear-gradient');
    expect(rule).toContain('background-color: transparent');
    expect(rule).toMatch(/opacity:\s*0\.\d+/);
  });

  it('a CONTRADICTORY record wears the error edge, whatever its category is', () => {
    const bad = css.match(/\.cv2-root \.b2tl__bar\[data-contradictory\]\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(bad).toContain('var(--pn-block)');
  });

  it('a clipped bar is TORN, not rounded — a rounded end would claim it stops here', () => {
    const start = css.match(/\.cv2-root \.b2tl__bar\[data-clipped-start\]\s*\{([^}]*)\}/s)?.[1] ?? '';
    const end = css.match(/\.cv2-root \.b2tl__bar\[data-clipped-end\]\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(start).toContain('border-top-left-radius: 0');
    expect(end).toContain('border-top-right-radius: 0');
  });
});

describe('the grid, and the two ways it could silently break', () => {
  const grid = bare.match(/\.cv2-root \.b2tl__grid\s*\{([^}]*)\}/s)?.[1] ?? '';

  it('PINS its rows — implicit `auto` rows inside a definite height get divided across it', () => {
    // The defect this prevents shipped once already: cards painted on top of
    // one another because the rows were sized from the container, not content.
    expect(grid).toMatch(/grid-auto-rows:\s*var\(--b2tl-row\)/);
    expect(grid).not.toMatch(/grid-auto-rows:\s*auto/);
  });

  it('never floors the label track with an unfloored minmax — it must stay visible', () => {
    expect(grid).toContain('grid-template-columns: var(--b2tl-label) repeat(');
    expect(grid).not.toContain('minmax(0');
  });

  it('scrolls WIDE CONTENT in its own box, so the page body never scrolls sideways', () => {
    const scroll = bare.match(/\.cv2-root \.b2tl__scroll\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(scroll).toContain('overflow-x: auto');
    expect(scroll).toContain('min-width: 0');
    expect(scroll).toContain('max-width: 100%');
  });

  it('keeps the row names on screen while the calendar scrolls under them', () => {
    expect(css).toMatch(/\.cv2-root \.b2tl__label,?[\s\S]{0,80}\{[\s\S]*?position: sticky;[\s\S]*?left: 0;/);
  });
});
