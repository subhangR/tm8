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
import { act, fireEvent, render } from '@testing-library/react';
import { PanelResizer, usePanelHeight, usePanelWidth } from './PanelResizer';

const setup = (
  side: 'left' | 'right' | 'top' | 'bottom',
  onResize = vi.fn(),
  extra: { onBeyondFloor?: () => void } = {},
) => {
  const view = render(
    <div className="cv2-root">
      <PanelResizer
        side={side}
        label="Details"
        width={400}
        minWidth={320}
        maxWidth={600}
        onResize={onResize}
        {...extra}
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

/**
 * THE SECOND AXIS (2026-08-31). Home's dashboard split flips between side by
 * side and stacked, so one handle has to serve both gestures — extended here
 * rather than twinned, for the reason this file's subject exists at all.
 *
 * These cases mirror the x-axis ones one for one, because the failure modes are
 * the same failure modes: the SIGN inverts between `top` and `bottom` exactly
 * as it does between `left` and `right`, and a y drag that read `clientX` would
 * be a control that simply does not move — the loudest possible bug and, in
 * jsdom, an invisible one, since nothing here consults layout.
 */
describe('PanelResizer, the up-and-down axis', () => {
  it('drags a TOP panel taller downward and a BOTTOM panel shorter', () => {
    const top = setup('top');
    fireEvent.pointerDown(top.handle, { button: 0, pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(top.handle, { pointerId: 1, clientY: 560 });
    expect(top.onResize).toHaveBeenLastCalledWith(460);

    const bottom = setup('bottom');
    fireEvent.pointerDown(bottom.handle, { button: 0, pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(bottom.handle, { pointerId: 1, clientY: 560 });
    expect(bottom.onResize).toHaveBeenLastCalledWith(340);
  });

  it('measures the Y coordinate, not the X — a handle that reads the wrong axis never moves', () => {
    const { handle, onResize } = setup('top');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500, clientY: 500 });
    /* The pointer travels sideways only. A y-axis handle must ignore it. */
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900, clientY: 500 });
    expect(onResize).toHaveBeenLastCalledWith(400);
  });

  it('clamps to the floor and the ceiling on this axis too', () => {
    const { handle, onResize } = setup('top');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 0 });
    expect(onResize).toHaveBeenLastCalledWith(320);
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 5000 });
    expect(onResize).toHaveBeenLastCalledWith(600);
  });

  it('answers to the arrows of ITS axis, and to no others', () => {
    const { handle, onResize } = setup('top');
    /* Up/Down step. A y handle bound to Left/Right would be a keyboard path
       that contradicts the pointer one. */
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(onResize).toHaveBeenLastCalledWith(416);
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(onResize).toHaveBeenLastCalledWith(384);

    onResize.mockClear();
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('announces itself as a HORIZONTAL separator — the opposite word to its axis', () => {
    /* A separator that slides up and down is a horizontal rule between two
       rows. Reading it the other way round announces every splitter as the
       wrong shape, and it is the most common mistake in this pattern. */
    expect(setup('top').handle.getAttribute('aria-orientation')).toBe('horizontal');
    expect(setup('bottom').handle.getAttribute('aria-orientation')).toBe('horizontal');
    expect(setup('left').handle.getAttribute('aria-orientation')).toBe('vertical');
  });

  it('keeps reset on both axes — double-click and Backspace', () => {
    const onReset = vi.fn();
    const view = render(
      <div className="cv2-root">
        <PanelResizer
          side="top"
          label="Details"
          width={400}
          minWidth={320}
          maxWidth={600}
          onResize={vi.fn()}
          onReset={onReset}
        />
      </div>,
    );
    const handle = view.getByTestId('panel-resizer-top');
    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(handle, { key: 'Backspace' });
    expect(onReset).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(handle, { key: 'Delete' });
    expect(onReset).toHaveBeenCalledTimes(3);
  });
});

