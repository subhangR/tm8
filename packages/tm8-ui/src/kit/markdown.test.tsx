// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from './Markdown';

/**
 * The `img` override, tested as the PRIVACY BOUNDARY it is rather than as
 * styling. The load-bearing assertion in every remote case is the absence of an
 * `<img>`: jsdom would not issue the request anyway, so what these prove is
 * that no `src` pointing off-origin is ever handed to the browser at all.
 */
describe('Markdown images', () => {
  const href = (id: string) => `/v2/files/${id}/download`;

  it('renders a tm8:// file reference as a real image through the resolver', () => {
    const { getByTestId, container } = render(
      <Markdown source="![a diagram](tm8://file/file-123)" fileHref={href} />,
    );
    const img = getByTestId('markdown-image') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/v2/files/file-123/download');
    expect(img.getAttribute('alt')).toBe('a diagram');
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('accepts the transport spelling of the same reference', () => {
    const { getByTestId } = render(
      <Markdown source="![shot](/v2/files/file-9/download)" fileHref={href} />,
    );
    expect((getByTestId('markdown-image') as HTMLImageElement).getAttribute('src')).toBe(
      '/v2/files/file-9/download',
    );
  });

  it('states the reference instead of guessing a URL when no resolver is passed', () => {
    const { getByTestId, container } = render(<Markdown source="![shot](tm8://file/file-9)" />);
    getByTestId('markdown-image-unresolved');
    expect(container.querySelector('img')).toBeNull();
  });

  it('never emits an <img> for a remote URL — it offers a link chip instead', () => {
    const { getByTestId, container } = render(
      <Markdown source="![pixel](https://tracker.example/p.png)" fileHref={href} />,
    );
    const link = getByTestId('markdown-image-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://tracker.example/p.png');
    expect(link.className).toContain('md-link');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    expect(link.textContent).toContain('pixel');
    expect(container.querySelector('img')).toBeNull();
  });

  it('treats an absolute URL on our own host as remote — the path shape is not a proof of origin', () => {
    const { container } = render(
      <Markdown source="![x](https://evil.example/v2/files/f/download)" fileHref={href} />,
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('rejects a data: URI', () => {
    const { getByTestId, container } = render(
      <Markdown
        source="![inline](data:image/png;base64,iVBORw0KGgo=)"
        fileHref={href}
      />,
    );
    getByTestId('markdown-image-rejected');
    expect(container.querySelector('img')).toBeNull();
  });

  it('always carries alt text, even when the author wrote none', () => {
    const { getByTestId } = render(<Markdown source="![](tm8://file/file-1)" fileHref={href} />);
    expect((getByTestId('markdown-image') as HTMLImageElement).getAttribute('alt')).toBe('image');
  });
});
