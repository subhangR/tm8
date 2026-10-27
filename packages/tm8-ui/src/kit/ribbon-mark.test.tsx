// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RibbonMark, ribbonPhase } from './RibbonMark';

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

  /**
   * The segment budget. A glyph-size mark spends 150 quads on arcs a third of
   * a pixel long, so the chat surfaces buy fewer. Two things have to hold for
   * that to be a budget rather than a bug: the count is honoured, and the
   * geometry survives it — every station still passes through a cross product
   * and a normalize, and a coarse step is exactly where a degenerate tangent
   * would show up as NaN and silently drop quads.
   */
  it('honours a smaller segment budget', () => {
    const { container } = render(<RibbonMark segments={44} />);
    expect(container.querySelectorAll('polygon')).toHaveLength(44);
  });

  it('stays finite and shaded at glyph-size budgets', () => {
    for (const segments of [44, 60]) {
      const { container } = render(<RibbonMark segments={segments} />);
      const polys = Array.from(container.querySelectorAll('polygon'));
      const coords = polys.flatMap((p) =>
        (p.getAttribute('points') ?? '').split(/[\s,]+/).filter(Boolean).map(Number),
      );
      expect(coords).toHaveLength(segments * 8);
      expect(coords.every(Number.isFinite)).toBe(true);
      // The band must still be a band, not a flat silhouette — the shading is
      // the only thing that reads as depth once the mark is this small.
      const fills = new Set(polys.map((p) => p.getAttribute('fill')));
      expect(fills.size).toBeGreaterThan(10);
    }
  });

  it('refuses a degenerate budget rather than emitting a NaN band', () => {
    // A zero or fractional count would divide the loop into steps the tangent
    // cannot be taken over. Clamped, so a caller's bad arithmetic is a coarse
    // mark and never an invisible one.
    for (const segments of [0, -8, 2, 3.4]) {
      const { container } = render(<RibbonMark segments={segments} />);
      const polys = Array.from(container.querySelectorAll('polygon'));
      expect(polys.length).toBeGreaterThanOrEqual(3);
      const coords = polys.flatMap((p) =>
        (p.getAttribute('points') ?? '').split(/[\s,]+/).filter(Boolean).map(Number),
      );
      expect(coords.every(Number.isFinite)).toBe(true);
    }
  });

  /**
   * The stations are cached per count, and the cache is module-level and
   * shared by every mounted mark. A cache that ignored the count would hand a
   * 44-quad mark the 150-quad table — which does not throw, it just reads
   * `st[i + 1]` off the wrong sampling and draws a different curve.
   */
  it('keeps each budget’s geometry to itself across mounts', () => {
    const first = render(<RibbonMark segments={150} />).container;
    const small = render(<RibbonMark segments={44} />).container;
    const again = render(<RibbonMark segments={150} />).container;
    expect(small.querySelectorAll('polygon')).toHaveLength(44);
    expect(again.querySelectorAll('polygon')).toHaveLength(150);
    expect(again.querySelector('polygon')?.getAttribute('points')).toBe(
      first.querySelector('polygon')?.getAttribute('points'),
    );
  });

  /**
   * The `eclipse` finish (the tm8 brand mark). jsdom resolves no tokens, so
   * this runs on the fallback poles, which mirror the light theme. What it can
   * see is the contract the finish exists for: at rest the band carries BOTH
   * poles at once — a near-black half and a near-white half — rather than one
   * grey, and the lighting still varies within each half.
   */
  it('splits the band into a black half and a white half under the eclipse finish', () => {
    const { container } = render(<RibbonMark finish="eclipse" animated={false} />);
    const lum = Array.from(container.querySelectorAll('polygon')).map((p) => {
      const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(p.getAttribute('fill') ?? '');
      expect(m).not.toBeNull();
      return (Number(m![1]) + Number(m![2]) + Number(m![3])) / 3;
    });
    expect(lum.filter((v) => v < 90).length).toBeGreaterThan(40);
    expect(lum.filter((v) => v > 180).length).toBeGreaterThan(40);
    expect(new Set(lum.map(Math.round)).size).toBeGreaterThan(20);
  });

  it('leaves every other mount on the ink finish by default', () => {
    const ink = render(<RibbonMark animated={false} />).container;
    const eclipse = render(<RibbonMark finish="eclipse" animated={false} />).container;
    expect(ink.querySelector('polygon')?.getAttribute('fill')).not.toBe(
      eclipse.querySelector('polygon')?.getAttribute('fill'),
    );
  });

  it('swings the phase rest → turn → rest over one loop', () => {
    expect(ribbonPhase(0)).toBeCloseTo(0);
    expect(ribbonPhase(1)).toBeCloseTo(1);
    expect(ribbonPhase(2)).toBeCloseTo(0);
  });
});
