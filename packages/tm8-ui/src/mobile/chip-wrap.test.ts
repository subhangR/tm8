import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A PHONE CHIP LABEL NEVER BREAKS MID-WORD (fix-wrap, verify finding F5).
 *
 * `mobile-noscroll.css` sets `overflow-wrap: anywhere` on the phone root, and
 * it inherits. Inside a flex row whose chips may shrink (`min-width: 0`), that
 * drops each chip's min-content to one letter, so the task page's facts strip
 * drew "w/o/r/ki/n/g" one letter per line. The fix lives in
 * `panels/detail/panel-controls-phone.css`: the strip wraps, opts back out of
 * `anywhere`, and the chip faces ellipsize their label on one line.
 *
 * jsdom has no layout, so this file pins the rules. The measured half is
 * `e2e/check-chip-wrap.mjs`, which loads the task page in Chrome at
 * 360/390/430 and fails on any text drawn as one-letter lines.
 *
 * Comments are stripped first: the stylesheet explains the rule it replaced,
 * and a match on prose would pass a rule that is not there.
 */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const noscroll = strip(read('./mobile-noscroll.css'));
const band = strip(read('../panels/detail/panel-controls-phone.css'));
const controls = read('../panels/controls/EntityControls.tsx');

const STRIP = ".cv2-root[data-shell='mobile'] .pn-controls .lp__rowdetail--chips";

/** Declaration bodies of every rule whose selector list, whitespace
    collapsed, equals `selector`. */
function bodies(css: string, selector: string): string {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? '').trim().replace(/\s+/g, ' ') === selector)
    .map((m) => m[2] ?? '')
    .join('\n');
}

describe('the phone facts strip keeps its chip labels whole', () => {
  it('still inherits `overflow-wrap: anywhere` from the phone root (the reason this guard exists)', () => {
    expect(bodies(noscroll, ".cv2-root[data-shell='mobile']")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('opts the strip back out of `anywhere`', () => {
    expect(bodies(band, STRIP)).toMatch(/overflow-wrap:\s*normal/);
  });

  it('wraps the strip instead of shrinking every chip to a caret', () => {
    const body = bodies(band, STRIP);
    expect(body).toMatch(/flex-wrap:\s*wrap/);
    expect(body).not.toMatch(/flex-wrap:\s*nowrap/);
  });

  it('keeps each chip face on one line and ellipsizes it', () => {
    const face = bodies(
      band,
      `${STRIP} :is(.lp__statesel, .pn-badge, .lp__assignbtn, .lp__dateadd, .pn-gate)`,
    );
    expect(face).toMatch(/white-space:\s*nowrap/);
    expect(face).toMatch(/text-overflow:\s*ellipsis/);
    expect(face).toMatch(/overflow:\s*hidden/);
  });

  it('puts the ellipsis on a label span, because a flex face cannot ellipsize its own text', () => {
    const label = bodies(band, ".cv2-root[data-shell='mobile'] .pn-controls .lp__chiplabel");
    expect(label).toMatch(/min-width:\s*0/);
    expect(label).toMatch(/text-overflow:\s*ellipsis/);
    // The chip menu trigger, the assignee face and the collection face.
    expect(controls.match(/className="lp__chiplabel"/g)).toHaveLength(3);
  });
});
