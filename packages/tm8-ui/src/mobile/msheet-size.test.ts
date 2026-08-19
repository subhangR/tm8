import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WHAT `size='full'` IS ACTUALLY WORTH — read off the stylesheet, because
 * nothing else can read it.
 *
 * `views/aux-sheet-chrome.test.tsx` pins the CHOICE: Discussion asks for the
 * full sheet, Connections does not, and the choice reaches the DOM as
 * `data-size`. That is the whole of what a jsdom test can see, and on its own
 * it is an attribute nothing consumes — the variant could be deleted from the
 * stylesheet tomorrow and every case over there would stay green while the
 * composer went back under the keyboard.
 *
 * So this file asserts the other half, in the only way available: by reading
 * the rule. Same pattern and same reasons as `mobile-frame.test.ts` next door —
 * jsdom implements no layout, so `height: 100%` against a `calc(100dvh - …)`
 * ancestor resolves to an empty string there and proves nothing.
 *
 * Comments are stripped first, and that is not a formality here: the block
 * being asserted EXPLAINS the `100dvh` it deliberately does not use, so a
 * negative assertion over raw text would match the explanation and pass on a
 * rule that had been written the wrong way round.
 */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const css = strip(readFileSync(new URL('./mobile-screens.css', import.meta.url), 'utf8'));

/** Just the declarations of one rule, so a claim about `.msheet__panel` cannot
    be satisfied by a match somewhere else in a 900-line stylesheet. */
function block(selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `${selector} is not in mobile-screens.css`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

describe('the full-height sheet variant', () => {
  it('takes the frame, overriding BOTH the floor and the cap', () => {
    /* `.msheet__panel` is `height: 72%` AND `max-height: 88%`. Overriding the
       height alone leaves the cap in force and the "full" sheet is 88% — a
       variant that looks implemented, ships, and is 12% short. Both, or
       neither. */
    const full = block(".msheet__panel[data-size='full']");
    expect(full).toMatch(/height:\s*100%/);
    expect(full).toMatch(/max-height:\s*100%/);
  });

  it('inherits the keyboard shrink instead of re-deriving it', () => {
    /* THE DEFECT THIS FORBIDS: `height: 100dvh` here. It reads as the same
       intent and is wrong on the one screen state the variant exists for — the
       frame is `calc(100dvh - var(--mobile-keyboard-inset))`, so a sheet at a
       raw `100dvh` is the WHOLE screen and puts the composer it was widened for
       underneath the keyboard. Percentage of the ancestor is what keeps one
       measurement with one consumer.

       NO `\b` BEFORE `dvh`, and it is not a style choice. `\bdvh\b` cannot
       match `100dvh` — `0` and `d` are both word characters, so there is no
       boundary between them — which makes it a guard that is green whatever
       the rule says. It was written that way here first, and the M7 negative
       control (this exact rule set to `100dvh`) is what caught it: the case
       stayed green while its neighbour reddened. */
    const full = block(".msheet__panel[data-size='full']");
    expect(full).not.toMatch(/dvh/);
    expect(full).not.toMatch(/--mobile-keyboard-inset/);
  });

  it('leaves the default sheet its floor and its cap', () => {
    /* The control. A variant implemented by editing `.msheet__panel` itself
       rather than by adding a selector would pass every assertion above while
       making every sheet in the app full-height — including the account sheet
       and the launch sheet, neither of which asked. */
    const base = block('.msheet__panel {');
    expect(base).toMatch(/height:\s*72%/);
    expect(base).toMatch(/max-height:\s*88%/);
  });
});

describe('the sheet clears the keyboard the way the tab bar already does', () => {
  it('drops the home-indicator inset while the keyboard is up', () => {
    /* `.msheet__panel` pads its bottom by `--mobile-safe-bottom` to clear the
       home indicator. With the keyboard up there is no home indicator to clear
       — it is drawn over — so the padding becomes ~34px of blank paper between
       a composer's foot row and the keyboard, on the one screen state where
       vertical room is scarcest. `mobile.css` already zeroes exactly this for
       `.mobile-frame__tabbar`; this is the same fact at the other surface that
       pads against the same token. */
    const keyed = block("[data-keyboard='up'] .msheet__panel");
    expect(keyed).toMatch(/padding-bottom:\s*0/);
  });

  it('keys off the marker attribute, not off the inline custom property', () => {
    /* `MobileFrame` publishes the keyboard as BOTH a number (an inline custom
       property) and a boolean (`data-keyboard`). A rule that matched the number
       — `[style*='--mobile-keyboard-inset']` — would stop matching the first
       time the value was formatted differently, and would do it silently. */
    expect(css).not.toMatch(/\[style\*=[^\]]*keyboard/);
  });
});

describe('the controls the sheet inherited from a desktop column', () => {
  /*
   * THE FLOOR, PER NAMED CLASS, ROOTED AT `.msheet`. `.ev-aux` is a ~380px
   * pointer-device column and the sheet renders it under a thumb; its two
   * navigation controls arrived at desktop density (~22px and ~20px tall).
   *
   * Asserted from the stylesheet, not from a render: jsdom has no layout, so
   * `getBoundingClientRect()` there is all zeroes and a "44px" assertion in a
   * jsdom test would be measuring nothing. The real geometry is the mobile
   * audit's job.
   */
  it.each(['.kit-chip', '.pn-viewswitch__opt'])(
    'floors %s inside the sheet at the touch token',
    (selector) => {
      const rule = block(`.msheet ${selector}`);
      expect(rule).toMatch(/min-height:\s*var\(--mobile-touch-min\)/);
    },
  );

  it('scopes both floors to the phone, so the desktop column keeps its density', () => {
    /* `.kit-chip` is used across the whole product and `.pn-viewswitch__opt`
       sits in the desktop panel too. An unscoped floor would inflate every chip
       in the app — the exact failure CONTRACT.md §6 forbids a blanket
       `button { min-height: 44px }` for. */
    for (const selector of ['.kit-chip', '.pn-viewswitch__opt']) {
      const at = css.indexOf(`.msheet ${selector}`);
      const line = css.slice(css.lastIndexOf('\n', at) + 1, css.indexOf('{', at));
      expect(line).toContain("[data-shell='mobile']");
    }
  });

  it('puts the floor on the SMALLER side and does not fake it with a pseudo-element', () => {
    /* Two rules at once, and both are contract text. §6: the floor belongs on
       whichever side is smaller — 120×22 fails the same thumb as 22×120 — and
       these controls are wide and short, so HEIGHT is the side. And no
       `::after` hit area anywhere in the sheet's block: the audit measures the
       element's own rect, so a pseudo-element scores as fixed while the thumb
       still misses. */
    for (const selector of ['.kit-chip', '.pn-viewswitch__opt']) {
      expect(block(`.msheet ${selector}`)).not.toMatch(/min-width/);
    }
    expect(css.slice(css.indexOf('.msheet {'))).not.toMatch(/\.msheet[^{]*::after[^{]*\{[^}]*(width|height)/);
  });
});

describe('regression guards over the whole sheet block', () => {
  it('never keys a sheet rule off the inline keyboard custom property', () => {
    /* `MobileFrame` publishes the keyboard as BOTH a number (an inline custom
       property) and a boolean (`data-keyboard`). A rule that matched the number
       — `[style*='--mobile-keyboard-inset']` — would stop matching the first
       time the value was formatted differently, and would do it silently. */
    expect(css).not.toMatch(/\[style\*=[^\]]*keyboard/);
  });
});
