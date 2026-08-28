// @vitest-environment jsdom
/**
 * THE ROUTER IS MOUNTED — the acceptance loop for a shared link.
 *
 * `attachRouter` has been built and tested for a long time with no non-test
 * caller, so every one of these properties was true of a function nobody
 * called. The unit tests in `stores/navStore.test.ts` prove the LOOP; these
 * prove the MOUNT — that the composed app actually hydrates from the address,
 * writes back to it, and lets the address win where it has to.
 *
 * The memory target is the same double `navStore.test.ts` drives, injected
 * through `GateApp`'s `routerTarget` port. It is a real history stack with
 * back/forward, which is the only way to assert the history discipline: a
 * boolean "did it write" cannot tell a push from a replace, and the difference
 * between them IS the back button.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { navStore, resetNav } from '../stores/navStore';
import { screenKeyOf, screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget, MAX_HASH_LENGTH, type MemoryTarget } from '../routes';
import type { EntityId } from '@tm8/contract';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { LOCAL_SERVER, type UiServer } from '../servers';

/** A second Server, so the switch is a real one. Shape from server-signin.test.tsx. */
const STAGING: UiServer = {
  id: 'staging',
  label: 'staging · box',
  baseUrl: 'https://box.example:8888',
  routeBaseUrl: '/v2/server-connections/staging/proxy',
  reachability: 'ok',
};

const SPACE = FIXTURE_SPACE_ID;
/** A task the fixture dataset really holds, so the seeded screen has content. */
const TASK = 'task-4f8c2a9e' as EntityId;

/**
 * The `last-place-gate.test.tsx` storage double — load-bearing under this
 * runner, whose `localStorage` arrives without `setItem`/`removeItem`, and
 * replaced per case so a remembered target cannot leak between them.
 */
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
  screenStackStore.getState().clearAll();
});

const mount = (target: MemoryTarget) => render(<GateApp routerTarget={target} />);

/** Let the debounced replace (50ms) settle, so a write is measured once. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

describe('URL → screen', () => {
  it('lands a k/{slug} link on that kind screen', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/k/tasks`);
    const view = mount(target);
    await waitFor(() => view.getByTestId('entity-view'));
    /* The workspace is the FALLBACK this whole lane exists to stop being the
       answer, so its absence is the assertion that matters. */
    expect(view.queryByTestId('workspace-grid')).toBeNull();
    view.unmount();
  });

  it('lands a workspace link on the workspace', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/workspace`);
    const view = mount(target);
    await waitFor(() => view.getByTestId('workspace-grid'));
    view.unmount();
  });

  it('SEEDS THE SCREEN STACK from e/{id}?origin= — the shared-entity link', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/e/${TASK}?origin=tasks`);
    const view = mount(target);
    /* Both halves of the landing: the Tasks screen is what renders, and THAT
       entity is what it has open. Before the mount, the second half had no
       consumer at all. */
    await waitFor(() => view.getByTestId('entity-view'));
    await waitFor(() =>
      expect(screenStackStore.getState().stacks[screenKeyOf.kind('task')]).toEqual([TASK]),
    );
    view.unmount();
  });

  it('OPENS the session a ?session= link names', async () => {
    /* `selectAutoOpenSession` was written, tested and never called, so a link
       to a live session parsed cleanly, round-tripped faithfully, and landed
       the recipient on an EMPTY workspace. The param meant nothing. */
    const session = '019f0000-0000-7000-8000-000000000031' as EntityId;
    const target = createMemoryTarget(`#/s/${SPACE}/workspace?session=${session}`);
    const view = mount(target);
    await waitFor(() => view.getByTestId('workspace-grid'));
    await waitFor(() => expect(navStore.getState().stack).toContain(session));
    view.unmount();
  });

  it('lets a link that names its panels outrank the ?session= shorthand', async () => {
    /* §2.2: `session` auto-opens ONLY when `p` and `pin` are both absent. An
       explicit panel list is the sender being specific, and specificity wins. */
    const session = '019f0000-0000-7000-8000-000000000031' as EntityId;
    const target = createMemoryTarget(`#/s/${SPACE}/workspace?p=${TASK}&session=${session}`);
    const view = mount(target);
    await waitFor(() => view.getByTestId('workspace-grid'));
    await settle();
    expect(navStore.getState().stack).toEqual([TASK]);
    view.unmount();
  });

  it('lands the board route on the Board tab, full-bleed', async () => {
    /* Board tab wave: `#/s/{s}/board` is a menu VIEW (migration 130), so the
       link must land on the kanban screen, not the workspace fallback. */
    const target = createMemoryTarget(`#/s/${SPACE}/board`);
    const view = mount(target);
    await waitFor(() => view.getByTestId('board-screen'));
    expect(view.queryByTestId('workspace-grid')).toBeNull();
    view.unmount();
  });

  it('reports an unaddressable hash instead of guessing', async () => {
    /* `#/` names no space. `attachRouter` fires `onSpacePicker` and hydrates
       nothing, which is what lets last-place apply — asserted below. */
    const target = createMemoryTarget('#/');
    const view = mount(target);
    /* Revision 11: no memory, no address — the merged Home is the landing. */
    await waitFor(() => view.getByTestId('home-page'));
    view.unmount();
  });
});

