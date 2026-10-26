// @vitest-environment jsdom
/**
 * THE MERGED LEFT NAVIGATOR (design doc 01a1465d-a2b7, task 01a1469f-94a7):
 * the flag, the one column's parts, the pinned fold, ⌘\ and the collapsed
 * strip, All kinds, and the lower slot.
 *
 * WHAT THIS SUITE CANNOT SEE, stated rather than implied: jsdom has no layout,
 * so "300px, resizable 240–480" and "the 48px strip" are asserted as the
 * values the component HANDS the grid and the resizer, never as pixels. The
 * pixels are verified in the browser at 1440 and 390 and attached to the
 * close-out; a green here is not a claim about what the column looks like.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRailStore, NAV_COLLAPSED_KEY, NAV_PINS_FOLDED_KEY, railPinsKey, resetRailStores } from '../runtime/railStore';
import { createWorkspaceStore } from '../runtime/store';
import { WorkspaceProvider, type WorkspaceContextValue, type WorkspaceGateHandles } from './context';
import { Navigator } from './Navigator';
import { LEGACY_BROWSER_BOUNDS, NAVIGATOR_STORAGE_KEY, resolveNavigatorEnabled } from './navigatorFlag';
import { LAYOUT_BOUNDS } from '../runtime/types';

const SPACE = 'space-navigator-test';

function mount(slot: React.ReactNode = <div data-testid="slot-content">list</div>, props: { collapsedDefault?: boolean } = {}) {
  const store = createWorkspaceStore('viewer-1', SPACE);
  const dispatch = vi.fn(() => ({ ok: true }) as never);
  const gate = {
    shellTabs: [{ id: 'settings', label: 'Settings' }],
    openPalette: vi.fn(),
    onSelectViewTab: vi.fn(),
    navigateTo: vi.fn(),
    navigateView: vi.fn(),
    accountSlot: undefined,
    activeViewTabId: null,
  } as unknown as WorkspaceGateHandles;
  const value = { runtime: {} as never, store, dispatch, viewerId: 'viewer-1', spaceId: SPACE, gate } as WorkspaceContextValue;
  const view = render(
    <WorkspaceProvider value={value}>
      <Navigator slot={slot} {...props} />
    </WorkspaceProvider>,
  );
  return { view, store, dispatch, gate };
}

const pinRow = (kind: string) =>
  within(screen.getByTestId('tws-nav-pins')).getByRole('button', { name: new RegExp(`^${kind === 'task' ? 'Tasks' : kind}`) });

beforeEach(() => {
  window.localStorage.clear();
  resetRailStores();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the flag', () => {
  it('is OFF unless somebody opted in, from either source', () => {
    expect(resolveNavigatorEnabled({}, null)).toBe(false);
    expect(resolveNavigatorEnabled({ MODE: 'production' }, null)).toBe(false);
    expect(resolveNavigatorEnabled({}, '1')).toBe(true);
    expect(resolveNavigatorEnabled({}, '0')).toBe(false);
    expect(resolveNavigatorEnabled({ VITE_TM8_UI_NAVIGATOR: '1' }, null)).toBe(true);
    /* The env wins over the stored value, as the other two flags do. */
    expect(resolveNavigatorEnabled({ VITE_TM8_UI_NAVIGATOR: '0' }, '1')).toBe(false);
    expect(NAVIGATOR_STORAGE_KEY).toBe('tm8.ui.navigator');
  });

  it('keeps the OLD browser width with the flag off, and widens the clamp for both', () => {
    /* §11 risk 6: the contract clamp is the union so a 240 survives a read
       either way; the old column still starts at 320 and stops at 280. */
    expect(LAYOUT_BOUNDS.browserWidth).toEqual({ min: 240, max: 480, initial: 300 });
    expect(LEGACY_BROWSER_BOUNDS).toEqual({ min: 280, max: 480, initial: 320 });
  });
});

describe('the one column', () => {
  it('draws New, the default pins, All kinds, the slot and the footer', () => {
    mount();
    /* New names the kind the browser is ON (`DEFAULT_BROWSER_KIND`), which is
       the whole point of moving it out of the list toolbar: one place says
       what you are looking at and what ＋ will make. */
    expect(screen.getByTestId('tws-nav-new-create').getAttribute('aria-label')).toBe('New task');
    const pinned = Array.from(
      screen.getByTestId('tws-nav-pins').querySelectorAll<HTMLElement>('[data-kind]'),
    ).map((b) => b.dataset.kind);
    expect(pinned).toEqual(['chat', 'task', 'work_session', 'doc', 'artifact', 'team_member']);
    expect(screen.getByTestId('tws-nav-allkinds')).toBeTruthy();
    expect(within(screen.getByTestId('tws-nav-slot')).getByTestId('slot-content')).toBeTruthy();
    expect(screen.getByTestId('tws-nav-collapse')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Navigator' })).toBeTruthy();
  });

  it('a pin press shows that kind in the browser — the rail’s own routing', () => {
    const { dispatch } = mount();
    fireEvent.click(pinRow('task'));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'workspace.browser.set', args: { browserId: 'main', kind: 'task' } }),
    );
  });

  it('＋ New creates the current kind, and the ▾ offers the others', () => {
    const { dispatch } = mount();
    fireEvent.click(screen.getByTestId('tws-nav-new-create'));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'workspace.drafts.open', args: { kind: 'task' } }),
    );
    fireEvent.click(screen.getByTestId('tws-nav-new-kinds'));
    const menu = screen.getByTestId('tws-nav-new-menu');
    fireEvent.click(menu.querySelector<HTMLButtonElement>('[data-kind="doc"]')!);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'workspace.drafts.open', args: { kind: 'doc' } }),
    );
  });
});

