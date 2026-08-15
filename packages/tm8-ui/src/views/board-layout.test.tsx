// @vitest-environment jsdom
/**
 * THE BOARD IS THE WHOLE SCREEN, NOT A BODY INSIDE THE 320px RAIL.
 *
 * The defect (user report, 2026-08-07): the A2 board body shipped inside
 * `EntityListPanel`, and on a kind screen that panel is the LEFT RAIL — 320px
 * wide, holding columns with a 236px floor. One and a bit columns fit. The
 * board was correct and unreadable at the same time, while the centre beside
 * it showed the attention inbox.
 *
 * A unit test of the panel cannot see this: the panel renders the same columns
 * either way and knows nothing about the region it sits in. So this mounts the
 * COMPOSED app, walks to a kind screen and switches layout the way a user does
 * — the only place where "the board took the detail panel's width" is a fact
 * rather than a CSS opinion.
 *
 * The localStorage stub is last-place-gate.test.tsx's, for its reason:
 * gate.test.tsx's `window.localStorage.clear()` throws under this runner.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';

beforeEach(() => {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: store });
  resetNav();
  /* The URL is state now, and jsdom keeps ONE `window.location` per file. A
     case that navigates leaves its address behind and the next case boots from
     it, because an addressable hash at boot deliberately outranks last-place
     (R3) — so `resetNav()` alone stopped being a reset the day the router was
     mounted. Same class as the localStorage doubles these files already carry,
     one global later. */
  window.location.hash = '';
  screenStackStore.getState().clearAll();
});

async function openTasksScreen() {
  const view = render(<GateApp />);
  /* Revision 12: no-memory boots land on the merged Home; Tasks rides the
     Workspace caret ON THE WORK TAB — the rail is the active tab's contents. */
  await waitFor(() => view.getByTestId('home-page'));
  fireEvent.click(within(view.getByTestId('space-tab-bar')).getByRole('tab', { name: 'Workspace' }));
  const rail = within(view.getByTestId('menu-rail'));
  fireEvent.click(rail.getByLabelText('Expand Workspace'));
  fireEvent.click(rail.getByRole('button', { name: /^Tasks/ }));
  await waitFor(() => view.getByTestId('entity-view'));
  return view;
}

describe('the board layout', () => {
  it('replaces the three-region screen — the centre is not rendered behind it', async () => {
    const view = await openTasksScreen();

    // The control: list mode is three regions and the centre is mounted.
    expect(view.getByTestId('entity-view').dataset.layout).toBe('columns');
    expect(view.getByTestId('entity-view-detail')).toBeTruthy();

    fireEvent.click(within(view.getByTestId('view-switcher')).getByRole('button', { name: 'board layout' }));
    await waitFor(() => expect(view.getByTestId('entity-view').dataset.layout).toBe('board'));

    // NOT display:none. A hidden centre still mounts whatever entity is open —
    // its chat surface, its terminal, its polling — behind an invisible region.
    expect(view.queryByTestId('entity-view-detail')).toBeNull();
    expect(view.getByTestId('board-body')).toBeTruthy();

    view.unmount();
  });

  it('goes back to three regions when the switcher leaves the board', async () => {
    const view = await openTasksScreen();
    const switcher = () => within(view.getByTestId('view-switcher'));

    fireEvent.click(switcher().getByRole('button', { name: 'board layout' }));
    await waitFor(() => expect(view.queryByTestId('entity-view-detail')).toBeNull());

    fireEvent.click(switcher().getByRole('button', { name: 'list layout' }));
    await waitFor(() => view.getByTestId('entity-view-detail'));
    expect(view.getByTestId('entity-view').dataset.layout).toBe('columns');

    view.unmount();
  });
});