describe('screen → URL', () => {
  it('writes the kind route when the rail navigates, and PUSHES it', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/workspace`);
    const view = mount(target);
    await waitFor(() => view.getByTestId('workspace-grid'));
    const before = target.entries.length;

    {
      /* Revision 17: the Work tab retired — the guaranteed `g t` chord is
         the user-navigation door to the Tasks screen. */
      fireEvent.keyDown(window, { key: 'g' });
      fireEvent.keyDown(window, { key: 't' });
    }
    await waitFor(() => view.getByTestId('entity-view'));
    await settle();

    expect(target.getHash()).toBe(`#/s/${SPACE}/k/tasks`);
    /* USER NAVIGATION IS A PUSH. If this were a replace the back button would
       skip the workspace entirely, which is the failure the history discipline
       exists to prevent. */
    expect(target.entries.length).toBe(before + 1);
    view.unmount();
  });

  it('round-trips: the URL a rail click writes lands on the same screen', async () => {
    const first = createMemoryTarget(`#/s/${SPACE}/workspace`);
    const a = mount(first);
    await waitFor(() => a.getByTestId('workspace-grid'));
    {
      /* Revision 17: the Work tab retired — the guaranteed `g t` chord is
         the user-navigation door to the Tasks screen. */
      fireEvent.keyDown(window, { key: 'g' });
      fireEvent.keyDown(window, { key: 't' });
    }
    await waitFor(() => a.getByTestId('entity-view'));
    await settle();
    const shared = first.getHash();
    a.unmount();

    resetNav();
    screenStackStore.getState().clearAll();
    const second = createMemoryTarget(shared);
    const b = mount(second);
    await waitFor(() => b.getByTestId('entity-view'));
    expect(b.queryByTestId('workspace-grid')).toBeNull();
    b.unmount();
  });
});

describe('the entity a screen has open is part of the address', () => {
  it('drilling in writes e/{id}?origin=, and pushes', async () => {
    /* Before the mount this state lived only in `screenStackStore`: the address
       bar said `k/tasks` however deep you had drilled, so it could not be
       copied to share what was on screen and a reload came back to the list. */
    const target = createMemoryTarget(`#/s/${SPACE}/k/tasks`);
    const view = mount(target);
    await waitFor(() => view.getByTestId('entity-view'));
    const before = target.entries.length;

    await act(async () => {
      screenStackStore.getState().open(screenKeyOf.kind('task'), TASK);
    });
    await settle();

    expect(target.getHash()).toBe(`#/s/${SPACE}/e/${TASK}?origin=tasks`);
    expect(target.entries.length).toBe(before + 1);
    view.unmount();
  });

  it('does not rewrite the address it just arrived at', async () => {
    /* The seed and this sync are the same loop run in both directions, so an
       inexact fixed point would have them pushing history at each other. */
    const hash = `#/s/${SPACE}/e/${TASK}?origin=tasks`;
    const target = createMemoryTarget(hash);
    const view = mount(target);
    await waitFor(() => view.getByTestId('entity-view'));
    await settle();
    expect(target.getHash()).toBe(hash);
    expect(target.entries.length).toBe(1);
    view.unmount();
  });
});

