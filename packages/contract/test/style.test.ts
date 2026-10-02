/**
 * `resolveStyle` — the unit suite §12 asks for: fall-through, layer order,
 * one-hop alias, clamping with warnings, unknown token/type tolerance, derived
 * tokens, contrast warnings that never throw, migration, built-in fixed point.
 *
 * MOST OF IT RUNS AGAINST A TWO-TOKEN FIXTURE, not against Atelier. A test that
 * asserts "paper is #F4F2EC after this layer" is a test about the palette; the
 * resolver's job is the CASCADE, and a fixture small enough to read in one
 * screen is the only way a cascade assertion says what it means. The real
 * built-ins get exactly one test here — the fixed point — because that is the
 * one claim about them this package can make without the CSS in front of it.
 * (`packages/tm8-ui/src/styles/builtins-parity.test.ts` makes the other one.)
 */
import { describe, expect, it } from 'vitest';

import {
  ATELIER_DARK,
  ATELIER_LIGHT,
  BUILTIN_STYLES,
  STYLE_SCHEMA_VERSION,
  contrastRatio,
  migrateStyleDoc,
  resolveStyle,
  styleDocForBuiltin,
  styleSheetText,
  type BuiltinStyle,
  type StyleDoc,
  type StyleLayer,
} from '../src/index.js';

/**
 * A fixture foundation. It carries one token from each DERIVATION FAMILY so the
 * step-5 assertions have something to be about, and nothing else.
 */
const FIXTURE_LIGHT: BuiltinStyle = {
  id: 'builtin:fixture-light',
  title: 'Fixture Light',
  builtinRevision: 1,
  darkSibling: 'builtin:fixture-dark',
  tokens: {
    '--pn-paper': '#ffffff',
    '--pn-ink': '#000000',
    '--pn-ink-3': '#777777',
    '--pn-brand': '#B26A2B',
    '--pn-brand-rgb': '178, 106, 43',
    '--pn-fs-body': '14px',
    '--pn-fs-mono': '12.5px',
    '--pn-space-1': '4px',
    '--pn-space-4': '16px',
    '--pn-r-md': '10px',
    '--pn-r-pill': '999px',
    '--pn-dur-base': '180ms',
    '--pn-read-measure': '720px',
    '--pn-x-term-live-bg': '#131009',
    '--pn-x-term-fg': '#D9D2C4',
    '--pn-x-term-cursor': '#E0A45A',
  },
};

const FIXTURE_DARK: BuiltinStyle = {
  ...FIXTURE_LIGHT,
  id: 'builtin:fixture-dark',
  title: 'Fixture Dark',
  darkSibling: 'builtin:fixture-dark',
  tokens: { ...FIXTURE_LIGHT.tokens, '--pn-paper': '#111111', '--pn-ink': '#eeeeee' },
};

const FIXTURES: Record<string, BuiltinStyle> = {
  [FIXTURE_LIGHT.id]: FIXTURE_LIGHT,
  [FIXTURE_DARK.id]: FIXTURE_DARK,
};

const doc = (...layers: StyleLayer[]): StyleDoc => ({
  schemaVersion: STYLE_SCHEMA_VERSION,
  foundation: FIXTURE_LIGHT.id,
  layers,
});

const resolve = (d: StyleDoc) => resolveStyle(d, FIXTURES);

describe('resolveStyle — fall-through', () => {
  it('returns the foundation verbatim when there are no layers', () => {
    const r = resolve(doc());
    expect(r.cssVars).toEqual(FIXTURE_LIGHT.tokens);
    expect(r.warnings).toEqual([]);
  });

  it('leaves tokens a layer does not mention untouched', () => {
    const r = resolve(doc({ type: 'colour', tokens: { paper: '#eeeeee' } }));
    expect(r.cssVars['--pn-paper']).toBe('#eeeeee');
    expect(r.cssVars['--pn-ink']).toBe(FIXTURE_LIGHT.tokens['--pn-ink']);
    /* The OUTPUT IS A FULL TABLE, not a diff — the property every renderer
       depends on for "switching styles cannot leave a stale value behind". */
    expect(Object.keys(r.cssVars).sort()).toEqual(Object.keys(FIXTURE_LIGHT.tokens).sort());
  });
});

