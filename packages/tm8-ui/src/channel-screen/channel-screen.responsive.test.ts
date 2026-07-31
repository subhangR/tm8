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

  it('gives the arrow-key highlight a visible treatment', () => {
    // Without this rule ↑/↓ move an invisible cursor and Enter commits a row
    // the user cannot see — the keyboard navigation depends on it entirely.
    const active = /\.chs-mention-picker button\[data-active='true'\]\s*\{([^}]*)\}/s.exec(css)?.[1];
    expect(active, 'the active-row rule must exist').toBeTruthy();
    expect(active).toMatch(/background:\s*var\(--pn-brand-soft\)/);
    expect(active).toMatch(/border-color:\s*var\(--pn-brand\)/);
  });
});
