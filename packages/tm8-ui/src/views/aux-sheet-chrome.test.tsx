// @vitest-environment jsdom
/**
 * THE AUX SHEET'S CHROME AND ITS HEIGHT — Lane 3.
 *
 * Connections and Discussion have opened as `MobileSheet`s on the phone since
 * the sheet primitive landed. What this file pins is the two things about that
 * sheet that nothing could previously hold:
 *
 *   · THE HEADER COUNT. `.ev-aux` is a desktop THIRD COLUMN — it draws its own
 *     crumb, an `esc` hint and a ✕ — and inside a sheet that already draws a
 *     title and a ✕ that is two headers and two close controls stacked, with a
 *     keyboard hint on a device that has no Escape key. It had been fixed once,
 *     with `display: none` in `mobile-screens.css`, and that fix is invisible
 *     here: JSDOM LOADS NO STYLESHEETS, so a `display:none` header is a header
 *     as far as every vitest in this package is concerned. The defect could
 *     therefore come back — as a deleted CSS rule, or as a second header added
 *     somewhere new — with the whole suite green. It is now declined at the
 *     RENDER, which is the same result stated where a test can read it.
 *
 *   · THE SIZE. Discussion carries a composer and takes the whole frame;
 *     Connections does not and keeps the strip of screen underneath. Asserted
 *     as the `data-size` ATTRIBUTE, never as pixels — see below.
 *
 * ── WHAT THIS FILE CANNOT DO ───────────────────────────────────────────────
 *
 * It cannot tell you the full sheet is taller than the default one. jsdom has
 * no layout and loads no stylesheets, so `height: 72%` and `height: 100%` are
 * the same nothing to it. The attribute is the seam deliberately: `MobileSheet`
 * publishes the CHOICE as `data-size`, the stylesheet owns what the choice is
 * worth in pixels, and this file asserts only the half it can actually see. A
 * case here that claimed to measure the height would be measuring the fixture.
 *
 * The phone harness (stored shell override, `innerWidth`, `matchMedia`, the
 * `localStorage` double) is `mobile-back.test.tsx`'s, for its reasons — the
 * override branch of `shellFor` is checked first and unconditionally, so it
 * cannot be defeated by a jsdom default.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget } from '../routes';
import { SHELL_OVERRIDE_KEY } from '../mobile';
import type { EntityId } from '@tm8/contract';
import { FIXTURE_SPACE_ID } from '../fixtures';

const SPACE = FIXTURE_SPACE_ID;
/** A task the fixture dataset really holds, so Connections has edges to draw. */
const A = 'task-4f8c2a9e' as EntityId;
const entityHash = (id: EntityId) => `#/s/${SPACE}/e/${id}?origin=tasks`;

/** `router-mount.test.tsx`'s storage double — this runner's `localStorage`
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

/**
 * Put the app back on a desktop, COHERENTLY.
 *
 * Clearing the override is not enough and the reason is worth stating, because
 * it cost this file a red: `shellFor` falls back to the VIEWPORT when there is
 * no override, and `beforeEach` has already pinned `innerWidth` to 390 with a
 * coarse pointer for the whole file. An "unset the override" desktop case
 * therefore resolves to mobile again and asserts the phone arrangement while
 * claiming to assert the desktop one — green, and measuring the wrong shell.
 * Both halves are set so the environment agrees with itself.
 */
