// @vitest-environment jsdom
/**
 * `e/{id}` IS THE Z4 ENTITY FULL VIEW — the wiring, for both callers.
 *
 * `views/entity-full/entity-full-view.test.tsx` pins the COMPONENT: given the
 * props, it resolves and renders correctly. It passed for a long time while
 * nothing rendered it, which is the same shape as the router's own history —
 * built, correct, unreached. These cases pin the MOUNT.
 *
 * THE FILE THIS REPLACES asserted the opposite of most of it, and deliberately
 * so: promote was REFUSED and a pasted `e/{id}` drew a not-built-yet card,
 * because ruling M1 named a host that did not exist. It exists now. What was
 * worth keeping from that file is kept here — the promote regression it was
 * written for (one click emptied both the panel and the screen) is still the
 * thing the promote cases measure, only from the other side.
 *
 * ── WHY EVERY CASE BELOW IS ABOUT HISTORY ──────────────────────────────────
 *
 * Two callers share this address and arrive OPPOSITELY. A pasted link has
 * nothing behind it, so its first step up must REPLACE (R15) or Back returns
 * to the entity and the viewer is trapped in a two-item loop — on the exact
 * entry path a shared link creates. A promote arrived BY a push with a live
 * stack behind it, so the same step must PUSH. Same URL, same store shape,
 * opposite correct behaviour, and the difference is reported as "the back
 * button is broken" and takes a week to trace. So the entries array is
 * asserted, never just the current hash: a boolean "did it write" cannot tell
 * a push from a replace, and that difference IS the back button.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { CollabError } from '@tm8/contract';
import type { EntityId } from '@tm8/contract';
import { GateApp } from './GateApp';
import { navStore, resetNav } from '../stores/navStore';
import { screenKeyOf, screenStackStore, topOf } from '../stores/screenStackStore';
import { createMemoryTarget, type MemoryTarget } from '../routes';
import { createFixtureSeam } from '../data';
import type { Seam } from '../data/seam';
import { SHELL_OVERRIDE_KEY } from '../mobile';
import { FIXTURE_SPACE_ID } from '../fixtures';

const SPACE = FIXTURE_SPACE_ID;
/** A task the fixture dataset really holds, so the panel has something to draw. */
const TASK = 'task-4f8c2a9e' as EntityId;
/** An id the fixture node has never held — `seam.entity` 404s on it. */
const GONE = 'entity-long-gone' as EntityId;

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
  /* jsdom keeps ONE `window.location` per file and an addressable hash at boot
     outranks last-place, so a case that navigated would boot the next one from
     its address. */
  window.location.hash = '';
  screenStackStore.getState().clearAll();
});

afterEach(cleanup);

const mount = (target: MemoryTarget, seam?: Seam) =>
  render(<GateApp routerTarget={target} {...(seam ? { seam } : {})} />);