describe('R15 — a cold entry steps UP, and up is a replace', () => {
  it('does not trap a pasted link in a two-item loop', async () => {
    /* Depth 1: nothing is behind this entry, so `‹` cannot mean back and can
       only mean up. If up PUSHED, back would return to the entity and there
       would be no way out — on the exact path a shared link creates. */
    const target = createMemoryTarget(`#/s/${SPACE}/e/${TASK}?origin=tasks`);
    expect(target.entries.length).toBe(1);
    const view = mount(target);
    await waitFor(() => view.getByTestId('entity-view'));
    await settle();

    /* The store the Esc handler drives — up, one rung. */
    await act(async () => {
      screenStackStore.getState().pop(screenKeyOf.kind('task'));
    });
    await settle();

    expect(target.getHash()).toBe(`#/s/${SPACE}/k/tasks`);
    /* REPLACED, NOT PUSHED. The whole assertion. */
    expect(target.entries.length).toBe(1);
    expect(target.canGoBack()).toBe(false);
    view.unmount();
  });

  it('spends the concession once — the next step up is an ordinary push', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/e/${TASK}?origin=tasks`);
    const view = mount(target);
    await waitFor(() => view.getByTestId('entity-view'));
    /* React 19: the seed effect that opens the addressed entity settles a
       beat later than the screen's first paint — step up before it lands and
       the pop precedes the open it undoes. The passing sibling above always
       settled here; this test needs the same beat. */
    await settle();
    await act(async () => {
      screenStackStore.getState().pop(screenKeyOf.kind('task'));
    });
    await settle();
    const afterUp = target.entries.length;

    await act(async () => {
      screenStackStore.getState().open(screenKeyOf.kind('task'), TASK);
    });
    await settle();
    await act(async () => {
      screenStackStore.getState().pop(screenKeyOf.kind('task'));
    });
    await settle();

    /* Two real navigations once a history exists, not two more replaces.
       React 19 commits the store→hash effect later than 18 did — wait for
       the pushes rather than reading the ledger synchronously. */
    await waitFor(() => expect(target.entries.length).toBe(afterUp + 2));
    view.unmount();
  });
});

describe('back and forward', () => {
  it('walks back to where you were and forward again', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/workspace`);
    const view = mount(target);
    await waitFor(() => view.getByTestId('workspace-grid'));

    {
      /* Revision 17: the Work tab retired — the guaranteed `g t` chord is
         the user-navigation door to the Tasks screen. */
      fireEvent.keyDown(window, { key: 'g' });
      fireEvent.keyDown(window, { key: 't' });
    }
    await waitFor(() => view.getByTestId('entity-view'));
    await settle();

    await act(async () => {
      target.back();
    });
    await waitFor(() => view.getByTestId('workspace-grid'));

    await act(async () => {
      target.forward();
    });
    await waitFor(() => view.getByTestId('entity-view'));
    view.unmount();
  });
});

describe('R3 — an addressable hash at boot OUTRANKS last-place', () => {
  it('honours the link even when last-place remembers somewhere else', async () => {
    /* THE RACE, EXACTLY. The boot restore fires when `data.spaceId` lands
       ASYNCHRONOUSLY, which is strictly after the router has synchronously
       hydrated the link — so without R3 the link ARRIVES FIRST AND LOSES, and
       every shared link is silently discarded by a restore nobody asked for.

       Last place is written by visiting Tasks and remounting, which is the only
       way to produce a record the real code would read. */
    const warm = createMemoryTarget(`#/s/${SPACE}/workspace`);
    const a = mount(warm);
    await waitFor(() => a.getByTestId('workspace-grid'));
    {
      /* Revision 17: the Work tab retired — the guaranteed `g t` chord is
         the user-navigation door to the Tasks screen. */
      fireEvent.keyDown(window, { key: 'g' });
      fireEvent.keyDown(window, { key: 't' });
    }
    await waitFor(() => a.getByTestId('entity-view'));
    await settle();
    a.unmount();

    resetNav();
    screenStackStore.getState().clearAll();
    /* The link says workspace; the memory says Tasks. The link wins. */
    const link = createMemoryTarget(`#/s/${SPACE}/workspace`);
    const b = mount(link);
    await waitFor(() => b.getByTestId('workspace-grid'));
    await settle();
    expect(b.queryByTestId('entity-view')).toBeNull();
    expect(link.getHash()).toBe(`#/s/${SPACE}/workspace`);
    b.unmount();
  });

  it('still falls back to last-place when the hash addresses nothing', async () => {
    /* The other half, and the reason R3 is a precedence rule rather than a
       removal: last-place is not dead, it is second. */
    const warm = createMemoryTarget(`#/s/${SPACE}/workspace`);
    const a = mount(warm);
    await waitFor(() => a.getByTestId('workspace-grid'));
    {
      /* Revision 17: the Work tab retired — the guaranteed `g t` chord is
         the user-navigation door to the Tasks screen. */
      fireEvent.keyDown(window, { key: 'g' });
      fireEvent.keyDown(window, { key: 't' });
    }
    await waitFor(() => a.getByTestId('entity-view'));
    await settle();
    a.unmount();

    resetNav();
    screenStackStore.getState().clearAll();
    const cold = createMemoryTarget('#/');
    const b = mount(cold);
    await waitFor(() => b.getByTestId('entity-view'));
    b.unmount();
  });
});

