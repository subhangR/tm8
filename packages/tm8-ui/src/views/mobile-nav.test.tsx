// @vitest-environment jsdom
/**
 * t-nav — THE PHONE'S ‹ AGAINST THE REAL GATE AND A MEMORY HISTORY.
 *
 * CONTRACT §5 rulings (owner, 2026-10-18): ‹ is Back when the entry below is
 * ours (rulings 1, 5), replaces with Chat over the drawer's floor (ruling 3),
 * and is Up-by-REPLACE on a cold link (ruling 4). Harness copied from
 * `mobile-back.test.tsx`, which pins the system Back half of the same contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { GateApp } from './GateApp';
import { navStore, resetNav } from '../stores/navStore';
import { screenKeyOf, screenStackStore, stackOf } from '../stores/screenStackStore';
import { resetPhoneHistory, resetToChatFloor } from '../stores/phoneHistory';
import { fireEvent } from '@testing-library/react';
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
  resetPhoneHistory();
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
const pressChevron = async (view: ReturnType<typeof mount>) => {
  await act(async () => {
    fireEvent.click(view.getByTestId('mobile-header-back'));
  });
  await settle();
};

describe('‹ IS BACK WHEN THE ENTRY BELOW IS OURS', () => {
  it('list → entity → ‹ walks history back: no entry is spent and the list returns', async () => {
    const target = createMemoryTarget(kindHash);
    const view = mount(target);
    await waitFor(() => view.getByTestId('entity-view'));
    await settle();
    await act(async () => {
      screenStackStore.getState().open(TASKS, A);
    });
    await settle();
    expect(target.entries).toEqual([kindHash, entityHash(A)]);

    expect(view.getByTestId('mobile-header-back').getAttribute('aria-label')).toBe('Back');
    await pressChevron(view);

    expect(target.getHash()).toBe(kindHash);
    expect(target.index).toBe(0);
    /* Forward still holds the entity: ‹ was a real Back, not a pushed "up". */
    expect(target.entries).toEqual([kindHash, entityHash(A)]);
    expect(stack()).toEqual([]);
    view.unmount();
  });
});

describe('‹ ON A COLD LINK IS UP, AND UP REPLACES (ruling 4)', () => {
  it('replaces the entity with its kind list; the system Back then leaves the app', async () => {
    const target = createMemoryTarget(entityHash(A));
    const view = mount(target);
    await waitFor(() => expect(stack()).toEqual([A]));
    await settle();

    expect(view.getByTestId('mobile-header-back').getAttribute('aria-label')).toBe('Up to Tasks');
    await pressChevron(view);

    expect(target.getHash()).toBe(kindHash);
    expect(target.entries).toEqual([kindHash]);
    expect(stack()).toEqual([]);
    view.unmount();
  });
});

describe('THE DRAWER RESETS TO [Chat, destination] (ruling 3)', () => {
  it('‹ from a drawer destination replaces it with Chat', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/inbox`);
    const view = mount(target);
    await waitFor(() => expect(navStore.getState().view).toMatchObject({ view: 'inbox' }));
    await settle();
    await act(async () => {
      resetToChatFloor();
      navStore.getState().navigate({ view: 'kind', slug: 'tasks', mode: null, q: null });
    });
    await settle();
    expect(target.entries).toEqual([`#/s/${SPACE}/inbox`, kindHash]);

    expect(view.getByTestId('mobile-header-back').getAttribute('aria-label')).toBe('Back to Chat');
    await pressChevron(view);

    expect(navStore.getState().view).toMatchObject({ view: 'home' });
    /* Replaced, not pushed: the inbox entry is still the one below. */
    expect(target.entries).toHaveLength(2);
    expect(target.index).toBe(1);
    view.unmount();
  });
});
