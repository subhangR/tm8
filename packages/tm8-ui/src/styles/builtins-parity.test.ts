/**
 * BUILT-IN PARITY (style design §11) — the shipped Atelier JSON and the token
 * CSS may never be two palettes.
 *
 * `tokens.css` + `canvas-extra.css` remain the source of truth;
 * `packages/contract/src/builtins/*.json` are generated from them by
 * `scripts/extract-builtins.mjs`. Two assertions, two different failures:
 *
 *  1. EXTRACTION == COMMITTED JSON. Someone changed a token in the CSS and did
 *     not re-run the script (or hand-edited the JSON). Fix: run
 *     `node scripts/extract-builtins.mjs` and commit both in one stroke — the
 *     same "move both together" discipline `tokens-verbatim.test.ts` holds.
 *  2. resolveStyle(builtin).cssVars == EXTRACTED TABLE. The resolver must be the
 *     identity on a foundation with no layers. If it is not, it has an opinion
 *     of its own (a derived token computed differently from the hand-written
 *     one, a float printed differently) and every viewer would see it, because
 *     the injected sheet paints `cssVars` over `tokens.css`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_STYLES,
  BUILTIN_STYLE_IDS,
  resolveStyle,
  styleDocForBuiltin,
} from '@tm8/contract';

// The SAME function the script runs, not a copy of it.
import { extractBuiltins, serialise } from '../../scripts/extract-builtins.mjs';

type Extracted = Record<string, { id: string; tokens: Record<string, string> }>;
const extracted = extractBuiltins() as Extracted;

const committed = (name: string): string =>
  readFileSync(new URL(`../../../contract/src/builtins/${name}.json`, import.meta.url), 'utf8');

describe('built-in styles stay in sync with tokens.css', () => {
  it('extracts both built-ins, each with the whole token table', () => {
    expect(Object.keys(extracted).sort()).toEqual(['atelier-dark', 'atelier-light']);
    /* Guards the guard: a scan that matched nothing would make every equality
       below compare two empty tables and pass forever. */
    for (const builtin of Object.values(extracted)) {
      expect(Object.keys(builtin.tokens).length).toBeGreaterThan(100);
    }
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
    const resolved = resolveStyle(styleDocForBuiltin(builtin.id as `builtin:${string}`), BUILTIN_STYLES);
    expect(resolved.cssVars).toEqual(builtin.tokens);
    expect(resolved.warnings).toEqual([]);
  });

  it('paints every always-dark scope with the dark ramp, from either built-in', () => {
    /* The injected sheet's second rule replaces tokens.css's
       `.cv2-root[data-theme="dark"]` for the terminal, the workspace centre,
       Z4 and the files preview — so it must be exactly the dark table, or those
       regions move a pixel in light mode. */
    const dark = extracted['atelier-dark']!.tokens;
    for (const id of Object.values(BUILTIN_STYLE_IDS)) {
      const resolved = resolveStyle(styleDocForBuiltin(id), BUILTIN_STYLES);
      expect(resolved.alwaysDarkCssVars).toEqual(dark);
    }
  });
});
