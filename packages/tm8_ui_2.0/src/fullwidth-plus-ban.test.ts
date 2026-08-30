import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE FULLWIDTH-PLUS BAN. A character the shipped fonts cannot draw never
 * reaches the screen.
 *
 * A PACKAGE-LEVEL GUARD, OWNED BY NO LANE, named for the law rather than a
 * module — the same shape and the same reasoning as `hex-ban.test.ts` beside
 * it, and for the same reason: this is a package-wide law, so a violation must
 * turn the PACKAGE red rather than make some unlucky lane red for a file it
 * cannot fix.
 *
 * THE DEFECT. The self-hosted webfonts are latin/latin-ext subsets. U+FF0B
 * FULLWIDTH PLUS is in neither, so every control that used it drew a literal
 * FF/0B tofu box — visible beside "Tasks", on "New task", on the composer's
 * attach control, and in the owner's own screenshot of 2026-08-30. It was not
 * a styling opinion; the glyph was simply absent, in ~39 places across 22
 * files and 10 directories, and no single lane owned enough of them to fix it.
 *
 * WHY THE GUARD IS SOURCE-LEVEL AND CODE-ONLY. Two halves, both necessary:
 *
 *  - SOURCE, not rendered. `vite.config.ts` sets no `css` key, so vitest runs
 *    with `css: false` and no stylesheet is ever applied. A rendered assertion
 *    can only see the surfaces a test happens to mount, which is how this
 *    survived a suite of 1129 tests. Reading the files catches all of them.
 *
 *  - CODE, not comments. Most occurrences of this character in the tree are
 *    PROSE ABOUT IT — "pressing ＋ on Docs", "how ＋ became a dead button",
 *    and the note in `list-root-header.css` recording why the column floor was
 *    chosen. Those are correct and must survive: a comment that describes a
 *    defect is not the defect. Banning the codepoint outright would have
 *    forced whoever ran the sweep to mangle the explanations, so the scanner
 *    tracks lexical state and only reads what the compiler reads — string
 *    literals and JSX text.
 *
 * If this test fails, do not delete the character from a comment to make it
 * pass. It is telling you a CONTROL is about to ship an empty box.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FULLWIDTH_PLUS = '＋';

/** Every U+FF0B the compiler would emit — comments and their prose excluded. */
function renderedOccurrences(source: string): number {
  let hits = 0;
  let inLine = false;
  let inBlock = false;
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1] ?? '';
    if (inLine) {
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i += 1; }
      continue;
    }
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) { quote = null; continue; }
      if (c === FULLWIDTH_PLUS) hits += 1;
      continue;
    }
    if (c === '/' && next === '/') { inLine = true; i += 1; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 1; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === FULLWIDTH_PLUS) hits += 1;   // JSX text
  }
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe('U+FF0B FULLWIDTH PLUS never reaches a rendered control', () => {
  it('no source file emits a glyph the shipped font subsets cannot draw', () => {
    const offenders = walk(HERE)
      .map((file) => ({ file, hits: renderedOccurrences(readFileSync(file, 'utf8')) }))
      .filter((r) => r.hits > 0)
      .map((r) => `${relative(HERE, r.file)} (${r.hits})`);

    expect(
      offenders,
      `U+FF0B has no glyph in the latin-subset webfonts and renders as a tofu box.\n` +
        `Use ASCII "+". Comments describing the character are fine and are not scanned.\n` +
        `Offending files:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the scanner reads code and spares comments — the property the sweep relied on', () => {
    // Pinning the scanner itself. If this stops holding, the guard above starts
    // either missing real controls or demanding that explanations be mangled,
    // and both failures look like a passing test.
    expect(renderedOccurrences(`const glyph = '${FULLWIDTH_PLUS}';`)).toBe(1);
    expect(renderedOccurrences(`<span>${FULLWIDTH_PLUS} New</span>`)).toBe(1);
    expect(renderedOccurrences(`// pressing ${FULLWIDTH_PLUS} on Docs`)).toBe(0);
    expect(renderedOccurrences(`/* ${FULLWIDTH_PLUS} is fullwidth and ▮ is not */`)).toBe(0);
    expect(renderedOccurrences(`/*\n * a ${FULLWIDTH_PLUS} across lines\n */`)).toBe(0);
  });
});
