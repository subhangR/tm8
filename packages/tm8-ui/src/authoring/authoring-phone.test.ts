import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE PHONE ARRANGEMENT OF THE CREATE / EDIT FORM, pinned by reading the
 * stylesheet — the pattern `mobile/mobile-frame.test.ts` and
 * `channel-screen.responsive.test.ts` already establish, and here it is not a
 * convenience but the only honest instrument available.
 *
 * ── WHY NOT A RENDER TEST ────────────────────────────────────────────────
 *
 * jsdom LOADS NO STYLESHEETS AND IMPLEMENTS NO LAYOUT. `getComputedStyle` on a
 * rendered dialog returns the empty string for every property this file is
 * about. A jsdom test asserting "the input is 16px" would therefore pass on a
 * branch that had deleted the rule, pass on a branch that never had it, and
 * pass on a branch that overrode it three lines later. It would be a lie, and
 * the brief says it will be read as one.
 *
 * So the claim made here is exactly the claim the source can support: THE
 * DECLARATION IS PRESENT, IT HAS THE RIGHT VALUE, AND NOTHING LATER IN THE
 * FILE TAKES IT BACK. Whether the pixels follow is the build service's, from a
 * real device — and for the 16px rule specifically, from a real iOS Safari,
 * because no Chrome emulation reproduces the behaviour it prevents.
 *
 * ── THE PARSE, AND WHY IT IS NOT A `toMatch` ─────────────────────────────
 *
 * A first-match regex guard is a trap this program has already paid for: it
 * goes green on the FIRST occurrence and cannot see the defect returning in a
 * SECOND rule further down the file. Every assertion below therefore collects
 * ALL matching blocks and asserts over the whole set. That is also what lets
 * these tests survive someone appending to the file, which is the likeliest
 * way any of this regresses.
 */

/** Comments are stripped first: this file's stylesheet EXPLAINS what it forbids
    (13px, `100vh`, blanket button rules, `::after` hit areas), and a negative
    assertion over raw text would fail on the explanation rather than on the
    defect. Same reasoning, and the same helper, as `mobile-frame.test.ts`. */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

const css = strip(read('./authoring-phone.css'));
const dialog = read('./EditEntityDialog.tsx');

/** Every `selector { … }` block in the sheet, as a pair. */
function blocks(source: string): Array<{ selector: string; body: string }> {
  const found: Array<{ selector: string; body: string }> = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let hit: RegExpExecArray | null;
  while ((hit = rule.exec(source)) !== null) {
    found.push({ selector: hit[1]!.trim(), body: hit[2]! });
  }
  return found;
}

/** Every declared value of `property` in the blocks whose selector matches. */
function declared(property: string, selectorMatch: RegExp): string[] {
  const values: string[] = [];
  for (const block of blocks(css)) {
    if (!selectorMatch.test(block.selector)) continue;
    const decl = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'g');
    let hit: RegExpExecArray | null;
    while ((hit = decl.exec(block.body)) !== null) values.push(hit[1]!.trim());
  }
  return values;
}

const RULES = blocks(css);

describe('the sheet cannot reach the desktop', () => {
  it('has rules at all, so every assertion below is about something', () => {
    // A parse that silently produced zero blocks would make every "for every
    // rule …" assertion below vacuously true, forever.
    expect(RULES.length).toBeGreaterThan(0);
  });

  it('scopes EVERY rule to the phone shell', () => {
    // `.cv2-root[data-shell='mobile']` is the marker `GateApp` stamps on the
    // phone root and nowhere else. The desktop authoring dialog is in daily
    // use; one unscoped rule head here restyles it. Checked across ALL rules
    // rather than by finding one that is scoped — the failure mode is a rule
    // APPENDED without the prefix, which a first-match check cannot see.
    const unscoped = RULES.filter((rule) => !rule.selector.includes("[data-shell='mobile']"));
    expect(unscoped.map((rule) => rule.selector)).toEqual([]);
  });

  it('is bound to the component that draws the markup, not to the barrel', () => {
    // `authoring/index.ts` imports `authoring.css` on the reasoning that a host
    // taking one symbol gets the whole vocabulary — and a DEEP-PATH import
    // bypasses the barrel entirely (#455). `loops/LoopCreateControl.tsx` wears
    // `.au-dialog` for the whole `scheduled-work` CREATE form and imports
    // `../authoring/commands` directly, so it has never pulled the barrel.
    expect(dialog).toContain("import './authoring-phone.css'");
  });
});

describe('the 16px floor, which is the rule that prevents a whole-app failure', () => {
  it('sets every text control in the form to at least 16px', () => {
    // Mobile Safari AUTO-ZOOMS the layout viewport when focus lands in a text
    // control under 16px AND DOES NOT ZOOM BACK ON BLUR. The base is 13px. One
    // tap into any field leaves the reader permanently magnified with every
    // fixed control off screen.
    //
    // EVERY declaration, not the first: a later rule re-setting the same
    // selector to 13px is precisely the regression this guards, and a
    // `toMatch(/font-size:\s*16px/)` would pass right through it.
    const sizes = declared('font-size', /\.au-dialog__input/);
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) {
      expect(Number.parseFloat(size)).toBeGreaterThanOrEqual(16);
    }
  });

  it('states it in px, because a relative unit is not a threshold', () => {
    // The 16px is a WebKit constant, not a ratio. `1rem` inherits from a root
    // this shell does not control and `em` from whatever the field's parent
    // happens to be, so either could resolve under the threshold without a
    // single line of this file changing.
    for (const size of declared('font-size', /\.au-dialog__input/)) {
      expect(size).toMatch(/^\d+(\.\d+)?px$/);
    }
  });
});

