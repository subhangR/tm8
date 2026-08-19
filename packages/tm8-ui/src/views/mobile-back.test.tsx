// @vitest-environment jsdom
/**
 * HARDWARE BACK ON A PHONE — the acceptance loop for the back contract.
 *
 * `stores/back-contract.test.ts` proves the DECISION without a DOM. This file
 * proves the MOUNT: that a real history stack, walked backwards through the
 * composed app rendering its PHONE shell, lands on the screen the contract
 * promises. The two failures it exists to catch are invisible to the unit test —
 * a stack that agrees with the address but a URL that gets rewritten anyway, and
 * a back press that consumes a history entry it should not have.
 *
 * THERE IS NO BACK HANDLER TO TEST, AND THAT IS THE FINDING. A phone's back
 * gesture IS browser back. Nothing in this codebase listens for `popstate` or
 * intercepts a gesture, so what is asserted here is that the ORDINARY history
 * walk produces the right screen — which is the only formulation compatible with
 * "one browser history, two renderings". `target.back()` below is the phone's
 * back gesture, faithfully: it moves the history index and notifies, exactly
 * what the hardware button does.
 *
 * The contract, with the reasoning and the cross-device table, is
 * `docs/features/mobile/BACK-CONTRACT.md`.
 *
 * ── THE jsdom TRAP THIS FILE INHERITS ──────────────────────────────────────
 *
 * `mobile/useShellKind.ts` warns that jsdom keeps ONE `window.location` per test
 * FILE, so a case that navigates leaves its address behind and the next case
 * boots from it. Every case here drives a MEMORY target through `GateApp`'s
 * `routerTarget` port rather than the real address, which sidesteps it — and the
 * hash is reset in `beforeEach` anyway, because `useShellKind` is genuinely
 * mounted in this file and its docblock asks for exactly that line.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { GateApp } from './GateApp';
import { navStore, resetNav } from '../stores/navStore';
import { screenKeyOf, screenStackStore, stackOf } from '../stores/screenStackStore';
import { createMemoryTarget, type MemoryTarget } from '../routes';
import { SHELL_OVERRIDE_KEY } from '../mobile';
import type { EntityId } from '@tm8/contract';
import { FIXTURE_SPACE_ID } from '../fixtures';

const SPACE = FIXTURE_SPACE_ID;
/** Two tasks the fixture dataset really holds, so a two-deep drill has content. */
const A = 'task-4f8c2a9e' as EntityId;
const B = 'task-blocked' as EntityId;
const TASKS = screenKeyOf.kind('task');

const kindHash = `#/s/${SPACE}/k/tasks`;
const entityHash = (id: EntityId) => `#/s/${SPACE}/e/${id}?origin=tasks`;

/** The `router-mount.test.tsx` storage double — this runner's `localStorage`
    arrives without `setItem`, and the shell override is read through it. */
function installStorage(): Map<string, string> {
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
  return map;
}

/**
 * Put the app on a phone.
 *
 * VIA THE STORED OVERRIDE, not by faking a media query, and the choice matters:
 * `shellFor`'s override branch is checked FIRST and unconditionally, so this
 * cannot be defeated by a jsdom `innerWidth` default or a missing `matchMedia`.
 * The width and pointer are set too, so the environment is coherent rather than
 * merely overridden — a test that lies about the device it is on is a test whose
 * failures do not mean anything.
 */
function useMobileShell(storage: Map<string, string>): void {
  storage.set(SHELL_OVERRIDE_KEY, 'mobile');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('coarse'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  const storage = installStorage();
  useMobileShell(storage);
  window.location.hash = '';
  resetNav();
  screenStackStore.getState().clearAll();
});

afterEach(cleanup);

const mount = (target: MemoryTarget) => render(<GateApp routerTarget={target} />);

/** Let the debounced replace (50ms) settle, so a write is measured once. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

/** The phone's back gesture. It is browser back; there is nothing else. */
async function pressBack(target: MemoryTarget): Promise<void> {
  await act(async () => {
    target.back();
  });
  await settle();
}

const stack = () => stackOf(screenStackStore.getState(), TASKS);

describe('the phone really is rendering the phone shell', () => {
  /* Leg zero. Every assertion below is about the mobile shell, and a case that
     silently rendered the DESKTOP shell would still pass most of them — the
     contract is shared, which is exactly what makes that mistake invisible. So
     the fork is asserted once, loudly, before anything depends on it. */
  /* The tell USED to be `.mobile-tabs`. The tab bar was removed (owner ruling
     2026-08-19) and the drawer's ☰ replaced it as this shell's navigation, so
     the fork is asserted on the ☰ instead — which is a BETTER tell than the bar
     was, because it is present on every mobile screen rather than on the five
     the bar happened to name. The drawer itself is not asserted here: it is a
     modal layer and it is shut until somebody opens it, so its absence would
     prove nothing about which shell mounted. */
  it('mounts the phone header’s ☰ and not the desktop menu rail', async () => {
    const target = createMemoryTarget(kindHash);
    const view = mount(target);
    await waitFor(() => expect(view.queryByTestId('mobile-drawer-menu')).not.toBeNull());
    expect(view.queryByTestId('menu-rail')).toBeNull();
    view.unmount();
  });
});

