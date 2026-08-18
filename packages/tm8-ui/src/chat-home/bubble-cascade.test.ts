/**
 * CASCADE ARITHMETIC FOR THE USER BUBBLE — the transcript lane's pattern
 * (D-VIS-1 / their own caught-before-merge bug), applied to this file set.
 *
 * jsdom applies NO cascade, so a bubble losing a specificity war renders
 * identically to a winning one in every component test — the only honest
 * guard is arithmetic over the selectors themselves. Three rules interact:
 *
 *   kit/markdown.css   `.cv2-root .md-root`                          (0,2,0)
 *   chat-home.css      `.cv2-root .md-root.tch-user-body`            (0,3,0)
 *   chat-home.css      `.cv2-root .tch-turn[data-self='true'] …`     (0,4,0)
 *
 * The bubble base must OUTRANK markdown's serif default (or typed messages
 * render in the doc face), and the sidedness rule must OUTRANK the bubble
 * base (equal specificity falls to source order, where the base declares
 * `margin-left` later and own-right silently dies — the transcript lane
 * shipped exactly that and caught it only in the built stylesheet).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const HERE = new URL('.', import.meta.url).pathname;
const chatHome = readFileSync(`${HERE}chat-home.css`, 'utf8');
const markdown = readFileSync(`${HERE}../kit/markdown.css`, 'utf8');

/** (ids, classes+attributes+pseudo-classes, elements) — enough for these
 *  class/attribute selectors; no pseudo-element or :where() games here. */
function specificity(selector: string): [number, number, number] {
  const s = selector.trim();
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes =
    (s.match(/\.[\w-]+/g) ?? []).length +
    (s.match(/\[[^\]]+\]/g) ?? []).length +
    (s.match(/:(?!:)[\w-]+/g) ?? []).length;
  const elements = (s.match(/(^|[\s>+~])[a-z][\w-]*/g) ?? []).length;
  return [ids, classes, elements];
}

function outranks(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
}

/** The selector of the rule whose declarations include `needle`. Comments are
 *  stripped FIRST — a docblock above a rule is full of `.class`-shaped prose
 *  that would otherwise inflate the arithmetic. */
function selectorsDeclaring(css: string, member: string, needle: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(bare); m; m = re.exec(bare)) {
    const [, sel, body] = m;
    if (sel!.includes(member) && body!.includes(needle)) found.push(sel!.trim());
  }
  return found;
}

describe('user-bubble cascade arithmetic', () => {
  const markdownBase = selectorsDeclaring(markdown, '.md-root', 'font-family').find(
    (s) => !s.includes('.tch-') && !s.includes(','),
  );
  const bubbleBase = selectorsDeclaring(chatHome, '.tch-user-body', 'font-size')[0];
  const sidedness = selectorsDeclaring(chatHome, '.tch-user-body', 'margin-left: auto')[0];

  it('all three rules exist where this test thinks they do', () => {
    expect(markdownBase, 'markdown.css base rule went missing').toBeTruthy();
    expect(bubbleBase, 'the bubble base rule went missing').toBeTruthy();
    expect(sidedness, 'the own-right sidedness rule went missing').toBeTruthy();
  });

  it("the bubble base outranks markdown's serif default", () => {
    expect(
      outranks(specificity(bubbleBase!), specificity(markdownBase!)),
      `${bubbleBase} must beat ${markdownBase} or typed messages render serif (D-VIS-1)`,
    ).toBe(true);
  });

  it('the own-right rule outranks the bubble base — never a source-order tie', () => {
    expect(
      outranks(specificity(sidedness!), specificity(bubbleBase!)),
      `${sidedness} must beat ${bubbleBase}; at equal specificity the base's later ` +
        'margin-left wins and own-right silently dies (the transcript lane shipped this)',
    ).toBe(true);
  });
});
