// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { STORY_FIXTURE } from '../fixture';
import { StoryGraph } from './StoryGraph';
import { clampGraphZoom, GRAPH_ZOOM_MAX, GRAPH_ZOOM_MIN } from './useGraphZoom';

/**
 * Wiring only (issue #22). jsdom has no layout, so every rect is 0×0 and the
 * "drawn scale" reads as 1: these assert that the controls, keys and
 * ctrl+wheel reach the svg's width and the full-screen class — not pixels.
 */

function graph() {
  const r = render(<StoryGraph view={STORY_FIXTURE} />);
  const svg = r.container.querySelector<SVGSVGElement>('svg.stg-svg')!;
  const card = r.container.querySelector<HTMLElement>('.stg-card')!;
  const scroller = r.container.querySelector<HTMLElement>('.stg-scroll')!;
  const natural = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
  return { ...r, svg, card, scroller, natural };
}

describe('story graph zoom and full screen', () => {
  it('rests with no explicit width, so the canvas sizes itself as before', () => {
    const { svg } = graph();
    expect(svg.style.width).toBe('');
    expect(screen.getByRole('button', { name: /reset/ })).toHaveProperty('disabled', true);
  });

  it('zoom in / out buttons scale the drawn width; the % readout resets', () => {
    const { svg, natural } = graph();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(svg.style.width).toBe(`${Math.round(natural * 1.25)}px`);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(svg.style.width).toBe(`${natural}px`);
    fireEvent.click(screen.getByRole('button', { name: /reset/ }));
    expect(svg.style.width).toBe('');
  });

  it('ctrl/cmd+wheel zooms; a plain wheel is left to the page', () => {
    const { svg, scroller } = graph();
    const plain = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    scroller.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(svg.style.width).toBe('');
    const pinch = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    fireEvent(scroller, pinch);
    expect(pinch.defaultPrevented).toBe(true);
    expect(svg.style.width).not.toBe('');
  });

  it('+ / - / 0 zoom from the keyboard, but ctrl/cmd +/- stays the browser zoom', () => {
    const { svg, scroller, natural } = graph();
    fireEvent.keyDown(scroller, { key: '=', ctrlKey: true });
    expect(svg.style.width).toBe('');
    fireEvent.keyDown(scroller, { key: '+' });
    expect(svg.style.width).toBe(`${Math.round(natural * 1.25)}px`);
    fireEvent.keyDown(scroller, { key: '0' });
    expect(svg.style.width).toBe('');
  });

  it('full screen enters from the button and exits on Escape or the button', () => {
    const { card } = graph();
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(card.classList.contains('stg-card--max')).toBe(true);
    expect(card.classList.contains('stg-card--fill')).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(card.classList.contains('stg-card--max')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    expect(card.classList.contains('stg-card--max')).toBe(false);
  });

  it('clamps', () => {
    expect(clampGraphZoom(100)).toBe(GRAPH_ZOOM_MAX);
    expect(clampGraphZoom(0)).toBe(GRAPH_ZOOM_MIN);
  });
});
