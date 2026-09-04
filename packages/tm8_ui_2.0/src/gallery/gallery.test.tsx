// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { GalleryPage } from './GalleryPage';
import { fixtureSummaries } from '../fixtures';

/**
 * Render-level smoke of the whole gallery: executes the full module graph
 * (kit + fixtures + honesty states) in a DOM. NOT a substitute for the
 * browser screenshot (jsdom has no layout engine — this repo learned that
 * the hard way); it proves the page mounts and both theme panes exist.
 */
describe('GalleryPage', () => {
  it('mounts both theme panes: light (no data-theme) and dark', () => {
    const { container } = render(<GalleryPage />);
    const panes = container.querySelectorAll('.cv2-root');
    expect(panes).toHaveLength(2);
    expect(panes[0]?.getAttribute('data-theme')).toBeNull();
    expect(panes[1]?.getAttribute('data-theme')).toBe('dark');
  });

  it('renders the full fixture roster in each pane', () => {
    const { container } = render(<GalleryPage />);
    // one hairline row per summary per pane
    const rows = container.querySelectorAll('.kit-hairline-b');
    expect(rows.length).toBeGreaterThanOrEqual(fixtureSummaries.length * 2);
    // the worst-case UUID title is present (twice — once per theme)
    const uuidRows = Array.from(rows).filter((r) => r.textContent?.includes('4f8c2a9e-77b1-4e3d-9c2f-a1b0d3e5f6a7'));
    expect(uuidRows).toHaveLength(2);
  });

  it('renders the D7 honesty section: disabled-with-reason + both hollow states', () => {
    const { getAllByText, getAllByTitle } = render(<GalleryPage />);
    expect(getAllByText(/disabled-with-reason \(D7\.1\)/)).toHaveLength(2);
    expect(getAllByText(/hollow-value presence \(D7\.2\)/)).toHaveLength(2);
    expect(getAllByText(/hollow provenance chip \(D7\.3\)/)).toHaveLength(2);
    // the disabled paging affordance carries its reason and is truly disabled
    const disabled = getAllByTitle(/next-page token is defective/);
    expect(disabled).toHaveLength(2);
    for (const el of disabled) expect((el as HTMLButtonElement).disabled).toBe(true);
  });
});
