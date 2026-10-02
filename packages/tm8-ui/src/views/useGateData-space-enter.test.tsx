// @vitest-environment jsdom
/**
 * W3-client a1, the hook half: every space the workspace opens is ENTERED
 * first. `enterSpace` is what mints the pinned session on an enforcing server
 * (`auth/space-sessions.ts`, tested against a fake node there), so it must
 * resolve before `openSpace` and before any read of the space, on the first
 * space and on every switch.
 *
 * THE NEGATIVE TWINS (task 01a0db7c F5) are what let the positive case fail.
 * The hook must REFRAIN as well: a superseded switch opens nothing once its
 * enter lands, a refused enter opens nothing at all, and re-picking the open
 * space enters nothing again. A hook that entered-then-opened unconditionally
 * would pass the first test and fail these.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CollabError, type SpaceId } from '@tm8/contract';
import { FIXTURE_SPACE_ID, createFixtureSeam } from '../data/fixtures/seam-fixture';
import type { SpaceSessionHandle } from '../auth/space-sessions';
import { nodeKeyOf } from '../data/launch-cache';
import { clearLastPlace } from './last-place';
import { useGateData } from './useGateData';

const SPACE_B = '0b0b0b0b-0000-4000-8000-00000000000b' as SpaceId;
const SPACE_C = '0c0c0c0c-0000-4000-8000-00000000000c' as SpaceId;

/** A seam listing home, B and C, whose `openSpace` is logged. */
async function loggedSeam(log: string[]) {
  const seam = createFixtureSeam();
  const [home] = await seam.spaces();
  const spied = {
    ...seam,
    async spaces() {
      return [home!, { ...home!, id: SPACE_B, name: 'Other' }, { ...home!, id: SPACE_C, name: 'Third' }];
    },
    async openSpace(id: SpaceId) {
      log.push(`open:${id}`);
      return seam.openSpace(id);
    },
  };
  return { seam, spied };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('useGateData enters a space before opening it (W3)', () => {
  // Each test boots fresh: a remembered space from the one before would boot
  // there instead of the fixture's home space.
  beforeEach(() => clearLastPlace(nodeKeyOf(undefined)));

  it('calls enterSpace for the boot space and for a switch, each before openSpace', async () => {
    const seam = createFixtureSeam();
    const [home] = await seam.spaces();
    const log: string[] = [];
    const spied = {
      ...seam,
      async spaces() {
        return [home!, { ...home!, id: SPACE_B, name: 'Other' }];
      },
      async openSpace(id: SpaceId) {
        log.push(`open:${id}`);
        return seam.openSpace(id);
      },
    };
    const spaceSession: SpaceSessionHandle = {
      credentialFor: () => null,
      recover: async () => false,
      requestToken: () => null,
      async enterSpace(id) {
        log.push(`enter:${id}`);
        await new Promise((r) => setTimeout(r, 20));
        log.push(`entered:${id}`);
      },
    };

    const { result, unmount } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: spied, spaceSession }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.selectSpace(SPACE_B));
    await waitFor(() => expect(result.current.spaceId).toBe(SPACE_B));
    // The fixture holds no rows for B, so wait on the open, not on `ready`.
    await waitFor(() => expect(log).toContain(`open:${SPACE_B}`));

    const firstOpen = (id: string) => log.indexOf(`open:${id}`);
    for (const id of [FIXTURE_SPACE_ID, SPACE_B]) {
      expect(log.indexOf(`entered:${id}`)).toBeGreaterThanOrEqual(0);
      expect(log.indexOf(`entered:${id}`)).toBeLessThan(firstOpen(id));
    }

    unmount();
    seam.dispose();
  }, 15_000);

  it('a switch superseded while its enter is in flight never opens that space', async () => {
    const log: string[] = [];
    const { seam, spied } = await loggedSeam(log);
    const spaceSession: SpaceSessionHandle = {
      credentialFor: () => null,
      recover: async () => false,
      requestToken: () => null,
      async enterSpace(id) {
        log.push(`enter:${id}`);
        await sleep(id === SPACE_B ? 150 : 5);
        log.push(`entered:${id}`);
      },
    };

    const { result, unmount } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: spied, spaceSession }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.selectSpace(SPACE_B));
    await waitFor(() => expect(log).toContain(`enter:${SPACE_B}`));
    act(() => result.current.selectSpace(SPACE_C));
    await waitFor(() => expect(log).toContain(`open:${SPACE_C}`));
    // B's enter resolves after C's switch; give it time to land.
    await waitFor(() => expect(log).toContain(`entered:${SPACE_B}`));
    await sleep(50);

    expect(log).not.toContain(`open:${SPACE_B}`);
    expect(log.indexOf(`entered:${SPACE_C}`)).toBeLessThan(log.indexOf(`open:${SPACE_C}`));

    unmount();
    seam.dispose();
  }, 15_000);

  it('a refused enter opens nothing: no read of a space the node would not pin', async () => {
    const log: string[] = [];
    const { seam, spied } = await loggedSeam(log);
    const spaceSession: SpaceSessionHandle = {
      credentialFor: () => null,
      recover: async () => false,
      requestToken: () => null,
      async enterSpace(id) {
        log.push(`enter:${id}`);
        if (id === SPACE_B) throw new CollabError('forbidden', 'not a member of this space');
      },
    };

    const { result, unmount } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: spied, spaceSession }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.selectSpace(SPACE_B));
    await waitFor(() => expect(result.current.bootError).not.toBeNull());

    expect(log).toContain(`enter:${SPACE_B}`);
    expect(log).not.toContain(`open:${SPACE_B}`);

    unmount();
    seam.dispose();
  }, 15_000);

  it('re-picking the open space enters nothing again', async () => {
    const log: string[] = [];
    const { seam, spied } = await loggedSeam(log);
    const spaceSession: SpaceSessionHandle = {
      credentialFor: () => null,
      recover: async () => false,
      requestToken: () => null,
      async enterSpace(id) {
        log.push(`enter:${id}`);
      },
    };

    const { result, unmount } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: spied, spaceSession }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    const entered = log.filter((line) => line.startsWith('enter:')).length;
    act(() => result.current.selectSpace(FIXTURE_SPACE_ID));
    await sleep(50);

    expect(log.filter((line) => line.startsWith('enter:')).length).toBe(entered);

    unmount();
    seam.dispose();
  }, 15_000);
});
