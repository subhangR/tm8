// @vitest-environment jsdom
/**
 * ONE CLICK USED TO DESTROY THE PANEL AND THE SCREEN TOGETHER.
 *
 * `navStore.promote` clears an id from stack AND pins and sets
 * `{view:'entity', entityId, origin:null}`. Its `origin` is read from the
 * OUTGOING view and only a `kind` view has one — so promoting from the
 * workspace produces `e/{id}` with no origin. `landingOfRoute` returns null for
 * that form (resolving it needs the entity's kind, which is a read), so
 * `activeTarget` went null and the whole centre became the loud
 * unrecognised-target card. The panel was gone, the screen was gone, and there
 * was no way back to either.
 *
 * The write is old. Phase 1 (68dc93fd) made `navStore` authoritative, which
 * turned an inert write into a visible one — and its own exit criterion was "no
 * visible change". NOTHING COVERED IT, which is why it shipped, and that is the
 * only reason this file exists.
 *
 * Two guarantees, and they are deliberately separate because the route can
 * arrive without any port to refuse it:
 *   1. The port refuses the promote, so the panel survives.
 *   2. A pasted `e/{id}` gets the unbuilt-screen sentence rather than the
 *      unrecognised-target one — ruling M1 says that route means the Z4 full
 *      view, and that host does not exist yet. A specified route with no screen
 *      is not an unrecognised route, and telling the reader otherwise is false.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
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
});

describe('promote cannot produce a state nothing can host', () => {
  it('keeps the panel, and says why, instead of emptying the screen', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/workspace`);
    const view = render(<GateApp routerTarget={target} />);
    await waitFor(() => view.getByTestId('workspace-grid'));

    /* A panel to promote. The store is the door the app itself uses — the
       gate suite opens panels this way for the same reason. */
    await act(async () => {
      navStore.getState().push('task-guide-lines' as EntityId);
    });
    const promote = await waitFor(() => {
      const grid = view.getByTestId('workspace-grid');
      const btn = within(grid).queryAllByLabelText('Open full view')[0];
      if (!btn) throw new Error('no panel with window controls yet');
      return btn;
    });

    const stackBefore = navStore.getState().stack;
    expect(stackBefore).toContain('task-guide-lines');

    fireEvent.click(promote);

    /* THE PANEL SURVIVES. This is the assertion the regression fails. */
    expect(navStore.getState().stack).toEqual(stackBefore);
    expect(navStore.getState().view.view).not.toBe('entity');
    /* And the screen is still the screen. */
    expect(view.getByTestId('workspace-grid')).toBeTruthy();
    /* Refused OUT LOUD — a control that silently does nothing is its own bug. */
    await waitFor(() => view.getByText(/isn’t built yet/i));
    view.unmount();
  });
});

/**
 * DEF-002 — A BARE `e/{id}` NOW RESOLVES, AND THIS SUITE MOVED WITH IT.
 *
 * These two tests used to assert that a pasted `e/{id}` drew the unbuilt-screen
 * card. That was the honest state of the build when they were written and it is
 * no longer the behaviour, so they assert the new behaviour instead of being
 * loosened around it.
 *
 * WHAT CHANGED AND WHY IT IS NOT A WEAKENING. `landingOfRoute` still returns
 * null for the no-origin form — resolving it needs the entity's KIND, which is
 * a read, and a pure function cannot do a read. `GateApp` now performs that
 * read and applies §2.2's canonical-reload rule, the same rule
 * `EntityFullView.companionOf` already applies when LEAVING an entity: with no
 * origin, the companion screen is the entity's own collection. So the route
 * resolves to exactly what `?origin=` would have produced.
 *
 * The M1 card is NOT deleted — the third test below is it, kept for the case
 * where the rule genuinely yields nothing. That is the distinction the original
 * file was written to protect, and it survives.
 */
describe('a pasted bare e/{id} lands on the entity, not on a card (DEF-002)', () => {
  it('resolves to the entity’s own collection with the entity open', async () => {
    /* The form a person PASTES. A phone is where links are received, which is
       why this is a shell-contract row even though the parse is shared. */
    const target = createMemoryTarget(`#/s/${SPACE}/e/task-4f8c2a9e`);
    const view = render(<GateApp routerTarget={target} />);

    /* The entity is seeded onto the collection's screen stack — the same seam
       `?origin=tasks` writes, reached without the origin being spelled out. */
    await waitFor(() =>
      expect(screenStackStore.getState().stacks['kind:task']).toContain('task-4f8c2a9e'),
    );

    /* And the honest-refusal cards are BOTH absent: this is neither an
       unrecognised target nor a specified-but-unhosted one any more. */
    expect(view.queryByTestId('unrouted-target')).toBeNull();
    expect(view.queryByTestId('entity-full-view-unbuilt')).toBeNull();
    view.unmount();
  });

  it('keeps the address it was given — the bare link stays shareable', async () => {
    /* THE ADDRESS IS NOT REWRITTEN, and that is deliberate rather than
       incidental. `sameDestination` compares `entity` routes by id alone, so
       the screen→URL sync sees the resolved `e/{id}?origin=tasks` it would emit
       as THE SAME PLACE the address already names and declines to write. The
       reader keeps the exact string they were sent, and it keeps working. */
    const hash = `#/s/${SPACE}/e/task-4f8c2a9e`;
    const target = createMemoryTarget(hash);
    const view = render(<GateApp routerTarget={target} />);
    await waitFor(() =>
      expect(screenStackStore.getState().stacks['kind:task']).toContain('task-4f8c2a9e'),
    );
    expect(target.getHash()).toBe(hash);
    view.unmount();
  });

  it('still draws the M1 card for a kind that has nowhere to collapse to', async () => {
    /* THE CASE THE ORIGINAL SUITE EXISTED FOR, PRESERVED.
       `slugOfKind` returns null for the `special` and `anchored` strategies —
       `voice_channel` and `message` have no `k/` view BY DESIGN (WLT §2.1). A
       null there is a FACT ABOUT THE KIND, not a broken link, so the rule
       yields nothing and ruling M1's card is still the honest answer: the route
       is right, and there is no screen behind it. */
    const target = createMemoryTarget(`#/s/${SPACE}/e/vc-standup`);
    const view = render(<GateApp routerTarget={target} />);
    await waitFor(() => view.getByTestId('entity-full-view-unbuilt'));
    expect(view.queryByTestId('unrouted-target')).toBeNull();
    view.unmount();
  });
});
