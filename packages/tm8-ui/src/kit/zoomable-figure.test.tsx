// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ZoomableFigure, clampFigureZoom, FIGURE_ZOOM_MAX, FIGURE_ZOOM_MIN } from './ZoomableFigure';

/**
 * WHAT A JSDOM SUITE CAN HONESTLY SAY ABOUT THIS COMPONENT, AND WHAT IT CANNOT.
 *
 * jsdom has no layout and no cascade: every `getBoundingClientRect` here is
 * 0×0, no stylesheet is applied, and a transform is a string on a style
 * attribute rather than a thing that moves pixels. So this file asserts the
 * WIRING — that a control is connected to the state it claims, that the state
 * reaches the DOM as the attribute the stylesheet keys off, that Escape is
 * heard, that the clamp is arithmetic — and asserts NOTHING about size.
 *
 * "Is the expanded figure actually covering the viewport" and "does a zoomed
 * diagram get bigger" are browser questions and are answered in
 * `e2e/mermaid.spec.ts`, where a real engine measures a real mermaid SVG. The
 * split is deliberate: a jsdom assertion about either would pass for the wrong
 * reason and then be believed.
 */

const FIGURE = 'zoomable-figure';

function figure(label = 'Diagram') {
  return render(
    <ZoomableFigure label={label}>
      <svg data-testid="child-svg" viewBox="0 0 100 100" />
    </ZoomableFigure>,
  );
}

/** The canvas' inline transform, or null while the figure rests at fit. */
function transformOf(container: HTMLElement): string | null {
  const canvas = container.querySelector<HTMLElement>('.kit-zfig__canvas');
  const value = canvas?.style.transform ?? '';
  return value === '' ? null : value;
}

function scaleOf(container: HTMLElement): number {
  const match = /scale\(([-\d.]+)\)/.exec(transformOf(container) ?? '');
  return match ? Number(match[1]) : 1;
}

describe('clampFigureZoom', () => {
  it('holds every zoom inside the figure clamp', () => {
    expect(clampFigureZoom(1)).toBe(1);
    expect(clampFigureZoom(1000)).toBe(FIGURE_ZOOM_MAX);
    expect(clampFigureZoom(0.0001)).toBe(FIGURE_ZOOM_MIN);
    expect(clampFigureZoom(-4)).toBe(FIGURE_ZOOM_MIN);
  });

  it('magnifies well past fit, which the GraphView clamp would not', () => {
    // The whole complaint is a diagram squeezed into a column. A ceiling near
    // 1× (GraphView's 1.75, tuned for a canvas that starts at full size) would
    // answer it only barely — this is why the constants are not shared.
    expect(FIGURE_ZOOM_MAX).toBeGreaterThan(3);
    expect(FIGURE_ZOOM_MIN).toBeLessThanOrEqual(1);
  });
});

describe('ZoomableFigure — controls', () => {
  it('offers zoom in, zoom out, reset and expand, each with a real name', () => {
    const { getByRole } = figure();
    for (const name of ['Zoom in', 'Zoom out', 'Reset to fit', 'Expand to full screen']) {
      expect(getByRole('button', { name })).toBeTruthy();
    }
  });

  it('writes no transform at all until something is done to it', () => {
    // The resting state has to be byte-for-byte the old behaviour: no
    // transform means no containing block and no stacking context introduced
    // into a document column that never asked for one.
    const { container, getByTestId } = figure();
    expect(transformOf(container)).toBeNull();
    expect(getByTestId(FIGURE).dataset.interactive).toBe('false');
  });

  it('zoom in raises the scale and marks the figure interactive', () => {
    const { container, getByRole, getByTestId } = figure();
    fireEvent.click(getByRole('button', { name: 'Zoom in' }));
    expect(scaleOf(container)).toBeGreaterThan(1);
    // The attribute the stylesheet keys `overflow: hidden` and `touch-action`
    // off — panning by transform and native scrolling cannot both be live.
    expect(getByTestId(FIGURE).dataset.interactive).toBe('true');
  });

  it('zoom out lowers the scale', () => {
    const { container, getByRole } = figure();
    fireEvent.click(getByRole('button', { name: 'Zoom out' }));
    expect(scaleOf(container)).toBeLessThan(1);
  });

  it('never lets repeated presses drive the scale outside the clamp', () => {
    const { container, getByRole } = figure();
    for (let i = 0; i < 40; i += 1) fireEvent.click(getByRole('button', { name: 'Zoom in' }));
    expect(scaleOf(container)).toBe(FIGURE_ZOOM_MAX);
    for (let i = 0; i < 80; i += 1) fireEvent.click(getByRole('button', { name: 'Zoom out' }));
    expect(scaleOf(container)).toBe(FIGURE_ZOOM_MIN);
  });

  it('reset returns the figure to fit, transform and all', () => {
    const { container, getByRole, getByTestId } = figure();
    fireEvent.click(getByRole('button', { name: 'Zoom in' }));
    expect(transformOf(container)).not.toBeNull();
    fireEvent.click(getByRole('button', { name: 'Reset to fit' }));
    expect(transformOf(container)).toBeNull();
    expect(getByTestId(FIGURE).dataset.interactive).toBe('false');
  });

  it('the keyboard reaches zoom and fit without touching a button', () => {
    const { container, getByTestId } = figure();
    const viewport = getByTestId(`${FIGURE}-viewport`);
    fireEvent.keyDown(viewport, { key: '+' });
    expect(scaleOf(container)).toBeGreaterThan(1);
    fireEvent.keyDown(viewport, { key: '0' });
    expect(transformOf(container)).toBeNull();
  });
});

