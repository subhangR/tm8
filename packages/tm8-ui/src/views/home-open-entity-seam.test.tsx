// @vitest-environment jsdom
/**
 * THE HOST'S ENTITY-OPEN SEAM — one generic route into the right panel,
 * asserted through the real GateApp (task 01a023fb-23da, S5).
 *
 * The ledger surfaces (sticky panel tree rows, transcript create lines, the
 * expanded read line) all open entities through ONE handler: the chat
 * surface's `onOpenEntity`, which the gate binds to `navStore.openRight` —
 * region C, the aside beside the conversation (GateApp's ChatHomeSurface
 * mount; HomeView.tsx `openEntity`). Sessions are not a special door: a
 * `work_session` rides the same route and its DETAIL VIEW happens to be the
 * terminal (registry: `archetype: 'terminal'` → EntityDetailPanel mounts
 * TerminalBody). Kind routing is host-side and automatic.
 *
 * Nothing in the suite asserted this half before: gate-chat-home-wiring
 * covers the stage verbs, home-trails covers the CENTRE trail, and every
 * FleetPane/chip test renders the component directly and checks that it ASKS.
 * These cases check that the gate ANSWERS — the observable consequence in the
 * aside, not prop presence — so they survive the FleetPane → LedgerPanel swap:
 * the new panel's rows call the same handler these cases drive.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { GateApp } from './GateApp';
import { navStore, resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget } from '../routes';
import { sessionLive, taskGuideLines } from '../fixtures';

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

describe('the entity-open seam lands in the right panel', () => {
  it('an expanded read-line row opens the aside — the ledger asks, the gate answers with region C', async () => {
    /* Originally this case clicked a transcript entity CHIP; S3 retired the
       chips for the ledger lines, so the ledger's own route is what gets
       pinned now: expand the counted read line (S3b) and click a row inside.
       The row is a BUTTON only because the gate wired `onOpenEntity` — the
       same span/button honesty split, one handler for every ledger surface. */
    const target = createMemoryTarget(`#/s/${SPACE}/home`);
    const view = render(<GateApp routerTarget={target} />);
    /* First mount in the file pays the whole module graph's init — give the
       boot the same allowance the gate suites give it. */
    await view.findByTestId('chat-home-screen', {}, { timeout: 5000 });

    const line = await view.findByTestId('chat-ledger-reads', {}, { timeout: 5000 });
    fireEvent.click(line);
    const region = await waitFor(() => view.getByTestId('chat-ledger-readtree'));
    const row = within(region).getByText('Unblock the storage lane');
    expect(row.closest('button'), 'the row rendered inert — the gate stopped wiring onOpenEntity').toBeTruthy();
    fireEvent.click(row);

    /* The observable consequence: the aside opens, and the address carries it
       (`r=` is the right trail — a reload reproduces the arrangement). */
    await waitFor(() => expect(view.getByTestId('hp-aside')).toBeTruthy());
    await waitFor(() => expect(target.getHash()).toContain('r='));
    view.unmount();
  });

  it('a work_session on that route gets the TERMINAL — kind routing is the host’s, not the row’s', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/home`);
    const view = render(<GateApp routerTarget={target} />);
    await waitFor(() => view.getByTestId('chat-home-screen'));

    /* The same verb a ledger session row will call: the gate binds
       `onOpenEntity` to `openRight`, so driving the store here IS the seam
       below the row — the chip case above proves the surface reaches it. */
    act(() => navStore.getState().openRight(sessionLive.id as EntityId));

    const aside = await waitFor(() => view.getByTestId('hp-aside'));
    /* Not "a panel opened" — THE TERMINAL opened. The registry's terminal
       archetype is what makes a session row's click different from a task
       row's, and it must engage with no per-kind wiring in the opener. */
    await waitFor(() => expect(within(aside).getByTestId('terminal-body')).toBeTruthy());
    view.unmount();
  });

  it('a task on the same route gets its detail, never a terminal — the generic path serves every kind', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/home`);
    const view = render(<GateApp routerTarget={target} />);
    await waitFor(() => view.getByTestId('chat-home-screen'));

    act(() => navStore.getState().openRight(taskGuideLines.id as EntityId));

    const aside = await waitFor(() => view.getByTestId('hp-aside'));
    await waitFor(() =>
      expect(within(aside).getAllByText(taskGuideLines.title).length).toBeGreaterThan(0),
    );
    expect(within(aside).queryByTestId('terminal-body')).toBeNull();
    view.unmount();
  });
});
