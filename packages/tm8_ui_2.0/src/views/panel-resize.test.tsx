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
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import {
  EV_CENTER_MIN,
  EV_DETAIL_DEFAULT,
  EV_DETAIL_MIN,
  EV_PANEL_BORDER,
  EV_RESIZER,
} from './EntityView';
/* HOME_LIST_* is deliberately NOT imported any more: Home draws no list
   column, so a floor, a ceiling and a default for one are numbers with no
   subject. See the block near the bottom of this file for what replaced the
   rulings they used to pin. */
import { HOME_RAIL_COLLAPSED, HOME_RAIL_EXPANDED } from './HomeView';

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

describe('the home icon rail', () => {
  /* Revision 17: no shipped tab draws the MENU rail any more (every group is
     a railless single view); the collapsed-keeps-the-word law (#269) lives
     on in Home's own icon rail, which these cases now measure. */
  it('opens COLLAPSED, with every destination named and reachable', async () => {
    const view = render(<GateApp />);
    await waitFor(() => view.getByTestId('home-page'));
    const rail = view.getByTestId('home-rail');
    /* A fresh profile starts collapsed — which is only a defensible default
       because the collapsed rail still prints every word under its mark, so
       the whole map is legible on first paint. */
    expect(rail.dataset.collapsed).toBe('true');

    const captions = [...rail.querySelectorAll('.hr-rail__label')].map((n) => n.textContent);
    expect(captions).toContain('Tasks');
    expect(captions).toContain('Docs');
    expect(within(rail).getByRole('button', { name: /^Tasks/ })).toBeTruthy();

    /* A collapsed row still navigates: it switches Home's root list.

       THE LIST MOVED, THE CLAIM DID NOT (2026-08-30 restructure). It used to
       land in `tch-hosted-list` — the chat surface's middle column — which is
       retired; a selected kind now takes the whole working area, so the handle
       is the working area itself. Asserting the panel INSIDE it too, because
       `.hp-listmain` with nothing in it would be the same silent no-op this
       line exists to catch. */
    fireEvent.click(within(rail).getByRole('button', { name: /^Tasks/ }));
    const main = await waitFor(() => view.getByTestId('hp-list-main'));
    expect(within(main).getByTestId('entity-list-panel')).toBeTruthy();

    // And the toggle still works in the other direction.
    fireEvent.click(view.getByRole('button', { name: 'Expand the rail' }));
    await waitFor(() => expect(rail.dataset.collapsed).toBe('false'));

    view.unmount();
  });

  it('remembers being EXPANDED — the choice outlives the mount', async () => {
    /* The direction is deliberate. Collapsed is the shipped default, so a
       walk that collapses and then finds a collapsed rail proves nothing: it
       passes identically against a flag nothing persists. Expanding is the
       choice that DIFFERS from the default, so it is the only one whose
       survival is evidence. */
    const first = render(<GateApp />);
    await waitFor(() => first.getByTestId('home-rail'));
    fireEvent.click(first.getByRole('button', { name: 'Expand the rail' }));
    await waitFor(() =>
      expect(first.getByTestId('home-rail').dataset.collapsed).toBe('false'),
    );
    first.unmount();

    expect(window.localStorage.getItem('tm8ui.panel-flag.home-rail-collapsed')).toBe('0');

    const second = render(<GateApp />);
    await waitFor(() => second.getByTestId('home-rail'));
    expect(second.getByTestId('home-rail').dataset.collapsed).toBe('false');
    second.unmount();
  });
});