describe('resolveStyle — layer order', () => {
  it('lets a later layer win', () => {
    const r = resolve(
      doc(
        { type: 'colour', tokens: { paper: '#111111' } },
        { type: 'colour', tokens: { paper: '#222222' } },
      ),
    );
    expect(r.cssVars['--pn-paper']).toBe('#222222');
  });

  it('skips a disabled layer without dropping the ones after it', () => {
    const r = resolve(
      doc(
        { type: 'colour', enabled: false, tokens: { paper: '#111111' } },
        { type: 'colour', tokens: { ink: '#333333' } },
      ),
    );
    expect(r.cssVars['--pn-paper']).toBe('#ffffff');
    expect(r.cssVars['--pn-ink']).toBe('#333333');
  });
});

describe('resolveStyle — aliases', () => {
  it('resolves an @alias into the resolved table', () => {
    const r = resolve(doc({ type: 'terminal', tokens: { cursor: '@brand' } }));
    expect(r.cssVars['--pn-x-term-cursor']).toBe('#B26A2B');
    expect(r.warnings).toEqual([]);
  });

  it('sees the alias target AFTER earlier layers changed it', () => {
    const r = resolve(
      doc(
        { type: 'colour', tokens: { brand: '#010203' } },
        { type: 'terminal', tokens: { cursor: '@brand' } },
      ),
    );
    expect(r.cssVars['--pn-x-term-cursor']).toBe('#010203');
  });

  it('does NOT chain two hops, and says so instead of guessing', () => {
    const r = resolve(
      doc({ type: 'colour', tokens: { brand: '@ink' } }, { type: 'terminal', tokens: { cursor: '@brand' } }),
    );
    expect(r.cssVars['--pn-brand']).toBe('#000000');
    // `cursor` read `brand` BEFORE substitution, found `"@ink"`, and refused.
    expect(r.cssVars['--pn-x-term-cursor']).toBe(FIXTURE_LIGHT.tokens['--pn-x-term-cursor']);
    expect(r.warnings.map((w) => w.code)).toContain('unresolved-alias');
  });

  it('keeps the foundation value when an alias names nothing', () => {
    const r = resolve(doc({ type: 'colour', tokens: { paper: '@nope' } }));
    expect(r.cssVars['--pn-paper']).toBe('#ffffff');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.code).toBe('unresolved-alias');
  });
});

describe('resolveStyle — clamping', () => {
  it('clamps an out-of-range number and warns with both bounds', () => {
    const r = resolve(doc({ type: 'scale', tokens: { factor: 9 } }));
    const clamp = r.warnings.find((w) => w.code === 'clamped');
    expect(clamp).toBeDefined();
    expect(clamp!.at).toBe('scale.factor');
    expect(clamp!.layer).toBe(0);
    // 1.4 is the ceiling: 14 * 1.4 = 19.6 -> nearest half pixel is 19.5.
    expect(r.cssVars['--pn-fs-body']).toBe('19.5px');
  });

  it('does not warn for a value inside the range', () => {
    const r = resolve(doc({ type: 'scale', tokens: { factor: 1.2 } }));
    expect(r.warnings.filter((w) => w.code === 'clamped')).toEqual([]);
  });

  it('clamps an xterm option too', () => {
    const r = resolve(doc({ type: 'terminal', tokens: { scrollback: 10 } }));
    expect(r.xterm.options.scrollback).toBe(500);
    expect(r.warnings.map((w) => w.at)).toContain('terminal.scrollback');
  });
});

