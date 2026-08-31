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

/**
 * CALLOUTS — asserted as STRUCTURE, never as appearance.
 *
 * `vitest` runs with `css: false` in this package, so nothing below can see the
 * tone colour, the ground or the rule; a test that claimed to check "the
 * warning is amber" would be checking nothing. What these DO check is every
 * decision the renderer makes: which blockquotes are admitted, that the marker
 * text is removed rather than shown beside the word it produced, that the tone
 * reaches the attribute the stylesheet keys on, and — the one that matters most
 * — that an ordinary quotation is still an ordinary quotation.
 */
describe('Markdown callouts', () => {
  it('turns a GFM alert into a toned callout and drops the marker text', () => {
    const { getByTestId } = render(
      <Markdown source={'> [!WARNING]\n> Every count in this section is stale.'} />,
    );
    const callout = getByTestId('markdown-callout');
    expect(callout.getAttribute('data-tone')).toBe('warning');
    expect(callout.textContent).toContain('Every count in this section is stale.');
    // The syntax must not survive beside the word it produced.
    expect(callout.textContent).not.toContain('[!WARNING]');
    expect(callout.textContent).toContain('Warning');
  });

  it.each([
    ['NOTE', 'note', 'Note'],
    ['TIP', 'tip', 'Tip'],
    ['IMPORTANT', 'important', 'Important'],
    ['WARNING', 'warning', 'Warning'],
    ['CAUTION', 'caution', 'Caution'],
  ])('recognises [!%s]', (marker, tone, word) => {
    const { getByTestId } = render(<Markdown source={`> [!${marker}]\n> body`} />);
    const callout = getByTestId('markdown-callout');
    expect(callout.getAttribute('data-tone')).toBe(tone);
    expect(callout.querySelector('.md-callout__title')?.textContent).toBe(word);
  });

  it('marks the callout with drawn geometry, not a text character', () => {
    // `VectorIcon`'s standing argument: a pictographic character lands on its
    // own font's baseline and resolves to a blob at 14px. If this ever becomes
    // an emoji again, this is the test that says so.
    const { getByTestId } = render(<Markdown source={'> [!CAUTION]\n> mind the gap'} />);
    const title = getByTestId('markdown-callout').querySelector('.md-callout__title');
    expect(title?.querySelector('svg')).not.toBeNull();
  });

  it('leaves an ordinary quotation alone', () => {
    const { container, queryByTestId } = render(
      <Markdown source="> A quotation is not a callout and must not become one." />,
    );
    expect(queryByTestId('markdown-callout')).toBeNull();
    const quote = container.querySelector('blockquote');
    expect(quote).not.toBeNull();
    expect(quote?.className).toBe('');
  });

  it('leaves a marker it does not know alone, verbatim', () => {
    const { container, queryByTestId } = render(<Markdown source={'> [!HINT]\n> not a GFM alert'} />);
    expect(queryByTestId('markdown-callout')).toBeNull();
    expect(container.querySelector('blockquote')?.textContent).toContain('[!HINT]');
  });

  it('only reads the marker on the FIRST line — a mention mid-quote is prose', () => {
    const { queryByTestId, container } = render(
      <Markdown source={'> We agreed to write\n> [!NOTE] blocks from now on.'} />,
    );
    expect(queryByTestId('markdown-callout')).toBeNull();
    expect(container.querySelector('blockquote')?.textContent).toContain('[!NOTE]');
  });

  it('renders a callout with no body as the bare notice, not as a crash', () => {
    // Reachable input: an author types the marker and saves before the body.
    const { getByTestId } = render(<Markdown source="> [!NOTE]" />);
    expect(getByTestId('markdown-callout').getAttribute('data-tone')).toBe('note');
  });
});
