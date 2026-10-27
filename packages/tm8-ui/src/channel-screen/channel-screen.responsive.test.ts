import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./channel-screen.css', import.meta.url), 'utf8');
const panelCss = readFileSync(new URL('../panels/panels.css', import.meta.url), 'utf8');

describe('Chat responsive and preference gates', () => {
  it('ships narrow-container, reduced-motion, forced-colors, and measured virtualization rules', () => {
    expect(css).toContain('@container (max-width: 440px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain(".chs-list[data-virtualized='true'] > .chs-row");
    expect(css).toContain('contain-intrinsic-size: auto var(--chs-measured-row-size, 72px)');
  });

  it('measures the transcript and the composer on ONE shared rail', () => {
    // Subhang, 2026-09-18: the feed was full-bleed while the composer capped
    // itself at 760px and centred, so at a 1466px panel the two rails started
    // 296px apart and the transcript hugged the left edge. jsdom cannot lay
    // anything out, so this pins the three facts that make them one rail:
    // the token exists, the feed's children ride it, and the composer points
    // at the SAME token rather than a number of its own.
    // 2026-10-18: the rail is chat's 760px column (`.tch-transcript`), so a
    // channel and a chat read identically in the same pane.
    expect(/\.chs-root\s*\{[\s\S]*?--chs-measure:\s*min\(760px,\s*100%\)/.test(css)).toBe(true);
    expect(css).toMatch(
      /\.chs-feed > :not\(\.chs-feed__spacer\)\s*\{[^}]*width:\s*var\(--chs-measure\);[^}]*margin-inline:\s*auto/s,
    );
    expect(css).toMatch(
      /\.chs-composer > :not\(\.chs-mention-picker\)\s*\{[^}]*width:\s*var\(--chs-measure\);[^}]*margin-inline:\s*auto/s,
    );
    // `min(…, 100%)` and not a clamp or a bare width: the rail has to
    // degrade to the full width inside the ~360px thread pane and the 440px
    // phone container, where those blocks below still get the last word.
    expect(css).not.toMatch(/--chs-measure:\s*\d+px/);
    // The 70ch LINE measure is a different job and stays where it was.
    expect(css).toMatch(/\.chs-text\s*\{[^}]*max-width:\s*70ch/s);
  });

  it('keeps composer and Terminal/Chat touch targets at least 44px', () => {
    expect(css).toMatch(/\.chs-composer__send\s*\{[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/\.chs-iconbtn\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px/s);
    expect(panelCss).toMatch(/\.cv2-root \.pn-surface-switch__tab\s*\{[^}]*min-height:\s*44px/s);
  });

  it('floats the @ picker as a single-column scrolling popover, never a grid', () => {
    const picker = /\.chs-mention-picker\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    // A popover: it overlays the composer instead of reflowing it, so opening
    // the list never moves the textarea out from under the caret.
    expect(picker).toMatch(/position:\s*absolute/);
    expect(picker).toMatch(/bottom:\s*100%/);

    const listbox = /\.chs-mention-picker \[role='listbox'\]\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    // ONE column. A grid gives "down" two meanings and makes ↑/↓ ambiguous.
    expect(listbox).not.toMatch(/grid/);
    expect(listbox).toMatch(/flex-direction:\s*column/);
    // Bounded to roughly five 44px rows, then it scrolls rather than growing
    // until it covers the feed it was opened over.
    expect(listbox).toMatch(/max-height:\s*238px/);
    expect(listbox).toMatch(/overflow-y:\s*auto/);
  });

  it('collapses an open thread to replace the feed below the width threshold, breadcrumb taking over', () => {
    // The three-column split cannot survive a narrow container: an open
    // thread REPLACES the feed, and the `← #channel` breadcrumb becomes the
    // one way back. jsdom cannot evaluate container queries, so this pins the
    // RULES — the collapse is CSS, and losing any of these lines silently
    // re-opens the 180px-sliver-beside-180px-pane failure.
    const collapse = /@container \(max-width: 640px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(collapse).toMatch(/\.chs-root\[data-thread-open='true'\] \.chs-main\s*\{[^}]*display:\s*none/);
    expect(collapse).toMatch(/\.chs-root\[data-thread-open='true'\] \.chs-thread\s*\{[^}]*flex:\s*1 1 auto/);
    // The breadcrumb SHOWS collapsed and the ✕ hides — one wired fact, one
    // visible control at every width.
    expect(collapse).toMatch(/\.chs-thread__back\s*\{[^}]*display:\s*inline-flex/);
    expect(collapse).toMatch(/\.chs-thread__close\s*\{[^}]*display:\s*none/);
    // At full width the pane is a bounded aside column, never unfloored.
    const pane = /\.chs-thread\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(pane).toMatch(/flex:\s*0 0 clamp\(/);
    expect(pane).toMatch(/min-width:\s*0/);
    const back = /\.chs-thread__back\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(back).toMatch(/display:\s*none/);
  });

  it('gives the arrow-key highlight a visible treatment', () => {
    // Without this rule ↑/↓ move an invisible cursor and Enter commits a row
    // the user cannot see — the keyboard navigation depends on it entirely.
    const active = /\.chs-mention-picker button\[data-active='true'\]\s*\{([^}]*)\}/s.exec(css)?.[1];
    expect(active, 'the active-row rule must exist').toBeTruthy();
    expect(active).toMatch(/background:\s*var\(--pn-brand-soft\)/);
    expect(active).toMatch(/border-color:\s*var\(--pn-brand\)/);
  });
  it('puts phone message actions in flow under the turn, never over its byline or text', () => {
    // Verify F6 (2026-10-18): pinned open by the 440 container block, the
    // absolutely-positioned bar's 44px ↩ tiles covered the author and first
    // line of every message in the phone Discussion sheet. On the phone the
    // bar is turn chrome: static, plain, on the bubble's side.
    const phone = /\.cv2-root\[data-shell='mobile'\] \.chs-row--turn \.chs-actions\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    expect(phone).toMatch(/position:\s*static/);
    expect(phone).toMatch(/opacity:\s*1/);
    expect(phone).toMatch(/border:\s*none/);
    expect(css).toMatch(
      /\.cv2-root\[data-shell='mobile'\] \.chs-row--turn\[data-own\] \.chs-actions\s*\{[^}]*justify-content:\s*flex-end/s,
    );
    // The reply target keeps the 44px floor.
    expect(css).toMatch(
      /\.cv2-root\[data-shell='mobile'\] \.chs-row--turn \.chs-iconbtn\s*\{[^}]*min-width:\s*var\(--mobile-touch-min, 44px\);[^}]*min-height:\s*var\(--mobile-touch-min, 44px\)/s,
    );
    // It must come AFTER the generic turn placement, or the cascade loses it.
    expect(css.indexOf(".cv2-root[data-shell='mobile'] .chs-row--turn .chs-actions"))
      .toBeGreaterThan(css.indexOf('.chs-row--turn .chs-actions { top: -10px'));
  });
});
