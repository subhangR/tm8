import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE FRAME'S STRUCTURAL FACTS, pinned by reading the stylesheet rather than by
 * rendering it — the pattern `channel-screen/channel-screen.responsive.test.ts`
 * already establishes for exactly this kind of assertion.
 *
 * DELIBERATELY NOT A jsdom TEST, and that is worth stating because it looks
 * like an omission. Two reasons:
 *
 *   1. jsdom DOES NOT IMPLEMENT LAYOUT. It would report `100dvh` and
 *      `env(safe-area-inset-bottom)` as empty strings and prove nothing about
 *      the two facts below, which are the only things in this file that can
 *      actually break a phone.
 *   2. THE HASH-LEAK TRAP. jsdom keeps one `window.location` per test FILE, and
 *      since the router mounted, a case that navigates leaves its address
 *      behind for the next one. That cost the router-mount lane eight failures
 *      that were ONE missing line. A render test here would need
 *      `window.location.hash = ''` beside `resetNav()` in its helper; a
 *      stylesheet assertion needs no helper at all and cannot leak.
 *
 * What this CANNOT prove is that the frame looks right on a real device. That
 * is a Phase 0 reference-capture job (§4.5) and is not claimed here.
 */

/**
 * Comments are stripped before every assertion, for the same reason
 * `no-router-fork.test.ts` strips them: BOTH FILES EXPLAIN THE THINGS THEY
 * FORBID. `mobile.css` names `100vh` and `minmax(0` in prose in order to say
 * why neither is used, and a negative assertion over raw text would fail on
 * the explanation rather than on the defect. Stripping first means these tests
 * describe the CODE, and the prose stays free to teach.
 */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const css = strip(readFileSync(new URL('./mobile.css', import.meta.url), 'utf8'));
const frame = strip(readFileSync(new URL('./MobileFrame.tsx', import.meta.url), 'utf8'));

describe('§3.6 — the two structural facts that exist nowhere else in this codebase', () => {
  it('sizes with 100dvh and never 100vh', () => {
    // On iOS Safari `100vh` is the height the viewport has with the URL bar
    // HIDDEN. A `100vh` shell is therefore taller than the screen for as long
    // as the bar is showing — which is most of the time — and the bottom tab
    // bar ends up underneath it. This is the single most common way a mobile
    // web shell is wrong, and it is invisible on a desktop browser.
    expect(css).toMatch(/height:\s*100dvh/);
    expect(css).not.toMatch(/\b100vh\b/);
  });

  it('reserves the safe area on every edge, so nothing sits under a notch or a home indicator', () => {
    for (const side of ['top', 'bottom', 'left', 'right']) {
      expect(css).toContain(`env(safe-area-inset-${side}`);
    }
  });

  it('exposes the insets as TOKENS, so §7.3 composes against them instead of re-deriving them', () => {
    // The drop notice has to sit ABOVE the tab bar and INSIDE the bottom inset.
    // If those numbers are inlined rather than named, the notice re-derives
    // them and the two drift the first time either changes.
    expect(css).toMatch(/--mobile-safe-bottom:/);
    expect(css).toMatch(/--mobile-tabbar-min:/);
    expect(css).toMatch(/bottom:\s*calc\(var\(--mobile-safe-bottom\)\s*\+\s*var\(--mobile-tabbar-min\)\)/);
  });
});

describe('L4 — floors are law', () => {
  it('never uses the forbidden unfloored track', () => {
    // An unfloored track collapses the region to zero and the content simply
    // vanishes. That has broken this app three separate times.
    expect(css).not.toMatch(/minmax\(\s*0/);
  });

  it('floors the scrolling region so the tab bar cannot be pushed off-screen', () => {
    // A grid child that scrolls needs `min-height: 0`; without it the row
    // floors at its content height and the WHOLE FRAME scrolls instead,
    // carrying the tab bar away with it.
    expect(css).toMatch(/\.mobile-frame__content\s*\{[^}]*min-height:\s*0/);
  });
});

describe('§14 — colour always resolves through a token', () => {
  it('carries no raw hex', () => {
    // Also covered by the package-level hex-ban, asserted here so this file
    // fails in the lane that owns it rather than turning the package red.
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });
});

describe('the frame is a frame — honest and empty', () => {
  it('ships slots, not screens', () => {
    // Phase 3 fills these against the §6 acceptance table. If this test starts
    // failing because a region was added, that is fine; if it fails because
    // the frame grew a screen, that is scope creep and the failure is the
    // point.
    for (const region of ['header', 'content', 'tabbar', 'sheet', 'notices']) {
      expect(css).toContain(`.mobile-frame__${region}`);
    }
  });

  it('renders every optional region conditionally, so an empty slot leaves no dead chrome', () => {
    // An always-rendered empty header is a band of border and background above
    // content that nothing asked for.
    for (const slot of ['header', 'tabBar', 'sheet', 'notices']) {
      expect(frame).toMatch(new RegExp(`\\{${slot}\\s*\\?`));
    }
  });

  it('takes its content as children and asks nothing about what a route draws', () => {
    // The origin-bearing vs origin-less `e/{id}` ruling is still open. The
    // frame cannot be invalidated by it because the frame never asks — it
    // places what it is handed. This pins that property rather than trusting it.
    expect(frame).toMatch(/\{children\}/);
    expect(frame).not.toMatch(/\bRoute\b/);
  });
});
