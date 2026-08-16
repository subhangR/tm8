// @vitest-environment jsdom
/**
 * THE LAYOUT MODE RIDES ON THE TARGET, AND THAT IS WHY IT SURVIVES.
 *
 * `MenuTarget`'s `kind` member carries an optional `mode` (`MenuRail.tsx`:90):
 * "route state the shell holds so the panel's switcher survives navigation".
 * `navigateTo` persists the WHOLE target through `writeLastTarget`, so the mode
 * goes to storage with it and the restore effect brings it back.
 *
 * WHY THIS IS PINNED NOW. `navStore` is about to become the source of truth for
 * the active view, and `mode` is the field most easily lost in that move: it is
 * optional, it is absent from every target the rail emits, and dropping it
 * fails SILENTLY — the app still works, every user's layout just quietly
 * resets to list on the next remount, and `App.tsx` remounts the gate on every
 * server switch (`key={activeServer.id}`). Nothing throws. Nobody gets an
 * error. The board they chose is simply gone.
 *
 * So this is a guard written against a change that has not been made yet. It
 * passes today, and if the ownership move drops `mode` on the floor it fails
 * here rather than in somebody's browser three weeks later.
 *
 * NOT ASSERTED, because it is deliberate: mode does NOT survive a KIND switch.
 * Tasks → Docs → Tasks resets the layout, and `GateApp`'s own comment says why
 * — "a new target has no mode yet". That is honest reset, not loss.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';

/* last-place-gate.test.tsx's stub, for its reason: the memory must survive the
   remount, and gate.test.tsx's `window.localStorage.clear()` throws here. */
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
  /* The URL is state now, and jsdom keeps one `window.location` per file. */
  window.location.hash = '';
});

/** The composed gate is slow under jsdom; see render-switch-honesty.test.tsx. */
const SLOW_GATE_MS = 30_000;

async function openTasksScreen() {
  const view = render(<GateApp />);
  /* Revision 12: no-memory boots land on the merged Home; Tasks rides the
     Workspace caret ON THE WORK TAB — the rail is the active tab's contents. */
  await waitFor(() => view.getByTestId('home-page'));
  fireEvent.click(within(view.getByTestId('space-tab-bar')).getByRole('tab', { name: 'Work' }));
  const rail = within(view.getByTestId('menu-rail'));
  fireEvent.click(rail.getByLabelText('Expand Workspace'));
  fireEvent.click(rail.getByRole('button', { name: /^Tasks/ }));
  await waitFor(() => view.getByTestId('entity-view'));
  return view;
}

describe('the chosen layout survives a remount', () => {
  it('comes back as a board, not reset to the list', async () => {
    const first = await openTasksScreen();
    expect(first.getByTestId('entity-view').dataset.layout).toBe('columns');

    fireEvent.click(
      within(first.getByTestId('view-switcher')).getByRole('button', { name: 'board layout' }),
    );
    await waitFor(() => expect(first.getByTestId('entity-view').dataset.layout).toBe('board'));

    /* THE REMOUNT. This is what `key={activeServer.id}` does on a server
       switch — every piece of useState in the tree ceases to exist, so only
       what reached storage can come back. */
    first.unmount();

    /* AND THE ADDRESS GOES WITH IT, SO THIS STILL MEASURES STORAGE. The mode
       click now also writes `?mode=board` into the URL, and an addressable hash
       at boot outranks last-place (R3) — leave it and the remount would come
       back as a board from the ADDRESS, which is a different guarantee from the
       one in this test's name. Both are true and only one is under test here. */
    window.location.hash = '';

    const second = render(<GateApp />);
    await waitFor(() => second.getByTestId('entity-view'));
    /* The regression this guards: 'columns'. */
    expect(second.getByTestId('entity-view').dataset.layout).toBe('board');
    second.unmount();
  }, SLOW_GATE_MS);
});
