// @vitest-environment jsdom
/**
 * The unified Home's route-owned trails, driven through the COMPOSED app
 * (task 01a00932 D1/R6/R7): the rail switches the root and the ADDRESS says
 * so; a list click roots the centre and the address carries the trail; Esc
 * walks it back out. The memory-history target is the assertion instrument —
 * what these cases prove is that the arrangement lives in the URL, which no
 * unit test of the store can see end to end.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget } from '../routes';

const SPACE = 'sp-atelier';

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
  window.location.hash = '';
  screenStackStore.getState().clearAll();
});

/**
 * Open the In Progress category tab, then click the specimen task.
 *
 * PHASE 7 made this two steps instead of one. The list used to open on `Open`
 * — one tab spanning `to_do` AND `in_progress` — and the four ruled tabs split
 * it, so the panel now opens on To Do while `Session tree guide lines`
 * (`working`) lives one tab across.
 *
 * The specimen stays `Session tree guide lines` because the trail assertions
 * downstream name it; the navigation is what changed, not the subject. (The
 * fixture set gained `taskQueued` in the same change, so the To Do tab is no
 * longer empty — it simply does not hold THIS row.)
 */
/* WHERE THE LIST LIVES (2026-08-30 Home restructure). It was `tch-hosted-list`
   — the chat surface's middle column. A selected kind is the WHOLE working area
   now (`hp-list-main`), and the chat surface is not mounted at all in that mode,
   so the old handle cannot be waited for: it never appears. Same list, same
   panel, same clicks; one container up. */
async function openInProgressTask(view: { getByTestId: (id: string) => HTMLElement }) {
  const list = await waitFor(() => view.getByTestId('hp-list-main'));
  fireEvent.click(within(list).getByRole('tab', { name: /^In Progress/ }));
  const row = await waitFor(() => within(list).getByText('Session tree guide lines'));
  fireEvent.click(row);
}

describe('Home trails live in the URL (D1)', () => {
  it('a rail click switches the root AND the address; a tile click roots the centre trail', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/home`);
    const view = render(<GateApp routerTarget={target} />);
    await waitFor(() => view.getByTestId('home-page'));

    /* The rail is the switcher (R4): its Tasks row makes tasks the root… */
    fireEvent.click(within(view.getByTestId('home-rail')).getByRole('button', { name: /^Tasks/ }));
    await waitFor(() => view.getByTestId('hp-list-main'));
    /* …and the ADDRESS says so. */
    await waitFor(() => expect(target.getHash()).toContain(`/home/k/tasks`));

    /* A tile click ROOTS the centre (R6a): the entity takes region B and the
       trail rides `p`.

       REGION B MOVED WITH THE LIST. `tch-center-override` is the chat
       surface's centre slot, and the chat surface is not mounted while a kind
       is selected — so the entity opens BESIDE the list inside the working
       area, under its own trail crumb. `hp-center-trail-host` is that same
       node (`HomeView` builds it and hands it on); the ruling this pins —
       a list click roots the centre and the trail rides the URL — is
       unchanged, and the `p=` assertions below are its other half. */
    await openInProgressTask(view);
    await waitFor(() => view.getByTestId('hp-center-trail-host'));
    await waitFor(() => expect(target.getHash()).toContain('p='));

    /* Esc walks the trail back out: B returns to the list, `p` leaves the
       address (D14 generalized). */
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(view.queryByTestId('hp-center-trail-host')).toBeNull());
    await waitFor(() => expect(target.getHash()).not.toContain('p='));
    view.unmount();
  });

  it('a deep link reproduces the arrangement: root and centre come back', async () => {
    /* First, make an arrangement and take its address. */
    const first = createMemoryTarget(`#/s/${SPACE}/home`);
    const a = render(<GateApp routerTarget={first} />);
    await waitFor(() => a.getByTestId('home-page'));
    fireEvent.click(within(a.getByTestId('home-rail')).getByRole('button', { name: /^Tasks/ }));
    await openInProgressTask(a);
    await waitFor(() => expect(first.getHash()).toContain('p='));
    const shared = first.getHash();
    a.unmount();

    /* A cold boot from that address lands on the same arrangement. */
    resetNav();
    const b = render(<GateApp routerTarget={createMemoryTarget(shared)} />);
    await waitFor(() => b.getByTestId('hp-list-main'));
    await waitFor(() => b.getByTestId('hp-center-trail-host'));
    b.unmount();
  });
});