describe('ZoomableFigure — expanded', () => {
  it('is a toggle that says so, via aria-pressed and its own name', () => {
    const { getByRole } = figure();
    const expand = getByRole('button', { name: 'Expand to full screen' });
    expect(expand.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(expand);
    const exit = getByRole('button', { name: 'Exit full screen' });
    expect(exit.getAttribute('aria-pressed')).toBe('true');
  });

  it('leaves aria-pressed OFF the plain action buttons', () => {
    // An action button that announces a pressed state is announcing a state it
    // does not have — the reason IconBtn omits the attribute rather than
    // writing "false" into it.
    const { getByRole } = figure();
    expect(getByRole('button', { name: 'Zoom in' }).hasAttribute('aria-pressed')).toBe(false);
    expect(getByRole('button', { name: 'Reset to fit' }).hasAttribute('aria-pressed')).toBe(false);
  });

  it('expanding is a CSS state on the SAME element, not a remount', () => {
    const { getByRole, getByTestId } = figure();
    const root = getByTestId(FIGURE);
    const svgBefore = getByTestId('child-svg');

    fireEvent.click(getByRole('button', { name: 'Expand to full screen' }));

    // Same node, both of them: the whole reason fullscreen is CSS here is that
    // the injected mermaid SVG must not be re-rendered to be enlarged.
    expect(getByTestId(FIGURE)).toBe(root);
    expect(getByTestId('child-svg')).toBe(svgBefore);
    expect(root.classList.contains('kit-zfig--expanded')).toBe(true);
    expect(root.dataset.expanded).toBe('true');
  });

  it('Escape exits expanded, and does nothing when it is not', () => {
    const { getByRole, getByTestId } = figure();
    const root = getByTestId(FIGURE);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(root.dataset.expanded).toBe('false');

    fireEvent.click(getByRole('button', { name: 'Expand to full screen' }));
    expect(root.dataset.expanded).toBe('true');

    // On `window`, because pressing the control leaves focus on a button and a
    // reader who expanded with the mouse has focus nowhere near the figure.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(root.dataset.expanded).toBe('false');
  });

  it('keeps the figure interactive while expanded even at 1x', () => {
    const { getByRole, getByTestId } = figure();
    fireEvent.click(getByRole('button', { name: 'Expand to full screen' }));
    // At full screen the drawing can exceed the box at its natural size, so
    // dragging has to be armed before any zoom happens.
    expect(getByTestId(FIGURE).dataset.interactive).toBe('true');
  });
});

describe('ZoomableFigure — the trust boundary', () => {
  it('puts every control OUTSIDE the child subtree', () => {
    /**
     * The load-bearing assertion of the whole component. The first caller feeds
     * this `dangerouslySetInnerHTML` output from mermaid — viewer-authored
     * markup — so no handler this package owns may be attached inside it. If a
     * control ever moves into the canvas this fails, and it should.
     */
    const { container, getAllByRole } = render(
      <ZoomableFigure label="Diagram">
        <div data-testid="untrusted" dangerouslySetInnerHTML={{ __html: '<svg><g/></svg>' }} />
      </ZoomableFigure>,
    );
    const canvas = container.querySelector('.kit-zfig__canvas');
    expect(canvas).toBeTruthy();
    expect(canvas!.querySelectorAll('button')).toHaveLength(0);
    for (const button of getAllByRole('button')) {
      expect(canvas!.contains(button)).toBe(false);
    }
  });

  it('carries the host frame class alongside its own', () => {
    // The host keeps its border/padding/paper; this component only adds
    // behaviour and the expanded state.
    const { getByTestId } = render(
      <ZoomableFigure label="Diagram" className="md-mermaid" testId="mermaid">
        <svg />
      </ZoomableFigure>,
    );
    const root = getByTestId('mermaid');
    expect(root.classList.contains('kit-zfig')).toBe(true);
    expect(root.classList.contains('md-mermaid')).toBe(true);
  });

  it('passes the host its own data attributes through untouched', () => {
    const { getByTestId } = render(
      <ZoomableFigure label="Diagram" testId="mermaid" dataAttrs={{ 'data-phase': 'ok' }}>
        <svg />
      </ZoomableFigure>,
    );
    expect(getByTestId('mermaid').getAttribute('data-phase')).toBe('ok');
  });
});