describe('resolveStyle — tolerance', () => {
  it('skips an unknown layer type and keeps resolving', () => {
    const r = resolve(doc({ type: 'wallpaper', tokens: { url: 'x' } }, { type: 'colour', tokens: { ink: '#0f0f0f' } }));
    expect(r.warnings.map((w) => w.code)).toContain('unknown-layer-type');
    expect(r.cssVars['--pn-ink']).toBe('#0f0f0f');
  });

  it('drops an unknown token key with a warning naming it', () => {
    const r = resolve(doc({ type: 'colour', tokens: { papper: '#123456', ink: '#654321' } }));
    const unknown = r.warnings.find((w) => w.code === 'unknown-token');
    expect(unknown!.at).toBe('colour.papper');
    expect(r.cssVars['--pn-ink']).toBe('#654321');
    expect(Object.values(r.cssVars)).not.toContain('#123456');
  });

  it('skips a layer whose value has the wrong TYPE rather than coercing it', () => {
    const r = resolve(doc({ type: 'scale', tokens: { factor: 'big' } }));
    expect(r.warnings.map((w) => w.code)).toContain('invalid-token');
    expect(r.cssVars['--pn-fs-body']).toBe('14px');
  });

  it('falls back to a registered built-in when the foundation is unknown', () => {
    const r = resolveStyle({ schemaVersion: 1, foundation: 'builtin:ghost', layers: [] }, FIXTURES);
    expect(r.warnings.map((w) => w.at)).toContain('foundation');
    expect(Object.keys(r.cssVars).length).toBeGreaterThan(0);
  });

  it('never throws on a document full of nonsense', () => {
    expect(() =>
      resolve(
        doc(
          { type: '', tokens: {} },
          { type: 'colour', tokens: { paper: 'not-a-colour-but-a-string' } },
          { type: 'spacing', tokens: { unit: -1, radiusFactor: 99, nope: 1 } },
        ),
      ),
    ).not.toThrow();
  });
});

describe('resolveStyle — derived tokens (§3 step 5)', () => {
  it('derives --pn-brand-rgb from --pn-brand', () => {
    const r = resolve(doc({ type: 'colour', tokens: { brand: '#102030' } }));
    expect(r.cssVars['--pn-brand-rgb']).toBe('16, 32, 48');
  });

  it('derives brand-rgb from a short hex too', () => {
    const r = resolve(doc({ type: 'colour', tokens: { brand: '#abc' } }));
    expect(r.cssVars['--pn-brand-rgb']).toBe('170, 187, 204');
  });

  it('scales every font size to the nearest half pixel and keeps the ratios', () => {
    const r = resolve(doc({ type: 'scale', tokens: { factor: 1.25 } }));
    expect(r.cssVars['--pn-fs-body']).toBe('17.5px'); // 14 * 1.25 = 17.5
    expect(r.cssVars['--pn-fs-mono']).toBe('15.5px'); // 12.5 * 1.25 = 15.625 -> 15.5
  });

  it('rebuilds the spacing ladder as N x unit', () => {
    const r = resolve(doc({ type: 'spacing', tokens: { unit: 6 } }));
    expect(r.cssVars['--pn-space-1']).toBe('6px');
    expect(r.cssVars['--pn-space-4']).toBe('24px');
  });

  it('scales radii but leaves the pill sentinel alone', () => {
    const r = resolve(doc({ type: 'spacing', tokens: { radiusFactor: 2 } }));
    expect(r.cssVars['--pn-r-md']).toBe('20px');
    expect(r.cssVars['--pn-r-pill']).toBe('999px');
  });

  it('collapses durations to 0 for reduced motion', () => {
    const r = resolve(doc({ type: 'motion', tokens: { durationFactor: 0 } }));
    expect(r.cssVars['--pn-dur-base']).toBe('0ms');
  });

  it('defaults xterm cursorAccent to the background', () => {
    const r = resolve(doc());
    expect(r.xterm.theme.cursorAccent).toBe(r.xterm.theme.background);
  });

  it('leaves xterm fontSize absent so the per-device setting still rules (§15.4)', () => {
    expect(resolve(doc()).xterm.options.fontSize).toBeUndefined();
    expect(resolve(doc({ type: 'terminal', tokens: { fontSize: 16 } })).xterm.options.fontSize).toBe(16);
  });
});