/** Let the router's debounced replace (50ms) settle, so a write is measured once. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

describe('the cold caller — a pasted link', () => {
  it('draws the Z4 host for the bare form, where no screen could be derived at all', async () => {
    /* `landingOfRoute` returns null here — resolving the companion needs the
       entity's KIND, which is a read — so this address used to reach the
       not-built card and, before that, the loud unrecognised-target one. */
    const target = createMemoryTarget(`#/s/${SPACE}/e/${TASK}`);
    const view = mount(target);

    const host = await waitFor(() => view.getByTestId('z4-host'));
    expect(host.getAttribute('data-entity-id')).toBe(TASK);
    expect(view.queryByTestId('unrouted-target')).toBeNull();
  });

  it('draws it for the origin-bearing form too — the ruling is not half-applied', async () => {
    /* THE CASE MOST LIKELY TO BE GOT WRONG. `e/{id}?origin=tasks` resolves its
       `activeTarget` to the TASKS KIND, so every arm keyed on the target would
       draw the list — which is precisely the kind-screen-plus-seed shape M1
       replaced, surviving in the form a shared link most often takes. */
    const target = createMemoryTarget(`#/s/${SPACE}/e/${TASK}?origin=tasks`);
    const view = mount(target);

    await waitFor(() => view.getByTestId('z4-host'));
    expect(view.queryByTestId('entity-view')).toBeNull();
  });

  it('keeps the address it was given', async () => {
    /* The link is correct and shareable; landing on it must not rewrite it. */
    const hash = `#/s/${SPACE}/e/${TASK}?origin=tasks`;
    const target = createMemoryTarget(hash);
    const view = mount(target);

    await waitFor(() => view.getByTestId('z4-host'));
    await settle();
    expect(target.getHash()).toBe(hash);
    expect(target.entries.length).toBe(1);
  });

  it('steps UP with a REPLACE, so Back cannot return to the entity (R15)', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/e/${TASK}?origin=tasks`);
    expect(target.entries.length).toBe(1);
    const view = mount(target);

    const collapse = await waitFor(() => view.getByLabelText('Collapse full view'));
    fireEvent.click(collapse);
    await settle();

    expect(target.getHash()).toBe(`#/s/${SPACE}/k/tasks`);
    /* REPLACED, NOT PUSHED — the whole assertion. A push would leave the
       entity one Back away from a screen whose only exit is Back. */
    expect(target.entries.length).toBe(1);
    expect(target.canGoBack()).toBe(false);
  });

  it('collapses onto the companion WITH THAT ENTITY OPEN (§2.2)', async () => {
    /* The seed's job under M1. Collapsing to a bare list would drop the subject
       the viewer was reading and quietly discard the `origin=` the link
       carried — the link would have named a collection, not a thing in it. */
    const target = createMemoryTarget(`#/s/${SPACE}/e/${TASK}?origin=tasks`);
    const view = mount(target);

    fireEvent.click(await waitFor(() => view.getByLabelText('Collapse full view')));
    await settle();

    expect(topOf(screenStackStore.getState(), screenKeyOf.kind('task'))).toBe(TASK);
    await waitFor(() => view.getByTestId('entity-view'));
  });

  it('resolves the companion from the ENTITY when the address names no origin', async () => {
    /* The canonical-reload rule (WLT §2.2), and the reason T7 exists: an opaque
       id reveals no kind, so the companion comes from the registry strategy —
       which needs the read this route already makes. */
    const target = createMemoryTarget(`#/s/${SPACE}/e/${TASK}`);
    const view = mount(target);

    fireEvent.click(await waitFor(() => view.getByLabelText('Collapse full view')));
    await settle();

    expect(target.getHash()).toBe(`#/s/${SPACE}/k/tasks`);
  });
});

describe('the workspace caller — promote ⤢', () => {
  it('promotes into the full view instead of refusing it', async () => {
    /* The regression this file was originally written for, from the other
       side: `navStore.promote` clears the id from stack AND pins and writes
       `{view:'entity', origin:null}`, so one click destroyed the panel and
       replaced the screen with the unrecognised card. A guard held it. The
       guard is gone because the destination exists. */
    const target = createMemoryTarget(`#/s/${SPACE}/workspace`);
    const view = mount(target);
    await waitFor(() => view.getByTestId('workspace-grid'));

    await act(async () => {
      navStore.getState().push('task-guide-lines' as EntityId);
    });
    const promote = await waitFor(() => {
      const grid = view.getByTestId('workspace-grid');
      const btn = within(grid).queryAllByLabelText('Open full view')[0];
      if (!btn) throw new Error('no panel with window controls yet');
      return btn;
    });

    fireEvent.click(promote);

    const host = await waitFor(() => view.getByTestId('z4-host'));
    expect(host.getAttribute('data-entity-id')).toBe('task-guide-lines');
    /* §5.2c single-host: the id leaves BOTH sets, so the panel is not also
       mounted in the centre behind this. */
    expect(navStore.getState().stack).not.toContain('task-guide-lines');
    expect(navStore.getState().pinned).not.toContain('task-guide-lines');
  });

  it('collapses with a PUSH, because it arrived by one', async () => {
    /* THE OPPOSITE OF R15, AT THE SAME ADDRESS. Nothing about the URL says
       which of these two happened — only the door the viewer came through
       does, which is why `arrival` is recorded at the promote and not sniffed
       from the store. Boot depth here is 1, exactly as for a pasted link, so a
       history rule reading only depth would replace and eat the workspace. */
    const target = createMemoryTarget(`#/s/${SPACE}/workspace`);
    const view = mount(target);
    await waitFor(() => view.getByTestId('workspace-grid'));

    await act(async () => {
      navStore.getState().push('task-guide-lines' as EntityId);
    });
    fireEvent.click(
      await waitFor(() => {
        const btn = within(view.getByTestId('workspace-grid')).queryAllByLabelText(
          'Open full view',
        )[0];
        if (!btn) throw new Error('no panel yet');
        return btn;
      }),
    );
    await waitFor(() => view.getByTestId('z4-host'));
    await settle();
    const afterPromote = target.entries.length;

    fireEvent.click(view.getByLabelText('Collapse full view'));
    await settle();

    expect(target.entries.length).toBe(afterPromote + 1);
    expect(target.canGoBack()).toBe(true);
  });
});

