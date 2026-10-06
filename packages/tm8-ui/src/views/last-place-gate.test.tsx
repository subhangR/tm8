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
  /* Leave Work through its own view selector — a user navigation, so the
     place is written exactly as a click writes it. */
  const goToObserve = async (view: ReturnType<typeof mount>) => {
    fireEvent.click(view.getByTestId('tws-view-select'));
    fireEvent.click(within(view.getByRole('menu', { name: 'Views' })).getByRole('menuitemradio', { name: /Observe/ }));
    await waitFor(() => expect(view.queryByTestId('tab-workspace')).toBeNull());
  };

  it('comes back to the view you left, not the landing screen', async () => {
    const first = mount();
    // D31: a viewer with no memory lands on Work.
    await waitFor(() => first.getByTestId('tab-workspace'));
    await goToObserve(first);

    // THE ROUND TRIP. Unmount is what `key={activeServer.id}` does on a switch.
    first.unmount();

    // AND THE ADDRESS GOES WITH IT, OR THIS TEST STOPS MEASURING ITSELF: an
    // addressable hash at boot deliberately OUTRANKS last-place (R3). A real
    // server switch is a fresh document with no hash, which is what this
    // restores.
    window.location.hash = '';

    const second = mount();
    await waitFor(() => second.getByTestId('graph-view'));
    // The regression this replaces: the landing screen, every time.
    expect(second.queryByTestId('tab-workspace')).toBeNull();
    second.unmount();
  });

  it('remembers Work itself, so a round trip from Work comes back to Work (D31 audit)', async () => {
    const first = mount();
    await waitFor(() => first.getByTestId('tab-workspace'));
    await goToObserve(first);
    // Back into Work through the view selector in Observe's frame header (shell alignment).
    fireEvent.click(first.getByTestId('tws-view-select'));
    fireEvent.click(first.getByRole('menuitemradio', { name: /Work/ }));
    await waitFor(() => first.getByTestId('tab-workspace'));
    first.unmount();
    window.location.hash = '';

    const second = mount();
    await waitFor(() => second.getByTestId('tab-workspace'));
    expect(second.queryByTestId('graph-view')).toBeNull();
    second.unmount();
  });

  it('boots to Work for a viewer with no remembered place (D31)', async () => {
    const view = mount();
    await waitFor(() => view.getByTestId('tab-workspace'));
    expect(view.queryByTestId('home-page')).toBeNull();
    expect(view.queryByTestId('workspace-grid')).toBeNull();
    view.unmount();
  });
});
