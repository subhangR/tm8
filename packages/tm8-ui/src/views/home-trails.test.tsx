// @vitest-environment jsdom
/**
 * The unified Home's route-owned trails, driven through the COMPOSED app
 * (task 01a00932 D1/R6/R7): the rail switches the root and the ADDRESS says
 * so; a list click roots the centre and the address carries the trail; Esc
 * walks the cursor back and never past the root (U14). The memory-history
 * target is the assertion instrument —
 * what these cases prove is that the arrangement lives in the URL, which no
 * unit test of the store can see end to end.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { GateApp } from './GateApp';
import { navStore, resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget } from '../routes';
import { projectTm8Ui, taskGuideLines, taskQueued } from '../fixtures';

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
async function openInProgressTask(view: { getByTestId: (id: string) => HTMLElement }) {
  const list = await waitFor(() => view.getByTestId('tch-hosted-list'));
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
    await waitFor(() => view.getByTestId('tch-hosted-list'));
    /* …and the ADDRESS says so. */
    await waitFor(() => expect(target.getHash()).toContain(`/home/k/tasks`));

    /* A tile click ROOTS the centre (R6a): the entity takes region B and the
       trail rides `p`. */
    await openInProgressTask(view);
    await waitFor(() => view.getByTestId('tch-center-override'));
    await waitFor(() => expect(target.getHash()).toContain('p='));

    /* Esc at the root does NOTHING (U14): a one-hop Trail has nowhere further
       back, and Esc must never be the key that throws a Trail away. */
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.getByTestId('tch-center-override')).toBeTruthy();
    expect(target.getHash()).toContain('p=');

    /* The panel's explicit close is the way back to the chat: B returns to
       the conversation and `p` leaves the address. */
    fireEvent.click(
      within(view.getByTestId('hp-center-trail-host')).getByRole('button', { name: 'Close panel' }),
    );
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
    await openInProgressTask(a);
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

describe('Esc steps the cursor back and stops at the root (U11 / U14)', () => {
  it('[a,b,c], cursorTo(a), Esc, Esc → the Trail is still [a,b,c] and the cursor still 0', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/home`);
    const view = render(<GateApp routerTarget={target} />);
    await waitFor(() => view.getByTestId('home-page'));

    const [a, b, c] = [projectTm8Ui.id, taskGuideLines.id, taskQueued.id] as EntityId[];
    act(() => {
      const nav = navStore.getState();
      nav.openCenter(a!);
      nav.trailPush(b!);
      nav.trailPush(c!);
    });
    await waitFor(() => view.getByTestId('hp-center-trail-host'));

    /* Still a step back while there is somewhere to step to — U14 narrowed
       the root, not the gesture. */
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(navStore.getState().cursor).toBe(1);

    act(() => navStore.getState().cursorTo(a!));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });

    const nav = navStore.getState();
    expect(nav.stack, 'Esc at the root threw the Trail away (D7 as first written; U14 overrules it)')
      .toEqual([a, b, c]);
    expect(nav.cursor).toBe(0);
    /* The address agrees, and B is still standing on the root. */
    await waitFor(() => expect(target.getHash()).toContain(`pc=${a}`));
    expect(view.getByTestId('hp-center-trail-host')).toBeTruthy();
    view.unmount();
  });
});

describe("Home's door into Work rides the Trail strip (U15)", () => {
  it('opens the entity the cursor stands on in the workspace — at length 1 too', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/home`);
    const view = render(<GateApp routerTarget={target} />);
    await waitFor(() => view.getByTestId('home-page'));

    const [a, b, c] = [projectTm8Ui.id, taskGuideLines.id, taskQueued.id] as EntityId[];
    /* Length 1: no crumbs to show, and the door is still there. */
    act(() => navStore.getState().openCenter(a!));
    const host = await waitFor(() => view.getByTestId('hp-center-trail-host'));
    expect(within(host).getByRole('button', { name: 'Open in Workspace' })).toBeTruthy();

    /* Mid-Trail: the door acts on the cursor's entry, not the top. */
    act(() => {
      const nav = navStore.getState();
      nav.trailPush(b!);
      nav.trailPush(c!);
      nav.cursorTo(b!);
    });
    fireEvent.click(
      within(view.getByTestId('hp-center-trail-host')).getByRole('button', { name: 'Open in Workspace' }),
    );
    await waitFor(() => expect(target.getHash()).toContain(`/s/${SPACE}/workspace`));
    const stack = navStore.getState().stack;
    expect(stack[stack.length - 1]).toBe(b);
    view.unmount();
  });
});
