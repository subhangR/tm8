/**
 * Styles — the contract (spec v8 §14 "Contract"): resolve fixed point,
 * overlay, unknown key, invalid value, clamp, alias one hop, derived
 * brand-rgb, always-dark ramp, xterm mapping, hash stability, refs,
 * write-time normalisation, export, schema. The sanitizer corpus lives in
 * `style-css.test.ts`; registry <-> CSS parity lives in tm8-ui's
 * `styles/builtins-parity.test.ts`, which can read the CSS.
 */
import { describe, expect, it } from 'vitest';
import {
  ATELIER_DARK,
  ATELIER_LIGHT,
  BUILTIN_STYLES,
  BUILTIN_STYLE_IDS,
  STYLE_REGISTRY,
  STYLE_EXPORT_FOUNDATION_MARKER,
  StyleDocSchema,
  StyleRefSchema,
  exportStyle,
  importStyle,
  formatStyleRef,
  migrateStyleDoc,
  normalizeStyleDoc,
  parseStyleRef,
  resolveStyle,
  styleDocForBuiltin,
  styleSheetText,
  validateStyleVar,
  type StyleDoc,
  type StyleRegistryEntry,
} from '../src/index.js';

const doc = (vars: Record<string, string> = {}, css: string | null = null): StyleDoc => ({
  schemaVersion: 1,
  foundation: BUILTIN_STYLE_IDS.light,
  vars,
  css,
});
const dark = (vars: Record<string, string> = {}): StyleDoc => ({ ...doc(vars), foundation: BUILTIN_STYLE_IDS.dark });
const codes = (r: { warnings: { code: string; key: string | null }[] }) => r.warnings.map((w) => `${w.code}:${w.key}`);
const entry = (key: string) => STYLE_REGISTRY.entries.find((e) => e.key === key) as StyleRegistryEntry;
const colourKeys = new Set(STYLE_REGISTRY.entries.filter((e) => e.kind === 'colour').map((e) => e.key));

describe('resolveStyle — fixed point on the built-ins', () => {
  it.each([ATELIER_LIGHT, ATELIER_DARK])('$id resolves to its own table with no warnings', (b) => {
    const r = resolveStyle(styleDocForBuiltin(b.id));
    expect(r.cssVars).toEqual(b.tokens);
    expect(r.warnings).toEqual([]);
    expect(r.clamped).toEqual([]);
    expect(r.css).toBeNull();
    expect(r.builtinRevision).toBe(b.builtinRevision);
  });

  it('every built-in carries every registry key and nothing else', () => {
    const keys = STYLE_REGISTRY.entries.map((e) => e.key).sort();
    for (const b of Object.values(BUILTIN_STYLES)) expect(Object.keys(b.tokens).sort()).toEqual(keys);
  });

  it('uses BUILTIN_STYLES and STYLE_REGISTRY by default', () => {
    expect(resolveStyle(doc()).hash).toBe(resolveStyle(doc(), BUILTIN_STYLES, STYLE_REGISTRY).hash);
  });
});

