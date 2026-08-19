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
       measurement with one consumer. */
    const full = block(".msheet__panel[data-size='full']");
    expect(full).not.toMatch(/\bdvh\b/);
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
