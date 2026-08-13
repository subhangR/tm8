/**
 * COLLECTION-MEMBERSHIP AUTHORING, composed ONCE for every host that mounts an
 * `EntityDetailPanel` — same shape and same reason as `gitSurface.tsx` /
 * `debugSurface.tsx`: the membership block is rendered by the panel for every
 * host, but the AUTHORING behind it is a prop the host hands down, and
 * hand-wiring each host is exactly how four of the five mounts shipped with
 * the add control silently missing ("i dont see any add item in the
 * collection detail page").
 *
 * A HOOK, not a plain function like `gitSurfaceFor` — the authoring lane
 * holds in-flight state (`pending`), and hooks cannot be called inside
 * `WorkspaceView.renderPanel`, which renders one panel per id. So the host
 * calls THIS once and hands `authoringFor(detail)` to each mount; the
 * per-subject mapping (direction, picker kind, refusal) happens per call.
 *
 * A host without a seam still gets an honest answer: `authoringFor` returns
 * null and `MembershipBlock` renders its add control disabled WITH the
 * unwired reason (L6/D28), never nothing.
 */
import { useCallback, useMemo } from 'react';
import type { EntityDetail, EntityKind, SpaceId } from '@tm8/contract';
import { getKind } from '../domain';
import type { MembershipAuthoring } from '../panels/bodies/MembershipBlock';
import { useCollectionMembership } from '../authoring';
import type { Seam } from '../data/seam';
import type { Notice } from '../shell/notices';

export interface MembershipSurfaceHost {
  spaceId: string;
  /** Optional so narrow ports (GraphScreen) qualify; absent ⇒ null authoring. */
  seam?: Seam | undefined;
  /** Invalidating re-read, so the block reflects the write it just made. */
  refetchDetail(id: string): void;
  /** Where a refused write reports. Absent ⇒ the failure has nowhere to say so. */
  onNotice?(notice: Notice): void;
}

export interface MembershipSurface {
  /** Pass to the mount's `membershipAuthoring`, per rendered panel. */
  authoringFor(detail: EntityDetail | null | undefined): MembershipAuthoring | null;
}

export function useMembershipSurface(host: MembershipSurfaceHost): MembershipSurface {
  const { spaceId, seam, refetchDetail, onNotice } = host;

  /* One bounded recent page — `search.query` is reserved (honest 501), so the
     picker is honest about being a recency list the block filters locally. */
  const searchPage = useCallback(
    async (kind: EntityKind | null) => {
      if (!seam) return [];
      const result = await seam.query({
        spaceId: spaceId as SpaceId,
        ...(kind ? { kinds: [kind] } : {}),
        limit: 50,
      });
      return result.page.items;
    },
    [seam, spaceId],
  );

  const membership = useCollectionMembership({
    /* The commands object is never reached when `seam` is absent:
       `authoringFor` answers null first, so the block refuses instead. */
    commands: seam?.commands ?? {
      addToCollection: () => Promise.reject(new Error('This view has no seam to write through.')),
      removeFromCollection: () => Promise.reject(new Error('This view has no seam to write through.')),
    },
    searchPage,
    onChanged: (id) => refetchDetail(id),
    onError: (title, body) => onNotice?.({
      id: `collection-membership:${spaceId}`,
      tone: 'error',
      title,
      body,
      ttlMs: 12_000,
    }),
  });

  return useMemo<MembershipSurface>(
    () => ({
      authoringFor: (detail) => {
        if (!detail || !seam) return null;
        /* Offered exactly where the kind's row declares a `membership` block —
           a registry test, never a kind literal (§15.2). The block's
           `direction` decides which endpoint of the `contains` pair the open
           entity is; `useCollectionMembership` owns that mapping. */
        const block = (getKind(detail.state.kind).panel.blocks ?? [])
          .find((candidate) => candidate.block === 'membership');
        if (!block) return null;
        return membership.authoringFor({
          id: detail.id,
          direction: block.params?.direction === 'incoming' ? 'incoming' : 'outgoing',
          /* Registry DATA, never a literal here — the entity side narrows the
             picker to collections, the collection side accepts any kind. */
          pickerKind: typeof block.params?.pickerKind === 'string'
            ? (block.params.pickerKind as EntityKind)
            : null,
          refusal: detail.capabilities.canEdit
            ? null
            : 'The node refuses edits to this entity, so its membership is read-only here.',
        });
      },
    }),
    [membership, seam],
  );
}