describe('resolveStyle — always-dark chrome (§3.3)', () => {
  it('emits the dark sibling ramp by default', () => {
    const r = resolve(doc());
    expect(r.terminalChrome).toBe('dark');
    expect(r.alwaysDarkCssVars!['--pn-paper']).toBe('#111111');
    expect(r.cssVars['--pn-paper']).toBe('#ffffff');
  });

  it('emits no chrome ramp at all when chrome follows the style', () => {
    const r = resolve(doc({ type: 'terminal', tokens: { chrome: 'follow' } }));
    expect(r.terminalChrome).toBe('follow');
    expect(r.alwaysDarkCssVars).toBeNull();
  });

  it('lets a non-colour layer reach the chrome, and keeps a colour layer out', () => {
    const r = resolve(
      doc({ type: 'scale', tokens: { factor: 1.2 } }, { type: 'colour', tokens: { paper: '#ff00ff' } }),
    );
    // 14 * 1.2 = 16.8 -> 17 at half-pixel rounding, in BOTH tables.
    expect(r.cssVars['--pn-fs-body']).toBe('17px');
    expect(r.alwaysDarkCssVars!['--pn-fs-body']).toBe('17px');
    // The chrome keeps the dark sibling's paper; that is what holds the pixels.
    expect(r.alwaysDarkCssVars!['--pn-paper']).toBe('#111111');
  });

  it('reads xterm colours off the chrome ramp, not the main one', () => {
    const r = resolve(doc({ type: 'colour', tokens: { paper: '#ffffff' } }));
    expect(r.xterm.theme.background).toBe('#131009');
  });
});

describe('resolveStyle — derived data-theme (§3.2)', () => {
  it('is light for a light paper and dark for a dark one', () => {
    expect(resolve(doc()).darkish).toBe(false);
    expect(resolveStyle(styleDocForBuiltin(FIXTURE_DARK.id), FIXTURES).darkish).toBe(true);
  });

  it('follows the resolved paper, not the foundation it came from', () => {
    const r = resolve(doc({ type: 'colour', tokens: { paper: '#101010' } }));
    expect(r.darkish).toBe(true);
  });
});

describe('resolveStyle — contrast lint (§3 step 6)', () => {
  it('warns and never refuses', () => {
    const r = resolve(doc({ type: 'colour', tokens: { ink: '#f8f8f8' } }));
    const low = r.warnings.filter((w) => w.code === 'low-contrast');
    expect(low.length).toBeGreaterThan(0);
    expect(r.cssVars['--pn-ink']).toBe('#f8f8f8');
  });

  it('says nothing about a colour it cannot evaluate rather than guessing', () => {
    const r = resolve(doc({ type: 'colour', tokens: { ink: 'color-mix(in srgb, red, blue)' } }));
    expect(r.warnings.filter((w) => w.code === 'low-contrast')).toEqual([]);
  });

  it('computes the WCAG ratio the way the spec does', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('var(--x)', '#ffffff')).toBeNull();
  });
});