describe('LINK ARRIVAL, THEN BACK', () => {
  it('does not spend a history entry standing still', async () => {
    const target = createMemoryTarget(entityHash(A));
    const view = mount(target);
    await waitFor(() => expect(stack()).toEqual([A]));
    await settle();
    /* The arrival settles to ONE entry: hydration rewrites in place and the
       stack it seeds is the one the address already named, so nothing pushes.
       An arrival that pushed would put a phantom entry behind the viewer and
       make the first back press mean something they never did. */
    expect(target.entries).toEqual([entityHash(A)]);
    view.unmount();
  });

  it('a COLD arrival has nothing behind it, so back leaves the app — Q4, answered', async () => {
    /*
     * The honest answer, and it is a feature. A pasted link IS the whole history;
     * there is no in-app place back could go, and manufacturing one would be
     * inventing a journey the viewer never took. So back returns them to
     * whatever they were reading when they tapped the link, which is where they
     * actually came from.
     *
     * `canGoBack()` false IS "back leaves the app": the transport has no earlier
     * entry, so the press belongs to the browser. Note what it is NOT — it is not
     * back bouncing to another in-app screen, and it is not the two-item trap.
     */
    const target = createMemoryTarget(entityHash(A));
    const view = mount(target);
    await waitFor(() => expect(stack()).toEqual([A]));
    await settle();
    expect(target.canGoBack()).toBe(false);
    view.unmount();
  });

  it('after ONE real navigation from a link arrival, back returns to the LINKED entity', async () => {
    /*
     * THE DEFECT THIS FILE WAS WRITTEN FOR, and the first thing a real phone user
     * hits: follow a link, tap one related thing, press back. Before the
     * contract, back walked the address to `e/A` — and then the screen→URL sync,
     * still holding `[A, B]` in the stack, pushed `e/B` straight back. The
     * viewer returned to the entity they had just left, having spent a history
     * entry to do it, and pressing back again repeated it forever.
     */
    const target = createMemoryTarget(entityHash(A));
    const view = mount(target);
    await waitFor(() => expect(stack()).toEqual([A]));
    await settle();

    await act(async () => {
      screenStackStore.getState().open(TASKS, B);
    });
    await settle();
    expect(target.entries).toEqual([entityHash(A), entityHash(B)]);

    await pressBack(target);

    expect(stack()).toEqual([A]);
    /* THE ASSERTION THAT WOULD HAVE CAUGHT THE TRAP: the address stays put and
       no entry is spent. A re-push would rewrite this to `e/{B}` and grow the
       entry list. */
    expect(target.getHash()).toBe(entityHash(A));
    expect(target.entries).toEqual([entityHash(A), entityHash(B)]);
    view.unmount();
  });
});

describe('DRILL TWO DEEP, THEN BACK TWICE', () => {
  it('unwinds one rung per press and lands on the list', async () => {
    const target = createMemoryTarget(kindHash);
    const view = mount(target);
    await waitFor(() => view.getByTestId('entity-view'));
    await settle();

    /* Two drill-ins. `screenStackStore.open` is what a row tap drives, and the
       screen→URL sync turns each into a pushed entry — which is precisely why
       the browser history alone can unwind them. */
    await act(async () => {
      screenStackStore.getState().open(TASKS, A);
    });
    await settle();
    await act(async () => {
      screenStackStore.getState().open(TASKS, B);
    });
    await settle();

    expect(stack()).toEqual([A, B]);
    expect(target.getHash()).toBe(entityHash(B));
    expect(target.entries).toEqual([kindHash, entityHash(A), entityHash(B)]);

    await pressBack(target);
    expect(stack()).toEqual([A]);
    expect(target.getHash()).toBe(entityHash(A));

    await pressBack(target);
    expect(stack()).toEqual([]);
    expect(target.getHash()).toBe(kindHash);
    view.unmount();
  });

  it('FORWARD rebuilds the drill-down it just unwound', async () => {
    /* The direction that a pop-the-stack-first design cannot get right, and the
       reason the contract is address-led rather than stack-led. If back popped
       the stack and then wrote the URL, forward would arrive at an address the
       stack no longer agreed with, and the two would disagree about depth. */
    const target = createMemoryTarget(kindHash);
    const view = mount(target);
    await waitFor(() => view.getByTestId('entity-view'));
    await settle();
    for (const id of [A, B]) {
      await act(async () => {
        screenStackStore.getState().open(TASKS, id);
      });
      await settle();
    }

    await pressBack(target);
    await pressBack(target);
    expect(stack()).toEqual([]);

    await act(async () => {
      target.forward();
    });
    await settle();
    expect(stack()).toEqual([A]);

    await act(async () => {
      target.forward();
    });
    await settle();
    expect(stack()).toEqual([A, B]);
    view.unmount();
  });
});

