// @vitest-environment jsdom
/**
 * A REFUSED SPACE IS NOT AN UNREACHABLE NODE.
 *
 * Verbatim from the field, as one bug report: "can't reach the tm8 node / not
 * a member of this space / … Retrying automatically — this clears itself the
 * moment the node answers." Those four lines are ONE card, and three of them
 * are false. The node had answered — with `forbidden` — and no amount of
 * waiting was going to change its mind. The reader, told the node was down,
 * waited.
 *
 * Sibling of `server-signin.test.tsx`, which pins the same class of lie for
 * `unauthenticated`. Every boot failure that is not a transport failure has an
 * answer behind it, and the card has to say which.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CollabError } from '@tm8/contract';
import { createFixtureSeam } from '../data';
import type { Seam } from '../data/seam';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';

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
  /* The URL is state now, and jsdom keeps ONE `window.location` per file. A
     case that navigates leaves its address behind and the next case boots from
     it, because an addressable hash at boot deliberately outranks last-place
     (R3) — so `resetNav()` alone stopped being a reset the day the router was
     mounted. Same class as the localStorage doubles these files already carry,
     one global later. */
  window.location.hash = '';
  screenStackStore.getState().clearAll();
});

/**
 * The node lists the Space and then refuses to open it — which is exactly what
 * a Space you are not a member of looked like, and what one whose membership
 * check asked about the wrong identity looked like to everybody in it.
 */
function seamRefusing(error: CollabError): Seam {
  const fixture = createFixtureSeam();
  return {
    ...fixture,
    spaceSettings: async () => {
      throw error;
    },
  };
}

describe('the boot card names the failure it actually got', () => {
  it('states a refusal as a refusal, and does not promise that waiting clears it', async () => {
    render(<GateApp seam={seamRefusing(new CollabError('forbidden', 'not a member of this space'))} />);

    await waitFor(() => expect(screen.getByText(/The node refused this Space/)).toBeTruthy());
    // The node's own words survive the trip — the reader can act on "not a
    // member" and cannot act on a generic failure.
    expect(screen.getByText(/not a member of this space/)).toBeTruthy();
    // And the two sentences that sent the last reader off to wait are gone.
    expect(screen.queryByText(/Can’t reach the tm8 node/)).toBeNull();
    expect(screen.queryByText(/clears itself the moment the node answers/)).toBeNull();
  });

  it('still calls an unreachable node unreachable', async () => {
    render(
      <GateApp
        seam={seamRefusing(
          new CollabError('upstream_unavailable', 'cannot reach the tm8 node: TypeError: fetch failed'),
        )}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Can’t reach the tm8 node/)).toBeTruthy());
    expect(screen.getByText(/clears itself the moment the node answers/)).toBeTruthy();
    expect(screen.queryByText(/The node refused this Space/)).toBeNull();
  });
});
