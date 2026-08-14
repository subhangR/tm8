// @vitest-environment jsdom
/**
 * THE DETAIL SCREENS RESIZE THE WAY THE WORKSPACE DOES (user report, 2026-08-14).
 *
 * The defect was a MISMATCH, not an absence. `WorkspaceGrid` shipped a
 * draggable separator on both side columns; the entity detail screens — the
 * screen every kind opens — shipped 320/420 literals with a media-query ladder
 * stepping them down. One surface answered the gesture, an identically-shaped
 * one beside it ignored it, which reads from outside as a broken control rather
 * than as a missing feature.
 *
 * WHY THIS MOUNTS THE COMPOSED APP. The interesting facts are all about the
 * REGION a panel sits in: that the rail's width is the one the viewer set, that
 * collapsing it leaves a way back, that the aux column's floor is respected.
 * A unit test of `PanelResizer` cannot see any of them — it would only prove
 * that a callback fires. So this walks to a kind screen the way a person does.
 *
 * The localStorage stub is board-layout.test.tsx's, for its reason: it is also
 * what makes the PERSISTENCE assertions here readable, since the widths are
 * written through exactly this object.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { EV_LIST_DEFAULT, EV_LIST_MIN } from './EntityView';

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
  screenStackStore.getState().clearAll();
});

async function openTasksScreen() {
  const view = render(<GateApp />);
  await waitFor(() => view.getByTestId('workspace-grid'));
  fireEvent.click(within(view.getByTestId('menu-rail')).getByRole('button', { name: /^Tasks/ }));
  await waitFor(() => view.getByTestId('entity-view'));
  return view;
}

const listWidthOf = (view: { getByTestId(id: string): HTMLElement }) =>
  view.getByTestId('entity-view').style.getPropertyValue('--ev-list');

describe('the entity detail screen resizes its panels', () => {
  it('gives the list rail a separator that moves it, and remembers where', async () => {
    const view = await openTasksScreen();
    expect(listWidthOf(view)).toBe(`${EV_LIST_DEFAULT}px`);

    // KEYBOARD, not a synthetic pointer drag. jsdom reports every element as
    // 0×0, so a pointer path would be asserting arithmetic against a viewport
    // that does not exist; the arrow keys exercise the same clamp through the
    // same callback, and they are the half of the control a pointer-only test
    // would never have covered at all.
    const separator = view.getByTestId('panel-resizer-left');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    await waitFor(() => expect(listWidthOf(view)).toBe(`${EV_LIST_DEFAULT + 16}px`));

    // Persisted, per kind — a width is a reading preference, not session state.
    expect(window.localStorage.getItem('tm8ui.panel-width.entity.task.list'))
      .toBe(String(EV_LIST_DEFAULT + 16));

    view.unmount();
  });

  it('refuses to drag the rail below its floor, and says so through ARIA', async () => {
    const view = await openTasksScreen();
    const separator = view.getByTestId('panel-resizer-left');
    expect(separator.getAttribute('aria-valuemin')).toBe(String(EV_LIST_MIN));
    expect(separator.getAttribute('aria-valuenow')).toBe(String(EV_LIST_DEFAULT));

    // Home is "as narrow as this column is allowed to be" — the floor, never 0.
    fireEvent.keyDown(separator, { key: 'Home' });
    await waitFor(() => expect(listWidthOf(view)).toBe(`${EV_LIST_MIN}px`));

    // And there is nothing below it: more arrows do not push past the floor.
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(listWidthOf(view)).toBe(`${EV_LIST_MIN}px`);

    view.unmount();
  });

  it('resets to the shipped width on double-click', async () => {
    const view = await openTasksScreen();
    const separator = view.getByTestId('panel-resizer-left');

    fireEvent.keyDown(separator, { key: 'Home' });
    await waitFor(() => expect(listWidthOf(view)).toBe(`${EV_LIST_MIN}px`));

    fireEvent.doubleClick(separator);
    await waitFor(() => expect(listWidthOf(view)).toBe(`${EV_LIST_DEFAULT}px`));

    view.unmount();
  });
});

describe('the entity detail screen collapses its list rail', () => {
  it('collapses to a strip that can reopen it — never to nothing', async () => {
    const view = await openTasksScreen();

    fireEvent.click(view.getByTestId('entity-view-list-collapse'));
    await waitFor(() => view.getByTestId('entity-view-list-expand'));

    // L6: the rail is GONE from the layout but its way back is on screen. A
    // collapse with no visible affordance is a panel the viewer has lost.
    expect(view.getByTestId('entity-view').dataset.listCollapsed).toBe('true');
    expect(view.queryByTestId('entity-view-list-collapse')).toBeNull();

    // The separator stays MOUNTED and refuses, rather than vanishing from under
    // the cursor mid-gesture.
    expect(view.getByTestId('panel-resizer-left').getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(view.getByTestId('entity-view-list-expand'));
    await waitFor(() => view.getByTestId('entity-view-list-collapse'));
    expect(view.getByTestId('entity-view').dataset.listCollapsed).toBeUndefined();

    view.unmount();
  });

  it('remembers the collapse across a remount, per kind', async () => {
    const first = await openTasksScreen();
    fireEvent.click(first.getByTestId('entity-view-list-collapse'));
    await waitFor(() => first.getByTestId('entity-view-list-expand'));
    first.unmount();

    expect(window.localStorage.getItem('tm8ui.panel-flag.entity.task.list-collapsed')).toBe('1');

    resetNav();
    screenStackStore.getState().clearAll();
    const second = await openTasksScreen();
    expect(second.getByTestId('entity-view-list-expand')).toBeTruthy();
    second.unmount();
  });
});

describe('the menu rail', () => {
  it('opens COLLAPSED, icons only, with every destination still reachable', async () => {
    const view = render(<GateApp />);
    await waitFor(() => view.getByTestId('workspace-grid'));
    const rail = view.getByTestId('menu-rail');
    expect(rail.dataset.collapsed).toBe('true');

    // Icons only — no words anywhere in the rail…
    expect(rail.querySelectorAll('.shell-rail__label')).toHaveLength(0);
    // …and yet the eight caret leaves the shipped default hangs off the
    // Workspace row are still there, still named, still navigable. This is the
    // pairing that makes collapsed-by-default safe: the old rail dropped its
    // leaves when it collapsed, so a default-collapsed rail would have shipped
    // with Tasks, Docs and Sessions unreachable on first paint.
    expect(within(rail).getByRole('button', { name: /^Tasks/ })).toBeTruthy();
    expect(within(rail).getByRole('button', { name: /^Docs/ })).toBeTruthy();

    fireEvent.click(within(rail).getByRole('button', { name: /^Tasks/ }));
    await waitFor(() => view.getByTestId('entity-view'));

    view.unmount();
  });

  it('remembers being expanded — the choice outlives the tab', async () => {
    const first = render(<GateApp />);
    await waitFor(() => first.getByTestId('workspace-grid'));
    fireEvent.click(first.getByRole('button', { name: 'Expand menu rail' }));
    await waitFor(() =>
      expect(first.getByTestId('menu-rail').dataset.collapsed).toBe('false'),
    );
    first.unmount();

    expect(window.localStorage.getItem('tm8ui.panel-flag.menu-rail-collapsed')).toBe('0');

    resetNav();
    const second = render(<GateApp />);
    await waitFor(() => second.getByTestId('workspace-grid'));
    expect(second.getByTestId('menu-rail').dataset.collapsed).toBe('false');
    second.unmount();
  });
});