describe('BACK AT A SCREEN ROOT', () => {
  it('leaves the screen for the previous screen — never the app', async () => {
    /* Q3/Q4: closing the last item exits the SCREEN, and the screen root is a
       screen. From a root reached by walking, back is an ordinary step to the
       previous screen and the app is never left. */
    /* The Inbox rather than the workspace: on a phone the workspace has no
       layout and draws the honest "no phone arrangement" card, so using it here
       would test the back walk against a screen the shell refuses to draw. The
       Inbox is a real phone destination and a real tab. */
    const target = createMemoryTarget(`#/s/${SPACE}/inbox`);
    const view = mount(target);
    await waitFor(() => expect(navStore.getState().view).toMatchObject({ view: 'inbox' }));
    await settle();

    await act(async () => {
      navStore.getState().navigate({ view: 'kind', slug: 'tasks', mode: null, q: null });
    });
    await settle();
    await act(async () => {
      screenStackStore.getState().open(TASKS, A);
    });
    await settle();

    await pressBack(target);
    expect(stack()).toEqual([]);
    expect(target.getHash()).toBe(kindHash);

    await pressBack(target);
    expect(navStore.getState().view).toMatchObject({ view: 'inbox' });
    /* Still inside the app, and still inside the Space. */
    expect(target.canGoBack()).toBe(false);
    expect(navStore.getState().spaceId).toBe(SPACE);
    view.unmount();
  });

  it('R15 — from a COLD arrival the root is history entry ZERO, so the next back leaves the app', async () => {
    /*
     * Q4 answered as an assertion rather than as prose. The step up from a
     * pasted link REPLACES, so the root does not sit on top of a fabricated
     * in-app history: `canGoBack()` is false, and the next press is the
     * browser's to handle — it returns the viewer to wherever the link came
     * from, which is the correct destination and is what R15's replace buys.
     *
     * What must NEVER happen is the alternative: back returning to the entity.
     * That is the two-item trap, and it is asserted against directly.
     */
    const target = createMemoryTarget(entityHash(A));
    const view = mount(target);
    await waitFor(() => expect(stack()).toEqual([A]));
    await settle();

    await act(async () => {
      screenStackStore.getState().pop(TASKS);
    });
    await settle();

    expect(target.getHash()).toBe(kindHash);
    expect(target.entries).toEqual([kindHash]);
    expect(target.canGoBack()).toBe(false);
    view.unmount();
  });
});

describe('ROTATE AND RESUME DO NOT CHANGE THE RULE', () => {
  it('a rotation changes no address, no stack and no screen', async () => {
    /*
     * A rotation is a resize. It re-runs the shell fork and nothing else — the
     * stores are module-level and the address is untouched — so the contract has
     * nothing to say about it, and this asserts that silence rather than
     * assuming it. A rotation that quietly re-seeded a stack would make back
     * mean something different in landscape.
     */
    const target = createMemoryTarget(kindHash);
    const view = mount(target);
    await waitFor(() => view.getByTestId('entity-view'));
    await act(async () => {
      screenStackStore.getState().open(TASKS, A);
    });
    await settle();
    const entries = [...target.entries];

    await act(async () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 844 });
      window.dispatchEvent(new Event('resize'));
    });
    await settle();

    expect(stack()).toEqual([A]);
    expect(target.getHash()).toBe(entityHash(A));
    expect(target.entries).toEqual(entries);
    view.unmount();
  });

  it('a RESUME from the same address restores the same screen, and back still means the same thing', async () => {
    /*
     * "Resume" at its most destructive: the OS discarded the tab and the viewer
     * came back to the address it was on. That is a reload, so the screen stack
     * is gone — it is deliberately not persisted — and the address is all there
     * is. The rule does not change BECAUSE the address is the state and the
     * stack is derived from it: the same hash rebuilds the same screen, at
     * depth 1, and the next back does what R15 says.
     */
    const target = createMemoryTarget(entityHash(A));
    const first = mount(target);
    await waitFor(() => expect(stack()).toEqual([A]));
    await settle();
    const resumeAt = target.getHash();
    first.unmount();

    /* Everything in-memory is gone; only the address survives. */
    resetNav();
    screenStackStore.getState().clearAll();
    expect(stack()).toEqual([]);

    const resumed = createMemoryTarget(resumeAt);
    const second = mount(resumed);
    await waitFor(() => expect(stack()).toEqual([A]));
    await settle();
    expect(resumed.getHash()).toBe(entityHash(A));
    expect(resumed.canGoBack()).toBe(false);
    second.unmount();
  });
});
