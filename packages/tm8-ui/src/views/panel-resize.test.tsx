// @vitest-environment jsdom
/**
 * THE DETAIL SCREENS RESIZE THE WAY THE WORKSPACE DOES (user report,
 * 2026-08-14) — restated for the Phase 3 flip (2026-08-15): the entity screen
 * is now list-centre / detail-right, so the draggable column is the DETAIL
 * panel and the centre whose floor the drag must respect is the LIST.
 *
 * WHY THIS MOUNTS THE COMPOSED APP. The interesting facts are all about the
 * REGION a panel sits in: that the detail column's width is the one the viewer
 * set, that the drag clamps against the centre's floor, that the aux column's
 * floor is respected. A unit test of `PanelResizer` cannot see any of them —
 * it would only prove that a callback fires. So this walks to a kind screen
 * the way a person does.
 *
 * The localStorage stub is board-layout.test.tsx's, for its reason: it is also
 * what makes the PERSISTENCE assertions here readable, since the widths are
 * written through exactly this object.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import {
  EV_CENTER_MIN,
  EV_DETAIL_DEFAULT,
  EV_DETAIL_MIN,
  EV_PANEL_BORDER,
  EV_RESIZER,
} from './EntityView';

/* D31: this suite drives a retired desktop view (Home, the old Work or
   Board), which only the legacy desktop still reaches (stage (c) deletes it). */
vi.mock('../shell/desktop-modes', () => ({ desktopModes: () => 'legacy' }));

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
  /* The URL is state and jsdom keeps ONE `window.location` per file — the
     same reset every sibling gate file carries. Without it, the address the
     previous case navigated to outranks last-place at the next boot (R3) and
     the case never sees the landing screen it waits for. */
  window.location.hash = '';
});

async function openTasksScreen() {
  /* A no-memory boot lands in the workspace (the Home dashboard is gone),
     which draws no screens tab row — so a fresh case boots on the Tasks
     address directly, the way a remount already does. */
  if (!window.location.hash) window.location.hash = `#/s/${FIXTURE_SPACE_ID}/k/tasks`;
  const view = render(<GateApp />);
  /* Revision 12: Tasks rides the closed Workspace caret ON THE WORK TAB —
     the rail renders only the active tab's contents, so the walk is
     tab → caret → leaf, the way a person now reaches it. Cases that remount
     mid-test boot straight onto `k/tasks` from the address (R3), so the walk
     is skipped when the screen is already there. */
  await waitFor(() => view.getByTestId('space-tab-bar'));
  if (!view.queryByTestId('entity-view')) {
    /* Revision 17: the Work tab retired — the guaranteed `g t` chord is the
       door to the Tasks screen. Cases that remount mid-test boot straight
       onto `k/tasks` from the address (R3), so the chord is skipped when the
       screen is already there. */
    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 't' });
  }
  await waitFor(() => view.getByTestId('entity-view'));
  return view;
}

const detailWidthOf = (view: { getByTestId(id: string): HTMLElement }) =>
  view.getByTestId('entity-view').style.getPropertyValue('--ev-detail');