function useDesktopShell(storage: Map<string, string>): void {
  storage.set(SHELL_OVERRIDE_KEY, 'desktop');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
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

/**
 * Open the entity, then send one of the two AUX tabs right.
 *
 * THE TAB STRIP IS THE ENTRANCE TODAY AND WILL NOT BE FOREVER. The phone's tab
 * row is being replaced by a FAB carrying the same two destinations, and when
 * that lands this helper is the ONE place that has to learn the new control —
 * every assertion below is about what the sheet contains, not about how it was
 * opened. The tab is addressed by its `id`, which `chrome.tsx` derives from the
 * `PanelTab` union, so a renamed tab breaks this loudly rather than silently
 * selecting nothing.
 */
async function openAux(tab: 'discussion' | 'connections') {
  const target = createMemoryTarget(entityHash(A));
  const view = render(<GateApp routerTarget={target} />);
  await waitFor(() => expect(document.querySelector('[data-testid="entity-view"]')).not.toBeNull());

  const control = await waitFor(() => {
    const found = document.querySelector(`#tab-${tab}`);
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  await act(async () => {
    fireEvent.click(control);
  });

  const sheet = await waitFor(() => {
    const found = document.querySelector('[data-testid="entity-view-aux-sheet"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  return { view, sheet };
}

describe('the phone aux sheet draws ONE header and ONE way out', () => {
  /*
   * THE COUNT, and it is the point of this file. Two of each is what a desktop
   * column dropped into a sheet produces, it shipped that way once, and the
   * repair that followed was a CSS rule no test in this package can see.
   *
   * Both tabs are checked rather than one: the header belongs to `.ev-aux`,
   * which wraps BOTH aux bodies, so a regression that reinstated it would show
   * up on whichever tab the reader happened to open — asserting one would leave
   * a coin flip in the coverage.
   */
  it.each(['discussion', 'connections'] as const)(
    'has exactly one header and one close control — %s',
    async (tab) => {
      const { view, sheet } = await openAux(tab);

      /* The sheet's own header, and nothing stacked above or below it. */
      expect(sheet.querySelectorAll('.msheet__head')).toHaveLength(1);
      expect(sheet.querySelectorAll('.msheet__close')).toHaveLength(1);

      /* The desktop column's head, which is the thing that used to be the
         second one. Counted by CLASS and by its two distinctive contents, so
         this cannot pass because the head was kept and merely renamed. */
      expect(sheet.querySelectorAll('.ev-aux__head')).toHaveLength(0);
      expect(sheet.querySelector('[data-testid="entity-view-aux-close"]')).toBeNull();
      expect(sheet.textContent).not.toContain('esc');

      /* THE POSITIVE COMPANION. Every assertion above would also pass on an
         EMPTY sheet, which is the failure mode a count test invites — the aux
         body has to actually be in there for the zeroes to mean anything. */
      expect(sheet.querySelector('[data-testid="entity-view-aux"]')).not.toBeNull();

      view.unmount();
    },
  );
});

describe('the sheet takes the frame only where a composer needs it', () => {
  /*
   * ASSERTED ON THE ATTRIBUTE, never on a height. The stylesheet turns
   * `data-size` into `height: 100%` against a frame that is already `100dvh`
   * minus the measured keyboard inset; none of that is visible to jsdom, and a
   * case that pretended otherwise would be reading the fixture back to itself.
   */
  it('Discussion takes the whole frame — it is the aux target you type into', async () => {
    const { view, sheet } = await openAux('discussion');
    expect((sheet.querySelector('.msheet__panel') as HTMLElement).dataset.size).toBe('full');
    view.unmount();
  });

  /*
   * AND THE CONTROL ON IT. Without this case the one above passes just as well
   * on a `MobileSheet` that had been made full-height unconditionally — which
   * would silently cost every other sheet in the app the strip of screen that
   * distinguishes a sheet from a navigation.
   */
  it('Connections keeps the strip — it has nothing to type into', async () => {
    const { view, sheet } = await openAux('connections');
    expect((sheet.querySelector('.msheet__panel') as HTMLElement).dataset.size).toBe('default');
    view.unmount();
  });
});

describe('the desktop third column is untouched', () => {
  /*
   * THE CONTROL ON THE WHOLE FILE. Everything above would also pass on a build
   * that had dropped `.ev-aux__head` in BOTH shells, and that would be a worse
   * defect than the one this lane fixes: the desktop column has no sheet header
   * to fall back on, so it would lose its crumb and its only close control at
   * once. On a desktop there is no sheet host, so `oneSurface` is false and the
   * head is rendered.
   */
  it('keeps its own crumb, its esc hint and its ✕', async () => {
    useDesktopShell(installStorage());
    window.location.hash = '';
    resetNav();
    screenStackStore.getState().clearAll();

    const target = createMemoryTarget(entityHash(A));
    const view = render(<GateApp routerTarget={target} />);
    await waitFor(() => expect(document.querySelector('[data-testid="entity-view"]')).not.toBeNull());

    const control = await waitFor(() => {
      const found = document.querySelector('#tab-discussion');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(control);
    });

    const aux = await waitFor(() => {
      const found = document.querySelector('[data-testid="entity-view-aux"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    expect(aux.querySelectorAll('.ev-aux__head')).toHaveLength(1);
    expect(aux.querySelector('[data-testid="entity-view-aux-close"]')).not.toBeNull();
    expect(aux.textContent).toContain('esc');

    /* And it is a COLUMN, not a sheet: no phone host exists, so `MobileSheet`
       returns null and there is no second header to be the one it kept. */
    expect(document.querySelector('[data-testid="entity-view-aux-sheet"]')).toBeNull();

    view.unmount();
  });
});