describe('the pinned fold', () => {
  it('starts open, folds to icons, and the fold is remembered', () => {
    mount();
    expect(screen.getByTestId('tws-nav').getAttribute('data-folded')).toBeNull();
    fireEvent.click(screen.getByTestId('tws-nav-fold'));
    expect(screen.getByTestId('tws-nav').getAttribute('data-folded')).toBe('true');
    expect(getRailStore(SPACE).getState().pinsFolded).toBe(true);
    expect(window.localStorage.getItem(NAV_PINS_FOLDED_KEY)).toBe('true');
    /* Folded is not a one-way door: the strip carries its own way back. */
    fireEvent.click(screen.getByTestId('tws-nav-unfold'));
    expect(screen.getByTestId('tws-nav').getAttribute('data-folded')).toBeNull();
  });
});

describe('collapse', () => {
  it('⌘\\ collapses to the pin-only strip and back, and remembers', () => {
    mount();
    expect(screen.getByTestId('tws-nav-slot')).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: '\\', metaKey: true });
    });
    expect(screen.getByTestId('tws-nav').getAttribute('data-collapsed')).toBe('true');
    /* §4: the strip is pins only — the lower area is not drawn. */
    expect(screen.queryByTestId('tws-nav-slot')).toBeNull();
    expect(screen.getByTestId('tws-nav-pins')).toBeTruthy();
    expect(window.localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('true');
    act(() => {
      fireEvent.keyDown(window, { key: '\\', metaKey: true });
    });
    expect(screen.getByTestId('tws-nav').getAttribute('data-collapsed')).toBeNull();
  });

  it('the footer button does the same thing as the key', () => {
    mount();
    fireEvent.click(screen.getByTestId('tws-nav-collapse'));
    expect(getRailStore(SPACE).getState().collapsed).toBe(true);
  });

  it('a pin pressed while collapsed EXPANDS the column on that kind (§12 Q3)', () => {
    window.localStorage.setItem(NAV_COLLAPSED_KEY, 'true');
    const { dispatch } = mount();
    expect(screen.getByTestId('tws-nav').getAttribute('data-collapsed')).toBe('true');
    fireEvent.click(screen.getByTestId('tws-nav-pins').querySelector<HTMLButtonElement>('[data-kind="task"]')!);
    expect(getRailStore(SPACE).getState().collapsed).toBe(false);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'workspace.browser.set', args: { browserId: 'main', kind: 'task' } }),
    );
  });

  it('`collapsedDefault` only applies while nobody has chosen (Craft phase 1)', () => {
    const first = mount(<div />, { collapsedDefault: true });
    expect(screen.getByTestId('tws-nav').getAttribute('data-collapsed')).toBe('true');
    /* One ⌘\ writes a real boolean, and the default stops deciding. */
    act(() => {
      fireEvent.keyDown(window, { key: '\\', metaKey: true });
    });
    expect(getRailStore(SPACE).getState().collapsed).toBe(false);
    first.view.unmount();
    mount(<div />, { collapsedDefault: true });
    expect(screen.getByTestId('tws-nav').getAttribute('data-collapsed')).toBeNull();
  });
});

describe('All kinds', () => {
  it('lists every kind with a pin toggle, and a pick opens it', () => {
    const { dispatch } = mount();
    fireEvent.click(screen.getByTestId('tws-nav-allkinds'));
    const pop = screen.getByTestId('tws-nav-allkinds-pop');
    /* The whole population the rail's flat list used to draw — nothing became
       unreachable in the merge. */
    expect(pop.querySelector('[data-kind="commit"]')).not.toBeNull();
    expect(pop.querySelector('[data-kind="memory"]')).not.toBeNull();
    fireEvent.click(pop.querySelector<HTMLButtonElement>('[data-kind="story"]')!);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'workspace.browser.set', args: { browserId: 'main', kind: 'story' } }),
    );
  });

  it('the pin toggle is the visible way to pin — no 500ms hold needed', () => {
    mount();
    fireEvent.click(screen.getByTestId('tws-nav-allkinds'));
    const pop = screen.getByTestId('tws-nav-allkinds-pop');
    const pin = pop.querySelector<HTMLButtonElement>('[data-pin="story"]')!;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pin);
    expect(getRailStore(SPACE).getState().pins).toContain('story');
    expect(JSON.parse(window.localStorage.getItem(railPinsKey(SPACE))!)).toContain('story');
  });
});
