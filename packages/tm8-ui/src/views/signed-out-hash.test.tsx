// @vitest-environment jsdom
/**
 * THE LAW: THE SIGNED-OUT GATE MUST NEVER WRITE THE HASH.
 *
 * Not `#/signin`. Not `#/`. Not a normalization. Not a cleanup on unmount.
 * Every such write destroys somebody's shared link, and it destroys it in the
 * one moment the link matters most — the recipient is not signed in, which is
 * precisely the case the whole feature exists to serve.
 *
 * WHY THIS HOLDS STRUCTURALLY, AND WHY IT IS STILL WORTH A TEST. `AuthGate` is
 * a RENDER SWAP inside one component, not a redirect: signed out it returns
 * `<AuthFlow/>`, signed in it returns `children`. It never touches
 * `window.location`. So the destination in the address bar survives sign-in for
 * free, and "login → page" needs no capture-and-replay mechanism at all.
 *
 * That property is load-bearing and easy to destroy by accident. The router is
 * being mounted BELOW this gate for exactly this reason; anyone who later
 * mounts it above, or adds a "clean up the URL" effect to the signed-out
 * branch, breaks deep links for every signed-out recipient and breaks nothing
 * else — so nothing else would catch it.
 *
 * This test was written BEFORE the router mount. It passes today, and its job
 * is to keep passing.
 *
 * THERE ARE TWO SIGNED-OUT SURFACES, AND THE LAW COVERS BOTH. `AuthGate` is one.
 * The other is INSIDE `GateApp`: when a named server answers the boot read
 * `unauthenticated`, `data.authRequired` renders `AuthFlow` in the centre with
 * the whole shell — and the mounted router — around it. The structural argument
 * that saves the first surface (children never mount) does NOT apply to the
 * second, because there the app is running. So it is asserted rather than
 * assumed, in the second describe below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { CollabError } from '@tm8/contract';
import { AuthGate } from '../auth';
import { GateApp } from './GateApp';
import { createFixtureSeam } from '../data';
import type { Seam } from '../data/seam';
import { createMemoryTarget } from '../routes';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';

/** A link of the exact shape §2.2 freezes for a shared entity. */
const DEEP_LINK =
  '#/s/019fbd5a-3c5b-71ea-9b91-1d3baa50da25/e/4f8c2a9e-77b1-4e3d-9c2f-a1b0d3e5f6a7?origin=tasks';

function installStorage(): void {
  /* The `realSeamFlag.test.ts` pattern, load-bearing under this runner —
     globalThis.localStorage arrives without setItem/removeItem. */
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

beforeEach(() => {
  installStorage();
  /* An UNREACHABLE node, on purpose: it is the harshest case for this law.
     The gate settles the claim read with a null answer and falls through to
     the sign-in card, which is the longest signed-out code path there is. */
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('node unreachable'))));
  window.location.hash = DEEP_LINK;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const APP = <div data-testid="the-app">the app</div>;

describe('the signed-out gate never writes the hash', () => {
  it('leaves a deep link byte-for-byte intact while it renders the auth flow', async () => {
    const view = render(<AuthGate>{APP}</AuthGate>);

    /* The gate is genuinely in its signed-out state — otherwise this test
       would be asserting the law about a component that never applied it. */
    await waitFor(() => screen.getByTestId('auth-frame'));
    expect(screen.queryByTestId('the-app')).toBeNull();

    /* Let every effect the signed-out branch owns run to completion, including
       the node-claim read that just rejected. */
    await act(async () => {
      await Promise.resolve();
    });

    expect(window.location.hash).toBe(DEEP_LINK);
    view.unmount();
  });

  it('does not clean the hash up on unmount', async () => {
    const view = render(<AuthGate>{APP}</AuthGate>);
    await waitFor(() => screen.getByTestId('auth-frame'));

    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });

    /* Named separately because an unmount cleanup is the FORM this mistake
       usually takes — it looks like tidiness rather than like a redirect, and
       it fires on exactly the transition that follows a successful sign-in. */
    expect(window.location.hash).toBe(DEEP_LINK);
  });

  it('never renders the app for a signed-out viewer, whatever the hash says', async () => {
    /* The other half of the same guarantee, and the reason the destination is
       safe: children do not mount at all, so no effect of theirs — including a
       future mounted router — can run and write the URL. */
    const view = render(<AuthGate>{APP}</AuthGate>);
    await waitFor(() => screen.getByTestId('auth-frame'));
    expect(screen.queryByTestId('the-app')).toBeNull();
    expect(window.location.hash).toBe(DEEP_LINK);
    view.unmount();
  });
});

/** The node lists nothing because it wants a pass first. */
function seamDemandingAuth(): Seam {
  return {
    ...createFixtureSeam(),
    spaces: async () => {
      throw new CollabError('unauthenticated', 'sign in to this server');
    },
  };
}

describe('the SECOND signed-out surface never writes the hash either', () => {
  beforeEach(() => {
    resetNav();
    screenStackStore.getState().clearAll();
  });

  it('keeps a deep link intact while the in-shell sign-in renders', async () => {
    /* THE SURFACE THE STRUCTURAL ARGUMENT DOES NOT COVER. Here the app IS
       running — rail, stores, effects and the mounted router — and only the
       centre is a sign-in. Everything that makes the first surface safe by
       construction is absent, so this is the one that has to be measured.

       The memory target is the assertion instrument, not a convenience: it
       records every write and distinguishes a push from a replace, so "the link
       survived" cannot be confused with "the link was rewritten to the same
       string by luck". */
    const target = createMemoryTarget(DEEP_LINK);
    const view = render(<GateApp seam={seamDemandingAuth()} routerTarget={target} />);

    await waitFor(() => screen.getByTestId('auth-frame'));
    /* Genuinely the IN-SHELL sign-in: the rail is still there. If this ever
       became AuthGate's full-screen swap, the test would be measuring the
       surface that is already covered above. */
    expect(screen.getByTestId('menu-rail')).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(target.getHash()).toBe(DEEP_LINK);
    /* And no history was manufactured underneath them: after sign-in the back
       button must not walk through entries the sign-in invented. */
    expect(target.entries).toEqual([DEEP_LINK]);
    view.unmount();
  });

  it('does not let the boot restore overwrite the link with last-place', async () => {
    /* R3 AT ITS SHARPEST. A signed-out recipient is exactly who a shared link is
       for, and the boot read that would normally supply a Space never answers
       here — so anything that restores "where you were" on this path is writing
       over a destination the viewer has not even reached yet. */
    const target = createMemoryTarget(DEEP_LINK);
    const view = render(<GateApp seam={seamDemandingAuth()} routerTarget={target} />);
    await waitFor(() => screen.getByTestId('auth-frame'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(target.getHash()).toBe(DEEP_LINK);
    view.unmount();
  });
});
