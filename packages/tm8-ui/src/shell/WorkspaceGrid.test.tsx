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

function dataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: (type?: string) => (type ? values.delete(type) : values.clear()),
    getData: (type: string) => values.get(type) ?? '',
    setData: (type: string, value: string) => void values.set(type, value),
    setDragImage: () => undefined,
  } as DataTransfer;
}

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

describe('WorkspaceGrid panel docking', () => {
  it('moves either panel across the center by drag and drop', () => {
    const onMovePanel = vi.fn();
    const view = renderGrid({ onMovePanel });
    const transfer = dataTransfer();

    fireEvent.dragStart(view.getByRole('button', { name: /drag tasks panel/i }), {
      dataTransfer: transfer,
    });
    fireEvent.dragEnter(view.getByLabelText('Right panel'), { dataTransfer: transfer });
    expect(view.getByLabelText('Right panel').className).toContain('shell-ws__side--drop');
    fireEvent.drop(view.getByLabelText('Right panel'), { dataTransfer: transfer });

    expect(onMovePanel).toHaveBeenCalledWith('left', 'right');
  });

  it('offers a keyboard equivalent for moving panels', () => {
    const onMovePanel = vi.fn();
    const view = renderGrid({ onMovePanel });

    fireEvent.keyDown(view.getByRole('button', { name: /drag sessions panel/i }), {
      key: 'ArrowLeft',
    });

    expect(onMovePanel).toHaveBeenCalledWith('right', 'left');
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
