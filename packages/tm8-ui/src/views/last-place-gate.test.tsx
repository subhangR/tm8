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
});

const mount = () => render(<GateApp />);

describe('a server round trip keeps your place', () => {
  it('comes back to the view you left, not the workspace', async () => {
    const first = mount();
    await waitFor(() => first.getByTestId('workspace-grid'));

    // Leave the workspace for a kind screen — the branch of GateApp's ternary
    // that renders EntityView.
    fireEvent.click(within(first.getByTestId('menu-rail')).getByRole('button', { name: /^Tasks/ }));
    await waitFor(() => first.getByTestId('entity-view'));

    // THE ROUND TRIP. Unmount is what `key={activeServer.id}` does on a switch.
    first.unmount();

    const second = mount();
    await waitFor(() => second.getByTestId('entity-view'));
    // The regression this replaces: `workspace-grid`, every time.
    expect(second.queryByTestId('workspace-grid')).toBeNull();
    second.unmount();
  });

  it('still boots to the workspace for a viewer with no remembered place', async () => {
    const view = mount();
    await waitFor(() => view.getByTestId('workspace-grid'));
    expect(view.queryByTestId('entity-view')).toBeNull();
    view.unmount();
  });
});