describe('resolveStyle — overlay and per-key validation', () => {
  it('overlays a set key and leaves every other key at the foundation', () => {
    const r = resolveStyle(doc({ '--pn-paper': '#101010' }));
    expect(r.cssVars['--pn-paper']).toBe('#101010');
    const { ['--pn-paper']: _a, ...rest } = r.cssVars;
    const { ['--pn-paper']: _b, ...base } = ATELIER_LIGHT.tokens;
    expect(rest).toEqual(base);
  });

  it('drops an unknown key with an unknown-key warning', () => {
    const r = resolveStyle(doc({ '--pn-papper': '#000' }));
    expect(codes(r)).toEqual(['unknown-key:--pn-papper']);
    expect(r.cssVars).not.toHaveProperty('--pn-papper');
  });

  it('keeps the foundation value for an invalid value and warns', () => {
    const r = resolveStyle(doc({ '--pn-paper': 'not a colour', '--pn-fs-body': 'huge' }));
    expect(r.cssVars['--pn-paper']).toBe(ATELIER_LIGHT.tokens['--pn-paper']);
    expect(r.cssVars['--pn-fs-body']).toBe(ATELIER_LIGHT.tokens['--pn-fs-body']);
    expect(codes(r)).toEqual(['invalid-value:--pn-paper', 'invalid-value:--pn-fs-body']);
  });

  it('refuses url() and friends in any value, including through a colour function', () => {
    for (const v of ['url(x)', 'rgb(1 2 3) url(x)', 'image-set(a)', 'expression(alert(1))', '#fff;}', 'red\\3b']) {
      expect(validateStyleVar(entry('--pn-paper'), v, colourKeys).ok).toBe(false);
    }
  });

  it('clamps out-of-range values, warns, and reports them in clamped', () => {
    const r = resolveStyle(doc({ '--pn-fs-body': '200px', '--pn-term-scrollback': '10', '--pn-dur-base': '9s' }));
    expect(r.cssVars['--pn-fs-body']).toBe('64px');
    expect(r.cssVars['--pn-term-scrollback']).toBe('500');
    expect(r.cssVars['--pn-dur-base']).toBe('2000ms');
    expect(r.clamped).toEqual([
      { key: '--pn-fs-body', from: '200px', to: '64px' },
      { key: '--pn-term-scrollback', from: '10', to: '500' },
      { key: '--pn-dur-base', from: '9s', to: '2000ms' },
    ]);
    expect(r.warnings.filter((w) => w.code === 'clamped')).toHaveLength(3);
  });

  it('accepts each kind in its grammar', () => {
    const ok: [string, string][] = [
      ['--pn-paper', 'oklch(0.7 0.1 50)'],
      ['--pn-paper', 'color-mix(in srgb, var(--pn-ink) 20%, white)'],
      ['--pn-paper', 'rebeccapurple'],
      ['--pn-ui', "'Inter', system-ui, sans-serif"],
      ['--pn-sh-md', '0 2px 6px rgba(0, 0, 0, 0.2), inset 0 0 0 1px #000'],
      ['--pn-ease-out', 'cubic-bezier(0.1, 0.2, 0.3, 1)'],
      ['--pn-lh-body', '1.6'],
      ['--pn-track-label', '0.1em'],
      ['--pn-space-4', '1rem'],
      ['--pn-term-cursor-style', 'bar'],
      ['--pn-term-font-size', 'auto'],
      ['--pn-term-font-size', '15'],
    ];
    for (const [k, v] of ok) expect(validateStyleVar(entry(k), v, colourKeys)).toMatchObject({ ok: true });
  });

  it('refuses a value of the wrong kind', () => {
    const bad: [string, string][] = [
      ['--pn-term-cursor-style', 'beam'],
      ['--pn-ui', 'font(evil)'],
      ['--pn-track-label', '2px'],
      ['--pn-paper', 'var(--pn-fs-body)'],
      ['--pn-brand-rgb', '1, 2, 3'],
    ];
    for (const [k, v] of bad) expect(validateStyleVar(entry(k), v, colourKeys).ok).toBe(false);
  });
});

describe('resolveStyle — alias one hop', () => {
  it('keeps a valid alias as var() in the sheet and resolves it for xterm', () => {
    const r = resolveStyle(doc({ '--pn-x-term-fg': '#eeeeee', '--pn-x-term-cursor': 'var(--pn-x-term-fg)' }));
    expect(r.cssVars['--pn-x-term-cursor']).toBe('var(--pn-x-term-fg)');
    expect(r.xterm.theme.cursor).toBe('#eeeeee');
    expect(r.warnings).toEqual([]);
  });

  it('derives from an aliased brand and paper', () => {
    const r = resolveStyle(doc({ '--pn-brand': 'var(--pn-x-term-fg)', '--pn-paper': 'var(--pn-x-term-bg)' }));
    expect(r.cssVars['--pn-brand-rgb']).toBe('217, 210, 196');
    expect(r.darkish).toBe(true);
  });

  it('treats the foundation\'s own var() values the same way (dark --pn-x-hairline-soft)', () => {
    expect(ATELIER_DARK.tokens['--pn-x-hairline-soft']).toBe('var(--pn-hover)');
    expect(resolveStyle(dark()).cssVars['--pn-x-hairline-soft']).toBe('var(--pn-hover)');
  });

  it('does not chain two hops, regardless of key order', () => {
    for (const vars of [
      { '--pn-ink': 'var(--pn-brand)', '--pn-brand': 'var(--pn-run)' },
      { '--pn-brand': 'var(--pn-run)', '--pn-ink': 'var(--pn-brand)' },
    ]) {
      const r = resolveStyle(doc(vars));
      expect(r.cssVars['--pn-ink']).toBe(ATELIER_LIGHT.tokens['--pn-ink']);
      expect(r.cssVars['--pn-brand']).toBe('var(--pn-run)');
      expect(codes(r)).toContain('invalid-value:--pn-ink');
    }
  });
});

