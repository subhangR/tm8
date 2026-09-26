// @vitest-environment jsdom
/**
 * W3-client a1, the hook half: every space the workspace opens is ENTERED
 * first. `enterSpace` is what mints the pinned session on an enforcing server
 * (`auth/space-sessions.ts`, tested against a fake node there), so it must
 * resolve before `openSpace` and before any read of the space, on the first
 * space and on every switch.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SpaceId } from '@tm8/contract';
import { FIXTURE_SPACE_ID, createFixtureSeam } from '../data/fixtures/seam-fixture';
import type { SpaceSessionHandle } from '../auth/space-sessions';
import { useGateData } from './useGateData';

const SPACE_B = '0b0b0b0b-0000-4000-8000-00000000000b' as SpaceId;

describe('useGateData enters a space before opening it (W3)', () => {
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
});
