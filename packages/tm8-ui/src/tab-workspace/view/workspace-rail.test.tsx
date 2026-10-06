// @vitest-environment jsdom
/**
 * The Workspace icon rail (task 01a1112a-c568): hold-to-pin vs click, pinned
 * kinds moved out of the list, the kinds/tools faces, the flat kind list (no groups), the persisted expanded
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

function mount(gateOverrides: Partial<WorkspaceGateHandles> = {}) {
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
    navigateTo: vi.fn(),
    accountSlot: undefined,
    activeViewTabId: null,
    ...gateOverrides,
  } as unknown as WorkspaceGateHandles;
  const value = { runtime: {} as never, store, dispatch, viewerId: 'viewer-1', spaceId: SPACE, gate } as WorkspaceContextValue;
  const view = render(
    <WorkspaceProvider value={value}>
      <WorkspaceRail />
    </WorkspaceProvider>,
  );
  return { view, store, dispatch, gate };
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
    const [moved] = kindButtons('project');
    fireEvent.keyDown(moved!, { key: 'Enter' });
    fireEvent.keyUp(moved!, { key: 'Enter' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('pinned section', () => {
  it('a pinned kind moves to Pinned and leaves the list', () => {
    mount();
    const pinned = within(screen.getByTestId('tws-rail-pinned'));
    expect(pinned.getByRole('button', { name: /^Tasks/ })).toBeTruthy();
    const tasks = kindButtons('task');
    expect(tasks.map((b) => b.dataset.placement)).toEqual(['pinned']);
    expect(tasks[0]!.getAttribute('aria-current')).toBe('true');
  });

  it('pinning moves the kind up; unpinning puts it at the top of the list, newest first', () => {
    vi.useFakeTimers();
    mount();
    const hold = (button: HTMLButtonElement) => {
      fireEvent.pointerDown(button, { button: 0, clientX: 10, clientY: 10 });
      act(() => vi.advanceTimersByTime(HOLD_MS));
      fireEvent.pointerUp(button);
    };
    const listOrder = () =>
      Array.from(screen.getByTestId('tws-rail-kinds').querySelectorAll<HTMLElement>('[data-kind]')).map((b) => b.dataset.kind);
    const before = listOrder();
    hold(kindButtons('project')[0]!);
    expect(kindButtons('project').map((b) => b.dataset.placement)).toEqual(['pinned']);
    expect(listOrder()).toEqual(before.filter((k) => k !== 'project'));
    hold(kindButtons('project')[0]!);
    expect(kindButtons('project').map((b) => b.dataset.placement)).toEqual(['list']);
    expect(listOrder()).toEqual(['project', ...before.filter((k) => k !== 'project')]);
    hold(kindButtons('task')[0]!);
    expect(listOrder().slice(0, 2)).toEqual(['task', 'project']);
    expect(getRailStore(SPACE).getState().lifted).toEqual(['task', 'project']);
    resetRailStores();
    expect(getRailStore(SPACE).getState().lifted).toEqual(['task', 'project']);
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
    const pins = getRailStore(SPACE).getState().pins;
    expect(kinds).toEqual(homeRootKinds().map((config) => config.kind).filter((k) => isWorkspaceKind(k) && !pins.includes(k)));
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
    fireEvent.click(screen.getByTestId('tws-rail-switch'));
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

describe('the two faces', () => {
  it('opens on the kinds with one switch at the bottom; the switch swaps in the tools', () => {
    const { gate } = mount();
    expect(screen.getByTestId('tws-rail-kinds')).toBeTruthy();
    expect(screen.queryByTestId('tws-rail-tools')).toBeNull();
    expect(document.querySelector('[data-rail-tool]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Command palette' })).toBeNull();
    const toggle = screen.getByTestId('tws-rail-switch');
    expect(toggle.getAttribute('aria-label')).toBe('Settings & tools');
    fireEvent.click(toggle);
    expect(screen.getByTestId('tws-rail').dataset.railMode).toBe('tools');
    expect(screen.queryByTestId('tws-rail-kinds')).toBeNull();
    const tools = screen.getByTestId('tws-rail-tools');
    const ids = Array.from(tools.querySelectorAll<HTMLElement>('[data-rail-tool]')).map((b) => b.dataset.railTool);
    expect(ids).toEqual(['inbox', 'messages', 'files', 'git', 'craft', 'settings', 'help']);
    fireEvent.click(within(tools).getByRole('button', { name: 'Inbox' }));
    expect(gate.navigateTo).toHaveBeenCalledWith({ type: 'view', ref: 'inbox' });
    fireEvent.click(within(tools).getByRole('button', { name: 'Settings' }));
    expect(gate.onSelectViewTab).toHaveBeenCalledWith('settings');
    fireEvent.click(screen.getByRole('button', { name: 'Back to kinds' }));
    expect(screen.getByTestId('tws-rail-kinds')).toBeTruthy();
  });

  it('marks the screen the shell shows as current, and the closed switch with it', () => {
    mount({ activeViewTabId: 'settings', activeScreenRef: 'settings' });
    const toggle = screen.getByTestId('tws-rail-switch');
    expect(toggle.getAttribute('aria-current')).toBe('page');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-current')).toBeNull();
    const current = document.querySelectorAll('[data-rail-tool][aria-current="page"]');
    expect(Array.from(current).map((b) => (b as HTMLElement).dataset.railTool)).toEqual(['settings']);
  });

  it('a Messages screen marks Messages, not a shell tab', () => {
    mount({ activeScreenRef: 'messages' });
    fireEvent.click(screen.getByTestId('tws-rail-switch'));
    const current = document.querySelectorAll('[data-rail-tool][aria-current="page"]');
    expect(Array.from(current).map((b) => (b as HTMLElement).dataset.railTool)).toEqual(['messages']);
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
