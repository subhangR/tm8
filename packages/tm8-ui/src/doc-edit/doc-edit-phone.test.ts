import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE DOC EDITOR'S PHONE GEOMETRY, read from the stylesheet.
 *
 * `ReaderSurface.phone.test.tsx` settles WHICH component the phone mounts.
 * This file settles whether that component is usable once mounted — and it has
 * to read the source, because jsdom loads no stylesheets and implements no
 * layout, so no rendering test in this repo can see a font size or a height.
 *
 * ── THE REASON THIS FILE EXISTS AT ALL ───────────────────────────────────
 *
 * `DocEditor` was written as the narrow-viewport answer ("a 320-440px panel
 * can't afford honest columns") and then mounted by NOTHING for its whole life.
 * Its claim to hold up at 390px had never been tested, and it does not: every
 * number in it was transcribed from a desktop oracle frame, so the stance
 * toggle is ~19px, Cancel and Save are ~20px, and the source textarea — the
 * whole writing surface — is 11.5px mono, under the iOS auto-zoom threshold.
 *
 * Mounting it without these rules would have shipped a worse phone editor than
 * the split it replaced, and every assertion in the sibling suite would still
 * have been green. That is the gap this file covers.
 *
 * Same parse discipline as `authoring/authoring-phone.test.ts`: collect ALL
 * matching blocks, never the first, so a defect reappearing in a later rule
 * cannot hide behind an earlier passing one.
 */

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

const css = strip(read('./doc-edit-phone.css'));
const editor = read('./DocEditor.tsx');

function blocks(source: string): Array<{ selector: string; body: string }> {
  const found: Array<{ selector: string; body: string }> = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let hit: RegExpExecArray | null;
  while ((hit = rule.exec(source)) !== null) {
    found.push({ selector: hit[1]!.trim(), body: hit[2]! });
  }
  return found;
}

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

describe('the sheet cannot reach the desktop split view', () => {
  it('has rules at all', () => {
    expect(RULES.length).toBeGreaterThan(0);
  });

  it('scopes EVERY rule to the phone shell', () => {
    // `.de-bar`, `.de-btn` and `.de-source__area` are the SPLIT VIEW's classes
    // too — `EditorChrome` is deliberately shared between the two frames, "same
    // session, so the same controls, so one implementation of them". So an
    // unscoped rule here does not merely restyle a desktop editor: it restyles
    // the desktop editor THROUGH the component this lane was told not to
    // change. Checked over all rules, not by finding one that is scoped.
    const unscoped = RULES.filter((rule) => !rule.selector.includes("[data-shell='mobile']"));
    expect(unscoped.map((rule) => rule.selector)).toEqual([]);
  });

  it('is bound to the component that draws the markup', () => {
    expect(editor).toContain("import './doc-edit-phone.css'");
  });
});

describe('the writing surface clears the iOS auto-zoom threshold', () => {
  it('sets the source textarea to at least 16px', () => {
    // Under 16px, Mobile Safari zooms the layout viewport on focus and does not
    // zoom back on blur. The base is 11.5px. This is the single most common
    // phone-form defect and it is invisible in every instrument this repo has:
    // no desktop browser does it, jsdom reads no stylesheet, and a 390px Chrome
    // emulation is still Blink. Only a real iOS Safari sees it.
    const sizes = declared('font-size', /\.de-source__area/);
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(Number.parseFloat(size)).toBeGreaterThanOrEqual(16);
  });

  it('states it in px, not a relative unit that could resolve under the threshold', () => {
    for (const size of declared('font-size', /\.de-source__area/)) {
      expect(size).toMatch(/^\d+(\.\d+)?px$/);
    }
  });

  it('gives the one pane real height, since there is no second column to read in', () => {
    // On the desktop the source shares the screen with a live preview. Here it
    // IS the edit surface, and the base floor (120px, sized for the F3c 320
    // floor) is about seven lines at the new size.
    const floors = declared('min-height', /\.de-source__area/);
    expect(floors.length).toBeGreaterThan(0);
    for (const floor of floors) expect(Number.parseFloat(floor)).toBeGreaterThan(120);
  });
});

describe('44px, per named class', () => {
  it('floors the stance toggle and the commit buttons', () => {
    // Write, Preview, Cancel, Save and ⇲ are the entire editor. At ~19px they
    // are on screen, laid out, measurable — and missed by a thumb.
    for (const selector of [/\.de-stance__opt/, /\.de-btn/, /\.hon-disabled/]) {
      const floors = declared('min-height', selector);
      expect(floors.length, String(selector)).toBeGreaterThan(0);
      for (const floor of floors) expect(Number.parseFloat(floor)).toBeGreaterThanOrEqual(44);
    }
  });

  it('never floors a bare element', () => {
    // CONTRACT.md §6: no blanket `button { min-height: 44px }` — the phone
    // renders the desktop's dense shared components inside sheets.
    const floored = RULES.filter((rule) => /min-height|min-width/.test(rule.body));
    expect(floored.length).toBeGreaterThan(0);
    for (const rule of floored) {
      expect(rule.selector, rule.selector).toMatch(/\.(de|hon)-/);
    }
  });

  it('uses no ::after hit areas', () => {
    // The audit measures the element's own rect, so a pseudo-element scores as
    // fixed while the thumb still misses.
    expect(css).not.toMatch(/::(after|before)/);
  });

  it('gives the refused exit the same geometry as the live one', () => {
    // R2 excludes disabled elements from the tap census because there is
    // nothing to tap — but a refusal that is a different SIZE from the control
    // it stands in for makes the bar jump as the document goes dirty, under the
    // reader's thumb. `⇲` is refused exactly when the draft is unsaved, i.e.
    // while they are typing.
    expect(declared('min-height', /\.hon-disabled/).length).toBeGreaterThan(0);
  });
});

describe('the keyboard is the frame’s job, not this sheet’s', () => {
  it('wires no second visualViewport listener', () => {
    // CONTRACT.md §3. The editor sits inside `.mobile-frame`, which is already
    // `calc(100dvh - var(--mobile-keyboard-inset))` — unlike the authoring
    // dialog, nothing here is `position: fixed`, so the pane shrinks with the
    // keyboard for free and this file needs no arithmetic at all.
    expect(strip(editor)).not.toContain('visualViewport');
    expect(css).not.toContain('visualViewport');
  });

  it('never sizes against a viewport unit, which cannot see the keyboard', () => {
    // `100vh` is the height with the URL bar hidden and `dvh` does not account
    // for an overlaying keyboard. Both are answered once, by the frame.
    expect(css).not.toMatch(/\b\d+(vh|dvh|svh|lvh)\b/);
  });
});