describe('resolveStyle — hash', () => {
  it('is stable for the same resolved output', () => {
    expect(resolve(doc()).hash).toBe(resolve(doc()).hash);
  });

  it('is a sha256-shaped lowercase hex digest', () => {
    expect(resolve(doc()).hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any resolved value changes', () => {
    expect(resolve(doc({ type: 'colour', tokens: { paper: '#fefefe' } })).hash).not.toBe(resolve(doc()).hash);
  });

  it('ignores how the document reached the same output', () => {
    const once = resolve(doc({ type: 'colour', tokens: { paper: '#abcdef' } }));
    const twice = resolve(
      doc({ type: 'colour', tokens: { paper: '#000000' } }, { type: 'colour', tokens: { paper: '#abcdef' } }),
    );
    expect(twice.hash).toBe(once.hash);
  });
});

describe('styleSheetText (§3.1)', () => {
  const sheet = styleSheetText(resolve(doc()));

  it('claims, in light, every root tokens.css leaves light and no root it makes dark', () => {
    expect(sheet.startsWith('.cv2-root:not([data-theme="dark"]):not([data-theme="dark"] *) {')).toBe(true);
  });

  it('claims, in dark, exactly tokens.css\'s dark selector — an explicit light root falls through', () => {
    const darkSheet = styleSheetText(resolve({ ...doc(), foundation: FIXTURE_DARK.id }));
    expect(darkSheet.startsWith('.cv2-root[data-theme="dark"],\n[data-theme="dark"] .cv2-root {')).toBe(true);
    expect(darkSheet).not.toContain(':not(');
  });

  it('puts the always-dark rule AFTER the active rule, because source order decides', () => {
    const chrome = sheet.indexOf('[data-always-dark="true"] .cv2-root {');
    expect(chrome).toBeGreaterThan(sheet.indexOf('{'));
  });

  it('declares every resolved token', () => {
    for (const [k, v] of Object.entries(resolve(doc()).cssVars)) {
      expect(sheet).toContain(`${k}: ${v};`);
    }
  });

  it('emits one rule only when the chrome follows the style', () => {
    const follow = styleSheetText(resolve(doc({ type: 'terminal', tokens: { chrome: 'follow' } })));
    expect(follow).not.toContain('data-always-dark');
  });
});

describe('migrateStyleDoc (§2.4)', () => {
  it('is the identity on a current document', () => {
    const d = styleDocForBuiltin(FIXTURE_LIGHT.id);
    expect(migrateStyleDoc(d)).toBe(d);
  });

  it('round-trips through resolve unchanged', () => {
    const d = doc({ type: 'colour', tokens: { paper: '#bada55' } });
    expect(resolve(migrateStyleDoc(d)).hash).toBe(resolve(d).hash);
  });

  it('normalises a below-current version without inventing content', () => {
    const migrated = migrateStyleDoc({ ...doc(), schemaVersion: 0 });
    expect(migrated.schemaVersion).toBe(STYLE_SCHEMA_VERSION);
    expect(migrated.layers).toEqual([]);
  });
});

describe('the shipped built-ins are a FIXED POINT of the resolver', () => {
  /*
   * The claim: resolving a built-in with no layers returns the built-in's own
   * table, byte for byte. If it does not, the resolver has an opinion of its
   * own — a default, a rounding, a derivation that disagrees with the CSS — and
   * every surface in the package would render slightly off the token file with
   * nothing to point at. This is the cheapest possible test of step 5's
   * arithmetic, because the expected answer is already in the repository.
   */
  for (const builtin of [ATELIER_LIGHT, ATELIER_DARK]) {
    it(`${builtin.id} resolves to itself`, () => {
      const r = resolveStyle(styleDocForBuiltin(builtin.id), BUILTIN_STYLES);
      expect(r.cssVars).toEqual(builtin.tokens);
      expect(r.warnings).toEqual([]);
    });
  }

  it('derives --pn-brand-rgb to the value tokens.css wrote by hand', () => {
    // Not a tautology: the JSON carries tokens.css's hand-written triple, and
    // the resolver overwrites it from --pn-brand. Agreement is the assertion.
    expect(resolveStyle(styleDocForBuiltin(ATELIER_LIGHT.id), BUILTIN_STYLES).cssVars['--pn-brand-rgb']).toBe(
      '178, 106, 43',
    );
    expect(resolveStyle(styleDocForBuiltin(ATELIER_DARK.id), BUILTIN_STYLES).cssVars['--pn-brand-rgb']).toBe(
      '224, 164, 90',
    );
  });

  it('gives both built-ins the same always-dark chrome, which is what freezes the terminal', () => {
    const light = resolveStyle(styleDocForBuiltin(ATELIER_LIGHT.id), BUILTIN_STYLES);
    const dark = resolveStyle(styleDocForBuiltin(ATELIER_DARK.id), BUILTIN_STYLES);
    expect(light.alwaysDarkCssVars).toEqual(ATELIER_DARK.tokens);
    expect(dark.alwaysDarkCssVars).toEqual(ATELIER_DARK.tokens);
    expect(light.xterm.theme).toEqual(dark.xterm.theme);
  });

  it('reproduces the xterm theme terminalTheme.ts reads off the DOM today', () => {
    const { theme } = resolveStyle(styleDocForBuiltin(ATELIER_LIGHT.id), BUILTIN_STYLES).xterm;
    expect(theme.background).toBe(ATELIER_DARK.tokens['--pn-x-term-live-bg']);
    expect(theme.foreground).toBe(ATELIER_DARK.tokens['--pn-x-term-fg']);
    expect(theme.cursorAccent).toBe(ATELIER_DARK.tokens['--pn-x-term-cursor-accent']);
    expect(theme.black).toBe(ATELIER_DARK.tokens['--pn-x-term-ansi-0']);
    expect(theme.brightWhite).toBe(ATELIER_DARK.tokens['--pn-x-term-ansi-15']);
  });
});
