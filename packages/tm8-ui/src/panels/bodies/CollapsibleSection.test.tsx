// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import {
  CollapsibleSection,
  resetFoldStateForTests,
  toggleEmptySections,
  useEmptySectionsRevealed,
} from './CollapsibleSection';

/**
 * THE FOLD PRIMITIVE's own contract: one hairline head row, content only when
 * open, ARIA wiring intact, state persisted globally per section id, and the
 * empty/reveal choreography that the body's `⋯ N empty sections` line drives.
 */

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // this jsdom exposes no storage — the store's in-memory fallback is live
  }
  resetFoldStateForTests();
});

function fold(over: Partial<React.ComponentProps<typeof CollapsibleSection>> = {}) {
  return render(
    <CollapsibleSection id="specimen" label="SPECIMEN" count={3} empty={false} testId="specimen-fold" {...over}>
      <p>the folded content</p>
    </CollapsibleSection>,
  );
}

describe('CollapsibleSection', () => {
  it('collapsed is ONE line: label and count on the head, no content, testid kept', () => {
    const view = fold();
    const section = view.getByTestId('specimen-fold');
    expect(section.textContent).toContain('SPECIMEN');
    expect(section.textContent).toContain('3');
    expect(section.textContent).not.toContain('the folded content');
    const head = view.getByRole('button', { name: /SPECIMEN/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands in place with the ARIA contract: aria-controls names the region, labelled by the head', () => {
    const view = fold();
    const head = view.getByRole('button', { name: /SPECIMEN/ });
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    const region = view.getByRole('region');
    expect(region.id).toBe(head.getAttribute('aria-controls'));
    expect(region.getAttribute('aria-labelledby')).toBe(head.id);
    expect(region.textContent).toContain('the folded content');
  });

  it('defaultOpen applies only until the fold is touched — then the touch wins, globally', () => {
    const first = fold({ defaultOpen: true });
    const head = first.getByRole('button', { name: /SPECIMEN/ });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(head);
    first.unmount();

    // A fresh mount with the same id: the persisted 'closed' beats defaultOpen.
    const second = fold({ defaultOpen: true });
    expect(second.getByRole('button', { name: /SPECIMEN/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('an EMPTY fold leaves the flow entirely, and the reveal brings it back', () => {
    const view = fold({ empty: true });
    expect(view.queryByTestId('specimen-fold')).toBeNull();

    // The reveal is the same store the body's toggle writes.
    function Reveal() {
      const revealed = useEmptySectionsRevealed();
      return (
        <button type="button" onClick={() => toggleEmptySections(revealed)}>
          reveal
        </button>
      );
    }
    const withToggle = render(<Reveal />);
    fireEvent.click(withToggle.getByText('reveal'));
    expect(view.getByTestId('specimen-fold')).toBeTruthy();
    expect(view.getByTestId('specimen-fold').getAttribute('data-empty')).toBe('true');
  });

  it('the caret is presentation only, and honours reduced motion in the stylesheet', () => {
    const view = fold();
    const caret = view.getByTestId('specimen-fold').querySelector('.pn-fold__caret');
    expect(caret?.getAttribute('aria-hidden')).toBe('true');
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'collapsible-section.css'),
      'utf8',
    );
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('the reading measure is a token, consumed by the measured body column', () => {
    // jsdom loads no stylesheet, so the 720px cap is pinned at the source: the
    // token exists, and the measured column consumes it for every child.
    const here = dirname(fileURLToPath(import.meta.url));
    const tokens = readFileSync(join(here, '../../styles/tokens.css'), 'utf8');
    expect(tokens).toContain('--pn-read-measure: 720px');
    const panels = readFileSync(join(here, '../panels.css'), 'utf8');
    expect(panels).toMatch(
      /\.cv2-root \.pn-body--measured > \* \{[^}]*max-width: var\(--pn-read-measure\)/,
    );
    expect(panels).toMatch(/\.pn-controls__measure \{[^}]*max-width: var\(--pn-read-measure\)/);
  });
});
