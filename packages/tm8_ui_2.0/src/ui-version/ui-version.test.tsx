// @vitest-environment jsdom
/**
 * The way home from the alternate UI must always be there.
 *
 * This control's whole job is to be a door a viewer can find and trust. It is
 * unconditional by design — `/` is where the product UI always is, and if this
 * bundle rendered at all it was served from the same origin — so what is worth
 * guarding is that it stays a real, plain, same-tab link. The failure it exists
 * to prevent is a one-way switch: a viewer who reaches 2.0, finds something
 * missing, and cannot get back without editing the address bar.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UiVersionReturn } from './UiVersionReturn';

describe('UiVersionReturn', () => {
  it('links to the product UI at the root', () => {
    render(<UiVersionReturn />);

    expect(screen.getByTestId('back-to-ui-1-0').getAttribute('href')).toBe('/');
  });

  it('is unconditional — it never probes and never refuses', () => {
    // No fetcher seam and no disabled state: a probe here could only ever say
    // yes, and a refusal would strand a viewer in the UI they are leaving.
    render(<UiVersionReturn />);

    expect(screen.getByTestId('back-to-ui-1-0')).toBeTruthy();
    expect(screen.queryByTestId('disabled-with-reason')).toBeNull();
  });

  it('never opens a second copy of the app beside itself', () => {
    // Two live UIs over one catalog would put the same entity on screen twice
    // with independent event streams.
    render(<UiVersionReturn />);

    expect(screen.getByTestId('back-to-ui-1-0').getAttribute('target')).toBeNull();
  });

  it('names itself for a screen reader and keeps the glyph decorative', () => {
    render(<UiVersionReturn />);

    const link = screen.getByLabelText('Back to UI 1.0');
    expect(link.querySelector('[aria-hidden]')).toBeTruthy();
  });

  it('wears the row grammar the host dresses it in', () => {
    render(<UiVersionReturn className="auth-menu__row" />);

    expect(screen.getByTestId('back-to-ui-1-0').className).toContain('auth-menu__row');
  });
});
