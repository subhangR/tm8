/**
 * THE DETECTOR for "the shared row floor was honoured against the wrong box".
 *
 * WHY THIS TEST EXISTS. `--pn-listrow-h` was introduced so a task row could be
 * held to the height a session row already measures ("sessions define it; tasks
 * follow it"). The rule that consumed it was correct-looking and wrong: this
 * app has NO global `box-sizing: border-box` reset — every rule that wants it
 * says so — and `min-height` sizes the CONTENT box by default. So a row with
 * `min-height: var(--pn-listrow-h)` and 6px/6px of padding measured 29 + 12 =
 * 41px, half again the 29px session row it was pointed at. Both consumers of
 * the token shipped with this defect and the list looked untouched.
 *
 * WHY IT SCANS THE SOURCE RATHER THAN THE DOM. jsdom loads no stylesheets and
 * implements no layout, so `getComputedStyle(...).height` is empty and
 * `getBoundingClientRect()` is all zeroes — a rendering test is structurally
 * unable to answer "how tall is this row". The whole 1714-test suite passed
 * green over the live defect, twice. The only thing that can catch it in-repo
 * is reading the declaration and checking the box model it resolves against.
 *
 * THE INVARIANT. Any rule that puts the shared floor on a box which also
 * carries padding must declare `box-sizing: border-box`, so the token means
 * the same number the session row measures. A padding-free box may carry the
 * floor without it — but then its PARENT's padding is added on top, which is
 * the same bug wearing a different hat, so this test requires border-box
 * unconditionally and makes any exception an explicit, reviewable edit.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sources = {
  'maestro-task-tile.css': readFileSync(
    fileURLToPath(new URL('./maestro-task-tile.css', import.meta.url)),
    'utf8',
  ),
  'panels.css': readFileSync(
    fileURLToPath(new URL('../panels.css', import.meta.url)),
    'utf8',
  ),
};

/** Every `selector { ... }` block whose body mentions the token. */
function blocksUsingRowToken(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const blockPattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(blockPattern)) {
    const [, selector, body] = match;
    if (/min-height:\s*var\(--pn-listrow-h\)/.test(body)) {
      out.push({ selector: selector.trim().replace(/\s+/g, ' '), body });
    }
  }
  return out;
}

describe('shared list-row floor', () => {
  it('is consumed by at least one rule (the token is not dead)', () => {
    const all = Object.values(sources).flatMap(blocksUsingRowToken);
    expect(all.length).toBeGreaterThan(0);
  });

  for (const [file, css] of Object.entries(sources)) {
    it(`${file}: every rule carrying the floor resolves it against the border box`, () => {
      const offenders = blocksUsingRowToken(css)
        .filter(({ body }) => !/box-sizing:\s*border-box/.test(body))
        .map(({ selector }) => selector);

      // A bare selector list is the useful failure message here: it names the
      // exact rule whose row will silently render `padding` taller than the
      // token claims.
      expect(offenders).toEqual([]);
    });
  }

  it('the session row sets no floor — it DEFINES the number by measuring it', () => {
    // If `pn-st__main` ever gains a min-height, the reference stops being a
    // measurement and starts being an assertion, and the two can drift apart
    // while both still "use the token".
    const sessionRule = sources['panels.css'].match(
      /\.cv2-root \.pn-st__main\s*\{([^}]*)\}/,
    );
    expect(sessionRule).not.toBeNull();
    expect(sessionRule![1]).not.toMatch(/min-height/);
  });
});
