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

describe('Home trails live in the URL (D1)', () => {
  it('a rail click switches the root AND the address; a tile click roots the centre trail', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/home`);
    const view = render(<GateApp routerTarget={target} />);
    await waitFor(() => view.getByTestId('home-page'));

    /* The rail is the switcher (R4): its Tasks row makes tasks the root… */
    fireEvent.click(within(view.getByTestId('home-rail')).getByRole('button', { name: /^Tasks/ }));
    await waitFor(() => view.getByTestId('tch-hosted-list'));
    /* …and the ADDRESS says so. */
    await waitFor(() => expect(target.getHash()).toContain(`/home/k/tasks`));

    /* A tile click ROOTS the centre (R6a): the entity takes region B and the
       trail rides `p`. */
    fireEvent.click(
      within(view.getByTestId('tch-hosted-list')).getByText('Session tree guide lines'),
    );
    await waitFor(() => view.getByTestId('tch-center-override'));
    await waitFor(() => expect(target.getHash()).toContain('p='));

    /* Esc walks the trail back out: B returns to the chat, `p` leaves the
       address (D14 generalized). */
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(view.queryByTestId('tch-center-override')).toBeNull());
    await waitFor(() => expect(target.getHash()).not.toContain('p='));
    view.unmount();
  });

  it('a deep link reproduces the arrangement: root and centre come back', async () => {
    /* First, make an arrangement and take its address. */
    const first = createMemoryTarget(`#/s/${SPACE}/home`);
    const a = render(<GateApp routerTarget={first} />);
    await waitFor(() => a.getByTestId('home-page'));
    fireEvent.click(within(a.getByTestId('home-rail')).getByRole('button', { name: /^Tasks/ }));
    await waitFor(() => a.getByTestId('tch-hosted-list'));
    fireEvent.click(
      within(a.getByTestId('tch-hosted-list')).getByText('Session tree guide lines'),
    );
    await waitFor(() => expect(first.getHash()).toContain('p='));
    const shared = first.getHash();
    a.unmount();

    /* A cold boot from that address lands on the same arrangement. */
    resetNav();
    const b = render(<GateApp routerTarget={createMemoryTarget(shared)} />);
    await waitFor(() => b.getByTestId('tch-hosted-list'));
    await waitFor(() => b.getByTestId('tch-center-override'));
    b.unmount();
  });
});