/**
 * HOME'S LEFT SIDE: THE RAIL IS THE ONLY THING THERE, AND IT COLLAPSES ALONE.
 *
 * WHAT THIS BLOCK USED TO PIN, AND WHAT SUPERSEDED IT (2026-08-30 Home
 * restructure — "two modes, never both", owner-approved). Task 01a00ac2 made
 * Home's column A — the entity list, a third column between the rail and the
 * chat — draggable, and these cases pinned four rulings from 2026-08-16:
 *
 *   1. a drag CLAMPS at the floor and never closes the panel;
 *   2. one toggle collapses the rail AND A together;
 *   3. a persistent edge affordance is the way back, not a hover-reveal;
 *   4. the range is 240–560 with a 340 default.
 *
 * THERE IS NO COLUMN A ON THIS SCREEN ANY MORE. Selecting a kind in the rail
 * makes that kind's list the WHOLE working area (`.hp-listmain`), which is what
 * selecting a kind always meant; the third column that restated the rail's own
 * taxonomy is gone, and with it every ruling that was about its width. Rulings
 * 1 and 4 have no subject left — a floor and a ceiling for a panel that is not
 * drawn are not claims, they are furniture — so they are REPLACED here, not
 * deleted, by the claims that took their place: the two modes are exclusive,
 * and the solver now reserves the rail and nothing else.
 *
 * RULINGS 2 AND 3 SURVIVE WITH ONE WORD CHANGED. The single toggle now
 * collapses THE RAIL (there is nothing else on the left to take with it), and
 * the way back is still a permanent on-screen chevron rather than a hover
 * target or a shortcut only. Those are still choices with live alternatives,
 * so they still get a case each.
 */
