/**
 * Team screen data — two collection reads (humans, agents) that refetch when
 * the durable stream reports the graph moved. Everything else the screen shows
 * is already inside the summaries those reads return.
 */
import { useCallback, useEffect, useState } from 'react';
import type { CollabFacade } from '../../facade/CollabFacade';
import { useAsyncValue, type AsyncValue } from '../../shell';
import type { CollectionResult, SpaceId, WorkspaceEvent } from '../../types/contract';

/** Bumps whenever an event that could change the roster or live work lands. */
export function useRosterNonce(facade: CollabFacade, spaceId: SpaceId): number {
  const [nonce, setNonce] = useState(0);
  useEffect(() => facade.subscribe(spaceId, (event: WorkspaceEvent) => {
    if (event.type === 'entity.upsert' || event.type === 'entity.deleted'
      || event.type === 'edge.upsert' || event.type === 'edge.deleted') {
      setNonce((n) => n + 1);
    }
  }), [facade, spaceId]);
  return nonce;
}

export function useMembers(facade: CollabFacade, spaceId: SpaceId, nonce: number): AsyncValue<CollectionResult> {
  const load = useCallback(
    // `position` ties break on join order, so the space owner heads the grid.
    () => facade.queryCollection({ spaceId, kinds: ['member'], sort: 'position', limit: 100 }),
    [facade, spaceId],
  );
  return useAsyncValue(load, [load, nonce]);
}

export function useAgents(facade: CollabFacade, spaceId: SpaceId, nonce: number): AsyncValue<CollectionResult> {
  const load = useCallback(
    () => facade.queryCollection({ spaceId, kinds: ['team_member'], sort: 'position', limit: 200 }),
    [facade, spaceId],
  );
  return useAsyncValue(load, [load, nonce]);
}
