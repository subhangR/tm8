/**
 * BUILT-IN + REGISTRY PARITY (spec v8 §2, §10.3, §14) — the shipped Atelier
 * JSON, the variable registry and the token CSS may never disagree.
 *
 * `tokens.css` + `canvas-extra.css` remain the source of truth for the 110 CSS
 * keys; `scripts/extract-builtins.mjs` writes them, plus the `--pn-term-*`
 * terminal options, into `packages/contract/src/builtins/*.json`. Failures:
 *
 *  1. EXTRACTION != COMMITTED JSON — a token moved in the CSS and the script
 *     was not re-run (or the JSON was hand-edited). Run
 *     `node scripts/extract-builtins.mjs` and commit both together.
 *  2. REGISTRY != CSS — a variable was added or removed in the CSS without a
 *     registry entry (or the reverse). Edit `style-registry.json` in the same
 *     commit (§10.4).
 *  3. `surface` WRONG — the always-dark ramp replaces exactly the surface
 *     keys with the dark sibling's values; a wrong flag moves terminal-chrome
 *     pixels in light mode.
 *  4. resolveStyle(built-in) != the table — the resolver has an opinion of
 *     its own, which every viewer would see through the injected sheet.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_STYLES,
  BUILTIN_STYLE_IDS,
  STYLE_REGISTRY,
  resolveStyle,
  styleDocForBuiltin,
  type BuiltinStyleId,
} from '@tm8/contract';

// The SAME function the script runs, not a copy of it.
import { TERMINAL_DEFAULTS, extractBuiltins, serialise } from '../../scripts/extract-builtins.mjs';
import {
  TERMINAL_CURSOR_STYLE,
  TERMINAL_FONT_STACK,
  TERMINAL_FONT_WEIGHT,
  TERMINAL_LETTER_SPACING,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_SCROLLBACK,
} from '../terminal/terminalTheme';

type Extracted = Record<string, { id: BuiltinStyleId; tokens: Record<string, string> }>;
const extracted = extractBuiltins() as Extracted;
const light = extracted['atelier-light']!.tokens;
const dark = extracted['atelier-dark']!.tokens;
const termKeys = Object.keys(TERMINAL_DEFAULTS as Record<string, string>);
const cssKeys = Object.keys(light).filter((k) => !termKeys.includes(k));

const committed = (name: string): string =>
  readFileSync(new URL(`../../../contract/src/builtins/${name}.json`, import.meta.url), 'utf8');

describe('built-in styles stay in sync with tokens.css', () => {
  it('extracts both built-ins, each with the whole table', () => {
    expect(Object.keys(extracted).sort()).toEqual(['atelier-dark', 'atelier-light']);
    /* Guards the guard: a scan that matched nothing would make every equality
       below compare two empty tables and pass forever. */
    expect(cssKeys.length).toBeGreaterThan(100);
  });

  it.each(['atelier-light', 'atelier-dark'])('%s.json is byte-identical to a fresh extraction', (name) => {
    expect(committed(name)).toBe(serialise(extracted[name]));
  });

  it.each(['atelier-light', 'atelier-dark'])('the bundled %s is the extracted one', (name) => {
    const builtin = extracted[name]!;
    expect(BUILTIN_STYLES[builtin.id]?.tokens).toEqual(builtin.tokens);
  });

  it.each(['atelier-light', 'atelier-dark'])('resolveStyle is the identity on %s', (name) => {
    const builtin = extracted[name]!;
    const resolved = resolveStyle(styleDocForBuiltin(builtin.id));
    expect(resolved.cssVars).toEqual(builtin.tokens);
    expect(resolved.warnings).toEqual([]);
  });

  it('paints every always-dark scope with the dark table, from either built-in', () => {
    for (const id of Object.values(BUILTIN_STYLE_IDS)) {
      expect(resolveStyle(styleDocForBuiltin(id)).alwaysDarkCssVars).toEqual(dark);
    }
  });
});

describe('the variable registry matches the CSS', () => {
  const registryKeys = STYLE_REGISTRY.entries.map((e) => e.key);

  it('has exactly the CSS keys plus the terminal option keys, once each', () => {
    expect(new Set(registryKeys).size).toBe(registryKeys.length);
    expect([...registryKeys].sort()).toEqual([...cssKeys, ...termKeys].sort());
  });

  it('marks as surface exactly the keys that differ between light and dark', () => {
    const flips = cssKeys.filter((k) => light[k] !== dark[k]).sort();
    const surface = STYLE_REGISTRY.entries.filter((e) => e.surface).map((e) => e.key).sort();
    expect(surface).toEqual(flips);
  });

  it('puts the terminal option keys in the terminal-option group with an xterm sink (chrome excepted)', () => {
    for (const key of termKeys) {
      const e = STYLE_REGISTRY.entries.find((x) => x.key === key)!;
      expect(e.group).toBe('terminal-option');
      if (key !== '--pn-term-chrome') expect(e.xtermSink).toMatch(/^option\./);
    }
  });
});

describe('the terminal option defaults are today\'s terminal', () => {
  /* What the terminal renders with now (terminalTheme.ts) is what the
     built-ins must say, so wiring LiveTerminal to `resolved.xterm` moves no
     pixel. Two values are deliberate decisions, asserted as such. */
  const t = TERMINAL_DEFAULTS as Record<string, string>;

  it('matches the terminalTheme.ts constants', () => {
    expect(t['--pn-term-font']).toBe(TERMINAL_FONT_STACK);
    expect(Number(t['--pn-term-font-weight'])).toBe(TERMINAL_FONT_WEIGHT);
    expect(Number(t['--pn-term-line-height'])).toBe(TERMINAL_LINE_HEIGHT);
    expect(Number(t['--pn-term-letter-spacing'])).toBe(TERMINAL_LETTER_SPACING);
    expect(Number(t['--pn-term-scrollback'])).toBe(TERMINAL_SCROLLBACK);
    expect(t['--pn-term-cursor-style']).toBe(TERMINAL_CURSOR_STYLE);
    expect(t['--pn-term-padding']).toBe('0');
    expect(t['--pn-term-chrome']).toBe('dark');
  });

  it('bold is 600 (no 700 face is bundled) and size is auto (the device decides) — sign-off decisions', () => {
    expect(t['--pn-term-font-weight-bold']).toBe('600');
    expect(t['--pn-term-font-size']).toBe('auto');
  });
});
