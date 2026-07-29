// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSidePanelKinds } from './useSidePanelKinds';

const SPACE = 'space-workspace-panels' as never;
const KEY = `tm8ui.sidePanel.viewer.${SPACE}`;
const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } satisfies Storage;
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
});

const options = {
  viewerId: 'viewer',
  spaceId: SPACE,
  defaultLeft: 'task',
  defaultRight: 'work_session',
};

describe('useSidePanelKinds workspace layout persistence', () => {
  it('moves panel kind and width together, then restores them', async () => {
    const first = renderHook(() => useSidePanelKinds(options));

    act(() => first.result.current.resizePanel('left', 300));
    act(() => first.result.current.resizePanel('right', 420));
    act(() => first.result.current.movePanel('left', 'right'));

    expect(first.result.current.leftKind).toBe('work_session');
    expect(first.result.current.leftWidth).toBe(420);
    expect(first.result.current.rightKind).toBe('task');
    expect(first.result.current.rightWidth).toBe(300);
    expect(JSON.parse(values.get(KEY) ?? '{}')).toMatchObject({
      left: 'work_session',
      leftWidth: 420,
      right: 'task',
      rightWidth: 300,
    });

    first.unmount();
    const restored = renderHook(() => useSidePanelKinds(options));
    await waitFor(() => expect(restored.result.current.leftKind).toBe('work_session'));
    expect(restored.result.current.leftWidth).toBe(420);
    expect(restored.result.current.rightKind).toBe('task');
    expect(restored.result.current.rightWidth).toBe(300);
  });

  it('resets each dock to its geometry default', () => {
    const view = renderHook(() => useSidePanelKinds(options));

    act(() => view.result.current.resizePanel('left', 444));
    act(() => view.result.current.resetPanelWidth('left'));
    act(() => view.result.current.resizePanel('right', 555));
    act(() => view.result.current.resetPanelWidth('right'));

    expect(view.result.current.leftWidth).toBe(240);
    expect(view.result.current.rightWidth).toBe(319);
  });
});
