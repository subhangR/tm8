/**
 * Channel hub data hooks.
 *
 * `useChannelDetail` keeps the hub's detail (topic + pinned shelf) live: a
 * pin/unpin is an `edge.upsert`/`edge.deleted`, and a rename/topic edit is an
 * `entity.upsert`, so both refetch the projection rather than the screen
 * re-deriving the shelf from raw edges.
 *
 * `useChannelTabs` reads the auto-tab projection from the facade — THE source
 * of the tab strip. Empty kinds never appear because the projection never
 * emits them, so the screen has nothing to filter and nothing to derive.
 */
import { useEffect } from 'react';
import type { CollabFacade } from '../../facade/CollabFacade';
import { useAsyncValue, type AsyncValue } from '../../shell';
import type { ChannelTab, EntityDetail, EntityId, SpaceId } from '../../types/contract';

const REFETCH_DEBOUNCE_MS = 30;

/** Refetch `reload` whenever a durable event could move the channel projection. */
function useReloadOnChannelEvents(
  facade: CollabFacade,
  spaceId: SpaceId | null | undefined,
  channelId: EntityId,
  reload: () => void,
): void {
  useEffect(() => {
    if (!spaceId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; reload(); }, REFETCH_DEBOUNCE_MS);
    };
    const unsubscribe = facade.subscribe(spaceId, (event) => {
      switch (event.type) {
        case 'entity.upsert':
        case 'entity.deleted':
          if (event.entity.id === channelId) schedule();
          break;
        // Pin/unpin and every attach/detach is an edge touching this channel.
        case 'edge.upsert':
        case 'edge.deleted':
          if (event.edge.source.id === channelId || event.edge.target.id === channelId) schedule();
          break;
        default:
          break;
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [facade, spaceId, channelId, reload]);
}

export function useChannelDetail(facade: CollabFacade, channelId: EntityId): AsyncValue<EntityDetail> {
  const detail = useAsyncValue(() => facade.getEntity(channelId), [facade, channelId]);
  useReloadOnChannelEvents(facade, detail.value?.spaceId, channelId, detail.reload);
  return detail;
}

export function useChannelTabs(facade: CollabFacade, channelId: EntityId): AsyncValue<ChannelTab[]> {
  const tabs = useAsyncValue(() => facade.getChannelTabs(channelId), [facade, channelId]);
  // Tabs carry their own space id in every query — no extra read needed.
  useReloadOnChannelEvents(facade, tabs.value?.[0]?.query.spaceId ?? null, channelId, tabs.reload);
  return tabs;
}
