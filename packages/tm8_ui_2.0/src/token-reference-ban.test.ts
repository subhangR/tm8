/**
 * EVERY BARE `var(--x)` MUST NAME A TOKEN SOMETHING DEFINES.
 *
 * WHY THIS GUARD DID NOT EXIST AND SHOULD HAVE. The package already bans raw
 * hex (`hex-ban`) and off-scale type (`type-scale-ban`) and pins the palette
 * byte-for-byte (`tokens-verbatim`) — three guards about what a stylesheet may
 * SAY. None of them checks whether what it says RESOLVES. So a stylesheet could
 * ask for a colour that does not exist and pass every gate in the package:
 *
 *   · CSS is specified to recover from errors. An unresolvable `var()` makes
 *     the declaration invalid at computed-value time, and the browser DROPS IT
 *     SILENTLY — the property falls back to `inherit` for an inherited property
 *     and `initial` otherwise. Nothing is logged. Nothing turns red.
 *   · `vite build` exits 0. A reference is syntactically perfect; only the
 *     lookup fails, and that happens in the browser, long after the build.
 *   · `vitest` runs with `css: false` in this package, so NO TEST HERE CAN SEE
 *     A STYLESHEET AT ALL. Every existing CSS guard is a grep over source text,
 *     which is exactly why they can catch a literal and not a dangling name.
 *
 * The measurement that produced this file (2026-08-31): 53 bare references to
 * 9 names that nothing defines. Forty-three of them were `--pn-ink-1`, which
 * has never existed — `--pn-ink` does — repeated across eight stylesheets
 * including `panels`, `graph`, `craft` and `help`. Every one of those
 * declarations was being thrown away at render time, so mention text, hover
 * states and a dozen other things quietly inherited whatever sat above them.
 * The rest were names borrowed from OTHER design systems: `--pn-danger`,
 * `--pn-border`, `--pn-text`, `--pn-bg`, `--pn-brass`, `--ease-standard`.
 *
 * TWO DISCRIMINATORS THIS GUARD IS BUILT AROUND, because getting either wrong
 * turns it into a nuisance that gets deleted:
 *
 *   1. **The comma is the difference between a bug and a default.**
 *      `var(--x, 12px)` is a deliberate fallback and is ALWAYS correct — the
 *      author said what happens when the token is absent. There are 178 of
 *      those here and not one is a defect. Only the no-fallback form is
 *      checked. A sweep that ignored this would have "fixed" 178 correct
 *      declarations.
 *   2. **A comment is not a declaration.** `auth.css` explains its own tinting
 *      convention in prose containing `var(--pn-x)` as a placeholder. The first
 *      version of this scan flagged it. Comments are stripped before scanning,
 *      which is the difference between a guard people trust and one they mute.
 *
 * WHAT COUNTS AS DEFINED: any custom property assigned in ANY stylesheet in
 * this package — not only `styles/tokens.css`. Component-scoped properties are
 * a legitimate pattern here (`--hp-rail`, `--set-gutter`), and so are
 * properties written from TypeScript at runtime via `style.setProperty` or an
 * inline style object, which is how the measured widths reach the layout. All
 * three sources are collected, because a guard that only knew the token sheet
 * would report correct code as broken and be switched off within a week.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));

function walk(dir: string, ext: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, ext));
    else if (ext.some((e) => name.endsWith(e))) out.push(path);
  }
  return out;
}

/** Comments carry prose, and prose names tokens illustratively. See §2 above. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const CSS_FILES = walk(SRC, ['.css']);
const TS_FILES = walk(SRC, ['.ts', '.tsx']);

/** Every custom property this package assigns, from any of its three homes. */
function definedProperties(): Set<string> {
  const defined = new Set<string>();
  for (const file of CSS_FILES) {
    const css = stripComments(readFileSync(file, 'utf8'));
    for (const m of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1] as string);
  }
  for (const file of TS_FILES) {
    const ts = readFileSync(file, 'utf8');
    // `el.style.setProperty('--hp-rail', …)` and `{ '--hp-list': … }`
    for (const m of ts.matchAll(/setProperty\(\s*['"](--[a-zA-Z0-9-]+)/g)) defined.add(m[1] as string);
    /* BOTH INLINE-STYLE KEY FORMS. A plain `'--x':` and the COMPUTED form
       `['--x' as string]:` that TypeScript forces when a custom property sits
       in a `CSSProperties` object — React's types do not admit `--x` as a
       key, so every author who sets one writes the second form. The first
       version of this guard matched only the plain form and reported
       `--b2tl-days` and `--b2tl-col` as dangling within an hour of shipping:
       they are set by `BoardTimeline.tsx`, correctly, in exactly that shape.
       A guard that calls correct code broken is worse than no guard — it
       teaches people to edit good code to silence it. */
    for (const m of ts.matchAll(/['"](--[a-zA-Z0-9-]+)['"]\s*(?:as\s+\w+\s*)?\]?\s*:/g)) {
      defined.add(m[1] as string);
    }
  }
  return defined;
}

describe('every token a stylesheet asks for is a token something defines', () => {
  it('has stylesheets to check, so a passing run is not an empty walk', () => {
    /* A guard whose corpus can silently become empty is not a guard. This
       package has ~100 stylesheets; the floor is deliberately far below that
       so a reorganisation does not trip it, and far above zero so a broken
       walk cannot report success. */
    expect(CSS_FILES.length).toBeGreaterThan(60);
    expect(TS_FILES.length).toBeGreaterThan(200);
  });

  it('resolves every bare var(--x)', () => {
    const defined = definedProperties();
    const dangling: string[] = [];
    for (const file of CSS_FILES) {
      const css = stripComments(readFileSync(file, 'utf8'));
      const lines = css.split('\n');
      lines.forEach((line, i) => {
        // NO-FALLBACK FORM ONLY — the `)` immediately after the name. See §1.
        for (const m of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)) {
          const name = m[1] as string;
          if (!defined.has(name)) {
            dangling.push(`${file.slice(SRC.length + 1)}:${i + 1}  var(${name})`);
          }
        }
      });
    }
    expect(
      dangling,
      'these declarations name a token nothing defines, so the browser drops them '
        + 'silently and the property falls back to inherit/initial. Either define the '
        + 'token in styles/tokens.css, correct the name, or give the reference an '
        + 'explicit fallback — `var(--x, <value>)` — which states what should happen '
        + 'when it is absent and is always allowed here.',
    ).toEqual([]);
  });

  it('leaves every var() that carries its own fallback alone', () => {
    /* THE GUARD MUST NOT GROW TEETH IT WAS NOT GIVEN. `var(--x, 12px)` is a
       deliberate default and there are ~180 of them in this package. This
       asserts they exist and are untouched, so a future tightening of the
       regex above cannot quietly start failing correct code. */
    let withFallback = 0;
    for (const file of CSS_FILES) {
      const css = stripComments(readFileSync(file, 'utf8'));
      withFallback += [...css.matchAll(/var\(\s*--[a-zA-Z0-9-]+\s*,/g)].length;
    }
    expect(withFallback).toBeGreaterThan(100);
  });
});
