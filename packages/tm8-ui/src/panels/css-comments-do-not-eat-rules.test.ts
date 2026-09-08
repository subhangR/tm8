/**
 * A CSS COMMENT THAT CLOSES EARLY DELETES THE RULE BELOW IT, SILENTLY.
 *
 * This file exists because it happened, in the change that added it. A comment
 * explaining why a dead rule had misled the audit contained the glob
 * `src/**` + `/*.tsx`. A CSS comment ends at the FIRST `*` `/` after it opens,
 * and that glob carries one in the middle. So the comment ended early, the
 * remaining prose became the head of a selector, and the parser swallowed the
 * whole `.cv2-root .lp__tab` block that followed as part of that selector's
 * rule. The four lifecycle tabs shipped as bare `<button>`s — UA outset
 * borders, ButtonFace grey, no gap between the word and its count.
 *
 * NOTHING IN THIS REPO COULD SEE IT. jsdom loads no stylesheets, so no unit
 * test parses CSS at all; `tsc` does not read `.css`; the build does not fail
 * on a dropped rule because a dropped rule is VALID CSS — error recovery is
 * the specified behaviour, not a bug. It took someone opening the page in a
 * browser and reading `getComputedStyle` off a tab.
 *
 * The check is deliberately about the FAILURE SHAPE rather than about the one
 * glob that caused it. Any comment that closes early spills prose into selector
 * position, and prose in these files is full of backticks, commas and English —
 * none of which can appear in a real selector here. So: tokenize the way a
 * browser does (comments end at the first terminator, no exceptions), then
 * assert that every selector still looks like a selector.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'node_modules' || name === 'dist' ? [] : cssFiles(path);
    }
    return name.endsWith('.css') ? [path] : [];
  });
}

/** Strip comments the way a CSS tokenizer does: `/*` opens, the FIRST `*` `/`
    closes. An unterminated comment runs to EOF. This is the whole point — a
    forgiving strip that honours what the author MEANT would hide the defect. */
function stripComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) return out;
      // Keep newlines so reported line numbers stay meaningful.
      out += css.slice(i, end + 2).replace(/[^\n]/g, ' ');
      i = end + 2;
      continue;
    }
    out += css[i];
    i += 1;
  }
  return out;
}

/** Every selector prelude in the file, with the line it starts on. */
function selectors(css: string): { selector: string; line: number }[] {
  const stripped = stripComments(css);
  const found: { selector: string; line: number }[] = [];
  let depth = 0;
  let prelude = '';
  let preludeStart = 1;
  let line = 1;
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '\n') line += 1;
    if (ch === '{') {
      if (depth === 0) {
        const text = prelude.trim();
        // At-rules (`@media`, `@container`, `@keyframes`) open a nested block
        // whose children are the selectors we care about; the at-rule prelude
        // itself is not one.
        if (text && !text.startsWith('@')) found.push({ selector: text, line: preludeStart });
        if (text.startsWith('@')) depth -= 1; // its children are still top level
      }
      depth += 1;
      prelude = '';
      preludeStart = line;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      prelude = '';
      preludeStart = line;
      continue;
    }
    if (depth === 0 || prelude !== '' || /\S/.test(ch)) {
      if (prelude === '' && /\S/.test(ch)) preludeStart = line;
      prelude += ch;
    }
  }
  return found;
}

/* CHARACTERS, NOT VOCABULARY. The first draft of this also flagged English
   words, and `.auth-rule` and `.hlp-rule` are real class names — a selector is
   allowed to read like a word. What a selector prelude physically CANNOT
   contain is any of these: a backtick (these comments are markdown-flavoured
   and full of them), a semicolon (it would have ended the statement), or `?`
   and `!`. The prose that escaped the reported comment carried a backtick in
   its first eight characters. */
const PROSE = /[`;?!]/;
/* NO LENGTH NET. The draft had one, at 200 characters, and it flagged six
   files' worth of perfectly good comma-separated selector lists and `:where()`
   groups — a long selector is normal here. The character check above is the
   precise signal and it is sufficient: prose that escapes one of these comments
   carries a backtick almost immediately. */

describe('a CSS comment must not swallow the rule after it', () => {
  const files = cssFiles(SRC);

  it('finds the stylesheets it is supposed to guard', () => {
    expect(files.length).toBeGreaterThan(3);
    expect(files.some((f) => f.endsWith('panels.css'))).toBe(true);
  });

  for (const file of files) {
    const short = file.slice(SRC.length);
    it(`${short} — no prose in selector position`, () => {
      const spilled = selectors(readFileSync(file, 'utf8'))
        .filter((s) => PROSE.test(s.selector))
        .map((s) => `${short}:${s.line}  ${s.selector.slice(0, 120)}`);
      expect(spilled).toEqual([]);
    });
  }

  /* The specific rules the reported defect destroyed. A shape check catches the
     class of bug; these catch it for the row this change is about, and they
     fail loudly rather than as "a selector looked odd". */
  it('the lifecycle tab rules survive parsing', () => {
    const panels = readFileSync(join(SRC, 'panels/panels.css'), 'utf8');
    const found = new Set(selectors(panels).flatMap((s) => s.selector.split(',').map((p) => p.replace(/\s+/g, ' ').trim())));
    for (const wanted of [
      '.cv2-root .lp__tab',
      '.cv2-root .lp__tab-word',
      '.cv2-root .lp__tab-count',
      '.cv2-root .lp__tab--active',
      '.cv2-root .lp__tierrow',
      '.cv2-root .lp__chip',
      '.cv2-root .lp__statedot',
    ]) {
      expect(found, `${wanted} was dropped by the parser`).toContain(wanted);
    }
  });
});
