// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import { createFixtureSeam } from '../data';
import { useGateData } from './useGateData';

describe('launch Interaction Profile hydration', () => {
  it('uses canonical entity detail when an older collection summary has no profile name', async () => {
    const seam = createFixtureSeam();
    const space = (await seam.spaces())[0]!;
    const profile = {
      id: 'profile-focused',
      spaceId: space.id,
      kind: 'interaction_profile',
      title: '',
      parentId: null,
      position: 1,
      visibility: 'space',
      version: 3,
      activityAt: '2026-07-30T00:00:00.000Z',
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
      deletedAt: null,
      createdBy: { id: 'member-owner', kind: 'member', displayName: 'Owner' },
      counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
      state: {
        kind: 'interaction_profile',
        status: 'active',
        currentDraftVersion: 1,
        activeVersion: 1,
        activeHash: 'sha256:focused',
        retiredAt: null,
      },
      badges: {},
    } as EntitySummary;
    const detail = { ...profile, title: 'Focused Chat — text only' } as EntityDetail;
    const query = seam.query.bind(seam);
    vi.spyOn(seam, 'query').mockImplementation((input) =>
      input.kinds?.includes('interaction_profile')
        ? Promise.resolve({ query: input, page: { items: [profile], nextCursor: null } })
        : query(input));
    const entity = vi.spyOn(seam, 'entity').mockResolvedValue(detail);

    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam }),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(entity).toHaveBeenCalledWith(profile.id);
    expect(result.current.launch.profiles.find((item) => item.id === profile.id)?.name)
      .toBe('Focused Chat — text only');
  });
});
