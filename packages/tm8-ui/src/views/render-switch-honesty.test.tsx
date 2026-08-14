// @vitest-environment jsdom
/**
 * THE FALLTHROUGH IS THE TEST.
 *
 * `GateApp`'s render switch is one order-dependent ternary chain, and it used to
 * end `: data.ready ? <WorkspaceView/>`. That arm looked like "the workspace"
 * and behaved like "everything else": a target with no branch rendered the
 * three-panel workspace, silently, under whatever the rail was highlighting.
 *
 * This has shipped twice — the voice-room misroute, and channels falling
 * through — and both times the report was "I clicked a thing and got the
 * workspace", which reads as nothing having happened rather than as a defect.
 * A silent wrong screen is the single most expensive failure mode in this file,
 * because it is indistinguishable from a no-op at a glance.
 *
 * So these cases pin the THREE outcomes apart, and the distinction between the
 * last two is the whole point:
 *
 *   workspace ref    → the workspace, matched EXPLICITLY and not by exhaustion
 *   known-unbuilt    → "isn't built yet", which is true of `feed`
 *   unrecognised     → the loud card, which does NOT claim it is coming soon
 *
 * NOTHING HERE ASSERTS A HARDCODED SPACE ID. The stored record is produced by
 * navigating for real and then rewritten in place, so the test cannot drift
 * from `last-place.ts`'s key scheme the way a hand-built fixture would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { GateApp } from './GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';

/**
 * jsdom's own localStorage persists for the whole FILE and `.clear()` throws
 * under this runner — the same problem `last-place-gate.test.tsx` documents, so
 * the same in-memory replacement, kept deliberately identical to it.
 */
let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map<string, string>();
  const store = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
    key: (i: number) => [...storage.keys()][i] ?? null,
    get length() {
      return storage.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: store });
  resetNav();
  screenStackStore.getState().clearAll();
  /* The URL is state now, and jsdom keeps ONE `window.location` per file. A
     case that navigates leaves its address behind and the next case boots from
     it, because an addressable hash at boot deliberately outranks last-place
     (R3) — so `resetNav()` alone stopped being a reset the day the router was
     mounted. Same class as the localStorage double above, one global later. */
  window.location.hash = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

const mount = () => render(<GateApp />);

/**
 * EVERY CASE HERE MOUNTS THE COMPOSED GATE TWICE — once to produce a real
 * last-place record, once to read it back — and the composed gate is slow under
 * jsdom. `last-place-gate.test.tsx` and `gate.test.tsx` already fail on this
 * machine at vitest's 5s default, purely on elapsed time (5740ms for a single
 * mount/remount, with the assertion never reached).
 *
 * That is a MACHINE-SPEED property and not a behavioural claim, so it is stated
 * as a timeout rather than worked around by asserting something cheaper. A
 * shorter test that avoided the second mount would not be testing restore, and
 * restore is exactly the path that hands this file an unrecognised target.
 */
const SLOW_GATE_MS = 30_000;

/** The `tm8.last-place.v1.*` entry, whatever node key this build computed. */
function lastPlaceEntry(): [string, { spaceId: string | null; targets: Record<string, unknown> }] {
  const key = [...storage.keys()].find((k) => k.startsWith('tm8.last-place.v1.'));
  if (!key) throw new Error('no last-place record was written — the test is not exercising restore');
  return [key, JSON.parse(storage.get(key) as string)];
}

/**
 * Navigate for real so the record exists under the RIGHT key, then swap the
 * remembered target for `target`. Returns once the record is rewritten; the
 * caller remounts to make the restore effect read it.
 */
async function rememberTarget(target: unknown): Promise<void> {
  const first = mount();
  await waitFor(() => first.getByTestId('workspace-grid'));
  /* Any real navigation will do — this is what writes the record. */
  fireEvent.click(within(first.getByTestId('menu-rail')).getByRole('button', { name: /^Tasks/ }));
  await waitFor(() => first.getByTestId('entity-view'));
  first.unmount();

  /* AND THE ADDRESS GOES WITH IT. That rail click now writes
     `#/s/{space}/k/tasks`, and an addressable hash at boot deliberately
     OUTRANKS last-place (R3) — so the caller's remount would land on Tasks from
     the URL and never consult the doctored record this function exists to
     plant. Every case in this file would then assert against a restore that
     never ran. A real boot into a restore is a fresh document with no hash. */
  window.location.hash = '';

  const [key, record] = lastPlaceEntry();
  const spaces = Object.keys(record.targets);
  expect(spaces.length).toBeGreaterThan(0);
  for (const space of spaces) record.targets[space] = target;
  storage.set(key, JSON.stringify(record));
}

describe('the render switch never falls through to the workspace', () => {
  it('draws the loud card for a target it has no screen for, not the workspace', async () => {
    /* `last-place.ts` validates the SHAPE of a stored target and never the ref,
       so this is a value the app can genuinely be handed on boot — not a
       contrived one. Before this change it rendered the workspace in silence. */
    const shout = vi.spyOn(console, 'error').mockImplementation(() => {});
    await rememberTarget({ type: 'view', ref: 'not-a-real-view' });

    const view = mount();
    await waitFor(() => view.getByTestId('unrouted-target'));

    /* THE REGRESSION THIS REPLACES, stated as an assertion. */
    expect(view.queryByTestId('workspace-grid')).toBeNull();
    /* And it must not borrow the unbuilt card's sentence: "coming soon" would
       be a promise nobody made about a destination that does not exist. */
    expect(view.queryByTestId('unbuilt-view')).toBeNull();

    expect(shout).toHaveBeenCalled();
    const said = shout.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('no screen for target');
    expect(said).toContain('not-a-real-view');
    view.unmount();
  }, SLOW_GATE_MS);

  it('still says "isn’t built yet" for a ref that is genuinely unbuilt', async () => {
    /* `feed` is the last real member of that set. The loud card would be WRONG
       here — the ref is recognised and its screen is honestly pending, which is
       a different sentence from "this build has no screen for that". */
    await rememberTarget({ type: 'view', ref: 'feed' });

    const view = mount();
    await waitFor(() => view.getByTestId('unbuilt-view'));
    expect(view.queryByTestId('unrouted-target')).toBeNull();
    expect(view.queryByTestId('workspace-grid')).toBeNull();
    view.unmount();
  }, SLOW_GATE_MS);

  it('matches the workspace explicitly rather than by exhaustion', async () => {
    await rememberTarget({ type: 'view', ref: 'workspace' });

    const view = mount();
    await waitFor(() => view.getByTestId('workspace-grid'));
    expect(view.queryByTestId('unrouted-target')).toBeNull();
    view.unmount();
  }, SLOW_GATE_MS);
});
