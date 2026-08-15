// @vitest-environment jsdom
/**
 * THE LINK REFUSALS, WIRED — a bad link must not land you somewhere else.
 *
 * `views/link-refusal/link-refusal.test.tsx` pins the CARDS: given the props,
 * they render the right words. It could pass forever with nothing rendering
 * them, and for a while that is exactly what it did. These cases pin the
 * WIRING: that the composed app reaches those cards on the two paths they were
 * built for, and — the assertion that actually matters — that it reaches
 * NOTHING ELSE.
 *
 * The negative assertions are the point of the file. "The refusal appeared" is
 * satisfied by a shell that also opened somebody else's Space behind it; the
 * failure being removed is precisely the thing rendered *instead*, so every
 * case asserts the absence too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { CollabError } from '@tm8/contract';
import type { EntityId, SpaceId } from '@tm8/contract';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget, type MemoryTarget } from '../routes';
import { createFixtureSeam } from '../data';
import type { Seam } from '../data/seam';
import { FIXTURE_SPACE_ID } from '../fixtures';

const SPACE = FIXTURE_SPACE_ID;
/** A Space id the fixture node does not list. Whether it EXISTS is the point:
    the shell must not be able to tell, and neither must this test. */
const UNREACHABLE = 'sp-not-yours' as SpaceId;
/** An entity id the fixture dataset has never held — `seam.entity` 404s on it. */
const GONE = 'entity-long-gone' as EntityId;

/** The storage double this runner needs; replaced per case so no memory leaks
    between them (the same one `router-mount.test.tsx` carries). */
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

beforeEach(() => {
  installStorage();
  resetNav();
  /* jsdom keeps ONE `window.location` per file and an addressable hash at boot
     outranks last-place, so a case that navigated would otherwise boot the
     next one from its address. */
  window.location.hash = '';
  screenStackStore.getState().clearAll();
});

afterEach(cleanup);

/** A seam that records every Space it was asked to OPEN. The strongest form of
    "nothing was substituted" is that no substitute was ever opened. */
function recordingSeam(): { seam: Seam; opened: SpaceId[] } {
  const fixture = createFixtureSeam();
  const opened: SpaceId[] = [];
  return {
    opened,
    seam: {
      ...fixture,
      openSpace: async (id: SpaceId) => {
        opened.push(id);
        return fixture.openSpace(id);
      },
    },
  };
}

/** Let the router's debounced replace (50ms) settle, so a write is measured once. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

const mount = (target: MemoryTarget, seam?: Seam) =>
  render(<GateApp routerTarget={target} {...(seam ? { seam } : {})} />);

describe('a link into a Space the viewer cannot open', () => {
  it('renders the refusal and opens no Space at all', async () => {
    /* THE BUG, STATED AS A TEST. The boot picked `remembered ?? list[0]`
       unconditionally, so this link put the recipient inside a DIFFERENT Space
       under this Space's address, with a toast as the only clue. */
    const { seam, opened } = recordingSeam();
    const target = createMemoryTarget(`#/s/${UNREACHABLE}/workspace`);
    const view = mount(target, seam);

    await waitFor(() => view.getByTestId('space-access-refusal'));
    /* The three things that must NOT be on screen: the workspace of some other
       Space, a kind screen of some other Space, and a spinner implying the
       question is still open. */
    expect(view.queryByTestId('workspace-grid')).toBeNull();
    expect(view.queryByTestId('entity-view')).toBeNull();
    /* And the fact underneath the words: no Space was ever opened, so
       "Nothing else was opened in its place" is true of the machine and not
       just of the copy. */
    await settle();
    expect(opened).toEqual([]);
  });

  it('does not say WHICH refusal it was — R4, the probing case', async () => {
    /* A stranger holding a URL learns nothing here. "Not a member of this
       Space" would CONFIRM THE SPACE EXISTS, which is the one disclosure the
       ruling prevents; "no such Space on this node" gives the same fact away
       inverted. The two specific cards stay unused on this path BY DESIGN, and
       this case is what stops a later reader from wiring them in for
       friendliness. */
    const target = createMemoryTarget(`#/s/${UNREACHABLE}/workspace`);
    const view = mount(target);

    await waitFor(() => view.getByTestId('space-access-refusal'));
    expect(view.queryByTestId('wrong-node-refusal')).toBeNull();
    expect(view.queryByTestId('not-space-member-refusal')).toBeNull();
  });

  it('does not substitute the Space this browser remembers either', async () => {
    /* The remembered Space is the tempting substitute — it is a Space the
       viewer really can open, so the shell "works". It is still not the Space
       the link named, and swapping it in is the same lie with a nicer excuse. */
    const warm = createMemoryTarget(`#/s/${SPACE}/workspace`);
    const a = mount(warm);
    await waitFor(() => a.getByTestId('workspace-grid'));
    await settle();
    a.unmount();

    resetNav();
    screenStackStore.getState().clearAll();
    const { seam, opened } = recordingSeam();
    const target = createMemoryTarget(`#/s/${UNREACHABLE}/workspace`);
    const view = mount(target, seam);

    await waitFor(() => view.getByTestId('space-access-refusal'));
    await settle();
    expect(opened).toEqual([]);
    expect(view.queryByTestId('workspace-grid')).toBeNull();
  });

  it('opens an available Space only when the viewer asks for one', async () => {
    /* The hazard is IMPLICIT substitution, not substitution. The card's button
       is an explicit act, and after it the shell is a normal shell — which is
       what keeps the refusal from being a dead end. */
    const { seam, opened } = recordingSeam();
    const target = createMemoryTarget(`#/s/${UNREACHABLE}/workspace`);
    const view = mount(target, seam);

    const card = await waitFor(() => view.getByTestId('space-access-refusal'));
    await settle();
    expect(opened).toEqual([]);

    fireEvent.click(card.querySelector('button')!);
    await waitFor(() => expect(opened).toEqual([SPACE]));
  });
});

