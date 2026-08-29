// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceLayout } from './geometry';
import { WorkspaceGrid } from './WorkspaceGrid';

const layout: WorkspaceLayout = {
  serverRail: 0,
  menu: 220,
  left: 240,
  right: 319,
  center: 1000,
  centerMin: 320,
  stackMode: 'columns',
  belowFloors: false,
};

function renderGrid(overrides: Partial<React.ComponentProps<typeof WorkspaceGrid>> = {}) {
  return render(
    <WorkspaceGrid
      layout={layout}
      left={<div>Tasks content</div>}
      center={<div>Center content</div>}
      right={<div>Sessions content</div>}
      leftLabel="Tasks"
      rightLabel="Sessions"
      {...overrides}
    />,
  );
}

describe('WorkspaceGrid side panels', () => {
  /* The dock grip is gone (task 01a01a3c). It was a 14px unlabelled strip above
     every panel's own header whose entire function was swapping the two docks —
     the only affordance in the workspace that cost vertical space on both
     columns to serve a binary toggle nobody could name. A panel's first row is
     now its own header. */
  it('gives a panel no chrome above its content', () => {
    const view = renderGrid();
    const left = view.getByLabelText('Left panel');

    expect(left.querySelector('.shell-ws__dock-grip')).toBeNull();
    expect(left.firstElementChild?.className).toBe('shell-ws__side-content');
  });
});

describe('WorkspaceGrid panel resizing', () => {
  it('resizes left and right panels from their adjacent tracks', () => {
    const onResizePanel = vi.fn();
    const view = renderGrid({ onResizePanel });
    const left = view.getByRole('separator', { name: 'Resize Tasks panel' });
    const right = view.getByRole('separator', { name: 'Resize Sessions panel' });

    fireEvent.pointerDown(left, { button: 0, pointerId: 1, clientX: 240 });
    fireEvent.pointerMove(left, { pointerId: 1, clientX: 300 });
    fireEvent.pointerUp(left, { pointerId: 1, clientX: 300 });
    expect(onResizePanel).toHaveBeenCalledWith('left', 300);

    fireEvent.pointerDown(right, { button: 0, pointerId: 2, clientX: 700 });
    fireEvent.pointerMove(right, { pointerId: 2, clientX: 660 });
    fireEvent.pointerUp(right, { pointerId: 2, clientX: 660 });
    expect(onResizePanel).toHaveBeenCalledWith('right', 359);
  });

  it('supports arrow-key resizing and double-click reset', () => {
    const onResizePanel = vi.fn();
    const onResetPanelWidth = vi.fn();
    const view = renderGrid({ onResizePanel, onResetPanelWidth });
    const right = view.getByRole('separator', { name: 'Resize Sessions panel' });

    fireEvent.keyDown(right, { key: 'ArrowLeft' });
    expect(onResizePanel).toHaveBeenCalledWith('right', 335);

    fireEvent.doubleClick(right);
    expect(onResetPanelWidth).toHaveBeenCalledWith('right');
  });
});
