// @vitest-environment jsdom
/**
 * THE REMOUNT IS THE TEST.
 *
 * `App.tsx` renders `<GateApp key={registry.activeServer.id}>`, so selecting a
 * Server does not re-render the gate — it DESTROYS and rebuilds it. Every piece
 * of `useState` in GateApp and useGateData goes with it. That is why going
 * remote and back landed the owner on the first space, in the workspace view:
 * nothing was cleared on purpose, it simply ceased to exist.
 *
 * A unit test of the store cannot see that, exactly as the note above
 * `describe('detail screens keep what you were looking at')` in gate.test.tsx
 * says of the same class of bug. So this unmounts and remounts the composed app
 * for real, which is what a server round trip does.
 *
 * The fixture seam serves ONE space, so the space half of the fix is pinned in
 * last-place.test.ts against the store the boot pick consults; what a composed
 * app CAN prove is the view half, and that the remembered view is honoured
 * across a remount rather than reset.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';

/**
 * jsdom's own localStorage persists for the whole FILE, which is what this test
 * needs (the memory must survive the remount) — but it must not leak between
 * cases, and gate.test.tsx's `window.localStorage.clear()` throws under this
 * runner. An explicit in-memory store, replaced per case, gives both.
 */
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
  /* The URL is state now, and jsdom keeps ONE `window.location` per file. This
     file is the sharpest case: it MOUNTS TWICE ON PURPOSE to prove last-place
     is honoured across a remount, and an addressable hash left by the first
     mount deliberately OUTRANKS last-place (R3). Without this, the second
     mount is reading the address rather than the memory, and the test would
     pass or fail for a reason it was never written to measure. */
  window.location.hash = '';
});

const mount = () => render(<GateApp />);

describe('a server round trip keeps your place', () => {
  it('comes back to the view you left, not the landing screen', async () => {
    const first = mount();
    // Revision 11: a viewer with no memory lands on the merged Home.
    await waitFor(() => first.getByTestId('home-page'));

    // Leave for a kind screen — the branch of GateApp's ternary that renders
    // EntityView. Tasks rides the Workspace caret on the WORK TAB now
    // (revision 12), so switch tab first. The caret itself is an EXPANDED-rail
    // control and the rail boots collapsed, where every leaf is drawn anyway.
    /* Revision 17: the Work tab retired — the guaranteed `g t` chord is the
       door to the Tasks screen now. */
    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 't' });
    await waitFor(() => first.getByTestId('entity-view'));

    // THE ROUND TRIP. Unmount is what `key={activeServer.id}` does on a switch.
    first.unmount();

    // AND THE ADDRESS GOES WITH IT, OR THIS TEST STOPS MEASURING ITSELF.
    //
    // The router now writes `#/s/{space}/k/tasks` when that rail click lands,
    // and an addressable hash at boot deliberately OUTRANKS last-place (R3). So
    // the second mount would find the destination in the URL and never consult
    // the memory at all — the assertion below would go green while the thing it
    // exists to prove had stopped being exercised. A real server switch is a
    // fresh document with no hash, which is what this restores.
    window.location.hash = '';

    const second = mount();
    await waitFor(() => second.getByTestId('entity-view'));
    // The regression this replaces: the landing screen, every time.
    expect(second.queryByTestId('workspace-grid')).toBeNull();
    expect(second.queryByTestId('home-page')).toBeNull();
    second.unmount();
  });

  it('boots to the merged Home for a viewer with no remembered place (r11)', async () => {
    const view = mount();
    await waitFor(() => view.getByTestId('home-page'));
    expect(view.queryByTestId('entity-view')).toBeNull();
    expect(view.queryByTestId('workspace-grid')).toBeNull();
    view.unmount();
  });
});
