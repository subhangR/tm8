// @vitest-environment jsdom
/**
 * PanelResizer — the primitive itself, at the level the screens cannot test.
 *
 * `views/panel-resize.test.tsx` mounts the composed app and asserts what a
 * viewer gets; it deliberately drives the KEYBOARD, because jsdom reports every
 * element as 0×0 and a pointer path there would be arithmetic against a
 * viewport that does not exist. That leaves two facts unproven, and both are
 * where a resizer usually breaks:
 *
 *   1. THE SIGN. A drag to the right widens a LEFT panel and narrows a RIGHT
 *      one. Getting this backwards produces a control that works perfectly on
 *      one side of the screen and inverts on the other.
 *   2. THE DRAG ORIGIN. Movement is measured from where the pointer went DOWN,
 *      not from the last move event. Accumulating deltas instead makes a slow
 *      drag and a fast one over the same distance land in different places.
 *
 * Pointer events are dispatched directly here, with the coordinates supplied —
 * no layout is consulted, so jsdom's missing box model is not in the way.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { PanelResizer } from './PanelResizer';

const setup = (side: 'left' | 'right', onResize = vi.fn()) => {
  const view = render(
    <div className="cv2-root">
      <PanelResizer
        side={side}
        label="Details"
        width={400}
        minWidth={320}
        maxWidth={600}
        onResize={onResize}
      />
    </div>,
  );
  return { view, onResize, handle: view.getByTestId(`panel-resizer-${side}`) };
};

describe('PanelResizer', () => {
  it('drags a LEFT panel wider to the right and a RIGHT panel narrower', () => {
    const left = setup('left');
    fireEvent.pointerDown(left.handle, { button: 0, pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(left.handle, { pointerId: 1, clientX: 560 });
    expect(left.onResize).toHaveBeenLastCalledWith(460);

    const right = setup('right');
    fireEvent.pointerDown(right.handle, { button: 0, pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(right.handle, { pointerId: 1, clientX: 560 });
    expect(right.onResize).toHaveBeenLastCalledWith(340);
  });

  it('measures every move from where the drag STARTED, not from the last move', () => {
    const { handle, onResize } = setup('left');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 520 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 540 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 560 });
    // 400 + (560 - 500), not 400 + 20 + 20 + 20 measured from each other.
    expect(onResize).toHaveBeenLastCalledWith(460);
  });

  it('clamps to the floor and the ceiling — a drag can never zero a column', () => {
    const { handle, onResize } = setup('left');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });
    expect(onResize).toHaveBeenLastCalledWith(320);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 5000 });
    expect(onResize).toHaveBeenLastCalledWith(600);
  });

  it('ignores moves once the pointer is up, and moves from other pointers', () => {
    const { handle, onResize } = setup('left');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 });
    // A second finger mid-drag must not hijack the gesture.
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 900 });
    expect(onResize).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('refuses when disabled — and says so rather than going silently dead (L6)', () => {
    const onResize = vi.fn();
    const view = render(
      <div className="cv2-root">
        <PanelResizer
          side="left"
          label="Details"
          width={400}
          minWidth={320}
          maxWidth={600}
          disabled
          onResize={onResize}
        />
      </div>,
    );
    const handle = view.getByTestId('panel-resizer-left');
    expect(handle.getAttribute('aria-disabled')).toBe('true');
    // Out of the tab order, so it cannot be focused into a control that does
    // nothing — the separator is still THERE, which is the point.
    expect(handle.getAttribute('tabindex')).toBe('-1');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('carries the ARIA window-splitter contract, values included', () => {
    const { handle } = setup('right');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-label')).toBe('Resize Details panel');
    expect(handle.getAttribute('aria-valuenow')).toBe('400');
    expect(handle.getAttribute('aria-valuemin')).toBe('320');
    expect(handle.getAttribute('aria-valuemax')).toBe('600');
  });
});
