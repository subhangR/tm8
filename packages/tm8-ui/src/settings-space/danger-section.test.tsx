// @vitest-environment jsdom
/**
 * THE DANGER ZONE'S LAYOUT, asserted.
 *
 * jsdom loads no stylesheets and runs no layout, so nothing here can see the
 * bulkhead's wash, its 520px measure, or the double gutter that started this.
 * Those were measured in real Chrome (SECTION-CONTRACT.md §8) and the numbers
 * are in `danger-section.css`'s header.
 *
 * What jsdom CAN hold is the structural half, and every assertion below is a
 * defect that was real in the build before this lane:
 *
 *   · the body was a `.set-stack`, whose own `12px var(--set-gutter)` nested
 *     inside the frame's `.set-section__pad` and doubled the gutter;
 *   · both acts carried the same caption and NOTHING ELSE, so the two most
 *     irreversible controls in the app were indistinguishable from each other;
 *   · the refusal has to keep saying "no executor" rather than "not allowed" —
 *     a permission gate is a door someone else can open, a missing verb is a
 *     door that is not built, and only one of those is worth waiting for.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { DangerSection } from './DangerSection';
import { DANGER_ZONE_UNAVAILABLE } from './reasons';

afterEach(cleanup);

describe('Danger zone — layout', () => {
  it('renders its body as the bulkhead, NOT a `.set-stack` inside the frame pad', () => {
    const { container } = render(<DangerSection heading="Danger zone" />);
    const scroll = container.querySelector('.set-section__scroll');
    expect(scroll).toBeTruthy();

    // The regression: `.set-stack` carries its own `12px var(--set-gutter)`,
    // and the frame's `.set-section__pad` already carries `12px 18px 20px`.
    // Nested, they add — 36px of body inset under an 18px head.
    expect(container.querySelector('.set-stack')).toBeNull();
    expect(container.querySelector('.set-danger')).toBeTruthy();
  });

  it('keeps exactly one scroller — the frame owns it, the bulkhead adds none', () => {
    const { container } = render(<DangerSection heading="Danger zone" />);
    expect(container.querySelectorAll('.set-section__scroll')).toHaveLength(1);
  });

  it('puts the prose BEFORE both acts, so the reason is met before the buttons', () => {
    const { container } = render(<DangerSection heading="Danger zone" />);
    const prose = container.querySelector('.set-danger__prose');
    const controls = screen.getAllByTestId('disabled-with-reason');
    expect(prose).toBeTruthy();
    for (const control of controls) {
      // DOCUMENT_POSITION_FOLLOWING: the control comes after the prose.
      expect(prose!.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('gives each act its OWN consequence line, so the two never read as one form', () => {
    render(<DangerSection heading="Danger zone" />);
    const transfer = screen.getByTestId('danger-act-transfer');
    const del = screen.getByTestId('danger-act-delete');

    const whatOf = (row: HTMLElement) =>
      row.querySelector('.set-danger__act-what')?.textContent?.trim() ?? '';

    expect(whatOf(transfer)).not.toBe('');
    expect(whatOf(del)).not.toBe('');
    // The defect this replaces: both rows said the same thing and nothing else.
    expect(whatOf(transfer)).not.toBe(whatOf(del));

    expect(within(transfer).getByRole('button', { name: 'transfer ownership' })).toBeTruthy();
    expect(within(del).getByRole('button', { name: 'delete this space' })).toBeTruthy();
  });
});

describe('Danger zone — the refusal survives the relayout', () => {
  it('both acts stay refused, focusable, and describe themselves', () => {
    render(<DangerSection heading="Danger zone" />);
    for (const name of ['transfer ownership', 'delete this space']) {
      const control = screen.getByRole('button', { name });
      expect(control.getAttribute('aria-disabled')).toBe('true');
      // NOT the `disabled` attribute: a natively disabled control leaves the
      // tab order, so a keyboard user could never reach the reason.
      expect(control.hasAttribute('disabled')).toBe(false);
      expect(control.tabIndex).toBe(0);

      const describedBy = control.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const caption = document.getElementById(describedBy!);
      expect(caption?.textContent).toContain(DANGER_ZONE_UNAVAILABLE.cause);
    }
  });

  it('says the seam carries no verb — never that the viewer lacks permission', () => {
    render(<DangerSection heading="Danger zone" />);
    const captions = Array.from(document.querySelectorAll('.hon-caption')).map(
      (el) => el.textContent ?? '',
    );
    expect(captions.length).toBe(2);
    for (const text of captions) {
      expect(text).toMatch(/no executor in this build/);
      // The distinction the brief is explicit about: this is a door that is
      // not built, not one the viewer is on the wrong side of.
      expect(text).not.toMatch(/permission|not allowed|admin|owner only|you can’t/i);
    }
  });
});