describe('a link to an entity that is gone', () => {
  it('renders the tombstone instead of the screen the link resolved to', async () => {
    /* The Space opened, so nothing above this failed and the origin screen
       would happily draw itself with an empty panel where the entity should
       be — a link resolving to a screen the sender never meant, saying
       nothing. */
    const target = createMemoryTarget(`#/s/${SPACE}/e/${GONE}?origin=tasks`);
    const view = mount(target);

    await waitFor(() => view.getByTestId('entity-unavailable-refusal'));
    expect(view.queryByTestId('entity-view')).toBeNull();
  });

  it('renders it for the bare e/{id} form too', async () => {
    /* No `origin`, so the route resolves to no screen at all. "Unavailable" is
       a different sentence from "this build has no screen for that", and the
       recipient of a dead link needs the first one. */
    const target = createMemoryTarget(`#/s/${SPACE}/e/${GONE}`);
    const view = mount(target);

    await waitFor(() => view.getByTestId('entity-unavailable-refusal'));
    expect(view.queryByTestId('entity-full-view-unbuilt')).toBeNull();
  });

  it('recovers by REPLACING the broken URL, so Back cannot resurrect it', async () => {
    /* The hazard the author flagged. A recovery that PUSHED would leave the
       dead address one back-press away, and the viewer's instinct after
       landing on a tombstone is to press Back — straight onto the tombstone
       again, in a loop with no exit. */
    const target = createMemoryTarget(`#/s/${SPACE}/e/${GONE}?origin=tasks`);
    const view = mount(target);

    const card = await waitFor(() => view.getByTestId('entity-unavailable-refusal'));
    fireEvent.click(card.querySelector('button')!);
    await settle();

    /* Not "the current hash changed" — the whole STACK is asserted, because a
       push also changes the current hash and is exactly the bug. */
    expect(target.entries.some((entry) => entry.includes(GONE))).toBe(false);

    target.back();
    await settle();
    expect(target.getHash()).not.toContain(GONE);
    expect(view.queryByTestId('entity-unavailable-refusal')).toBeNull();
  });

  it('does not call a node that could not answer a deletion', async () => {
    /* `unreadable` is not `dead`. A 503 or a dropped connection is not
       evidence that anything was deleted, and a tombstone drawn from one is
       the same class of lie pointed the other way — it tells the reader to
       stop trying about a link that is fine. */
    const fixture = createFixtureSeam();
    const seam: Seam = {
      ...fixture,
      entity: async () => {
        throw new CollabError('upstream_unavailable', 'the node blinked');
      },
    };
    const target = createMemoryTarget(`#/s/${SPACE}/e/${GONE}?origin=tasks`);
    const view = mount(target, seam);

    await waitFor(() => view.getByTestId('entity-view'));
    expect(view.queryByTestId('entity-unavailable-refusal')).toBeNull();
  });
});
