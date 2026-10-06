// @vitest-environment jsdom
/**
 * The Workspace icon rail (task 01a1112a-c568): hold-to-pin vs click, pinned
 * kinds drawn twice, the flat kind list (no groups), the persisted expanded
 * flag, and the separation from Home's pins.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homeRootKinds } from '../../domain';
import { loadRailPins } from '../../stores/homeRailStore';
import { getRailStore, RAIL_EXPANDED_KEY, railPinsKey, resetRailStores } from '../runtime/railStore';
import { createWorkspaceStore } from '../runtime/store';
import { isWorkspaceKind } from '../runtime/types';
import { WorkspaceProvider, type WorkspaceContextValue, type WorkspaceGateHandles } from './context';
import { HOLD_MS, WorkspaceRail } from './WorkspaceRail';

const SPACE = 'space-rail-test';

function mount() {
  const store = createWorkspaceStore('viewer-1', SPACE);
  const dispatch = vi.fn(() => ({ ok: true }) as never);
  const gate = {
    shellTabs: [
      { id: 'craft', label: 'Craft' },
      { id: 'settings', label: 'Settings' },
      { id: 'help', label: 'Help' },
    ],
    openPalette: vi.fn(),
    onSelectViewTab: vi.fn(),
    accountSlot: undefined,
  } as unknown as WorkspaceGateHandles;
  const value = { runtime: {} as never, store, dispatch, viewerId: 'viewer-1', spaceId: SPACE, gate } as WorkspaceContextValue;
  const view = render(
    <WorkspaceProvider value={value}>
      <WorkspaceRail />
    </WorkspaceProvider>,
  );
  return { view, store, dispatch };
}

const kindButtons = (kind: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(`button[data-kind="${kind}"]`));

beforeEach(() => {
  window.localStorage.clear();
  resetRailStores();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('hold to pin', () => {
  it('a press shorter than the hold is a click', () => {
    vi.useFakeTimers();
    const { dispatch } = mount();
    const [task] = kindButtons('task').filter((b) => b.dataset.placement === 'pinned');
    fireEvent.pointerDown(task!, { button: 0, clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(HOLD_MS - 100));
    fireEvent.pointerUp(task!);
    fireEvent.click(task!);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'workspace.browser.set', args: { browserId: 'main', kind: 'task' } }),
    );
    expect(getRailStore(SPACE).getState().pins).toContain('task');
  });

  it('a full hold toggles the pin and swallows the release click', () => {
    vi.useFakeTimers();
    const { dispatch } = mount();
    const [project] = kindButtons('project');
    expect(getRailStore(SPACE).getState().pins).not.toContain('project');
    fireEvent.pointerDown(project!, { button: 0, clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(HOLD_MS));
    fireEvent.pointerUp(project!);
    fireEvent.click(project!);
    expect(dispatch).not.toHaveBeenCalled();
    expect(getRailStore(SPACE).getState().pins).toContain('project');
    expect(screen.getByTestId('tws-rail-live').textContent).toBe('Pinned Projects');
    expect(JSON.parse(window.localStorage.getItem(railPinsKey(SPACE))!)).toContain('project');
  });

  it('moving past the slop cancels the hold', () => {
    vi.useFakeTimers();
    mount();
    const [project] = kindButtons('project');
    fireEvent.pointerDown(project!, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(project!, { clientX: 20, clientY: 10 });
    act(() => vi.advanceTimersByTime(HOLD_MS + 50));
    expect(getRailStore(SPACE).getState().pins).not.toContain('project');
  });

  it('holding Enter pins without clicking; a short Enter clicks', () => {
    vi.useFakeTimers();
    const { dispatch } = mount();
    const [project] = kindButtons('project');
    fireEvent.keyDown(project!, { key: 'Enter' });
    act(() => vi.advanceTimersByTime(HOLD_MS));
    fireEvent.keyUp(project!, { key: 'Enter' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(getRailStore(SPACE).getState().pins).toContain('project');
    fireEvent.keyDown(project!, { key: 'Enter' });
    fireEvent.keyUp(project!, { key: 'Enter' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('pinned section', () => {
  it('a pinned kind appears in Pinned and in the list, both current', () => {
    mount();
    const pinned = within(screen.getByTestId('tws-rail-pinned'));
    expect(pinned.getByRole('button', { name: 'Tasks' })).toBeTruthy();
    const tasks = kindButtons('task');
    expect(tasks.map((b) => b.dataset.placement).sort()).toEqual(['list', 'pinned']);
    expect(tasks.every((b) => b.getAttribute('aria-current') === 'true')).toBe(true);
  });

  it('an empty stored list pins nothing and hides the section', () => {
    window.localStorage.setItem(railPinsKey(SPACE), '[]');
    mount();
    expect(screen.queryByTestId('tws-rail-pinned')).toBeNull();
  });
});

describe('the kind list', () => {
  it('draws every kind flat, in the Home rail order — no group headings, nothing to expand', () => {
    mount();
    const list = screen.getByTestId('tws-rail-kinds');
    const kinds = Array.from(list.querySelectorAll<HTMLElement>('[data-kind]')).map((b) => b.dataset.kind);
    expect(kinds).toEqual(homeRootKinds().map((config) => config.kind).filter(isWorkspaceKind));
    expect(kinds).toContain('doc');
    for (const label of ['Work', 'Library', 'Agents & People', 'Code']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    expect(screen.getByTestId('tws-rail').querySelector('[aria-expanded]')).toBeNull();
  });
});

describe('expand', () => {
  it('the expanded flag toggles from the button and ⌘\\, and persists', () => {
    mount();
    const toggle = screen.getByTestId('tws-rail-expand');
    expect(toggle.getAttribute('aria-label')).toBe('Expand sidebar');
    fireEvent.click(toggle);
    expect(screen.getByTestId('tws-rail').hasAttribute('data-rail-expanded')).toBe(true);
    expect(window.localStorage.getItem(RAIL_EXPANDED_KEY)).toBe('true');
    fireEvent.keyDown(window, { key: '\\', metaKey: true });
    expect(window.localStorage.getItem(RAIL_EXPANDED_KEY)).toBe('false');
    fireEvent.keyDown(window, { key: '\\', metaKey: true });
    cleanup();
    resetRailStores();
    expect(getRailStore(SPACE).getState().expanded).toBe(true);
  });
});

describe('separation from Home', () => {
  it('Workspace pins never touch Home pins', () => {
    const homeBefore = loadRailPins(SPACE);
    getRailStore(SPACE).getState().togglePin('doc');
    expect(window.localStorage.getItem(`tm8.home.rail-pins:${SPACE}`)).toBeNull();
    expect(loadRailPins(SPACE)).toEqual(homeBefore);
  });
});
