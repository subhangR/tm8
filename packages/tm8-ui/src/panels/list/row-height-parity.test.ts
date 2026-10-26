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

/**
 * AND THE OTHER WAY A ROW OUTGROWS THE FLOOR: SOMETHING IN IT IS TALLER.
 *
 * The floor above is a `min-height`, so honouring it against the right box
 * guarantees a row is never SHORTER than the token — not that it stays on it.
 * The standard row shipped at 34px against the task row's 30 with both rules
 * correct, because `.lp__rowaction--ind` is 22px in a content box of 18 and
 * sat in the flow.
 *
 * WHY IT SAT THERE. §6 moved the row's verbs behind the `⋯`, which retired the
 * `.lp__rowactions` wrapper that used to float the cluster out of the flow,
 * and left the disclosure chevron a direct child of `.lp__row1`. The only rule
 * that took it out again lives inside `@media (hover: hover) and (pointer:
 * fine)` — so every device that reports no hover laid it out and paid the 4px.
 * That includes this project's own headless Chrome, which reports `hover:
 * none` AND `pointer: none` and therefore matches neither that query nor the
 * coarse one: the screenshots the branch was verified in were taken in the
 * environment where the defect is permanent. A task row never had it, because
 * `pn-tt__ind` lives inside `.pn-tt__actions`, which is absolute everywhere.
 *
 * THE INVARIANT. A non-media rule must bring the chevron's layout footprint
 * down to 18px, so the floor is also the ceiling for every pointer. The phone
 * is excluded by selector — there the chevron is a deliberate 44px target on a
 * row that is 44px by design.
 */
describe('nothing in line 1 may outgrow the shared floor', () => {
  /**
   * `panels.css` with the contents of every `@media` block removed.
   *
   * COMMENTS COME OUT FIRST, and this file is the reason
   * `css-comments-do-not-eat-rules.test.ts` exists: the prose above the new
   * rule QUOTES `@media (hover: hover) and (pointer: fine)`, and a scanner
   * that reads that as a block open skips from the comment to the next
   * matching brace and swallows the very rule it was written to find. It
   * failed exactly that way once, on the first run.
   */
  function outsideMediaQueries(source: string): string {
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
    let out = '';
    let i = 0;
    while (i < css.length) {
      const at = css.indexOf('@media', i);
      if (at === -1) {
        out += css.slice(i);
        break;
      }
      out += css.slice(i, at);
      const open = css.indexOf('{', at);
      if (open === -1) break;
      let depth = 1;
      let j = open + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth += 1;
        else if (css[j] === '}') depth -= 1;
        j += 1;
      }
      i = j;
    }
    return out;
  }

  const base = outsideMediaQueries(sources['panels.css']);

  it('the chevron really is taller than the row — the premise of the rule', () => {
    const rule = sources['panels.css'].match(/\.cv2-root \.lp__rowaction \{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/height:\s*22px/);
  });

  it('its footprint is cut outside every @media query', () => {
    const rule = base.match(/\.lp__row1 > \.lp__rowaction--ind \{([^}]*)\}/);
    expect(rule).not.toBeNull();
    // 22 - 2 - 2 = the 18px the lead icon already occupies (`.lp-lead` in
    // `browser.css` reaches the same number the same way).
    expect(rule![1]).toMatch(/margin-block:\s*-2px/);
  });

  it('and the phone is excluded, where the 44px target is the point', () => {
    const selector = base.match(/([^{}]*)\.lp__row1 > \.lp__rowaction--ind \{/);
    expect(selector).not.toBeNull();
    expect(selector![1]).toContain(":not([data-shell='mobile'])");
  });
});