describe('a Server switch does not carry the old Server’s address', () => {
  it('resets the address to the unaddressable form', async () => {
    /* Switching Server re-keys GateApp, so the router detaches and a fresh one
       mounts AND READS THE ADDRESS — which still names a Space on the Server
       just left. That hash is addressable, so R3 honours it, the boot refuses
       last-place, and the reconciliation then tells the viewer "that link
       points at another Space" about a link nobody clicked.

       Space ids are not portable across Servers: named Servers are same-origin
       relay routes, so the same hash resolves against whichever Server is
       active — the ambiguity ruling M2 exists to settle. Until it does, the
       honest reset is "this boot carried no route". */
    const target = createMemoryTarget(`#/s/${SPACE}/k/tasks`);
    const switched: string[] = [];
    const view = render(
      <GateApp
        routerTarget={target}
        activeServer={LOCAL_SERVER}
        servers={[LOCAL_SERVER, STAGING]}
        onSelectServer={(id) => switched.push(id)}
      />,
    );
    await waitFor(() => view.getByTestId('entity-view'));
    await settle();
    expect(target.getHash()).toBe(`#/s/${SPACE}/k/tasks`);

    /* Revision 11: servers moved into the identity block's popover. */
    fireEvent.click(view.getByLabelText(/^Server and space:/));
    fireEvent.click(within(view.getByRole('dialog')).getByText('staging · box'));

    /* The switch really happened — otherwise this would assert the reset of a
       button that did nothing. */
    expect(switched).toEqual(['staging']);
    expect(target.getHash()).toBe('#/');
    view.unmount();
  });
});

/*
 * NOT COVERED HERE, AND SAID RATHER THAN LEFT LOOKING COVERED: the space-switch
 * reset's history discipline. `leaveSpaceContext` now writes its interim
 * workspace view as a REPLACE instead of a push (it used to leave a back entry
 * for the space you were leaving, because the store still holds the old space
 * id at that instant). The fixture node serves exactly ONE space, so neither
 * the tab bar's switch nor the rail's server switch is reachable from this
 * harness, and every "equivalent" I could drive by hand would assert the
 * transitions that were ALREADY replaces while missing the view write that
 * changed. A test that exercises the wrong line and passes is worse than a
 * stated gap. It needs a multi-space seam, which belongs with whoever adds one.
 */

describe('an over-cap link says what it dropped', () => {
  it('surfaces the overflow notice rather than truncating in silence', async () => {
    /* R4-7: the 2048-char cap drops whole params in a ruled tier order, and a
       silent drop is indistinguishable from a link that never carried the
       state. Built from many pinned ids so `build` has something to drop. */
    const ids = Array.from({ length: 200 }, (_, i) => `entity-${String(i).padStart(40, '0')}`);
    const hash = `#/s/${SPACE}/workspace?p=${ids.join(',')}`;
    expect(hash.length).toBeGreaterThan(MAX_HASH_LENGTH);

    const target = createMemoryTarget(hash);
    const view = mount(target);
    await waitFor(() => view.getByTestId('workspace-grid'));
    await settle();
    /* Asserted against the notice HOST rather than by text query: the card's
       title and body both legitimately mention the drop, so a text matcher
       finds two elements and throws on the ambiguity rather than on the fact.
       The host is the single place the app promises this appears. */
    const host = await waitFor(() => {
      const el = view.getByTestId('notice-host');
      if (!/couldn’t be carried/i.test(el.textContent ?? '')) throw new Error('no notice yet');
      return el;
    });
    /* AND IT NAMES THE CLASS. R4-7's actual requirement: "some state wasn't
       carried" is a sentence a reader can do nothing with — it does not say
       whether they lost a filter they can retype or panels they cannot
       reconstruct. `DROP_CLASS_COPY` supplies the words. */
    expect(host.textContent).toMatch(/open panels|pinned panels/i);
    view.unmount();
  });
});

describe('the space the link names outranks the space you last had open', () => {
  it('says so out loud when the node does not list that Space', async () => {
    /* Not an error to swallow: showing a different Space's content under that
       address is the failure this lane removes. The fixture node serves exactly
       one space, so an unknown one is easy to name. */
    const target = createMemoryTarget('#/s/sp-not-yours/workspace');
    const view = mount(target);
    await waitFor(() => view.getByText(/another Space/i));
    /* And it lands them somewhere real rather than on a blank refusal —
       with no remembered place, that is the merged Home (revision 11). */
    await waitFor(() => view.getByTestId('home-page'));
    view.unmount();
  });
});

afterEach(() => {
  cleanup();
});
