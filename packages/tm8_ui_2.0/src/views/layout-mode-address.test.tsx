// @vitest-environment jsdom
/**
 * THE LAYOUT MODE RIDES ON THE TARGET, AND THAT IS WHY IT SURVIVES.
 *
 * `MenuTarget`'s `kind` member carries an optional `mode`: route state the
 * shell holds. `navigateTo` persists the WHOLE target through
 * `writeLastTarget`, so the mode goes to storage with it and the restore
 * effect brings it back.
 *
 * WHY THIS IS PINNED. `mode` is the field most easily lost in a change of view
 * ownership: it is optional, it is absent from every target the rail emits, and
 * dropping it fails SILENTLY — the app still works, the layout just quietly
 * resets to list on the next remount, and `App.tsx` remounts the gate on every
 * server switch (`key={activeServer.id}`). Nothing throws. Nobody gets an
 * error. The board is simply gone.
 *
 * WHAT CHANGED ON 2026-08-19, AND WHAT THIS FILE NOW MEASURES. The view
 * switcher was removed from every entity list, so nothing in the UI writes a
 * mode any more: an ADDRESS (`?mode=`) is the only way one enters.
 *
 * `writeLastTarget` fires from `navigateTo`, and the switcher's click was the
 * one caller that ever handed it a mode-bearing target. A hash change is not a
 * `navigateTo`, so the storage half of this guarantee now has no writer, and
 * the case below asserts the ADDRESS half instead — a pasted `?mode=board`
 * link rendering a board on a COLD boot, which is the whole of what a layout
 * choice is now. The remount-from-storage claim went with the control that
 * used to make it; it is named here rather than deleted so a future reader
 * knows it was retired deliberately, not lost.
 *
 * NOT ASSERTED, because it is deliberate: mode does NOT survive a KIND switch.
 * Tasks → Docs → Tasks resets the layout, and `GateApp`'s own comment says why
 * — "a new target has no mode yet". That is honest reset, not loss.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
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
  /* Revision 17: the Work tab retired — the guaranteed `g t` chord is the
     door to the Tasks screen now. */
  fireEvent.keyDown(window, { key: 'g' });
  fireEvent.keyDown(window, { key: 't' });
  await waitFor(() => view.getByTestId('entity-view'));
  return view;
}

describe('a layout arrives by ADDRESS, and the address is honoured cold', () => {
  it('a pasted ?mode=board link boots straight into the board', async () => {
    /* THE COLD BOOT. Not "navigate, then change the hash" — that is the warm
       path and it already has coverage in board-layout.test.tsx. This is the
       shape a shared link actually takes: the address exists before the app
       does, and R3 says an addressable hash at boot outranks last-place. */
    const first = await openTasksScreen();
    const [path] = window.location.hash.split('?');
    first.unmount();

    window.location.hash = `${path}?mode=board`;
    const second = render(<GateApp />);
    await waitFor(() => second.getByTestId('entity-view'));
    /* The regression this guards: 'columns' — the address parsed and the mode
       dying somewhere between the codec and the panel, which is exactly what
       §1.1 was written to fix and what the removal of the switcher could
       plausibly have undone by taking the wiring with it. */
    await waitFor(() =>
      expect(second.getByTestId('entity-view').dataset.layout).toBe('board'),
    );
    second.unmount();
  }, SLOW_GATE_MS);

  it('and a bare address is the registry default, not the last board someone opened', async () => {
    /* The honest consequence of having no writer: nothing remembers a layout
       across a remount any more. Pinned so the reset reads as designed rather
       than as the silent regression this file was originally written about. */
    const first = await openTasksScreen();
    const [path] = window.location.hash.split('?');
    window.location.hash = `${path}?mode=board`;
    fireEvent(window, new Event('hashchange'));
    await waitFor(() => expect(first.getByTestId('entity-view').dataset.layout).toBe('board'));
    first.unmount();

    window.location.hash = '';
    const second = render(<GateApp />);
    await waitFor(() => second.getByTestId('entity-view'));
    expect(second.getByTestId('entity-view').dataset.layout).toBe('columns');
    second.unmount();
  }, SLOW_GATE_MS);
});