describe('the keyboard, which the frame has already measured', () => {
  it('composes the overlay against the published inset', () => {
    // `.mobile-frame` shrinks by `--mobile-keyboard-inset`, and every region
    // INSIDE it inherits that for free. `.au-dialog__backdrop` is
    // `position: fixed` and `.mobile-frame` is only `position: relative`, which
    // is NOT a containing block for fixed — so this overlay resolves against
    // the layout viewport, which on iOS the keyboard overlays without
    // changing. The frame shrinks; the dialog does not; Save is under the
    // keyboard.
    const bottoms = declared('bottom', /\.au-dialog__backdrop/);
    expect(bottoms.some((value) => value.includes('--mobile-keyboard-inset'))).toBe(true);
  });

  it('does not measure the keyboard a second time', () => {
    // CONTRACT.md §3: "A LANE MUST NOT WIRE ITS OWN KEYBOARD LISTENER." A
    // composer, a modifier bar and a form that each subscribe to
    // `visualViewport` are three surfaces disagreeing about where the keyboard
    // starts. One measurement, published by the frame, consumed here.
    expect(strip(dialog)).not.toContain('visualViewport');
    expect(css).not.toContain('visualViewport');
  });

  it('sits inside the home-indicator inset by composing, never by re-deriving env()', () => {
    // CONTRACT.md §2. The frame publishes `--mobile-safe-bottom`; a region that
    // re-derives `env(safe-area-inset-bottom)` is a second copy of a number
    // that has to stay in step with the first.
    expect(css).toMatch(/--mobile-safe-bottom/);
    expect(css).not.toMatch(/env\(safe-area-inset/);
  });
});

describe('44px, per named class — the shape the ledger accepts', () => {
  it('floors the form’s own controls', () => {
    // The action row, the fields and the conflict card's moves are every
    // control on this surface. Their desktop geometry is ~19px, ~28px and
    // ~17px.
    for (const selector of [
      /\.au-dialog__actions button/,
      /\.au-dialog__input/,
      /\.au-refusal__move/,
    ]) {
      const floors = declared('min-height', selector);
      expect(floors.length, String(selector)).toBeGreaterThan(0);
      for (const floor of floors) expect(Number.parseFloat(floor)).toBeGreaterThanOrEqual(44);
    }
  });

  it('never floors a bare element, which would inflate every dense control in a sheet', () => {
    // CONTRACT.md §6 forbids `button { min-height: 44px }` because the phone
    // renders the desktop's dense shared components INSIDE sheets. Every
    // selector here that carries a floor must name a class of this form's own.
    const floored = RULES.filter((rule) => /min-height|min-width/.test(rule.body));
    expect(floored.length).toBeGreaterThan(0);
    for (const rule of floored) {
      expect(rule.selector, rule.selector).toMatch(/\.au-/);
    }
  });

  it('uses no ::after hit areas', () => {
    // The audit measures the ELEMENT's own `getBoundingClientRect()`, so a
    // pseudo-element hit area scores as fixed while the thumb still misses.
    expect(css).not.toMatch(/::(after|before)/);
  });
});

describe('the refusal states survive the new arrangement', () => {
  it('grows the sentences a failed save depends on', () => {
    // `au-dialog__missing` carries `role="alert"`; `au-dialog__unavailable` is
    // the sentence that says why Save is dark, and is the reason the dialog
    // states its refusal instead of silently disabling the button. Both are
    // 11px from `--pn-fs-micro`, beside inputs this sheet just took to 16px.
    for (const size of declared('font-size', /au-dialog__(missing|unavailable)/)) {
      expect(Number.parseFloat(size)).toBeGreaterThan(11);
    }
    expect(declared('font-size', /au-dialog__(missing|unavailable)/).length).toBeGreaterThan(0);
  });

  it('scopes the refusal-card floor inside the dialog, not across the six other hosts', () => {
    // `RefusalCard` is shared. A bare `.au-refusal__move` floor would reach
    // every surface that renders one, none of whose geometry is this lane's.
    for (const rule of RULES.filter((r) => r.selector.includes('au-refusal'))) {
      expect(rule.selector, rule.selector).toContain('.au-dialog');
    }
  });

  it('keeps the action row above the fields it is sticky over', () => {
    // The row is `position: sticky` inside the sheet's own scroll so a long
    // form cannot scroll Save out of reach. Sticky without a background paints
    // the fields THROUGH it; sticky without a stacking order lets a later
    // positioned sibling paint over it. Both are invisible in jsdom and both
    // lose the reader their Save button.
    const actions = RULES.filter((rule) => rule.selector.includes('.au-dialog__actions'));
    const sticky = actions.filter((rule) => /position:\s*sticky/.test(rule.body));
    expect(sticky).toHaveLength(1);
    expect(sticky[0]!.body).toMatch(/background:/);
    expect(sticky[0]!.body).toMatch(/z-index:/);
  });
});
