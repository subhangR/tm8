// @vitest-environment jsdom
/**
 * Avatar image support (identity display, 067).
 *
 * THE FALLBACK IS THE FEATURE UNDER TEST. Every profile row ships NULL, so
 * the monogram path is the one every user sees on day one — and a URL that
 * 404s must land back on it, not on a broken-image glyph. jsdom cannot load
 * images, which is exactly right for this suite: it can still prove the
 * DOM contract (img present/absent, monogram always painted, error handler
 * collapses back to the monogram).
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Avatar } from './Avatar';

describe('Avatar image layering', () => {
  it('renders NO img without a src — the monogram is the base state', () => {
    const { container } = render(<Avatar provenance="human" label="Ada Osei" />);
    expect(container.querySelector('.kit-avatar__img')).toBeNull();
    expect(container.querySelector('.kit-avatar')?.textContent).toBe('A');
  });

  it('null src is the same as no src (every profile row today)', () => {
    const { container } = render(<Avatar provenance="human" label="Ada Osei" src={null} />);
    expect(container.querySelector('.kit-avatar__img')).toBeNull();
  });

  it('layers the image over a still-painted monogram when a URL exists', () => {
    const { container } = render(
      <Avatar provenance="human" label="Ada Osei" src="https://example.test/ada.png" />,
    );
    const img = container.querySelector('.kit-avatar__img');
    expect(img?.getAttribute('src')).toBe('https://example.test/ada.png');
    // The initials must remain underneath: they are the loading state AND the
    // error state, with no re-render needed for either.
    expect(container.querySelector('.kit-avatar')?.textContent).toBe('A');
  });

  it('falls back to the monogram when the image errors (broken/404 URL)', () => {
    const { container } = render(
      <Avatar provenance="human" label="Ada Osei" src="https://example.test/404.png" />,
    );
    const img = container.querySelector('.kit-avatar__img')!;
    fireEvent.error(img);
    expect(container.querySelector('.kit-avatar__img')).toBeNull();
    expect(container.querySelector('.kit-avatar')?.textContent).toBe('A');
  });

  it('keeps provenance shape class with an image — shape survives the photo', () => {
    const { container } = render(
      <Avatar provenance="agent" label="Haiku" src="https://example.test/a.png" />,
    );
    expect(container.querySelector('.kit-avatar--agent')).not.toBeNull();
  });

  it('accessible name stays the actor label, image stays decorative', () => {
    const { getByRole, container } = render(
      <Avatar provenance="human" label="Ada Osei" src="https://example.test/ada.png" />,
    );
    getByRole('img', { name: 'Ada Osei' });
    expect(container.querySelector('.kit-avatar__img')?.getAttribute('alt')).toBe('');
  });
});
