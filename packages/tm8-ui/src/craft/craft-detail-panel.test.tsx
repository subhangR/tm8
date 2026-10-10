// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { createFixtureSeam } from '../data';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { useLiveDetail } from './CraftDetailPanel';

const SPACE = FIXTURE_SPACE_ID;

async function setup() {
  const seam = createFixtureSeam();
  await seam.openSpace(SPACE);
  const doc = async (title: string) =>
    (await seam.commands.createEntity({ clientMutationId: `cdp-${title}`, spaceId: SPACE, kind: 'doc', title })).entity!.id as EntityId;
  return { seam, doc };
}

describe('useLiveDetail — a stacked body re-reads its own detail on its event', () => {
  it('a doc edited elsewhere re-reads ITS detail once, and another entity’s edit does not', async () => {
    const { seam, doc } = await setup();
    const brief = await doc('Brief');
    const other = await doc('Other');
    const refetchDetail = vi.fn();
    renderHook(() => useLiveDetail(seam, { refetchDetail }, brief));

    await seam.commands.patchEntity(other, { clientMutationId: 'cdp-o', expectedVersion: 1, content: { body: 'not mine' } });
    await seam.commands.patchEntity(brief, { clientMutationId: 'cdp-b1', expectedVersion: 1, content: { body: 'v2' } });
    await seam.commands.patchEntity(brief, { clientMutationId: 'cdp-b2', expectedVersion: 2, content: { body: 'v3' } });

    await waitFor(() => expect(refetchDetail).toHaveBeenCalledWith(brief));
    /* A burst of saves is one re-read, and never one for another entity. */
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(refetchDetail.mock.calls).toEqual([[brief]]);
  });

  it('stops listening when the section unmounts', async () => {
    const { seam, doc } = await setup();
    const brief = await doc('Brief');
    const refetchDetail = vi.fn();
    const hook = renderHook(() => useLiveDetail(seam, { refetchDetail }, brief));
    hook.unmount();
    await seam.commands.patchEntity(brief, { clientMutationId: 'cdp-u', expectedVersion: 1, content: { body: 'later' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(refetchDetail).not.toHaveBeenCalled();
  });
});