describe('resolveStyle — derived values', () => {
  it('derives --pn-brand-rgb from --pn-brand', () => {
    expect(resolveStyle(doc({ '--pn-brand': '#0a0b0c' })).cssVars['--pn-brand-rgb']).toBe('10, 11, 12');
    expect(resolveStyle(doc({ '--pn-brand': '#abc' })).cssVars['--pn-brand-rgb']).toBe('170, 187, 204');
  });

  it('derives darkish from the resolved paper, not the foundation', () => {
    expect(resolveStyle(doc()).darkish).toBe(false);
    expect(resolveStyle(dark()).darkish).toBe(true);
    expect(resolveStyle(doc({ '--pn-paper': '#111111' })).darkish).toBe(true);
    expect(resolveStyle(dark({ '--pn-paper': '#fafafa' })).darkish).toBe(false);
  });
});

describe('resolveStyle — always-dark ramp', () => {
  it('is the dark built-in exactly, from either built-in', () => {
    expect(resolveStyle(doc()).alwaysDarkCssVars).toEqual(ATELIER_DARK.tokens);
    expect(resolveStyle(dark()).alwaysDarkCssVars).toEqual(ATELIER_DARK.tokens);
  });

  it('takes the sibling for surface keys and the style for everything else', () => {
    const r = resolveStyle(doc({ '--pn-paper': '#ffeedd', '--pn-fs-body': '16px', '--pn-x-term-fg': '#ffffff' }));
    expect(r.alwaysDarkCssVars!['--pn-paper']).toBe(ATELIER_DARK.tokens['--pn-paper']);
    expect(r.alwaysDarkCssVars!['--pn-fs-body']).toBe('16px');
    expect(r.alwaysDarkCssVars!['--pn-x-term-fg']).toBe('#ffffff');
  });

  it('is null when --pn-term-chrome is follow', () => {
    expect(resolveStyle(doc({ '--pn-term-chrome': 'follow' })).alwaysDarkCssVars).toBeNull();
  });
});

describe('resolveStyle — xterm mapping', () => {
  it('maps the built-in to today\'s terminal: palette from --pn-x-term-*, options from --pn-term-*', () => {
    const { theme, options } = resolveStyle(doc()).xterm;
    const t = ATELIER_LIGHT.tokens;
    expect(theme.background).toBe(t['--pn-x-term-live-bg']);
    expect(theme.foreground).toBe(t['--pn-x-term-fg']);
    expect(theme.cursorAccent).toBe(t['--pn-x-term-cursor-accent']);
    expect(theme.black).toBe(t['--pn-x-term-ansi-0']);
    expect(theme.brightWhite).toBe(t['--pn-x-term-ansi-15']);
    expect(options).toEqual({
      fontFamily: t['--pn-term-font'],
      fontSize: 'auto',
      fontWeight: 400,
      fontWeightBold: 600,
      lineHeight: 1.2,
      letterSpacing: 0,
      scrollback: 5000,
      cursorStyle: 'block',
      padding: 0,
    });
  });

  it('a numeric font size overrides the device', () => {
    expect(resolveStyle(doc({ '--pn-term-font-size': '16' })).xterm.options.fontSize).toBe(16);
  });
});

describe('resolveStyle — css, lint, hash, robustness', () => {
  it('sanitizes css into the resolved output', () => {
    const r = resolveStyle(doc({}, '.pn-chip { color: red; position: fixed }'));
    expect(r.css).toBe('.cv2-root .pn-chip {\n  color: red;\n}\n');
    expect(codes(r)).toEqual(['css-dropped:css']);
  });

  it('warns on low contrast and never refuses', () => {
    const r = resolveStyle(doc({ '--pn-ink': '#f0f0f0' }));
    expect(r.cssVars['--pn-ink']).toBe('#f0f0f0');
    expect(r.warnings.some((w) => w.code === 'low-contrast' && w.key === '--pn-ink on --pn-paper')).toBe(true);
  });

  it('hash is sha256:, stable, and moves with any resolved change', () => {
    const a = resolveStyle(doc()).hash;
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resolveStyle(doc()).hash).toBe(a);
    expect(resolveStyle(doc({ '--pn-paper': '#ffffff' })).hash).not.toBe(a);
    expect(resolveStyle(doc({}, '.x { color: red }')).hash).not.toBe(a);
    const bumped = { ...BUILTIN_STYLES, [ATELIER_LIGHT.id]: { ...ATELIER_LIGHT, builtinRevision: 99 } };
    expect(resolveStyle(doc(), bumped).hash).not.toBe(a);
  });

  it('ignores how the document reached the same output', () => {
    expect(resolveStyle(doc({ '--pn-paper': ATELIER_LIGHT.tokens['--pn-paper'] })).hash).toBe(resolveStyle(doc()).hash);
  });

  it('falls back to a built-in for an unknown foundation and never throws on nonsense', () => {
    const r = resolveStyle({ ...doc(), foundation: 'builtin:nope' });
    expect(r.foundation).toBe(ATELIER_LIGHT.id);
    expect(codes(r)).toContain('invalid-value:foundation');
    const junk = { schemaVersion: 1, foundation: 7, vars: { '--pn-paper': 5, x: null }, css: 42 } as unknown as StyleDoc;
    expect(() => resolveStyle(junk)).not.toThrow();
    expect(codes(resolveStyle(junk))).toEqual([
      'invalid-value:foundation',
      'invalid-value:--pn-paper',
      'unknown-key:x',
      'css-dropped:css',
    ]);
  });
});