describe('the four states of the no-origin read (T7)', () => {
  it('shows the resolving state while the read is in flight — not a panel skeleton', async () => {
    /* A panel skeleton promises an entity that may never come. Here we do not
       yet know there is anything to draw, and the two are different sentences. */
    const fixture = createFixtureSeam();
    const seam: Seam = { ...fixture, entity: () => new Promise(() => undefined) };
    const target = createMemoryTarget(`#/s/${SPACE}/e/${TASK}`);
    const view = mount(target, seam);

    await waitFor(() => view.getByTestId('entity-full-view-resolving'));
    expect(view.queryByTestId('entity-unavailable-refusal')).toBeNull();
  });

  it('draws the panel once the entity resolves', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/e/${TASK}`);
    const view = mount(target);

    await waitFor(() => view.getByTestId('z4-host'));
    expect(view.queryByTestId('entity-full-view-resolving')).toBeNull();
    /* The SAME panel every other host mounts, told to render as Z4. */
    await waitFor(() => expect(view.container.querySelector('[data-host="z4"]')).toBeTruthy());
  });

  it('is NOT a tombstone when the node merely could not answer', async () => {
    /* `unreadable` is not `dead`. A 503 is not evidence of a deletion, and a
       card saying "deleted" about a node timeout is the same lie pointed the
       other way. With no kind there is no companion, so no collapse control is
       drawn — a control that cannot perform is not drawn at all. */
    const fixture = createFixtureSeam();
    const seam: Seam = {
      ...fixture,
      entity: async () => {
        throw new CollabError('upstream_unavailable', 'the node blinked');
      },
    };
    const target = createMemoryTarget(`#/s/${SPACE}/e/${TASK}`);
    const view = mount(target, seam);

    await waitFor(() => view.getByTestId('z4-host'));
    expect(view.queryByTestId('entity-unavailable-refusal')).toBeNull();
    expect(view.queryByLabelText('Collapse full view')).toBeNull();
  });

  it('draws the standalone tombstone when the entity is gone, and no host at all', async () => {
    /* The §4.14 shape: a tombstone is STANDALONE — no companion, no collapsed
       left panel — and it is rendered above the shell fork because a refusal
       must not fork. So the Z4 host must not also be on screen underneath it. */
    const target = createMemoryTarget(`#/s/${SPACE}/e/${GONE}`);
    const view = mount(target);

    await waitFor(() => view.getByTestId('entity-unavailable-refusal'));
    expect(view.queryByTestId('z4-host')).toBeNull();
  });
});

describe('one host, two shells', () => {
  it('renders the full view on a phone too — the link is opened there most', async () => {
    /* "The shell forks and the router does not." Built inside the desktop
       return, this screen would simply not exist on a phone and a shared entity
       link would land on "this link doesn't name a screen this build has" —
       on the device shared links are read on. */
    window.localStorage.setItem(SHELL_OVERRIDE_KEY, 'mobile');
    const target = createMemoryTarget(`#/s/${SPACE}/e/${TASK}?origin=tasks`);
    const view = mount(target);

    await waitFor(() => view.getByTestId('z4-host'));
    expect(view.queryByTestId('mobile-unrouted')).toBeNull();
  });
});