/**
 * PAST THE FLOOR — the collapse report, and why it is not just a smaller floor.
 *
 * `onResize` may never see a value below `minWidth`; that is the floor law and
 * it is what stops a drag zeroing a column. But a splitter that CLOSES when you
 * keep dragging is a real gesture (Home's ACTIVE pane, band 3), and it cannot
 * be expressed by lowering the floor: `aria-valuemin` would then announce a
 * width the panel never takes.
 */
describe('PanelResizer past its floor', () => {
  it('reports a request well past the floor instead of clamping — and only well past it', () => {
    const onResize = vi.fn();
    const onBeyondFloor = vi.fn();
    const { handle } = setup('left', onResize, { onBeyondFloor });

    /* AT the floor: still a resize. A pointer resting on the floor must not
       close a panel out from under a reader. */
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 420 }); // asks for 320
    expect(onResize).toHaveBeenLastCalledWith(320);
    expect(onBeyondFloor).not.toHaveBeenCalled();

    /* A shove: 260 requested against a 320 floor, past the slack. */
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 360 });
    expect(onBeyondFloor).toHaveBeenCalled();
  });

  it('still clamps when no caller asked for the report — the four older mounts are untouched', () => {
    const { handle, onResize } = setup('left');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });
    expect(onResize).toHaveBeenLastCalledWith(320);
  });

  it('keeps aria-valuemin honest at the real floor, not at the collapse point', () => {
    const { handle } = setup('left', vi.fn(), { onBeyondFloor: vi.fn() });
    expect(handle.getAttribute('aria-valuemin')).toBe('320');
  });
});

/**
 * ONE KEY, TWO AXES, TWO REMEMBERED NUMBERS.
 *
 * Home's splitter asks `home.side` for an extent in both arrangements, and the
 * two have nothing to do with each other: 480px is a reasonable WIDTH for that
 * pane and a preposterous HEIGHT for it. A single slot per key would hand the
 * stacked arrangement the number the reader chose for side by side and then
 * overwrite it on the first drag — the same class of failure `useKeyedState`
 * exists for, one axis over.
 */
describe('usePanelWidth and usePanelHeight share a key without sharing a slot', () => {
  function Probe() {
    const w = usePanelWidth('home.side', 480, 240);
    const h = usePanelHeight('home.side', 300, 200);
    return (
      <div>
        <span data-testid="w">{w.width}</span>
        <span data-testid="h">{h.height}</span>
        <button type="button" data-testid="setw" onClick={() => w.setWidth(520)}>w</button>
        <button type="button" data-testid="seth" onClick={() => h.setHeight(360)}>h</button>
      </div>
    );
  }

  it('remembers each axis separately, and neither write disturbs the other', () => {
    window.localStorage.clear();
    const first = render(<Probe />);
    expect(first.getByTestId('w').textContent).toBe('480');
    expect(first.getByTestId('h').textContent).toBe('300');

    act(() => fireEvent.click(first.getByTestId('setw')));
    expect(first.getByTestId('w').textContent).toBe('520');
    /* THE HEIGHT DID NOT MOVE. With one slot it would now read 520 — a pane
       520px tall because someone widened it. */
    expect(first.getByTestId('h').textContent).toBe('300');

    act(() => fireEvent.click(first.getByTestId('seth')));
    expect(first.getByTestId('h').textContent).toBe('360');
    expect(first.getByTestId('w').textContent).toBe('520');
    first.unmount();

    /* Both survive a remount, from their own storage slots. */
    const second = render(<Probe />);
    expect(second.getByTestId('w').textContent).toBe('520');
    expect(second.getByTestId('h').textContent).toBe('360');
    second.unmount();
  });

  it('floors what comes back out of storage, per axis', () => {
    window.localStorage.clear();
    window.localStorage.setItem('tm8ui.panel-width.home.side', '12');
    window.localStorage.setItem('tm8ui.panel-height.home.side', '9');
    const view = render(<Probe />);
    expect(view.getByTestId('w').textContent).toBe('240');
    expect(view.getByTestId('h').textContent).toBe('200');
    view.unmount();
  });
});