describe('normalizeStyleDoc — the stored form', () => {
  it('stores clamped values, drops unknown and invalid keys, sanitizes css', () => {
    const n = normalizeStyleDoc(
      doc({ '--pn-fs-body': '99px', '--pn-nope': '1', '--pn-paper': 'url(x)', '--pn-ink': '#000' }, '.a{color:red}@import "x";'),
    );
    expect(n.doc).toEqual({
      schemaVersion: 1,
      foundation: BUILTIN_STYLE_IDS.light,
      vars: { '--pn-fs-body': '64px', '--pn-ink': '#000' },
      css: '.cv2-root .a {\n  color: red;\n}\n',
    });
    expect(n.clamped).toEqual([{ key: '--pn-fs-body', from: '99px', to: '64px' }]);
    expect(codes(n)).toEqual([
      'clamped:--pn-fs-body',
      'unknown-key:--pn-nope',
      'invalid-value:--pn-paper',
      'css-dropped:css',
    ]);
  });

  it('keeps an alias as written (resolve resolves it)', () => {
    expect(normalizeStyleDoc(doc({ '--pn-ink': 'var(--pn-brand)' })).doc.vars).toEqual({ '--pn-ink': 'var(--pn-brand)' });
  });

  it('is idempotent', () => {
    const once = normalizeStyleDoc(doc({ '--pn-fs-body': '99px' }, '.a { color: red }')).doc;
    expect(normalizeStyleDoc(once).doc).toEqual(once);
    expect(normalizeStyleDoc(once).warnings).toEqual([]);
  });
});

describe('refs', () => {
  const uuid = '01a0fc78-3974-73cc-9425-c8741062c673';

  it('parses and formats every kind, round-trip', () => {
    expect(parseStyleRef('builtin:atelier-dark')).toEqual({ kind: 'builtin', id: 'atelier-dark' });
    expect(parseStyleRef(`personal:${uuid}`)).toEqual({ kind: 'personal', id: uuid });
    expect(parseStyleRef(`space:${uuid.toUpperCase()}`)).toEqual({ kind: 'space', id: uuid });
    for (const r of ['builtin:atelier-dark', `personal:${uuid}`, `space:${uuid}`]) {
      expect(formatStyleRef(parseStyleRef(r)!)).toBe(r);
    }
  });

  it('rejects anything else', () => {
    for (const r of ['', 'atelier-dark', 'builtin:', 'builtin:Atelier', 'personal:42', 'space:not-a-uuid', 'other:x']) {
      expect(parseStyleRef(r)).toBeNull();
      expect(StyleRefSchema.safeParse(r).success).toBe(false);
    }
  });
});

describe('StyleDocSchema (§8.1)', () => {
  it('accepts a minimal document and defaults css to null', () => {
    const parsed = StyleDocSchema.parse({ schemaVersion: 1, foundation: 'builtin:atelier-dark', vars: {} });
    expect(parsed.css).toBeNull();
  });

  it('keeps unknown but well-formed keys (resolve drops them, §10.4)', () => {
    expect(StyleDocSchema.safeParse(doc({ '--pn-from-the-future': 'x' })).success).toBe(true);
  });

  it.each([
    ['a newer schemaVersion', { ...doc(), schemaVersion: 2 }],
    ['an unknown built-in', { ...doc(), foundation: 'builtin:nope' }],
    ['a user style as foundation', { ...doc(), foundation: 'space:01a0fc78-3974-73cc-9425-c8741062c673' }],
    ['a non --pn key', doc({ color: 'red' })],
    ['layers (the Phase 1 shape)', { ...doc(), layers: [] }],
    ['css over 16 KiB', doc({}, 'a'.repeat(16 * 1024 + 1))],
    ['more than 200 vars', doc(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`--pn-k${i}`, '1'])))],
  ])('rejects %s', (_, value) => {
    expect(StyleDocSchema.safeParse(value).success).toBe(false);
  });
});