describe('Home’s left side — the icon rail, and no column beside it', () => {
  /* The rail's width is published on the host as a custom property, which is
     what the layout reads. Asserting the property rather than a computed track
     is deliberate: jsdom loads no stylesheets, so the track itself is
     unmeasurable here (the standing tm8-ui law) while the number driving it is
     not. `--hp-list` is NOT read: nothing on this screen has a list column. */
  const railWidthOf = (view: ReturnType<typeof render>) =>
    (view.container.querySelector('.hp-host') as HTMLElement | null)?.style.getPropertyValue(
      '--hp-rail',
    );

  async function openHome() {
    const view = render(<GateApp />);
    await waitFor(() => view.getByTestId('home-page'));
    return view;
  }

  it('draws NO list column and no handle for one — replaces rulings 1 and 4', async () => {
    /* SUPERSEDES: "opens at the ruled default and drags to a width that
       persists". A remembered width for a column nobody can see is the kind of
       passing test this repair exists to prevent — it would go green forever
       against a `usePanelWidth` hook wired to nothing. What is true instead is
       structural, so that is what is asserted. */
    const view = await openHome();

    /* No drag handle on Home. (The ENTITY screen still has one — the cases at
       the top of this file — so this is Home's arrangement, not a retreat from
       resizable panels.) */
    expect(view.queryByTestId('panel-resizer-left')).toBeNull();
    expect(view.queryByTestId('hp-list-separator')).toBeNull();

    /* And no dashboard-plus-list arrangement: bare Home is the dashboard. */
    expect(view.queryByTestId('hp-list-main')).toBeNull();
    expect(view.getByTestId('chat-home-screen')).toBeTruthy();

    view.unmount();
  });

  it('gives a selected kind the whole working area, and Home takes it back', async () => {
    /* SUPERSEDES: "CLAMPS at the floor instead of closing — the ruled gesture
       (1)". The floor existed so a drag could not shut the panel; the panel is
       not draggable and not a panel. The claim that replaced it is the one the
       restructure actually makes — TWO MODES, NEVER BOTH — and it has the same
       property that made ruling 1 worth a case: a live alternative (a list
       beside the dashboard) that has already been shipped and removed twice. */
    const view = await openHome();
    const rail = view.getByTestId('home-rail');

    fireEvent.click(within(rail).getByRole('button', { name: /^Tasks/ }));
    const main = await waitFor(() => view.getByTestId('hp-list-main'));
    expect(within(main).getByTestId('entity-list-panel')).toBeTruthy();
    /* The dashboard and the chat are NOT rendered underneath or beside it. */
    expect(view.queryByTestId('chat-home-screen')).toBeNull();

    /* THE WAY BACK IS A ROW IN THE RAIL, not the browser's Back. Home is a
       destination and `activeKind: null` alone reads as "nothing selected". */
    fireEvent.click(view.getByTestId('home-rail-home'));
    await waitFor(() => expect(view.queryByTestId('hp-list-main')).toBeNull());
    expect(view.getByTestId('chat-home-screen')).toBeTruthy();

    view.unmount();
  });

  it('reserves the rail and nothing else — the solver’s surviving half', async () => {
    /* SUPERSEDES: "leaves the centre its floor at maximum drag — the ceiling is
       SOLVED (4)". The ceiling was A's, solved from the row width minus the
       rail, the centre's floor and the chrome. A is gone; the SOLVER is not,
       because it still has to know how much of the row the rail takes before
       it can tell whether region C fits beside the working area. So the claim
       that survives is about the one width that is still real. */
    const view = await openHome();
    /* A fresh profile opens collapsed — 72px, the icon strip that still prints
       every word under its mark (#269). */
    expect(railWidthOf(view)).toBe(`${HOME_RAIL_COLLAPSED}px`);

    fireEvent.click(view.getByRole('button', { name: 'Expand the rail' }));
    await waitFor(() => expect(railWidthOf(view)).toBe(`${HOME_RAIL_EXPANDED}px`));

    /* And OFF is zero, not a 72px strip left standing — "collapsing entire left
       panel AND icon rail" was the ask and a strip is not a collapse. */
    fireEvent.click(view.getByTestId('hp-rail-collapse'));
    await waitFor(() => expect(railWidthOf(view)).toBe('0px'));

    view.unmount();
  });

  it('collapses the RAIL on one toggle, and comes back (2, 3)', async () => {
    /* RULING 2, RESTATED. It read "one toggle collapses the rail AND A
       together" — the rejected alternative being two independent toggles. A is
       gone, so the toggle has one subject; what is still worth pinning is that
       the gesture takes the WHOLE rail off the row rather than shrinking it to
       its icon strip, and that the strip's own Collapse button (72↔208) is a
       different control that this one does not stand in for. */
    const view = await openHome();
    expect(view.getByTestId('home-rail')).toBeTruthy();

    const collapse = view.getByTestId('hp-rail-collapse');
    /* THE WORDS HAVE TO MATCH THE SUBJECT. These said "Collapse the list panel
       and the icon rail" while pointing `aria-controls` at `home-view-list` —
       a region this screen does not draw. A control that names a missing
       region is announced to a screen reader as a relationship that leads
       nowhere, which is worse than naming none. */
    expect(collapse.getAttribute('aria-label')).toBe('Collapse the icon rail');
    expect(collapse.getAttribute('title')).toBe('Collapse the icon rail (⌘\\)');
    expect(collapse.getAttribute('aria-controls')).toBe('home-rail');
    expect(view.getByTestId('home-rail').id).toBe('home-rail');

    fireEvent.click(collapse);

    await waitFor(() => expect(view.queryByTestId('home-rail')).toBeNull());
    expect(railWidthOf(view)).toBe('0px');

    /* Ruling 3: the way back is ALWAYS on screen. A hover-reveal overlay would
       leave nothing in the tree to find here — which is exactly the failure
       mode the ruling names, and exactly what this line detects. */
    const reveal = view.getByTestId('hp-rail-reveal');
    expect(reveal.getAttribute('aria-expanded')).toBe('false');
    expect(reveal.getAttribute('aria-label')).toBe('Show the icon rail');
    expect(reveal.getAttribute('aria-controls')).toBe('home-rail');
    /* And no drag handle appears in its place: there is nothing to resize. */
    expect(view.queryByTestId('panel-resizer-left')).toBeNull();

    fireEvent.click(reveal);
    await waitFor(() => expect(view.getByTestId('home-rail')).toBeTruthy());
    expect(railWidthOf(view)).toBe(`${HOME_RAIL_COLLAPSED}px`);

    view.unmount();
  });

  it('remembers being collapsed, and ⌘\\ is the same switch', async () => {
    const first = await openHome();
    /* Mod+\ used to toggle the MENU rail, which Home does not draw at all —
       the key did nothing where it was pressed. On Home it means Home's icon
       rail (it meant "the rail and column A" until column A was retired). */
    fireEvent.keyDown(window, { key: '\\', metaKey: true });
    await waitFor(() => expect(first.queryByTestId('home-rail')).toBeNull());
    expect(window.localStorage.getItem('tm8ui.panel-flag.home-focus')).toBe('1');
    first.unmount();

    const second = await openHome();
    await waitFor(() => expect(second.getByTestId('hp-rail-reveal')).toBeTruthy());
    expect(second.queryByTestId('home-rail')).toBeNull();

    /* The chevron and the shortcut write the SAME state — two `usePanelFlag`
       hooks on one key would each hold their own `useState` and drift, which
       is why the flag is owned by GateApp and handed down. */
    fireEvent.keyDown(window, { key: '\\', metaKey: true });
    await waitFor(() => expect(second.getByTestId('home-rail')).toBeTruthy());
    second.unmount();
  });
});
