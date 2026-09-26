/**
 * THE ATTENTION BROADCAST (Attention v2, chapter 5): the store's one ear on
 * the event stream.
 *
 * Since S2 (migration 254) every attention write emits a FULL `entity.upsert`
 * for the affected roots, the request's own entity and the raising session,
 * each carrying the badge recomputed by `attention_badges`. So an upsert is
 * the freshest badge the client can have, and the store keeps it per id; that
 * is what lets a tile whose host summary is stale still show the right chip.
 * A `resync` means events were missed, so the kept badges are dropped and the
 * host summaries (re-read by the resync) become the answer again.
 *
 * The request ROWS are refetched by `useAttentionPending`, which listens to the
 * same stream with its own throttle; this file only tracks badges.
 *
 * This is also the single hook for future notifications (Q19: a tab-title
 * count, desktop and push). They subscribe to the provider's `onCountsChange`,
 * not to the stream.
 */
import type { DurableWorkspaceEvent, EntityAttentionSummary, EntityId, SpaceId } from '@tm8/contract';
import type { AttentionSeam } from './attention-commands';
import { badgeOf } from './attention-commands';

export interface AttentionBroadcastSink {
  setBadge(id: EntityId, badge: EntityAttentionSummary | null): void;
  clearBadges(): void;
}

export function subscribeAttentionBroadcast(
  seam: Pick<AttentionSeam, 'onEvent' | 'onResync'>,
  spaceId: SpaceId,
  sink: AttentionBroadcastSink,
): () => void {
  const offEvent = seam.onEvent((event: DurableWorkspaceEvent) => {
    if (event.spaceId !== spaceId) return;
    if (event.type === 'entity.upsert') sink.setBadge(event.entity.id as EntityId, badgeOf(event.entity));
    else if (event.type === 'entity.deleted') sink.setBadge(event.entity.id as EntityId, null);
  });
  const offResync = seam.onResync((resynced) => {
    if (resynced === spaceId) sink.clearBadges();
  });
  return () => {
    offEvent();
    offResync();
  };
}
