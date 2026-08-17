// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RibbonMark } from './RibbonMark';

/**
 * jsdom loads no stylesheets and rasterizes nothing, so no test here can see
 * that the ribbon LOOKS right — that is what the browser screenshot on the PR
 * is for. What these can see is the failure mode that would otherwise reach a
 * screenshot as an invisible mark: the geometry going non-finite.
 *
 * Every station passes through a cross product, a normalize and a perspective
 * divide, so a sign slip or a zero-length tangent anywhere in the chain yields
 * NaN — and SVG's response to NaN in a `points` list is to silently drop the
 * polygon. A blank mark and a correct mark are the same empty DOM to jsdom,
 * hence the explicit finiteness sweep over every coordinate.
 */
describe('RibbonMark', () => {
  it('emits one polygon per segment', () => {
    const { container } = render(<RibbonMark />);
    expect(container.querySelectorAll('polygon')).toHaveLength(150);
  });

  it('emits only finite coordinates — NaN would drop the quad and paint nothing', () => {
    const { container } = render(<RibbonMark />);
    const polys = Array.from(container.querySelectorAll('polygon'));
    const coords = polys.flatMap((p) =>
      (p.getAttribute('points') ?? '').split(/[\s,]+/).filter(Boolean).map(Number),
    );
    expect(coords).toHaveLength(150 * 8); // 4 corners × 2 axes
    expect(coords.every(Number.isFinite)).toBe(true);
  });

  it('keeps the band inside its own viewBox', () => {
    const { container } = render(<RibbonMark />);
    const coords = Array.from(container.querySelectorAll('polygon')).flatMap((p) =>
      (p.getAttribute('points') ?? '').split(/[\s,]+/).filter(Boolean).map(Number),
    );
    const xs = coords.filter((_, i) => i % 2 === 0);
    const ys = coords.filter((_, i) => i % 2 === 1);
    // 560×700 design box. A mark that overflows here is one that will clip
    // against whatever container it is dropped into.
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(560);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(700);
  });

  it('shades the band rather than flooding it with one flat ink', () => {
    const { container } = render(<RibbonMark />);
    const fills = new Set(
      Array.from(container.querySelectorAll('polygon')).map((p) => p.getAttribute('fill')),
    );
    // The whole point of the port is the posterized lambert ramp; a single
    // fill across all 150 quads means the shading term collapsed.
    expect(fills.size).toBeGreaterThan(20);
    for (const f of fills) expect(f).toMatch(/^rgb\(\d{1,3},\d{1,3},\d{1,3}\)$/);
  });

  it('renders decoratively — the mark carries no accessible name of its own', () => {
    const { container } = render(<RibbonMark />);
    expect(container.querySelector('svg')?.querySelector('title')).toBeNull();
  });
});