describe('the entity screen resizes its detail column', () => {
  it('gives the detail column a separator that moves it, and remembers where', async () => {
    const view = await openTasksScreen();
    expect(detailWidthOf(view)).toBe(`${EV_DETAIL_DEFAULT}px`);

    // KEYBOARD, not a synthetic pointer drag. jsdom reports every element as
    // 0×0, so a pointer path would be asserting arithmetic against a viewport
    // that does not exist; the arrow keys exercise the same clamp through the
    // same callback. The column sits to the handle's RIGHT, so ArrowLeft is
    // what WIDENS it.
    const separator = view.getByTestId('panel-resizer-right');
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    await waitFor(() => expect(detailWidthOf(view)).toBe(`${EV_DETAIL_DEFAULT + 16}px`));

    // Persisted, ONCE for every kind — the detail column is a READING width
    // like the aux column's, not a per-collection preference the way the old
    // list rail's was.
    expect(window.localStorage.getItem('tm8ui.panel-width.entity.detail'))
      .toBe(String(EV_DETAIL_DEFAULT + 16));

    view.unmount();
  });

  it('refuses to drag the column below its floor, and says so through ARIA', async () => {
    const view = await openTasksScreen();
    const separator = view.getByTestId('panel-resizer-right');
    expect(separator.getAttribute('aria-valuemin')).toBe(String(EV_DETAIL_MIN));
    expect(separator.getAttribute('aria-valuenow')).toBe(String(EV_DETAIL_DEFAULT));

    // Home is "as narrow as this column is allowed to be" — the floor, never 0.
    fireEvent.keyDown(separator, { key: 'Home' });
    await waitFor(() => expect(detailWidthOf(view)).toBe(`${EV_DETAIL_MIN}px`));

    // And there is nothing below it: more arrows do not push past the floor.
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(detailWidthOf(view)).toBe(`${EV_DETAIL_MIN}px`);

    view.unmount();
  });

  it('resets to the shipped width on double-click', async () => {
    const view = await openTasksScreen();
    const separator = view.getByTestId('panel-resizer-right');

    fireEvent.keyDown(separator, { key: 'Home' });
    await waitFor(() => expect(detailWidthOf(view)).toBe(`${EV_DETAIL_MIN}px`));

    fireEvent.doubleClick(separator);
    await waitFor(() => expect(detailWidthOf(view)).toBe(`${EV_DETAIL_DEFAULT}px`));

    view.unmount();
  });

  /**
   * `End` is "as wide as this column may be", and the answer has to leave the
   * centre LIST its declared floor — chrome included: a separator occupies 8px
   * of real row and the column's 1px hairline adds to its width (nothing here
   * sets `box-sizing: border-box` globally).
   */
  it('leaves the centre its whole floor at maximum drag, chrome included', async () => {
    const view = await openTasksScreen();
    const separator = view.getByTestId('panel-resizer-right');

    fireEvent.keyDown(separator, { key: 'End' });
    await waitFor(() => expect(detailWidthOf(view)).not.toBe(`${EV_DETAIL_DEFAULT}px`));

    // jsdom has no layout, so the ROOT is the window — the same number the
    // component falls back to. That makes the arithmetic assertable here even
    // though the boxes are all 0×0.
    const detail = Number(detailWidthOf(view).replace('px', ''));
    const chrome = EV_RESIZER + EV_PANEL_BORDER;
    expect(detail).toBe(window.innerWidth - EV_CENTER_MIN - chrome);
    // Stated as the property rather than the arithmetic, so this still reads
    // as the LAW if the constants move.
    expect(window.innerWidth - detail - chrome).toBeGreaterThanOrEqual(EV_CENTER_MIN);

    view.unmount();
  });

  /**
   * The shell switches kinds by changing a PROP on an `EntityView` it keeps
   * mounted. The detail width is deliberately ONE preference across kinds —
   * a reading width follows the person, not the collection — so an in-place
   * kind switch keeps it, and a resize under Docs is the same preference the
   * Tasks screen reads back.
   */
  it('keeps one detail width across an in-place kind switch', async () => {
    window.localStorage.setItem('tm8ui.panel-width.entity.detail', '500');

    const view = await openTasksScreen();
    expect(detailWidthOf(view)).toBe('500px');

    // Same mounted component, different `kind` prop — no remount anywhere.
    // Revision 17: the rail rows retired; the panel's own kind selector is
    // the in-place switch (GateApp wires onKindChange → navigateTo).
    fireEvent.click(within(view.getByTestId('entity-view')).getByRole('button', { name: 'Tasks', expanded: false }));
    fireEvent.click(within(view.getByTestId('entity-view')).getByRole('menuitem', { name: /^Docs/ }));
    await waitFor(() => expect(view.getByTestId('entity-view').dataset.kind).toBe('doc'));
    expect(detailWidthOf(view)).toBe('500px');

    fireEvent.keyDown(view.getByTestId('panel-resizer-right'), { key: 'ArrowLeft' });
    await waitFor(() => expect(detailWidthOf(view)).toBe('516px'));
    expect(window.localStorage.getItem('tm8ui.panel-width.entity.detail')).toBe('516');

    view.unmount();
  });
});
