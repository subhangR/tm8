// @vitest-environment jsdom
/**
 * THE HONESTY CARDS WERE THEMSELVES UNPINNED.
 *
 * This whole design leans on three cards telling the truth about three
 * different states, and the distinction between them is the entire value:
 *
 *   unbuilt-view          — the ref is REAL, the screen is not built yet
 *   entity-full-view-unbuilt — the ROUTE is real and frozen, the host is not
 *                              built yet (ruling M1)
 *   unrouted-target       — the target is not something this build recognises
 *                              AT ALL, which is a defect and shouts in console
 *
 * Collapse any two and the app starts lying in one direction or the other:
 * "coming soon" about a bug, or "that's a bug" about a screen we simply have
 * not written. `VIEW_REF_SCREENS` was made a `satisfies` record precisely so
 * a new ref must be classified into one of them — but nothing ever checked
 * that the classification produced the right card, so the table could have
 * been correct and the render switch wrong and no test would have moved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { GateApp } from './GateApp';
import { navStore, resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget } from '../routes';
import { FIXTURE_SPACE_ID } from '../fixtures';

const SPACE = FIXTURE_SPACE_ID;

function installStorage(): void {
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
}

beforeEach(() => {
  installStorage();
  resetNav();
  screenStackStore.getState().clearAll();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mount = () => render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/workspace`)} />);

describe('an unbuilt view ref says it is not built, and does not shout', () => {
  it('draws the unbuilt card for feed', async () => {
    const shout = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = mount();
    await waitFor(() => view.getByTestId('workspace-grid'));

    await act(async () => {
      navStore.getState().navigate({ view: 'feed' });
    });

    await waitFor(() => view.getByTestId('unbuilt-view'));
    expect(view.queryByTestId('unrouted-target')).toBeNull();
    /* NOT A DEFECT, SO NOT A SHOUT. The unrecognised card fires `console.error`
       once per mount; an unbuilt screen is a known, deliberate gap and must not
       be reported as a routing bug in every developer's console. */
    expect(shout.mock.calls.flat().join(' ')).not.toMatch(/render switch fell through/);
    view.unmount();
  });

  it('names the thing that is missing, rather than showing an empty screen', async () => {
    const view = mount();
    await waitFor(() => view.getByTestId('workspace-grid'));
    await act(async () => {
      navStore.getState().navigate({ view: 'feed' });
    });
    const card = await waitFor(() => view.getByTestId('unbuilt-view'));
    /* "Nothing is hidden here" is the sentence that separates this from a
       screen that merely failed to load, and it is the whole point of the card. */
    expect(card.textContent).toMatch(/feed/i);
    expect(card.textContent).toMatch(/isn’t built yet|does not exist in this build/i);
    view.unmount();
  });
});

describe('the unrecognised card stays reserved for actual defects', () => {
  it('does not absorb an unbuilt ref', async () => {
    /* The regression this guards is the easy one: an arm added above the
       unbuilt branch, or a ref reclassified, silently routes a known gap into
       the "this is a bug" card. Both cards render; only their meaning differs,
       so nothing but an assertion can tell them apart. */
    const view = mount();
    await waitFor(() => view.getByTestId('workspace-grid'));
    await act(async () => {
      navStore.getState().navigate({ view: 'feed' });
    });
    await waitFor(() => view.getByTestId('unbuilt-view'));
    expect(view.queryByTestId('entity-full-view-unbuilt')).toBeNull();
    view.unmount();
  });
});
