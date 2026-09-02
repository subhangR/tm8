/**
 * A CONTROL STRIP WRAPS; IT NEVER SCROLLS SIDEWAYS.
 *
 * Owner, 2026-08-31, on a task open in the entity pane: the panel's controls
 * row — `open · MEDIUM · points · mm/dd/yyyy · mm/dd/yyyy · assignee` — was a
 * single `flex-wrap: nowrap` line with `overflow-x: auto` under it, so the form
 * had grown a horizontal scrollbar across itself.
 *
 * THE DISTINCTION THIS FILE DEFENDS, because it is the one that was lost: "wide
 * content scrolls in its own container" is a rule about TABLES and DIAGRAMS —
 * artefacts you READ, where the whole is a picture and panning across it is the
 * natural gesture. A control strip is something you OPERATE, and operating it
 * requires seeing all of it at once. A due date behind a scroll is a field most
 * people never find.
 *
 * Asserted as SOURCE because `vitest` runs `css: false` here and no test in
 * this package can observe a rendered pixel — the geometry half is the render
 * gate's. What source can prove is that the two properties that produced the
 * scrollbar are not on this selector, which is exactly the regression to catch:
 * it is one word, and it reads as harmless in a diff.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const taskCss = strip(readFileSync(new URL('./task-detail.css', import.meta.url), 'utf8'));
const phoneCss = strip(
  readFileSync(new URL('./detail/panel-controls-phone.css', import.meta.url), 'utf8'),
);

/** Every declaration block whose selector names the controls strip. */
function blocksFor(css: string, selectorNeedle: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    if (m[1]!.includes(selectorNeedle)) out.push(m[2]!);
  }
  return out;
}

describe('the entity panel’s controls strip', () => {
  const blocks = blocksFor(taskCss, '.lp__rowdetail--chips');

  it('has a rule at all — a vacuous pass here would hide the whole check', () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('WRAPS, and nowhere declares itself a single line', () => {
    const wrapping = blocks.filter((b) => /flex-wrap:\s*wrap/.test(b));
    expect(wrapping.length, 'the strip no longer declares a wrap').toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block, 'the controls strip is a single line again').not.toMatch(
        /flex-wrap:\s*nowrap/,
      );
    }
  });

  it('never scrolls sideways — that is the table rule, and these are controls', () => {
    for (const block of blocks) {
      expect(block, 'the controls strip scrolls horizontally again').not.toMatch(/overflow-x/);
      /* The scrollbar STYLING is checked too, not just the overflow: leaving a
         `scrollbar-width` behind is how the next reader concludes the scroller
         was meant to be there and puts it back. */
      expect(block, 'a scrollbar is still being styled on a control strip').not.toMatch(
        /scrollbar-width|scrollbar-color/,
      );
    }
  });

  it('keeps every control at its own width, so wrapping is what gives', () => {
    /* A shrinkable `<select>` compresses to its content instead of moving to
       the next line — the clipping failure arriving through a different
       property. `flex: none` on the children is what makes "it wraps" true
       rather than "it squeezes". */
    const children = blocksFor(taskCss, '.lp__rowdetail--chips > *');
    expect(children.some((b) => /flex:\s*none/.test(b))).toBe(true);
  });

  it('is scoped by ARCHETYPE, so this is one fix and not a task-shaped exception', () => {
    /* Every kind whose panel is `subtree` draws this band from this rule. If a
       future edit narrows the selector to a kind, the other kinds silently keep
       the scroller and the owner's "every entity" report comes back. */
    expect(taskCss).toContain("[data-archetype='subtree'] .lp__rowdetail--chips");
    expect(taskCss, 'the strip grew a per-kind selector').not.toMatch(
      /\[data-kind=['"]task['"]\][^{]*\.lp__rowdetail--chips/,
    );
  });
});

describe('the PHONE strip keeps its scroller, deliberately', () => {
  it('still pans, and still hides the bar', () => {
    /*
     * NOT AN OVERSIGHT — the one place the trade is correct, and it is left
     * intact so the next reader does not "finish the job".
     *
     * A 390px viewport cannot hold six controls on any number of lines without
     * spending the whole screen on them, so the phone trades panning for height
     * ON PURPOSE and hides the scrollbar rather than drawing a track across a
     * touch surface. Its rules are (0,4,0) via the shell attribute and beat the
     * desktop rule regardless of import order, so the wrap above cannot reach
     * it — which is the specificity trap that file's own docblock records.
     */
    expect(phoneCss).toMatch(/flex-wrap:\s*nowrap/);
    expect(phoneCss).toMatch(/overflow-x:\s*auto/);
    expect(phoneCss).toMatch(/scrollbar-width:\s*none/);
    expect(phoneCss, 'the phone rules stopped being shell-scoped').toContain(
      "[data-shell='mobile']",
    );
  });
});