describe('exportStyle', () => {
  const d = doc({ '--pn-paper': '#fafafa', '--pn-fs-body': '99px' }, '.a { color: red }');

  it('json/set is the document as stored', () => {
    expect(JSON.parse(exportStyle(d, { format: 'json', only: 'set' }))).toEqual(d);
  });

  it('json/all is the full resolved table', () => {
    const out = JSON.parse(exportStyle(d, { format: 'json', only: 'all' }));
    expect(Object.keys(out.vars)).toHaveLength(STYLE_REGISTRY.entries.length);
    expect(out.vars['--pn-fs-body']).toBe('64px');
    expect(out.css).toBe('.cv2-root .a {\n  color: red;\n}\n');
  });

  it('css carries the foundation marker, the vars block and the css', () => {
    const out = exportStyle(d, { format: 'css', only: 'set' });
    expect(out.startsWith(`/* ${STYLE_EXPORT_FOUNDATION_MARKER} builtin:atelier-light */\n.cv2-root {\n`)).toBe(true);
    expect(out).toContain('  --pn-fs-body: 99px;\n  --pn-paper: #fafafa;\n}');
    expect(out.endsWith('.a { color: red }\n')).toBe(true);
  });
});

describe('importStyle', () => {
  const stored = normalizeStyleDoc({
    ...dark({ '--pn-paper': '#101010', '--pn-ui': "'Inter', sans-serif", '--pn-fs-body': '15px' }),
    css: '.pn-chip { color: red }\n@media (max-width: 600px) { .pn-chip { color: blue } }',
  }).doc;

  it.each(['css', 'json'] as const)('round-trips a stored document through exportStyle (%s)', (format) => {
    const back = importStyle(exportStyle(stored, { format, only: 'set' }));
    expect(back.doc).toEqual(stored);
    expect(back.warnings).toEqual([]);
  });

  it('imports an all-keys export to a document that resolves identically', () => {
    const back = importStyle(exportStyle(stored, { format: 'css', only: 'all' }));
    expect(resolveStyle(back.doc).hash).toBe(resolveStyle(stored).hash);
  });

  it('defaults css without the marker to Atelier Light', () => {
    const back = importStyle('.cv2-root { --pn-paper: #222222; }');
    expect(back.doc).toEqual({ schemaVersion: 1, foundation: 'builtin:atelier-light', vars: { '--pn-paper': '#222222' }, css: null });
  });

  it('normalizes what it imports: clamps, drops, sanitizes', () => {
    const back = importStyle('.cv2-root { --pn-fs-body: 300px; --pn-nope: 1; }\nbody { color: red }');
    expect(back.doc.vars).toEqual({ '--pn-fs-body': '64px' });
    expect(back.doc.css).toBeNull();
    expect(back.clamped).toEqual([{ key: '--pn-fs-body', from: '300px', to: '64px' }]);
    expect(codes(back)).toEqual(['clamped:--pn-fs-body', 'unknown-key:--pn-nope', 'css-dropped:css']);
  });

  it('never throws on garbage', () => {
    expect(codes(importStyle('{not json'))).toEqual(['invalid-value:import']);
    expect(importStyle('{"foundation":"builtin:nope","vars":{"--pn-ink":3}}').warnings.map((w) => w.key)).toEqual([
      '--pn-ink',
      'foundation',
    ]);
    expect(() => importStyle('')).not.toThrow();
  });
});

describe('styleSheetText', () => {
  it('claims light roots in light and dark roots in dark, always-dark rule second', () => {
    const light = styleSheetText(resolveStyle(doc()));
    expect(light.startsWith('.cv2-root:not([data-theme="dark"]):not([data-theme="dark"] *) {')).toBe(true);
    const darkSheet = styleSheetText(resolveStyle(dark()));
    expect(darkSheet.startsWith('.cv2-root[data-theme="dark"],\n[data-theme="dark"] .cv2-root {')).toBe(true);
    expect(darkSheet.indexOf('[data-always-dark="true"] .cv2-root {')).toBeGreaterThan(0);
  });

  it('declares every key, and emits one rule when chrome follows', () => {
    const r = resolveStyle(doc());
    for (const [k, v] of Object.entries(r.cssVars)) expect(styleSheetText(r)).toContain(`  ${k}: ${v};`);
    expect(styleSheetText(resolveStyle(doc({ '--pn-term-chrome': 'follow' })))).not.toContain('data-always-dark');
  });
});

describe('migrateStyleDoc', () => {
  it('is the identity at v1', () => {
    const d = doc({ '--pn-paper': '#fff' });
    expect(migrateStyleDoc(d)).toEqual(d);
  });
});
