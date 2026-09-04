// @vitest-environment jsdom
/**
 * THE HOST'S ENTITY-OPEN SEAM — one generic route into the ENTITY PANE,
 * asserted through the real GateApp (task 01a023fb-23da, S5).
 *
 * SUPERSEDED 2026-08-31 — RULING: ONE GESTURE, ONE RESULT. Every case in this
 * file used to assert `hp-aside`, region C, the 440px column beside the
 * conversation. A connection now ALWAYS opens in the entity pane, in place,
 * pushing a trail crumb; `openRight` is no longer a destination for this
 * gesture on Home.
 *
 * The assertions are REPLACED rather than relaxed, and they were not wrong at
 * the time: the aside genuinely was the berth. What changed is that three
 * berths for one verb were being chosen by WHERE THE CLICK CAME FROM — a
 * distinction no reader can see — and that the aside holds exactly one entity,
 * so its own promise ("you do not lose your place") already expired on the
 * second chip. The trail survives arbitrary depth and `paneScrollMemory`
 * restores the offset, which is the guarantee R6 actually wanted.
 *
 * WHAT THESE CASES STILL PROVE, unchanged in spirit: the ledger surfaces
 * (sticky panel tree rows, transcript create lines, the expanded read line) all
 * open entities through ONE handler, kind routing is host-side and automatic,
 * and a `work_session` gets its TERMINAL through the same generic door as a
 * task gets its detail. Only the berth is different. Sessions are not a special door: a
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

describe('the entity-open seam lands in the entity pane', () => {
  it('an expanded read-line row opens the entity pane — the ledger asks, the gate answers with region C', async () => {
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

    /* The observable consequence: the ENTITY PANE takes it, under a crumb, and
       the address carries it (`p=` is the centre trail — a reload reproduces
       the arrangement, and Back walks the crumbs). */
    await waitFor(() => expect(view.getByTestId('hp-center-trail-host')).toBeTruthy());
    await waitFor(() => expect(target.getHash()).toContain('p='));
    expect(view.queryByTestId('hp-aside'), 'the gesture still routes to region C').toBeNull();
    view.unmount();
  });

  it('a ledger-panel session row opens ITS TERMINAL in the entity pane — S5, the whole path through the real host', async () => {
    /* The fixture thread delegates once (execution.spawn → the entity
       fixtures' live session), so the sticky panel has a sessions row to
       follow: expand the panel, click the row, and the terminal must be
       standing in region C. Every hop is real — LedgerPanel → the screen's
       onOpenEntity → the gate's openRight → AuxEntityPanel → the registry's
       terminal archetype. Rows stay view-only: opening navigates; the
       composer keeps addressing the conversation it always did. */
    const target = createMemoryTarget(`#/s/${SPACE}/home`);
    const view = render(<GateApp routerTarget={target} />);
    await view.findByTestId('chat-home-screen', {}, { timeout: 5000 });

    fireEvent.click(await view.findByTestId('ledger-panel-toggle', {}, { timeout: 5000 }));
    const row = await view.findByTestId('ledger-panel-session', {}, { timeout: 5000 });
    fireEvent.click(row);

    const pane = await waitFor(() => view.getByTestId('hp-center-trail-host'));
    await waitFor(() => expect(within(pane).getByTestId('terminal-body')).toBeTruthy());
    /* View-only, observably: the chat surface is still mounted around the
       terminal — the row navigated, it did not retarget or evict. The pane it
       lands in IS the chat's centre berth (D8), which is why the screen is
       still there. */
    expect(view.getByTestId('chat-home-screen')).toBeTruthy();
    view.unmount();
  });

  it('a work_session on that route gets the TERMINAL — kind routing is the host’s, not the row’s', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/home`);
    const view = render(<GateApp routerTarget={target} />);
    await waitFor(() => view.getByTestId('chat-home-screen'));

    /* The same verb a ledger session row will call: the gate binds
       `onOpenEntity` to `push` (ruling 2026-08-31), so driving the store here
       IS the seam below the row — the chip case above proves the surface
       reaches it. */
    act(() => navStore.getState().push(sessionLive.id as EntityId));

    const pane = await waitFor(() => view.getByTestId('hp-center-trail-host'));
    /* Not "a panel opened" — THE TERMINAL opened. The registry's terminal
       archetype is what makes a session row's click different from a task
       row's, and it must engage with no per-kind wiring in the opener. */
    await waitFor(() => expect(within(pane).getByTestId('terminal-body')).toBeTruthy());
    view.unmount();
  });

  it('a task on the same route gets its detail, never a terminal — the generic path serves every kind', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/home`);
    const view = render(<GateApp routerTarget={target} />);
    await waitFor(() => view.getByTestId('chat-home-screen'));

    act(() => navStore.getState().push(taskGuideLines.id as EntityId));

    const pane = await waitFor(() => view.getByTestId('hp-center-trail-host'));
    await waitFor(() =>
      expect(within(pane).getAllByText(taskGuideLines.title).length).toBeGreaterThan(0),
    );
    expect(within(pane).queryByTestId('terminal-body')).toBeNull();
    view.unmount();
  });
});
