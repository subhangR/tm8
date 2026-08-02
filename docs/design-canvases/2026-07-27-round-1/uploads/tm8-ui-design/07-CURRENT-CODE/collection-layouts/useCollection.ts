/**
 * useCollection — execute a CollectionQuery against the facade with the
 * collections-store cache and live updates.
 *
 * Live behavior: `entity.upsert` for an entity already in the result patches
 * it in place through the store (instant, no refetch); anything that could
 * change *membership* (a matching-kind entity appearing, deletes, edge
 * changes when the query filters on edges/assignees/readiness) schedules a
 * trailing refetch. Cursor pages append via the store.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFacade } from '../entity';
import {
  collectionKey, useCollectionsStore, type CachedCollection,
} from '../stores/collections';
import type {
  CollectionQuery, CollectionResult, EntitySummary, WorkspaceEvent,
} from '../types/contract';

const REFETCH_DEBOUNCE_MS = 30;

export interface UseCollectionValue {
  result: CollectionResult | null;
  items: EntitySummary[];
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  refetch: () => void;
}

/** True when the query has edge-derived membership (refetch on edge events). */
function edgeSensitive(query: CollectionQuery): boolean {
  const f = query.filters;
  return Boolean(f?.edge || f?.assigneeIds?.length || f?.readyToPull || query.groupBy === 'assignee');
}

export function useCollection(query: CollectionQuery): UseCollectionValue {
  const facade = useFacade();
  const key = collectionKey(query);
  // The query object identity changes per render; the stable key drives effects.
  const queryRef = useRef(query);
  queryRef.current = query;

  const cached: CachedCollection | undefined = useCollectionsStore((s) => s.cache[key]);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    const q = queryRef.current;
    const store = useCollectionsStore.getState();
    store.setLoading(q);
    facade.queryCollection(q).then(
      (result) => {
        if (!alive) return;
        useCollectionsStore.getState().setResult(q, result);
        setError(null);
      },
      (e: unknown) => {
        if (!alive) return;
        useCollectionsStore.getState().setResult(q, { query: q, page: { items: [], nextCursor: null } });
        setError(e as Error);
      },
    );
    return () => { alive = false; };
  }, [facade, key, nonce]);

  useEffect(() => {
    const spaceId = queryRef.current.spaceId;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefetch = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; refetch(); }, REFETCH_DEBOUNCE_MS);
    };
    const unsubscribe = facade.subscribe(spaceId, (event: WorkspaceEvent) => {
      const q = queryRef.current;
      const inResult = (id: string): boolean => {
        const c = useCollectionsStore.getState().cache[collectionKey(q)];
        return Boolean(c?.result.page.items.some((i) => i.id === id));
      };
      switch (event.type) {
        case 'entity.upsert': {
          const kindMatches = !q.kinds || q.kinds.includes(event.entity.kind);
          if (inResult(event.entity.id)) {
            useCollectionsStore.getState().applyEntityPatch(event.entity);
            // The patch may also change membership (e.g. a status filter) —
            // reconcile with the source of truth in the background.
            if (q.filters && Object.keys(q.filters).length > 0) scheduleRefetch();
          } else if (kindMatches) {
            scheduleRefetch();
          }
          break;
        }
        case 'entity.deleted':
          useCollectionsStore.getState().removeEntity(event.entity.id);
          break;
        case 'edge.upsert':
        case 'edge.deleted':
          if (edgeSensitive(q)) scheduleRefetch();
          break;
        default:
          break;
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [facade, key, refetch]);

  const result = cached?.result ?? null;
  const items = useMemo(() => result?.page.items ?? [], [result]);
  const nextCursor = result?.page.nextCursor ?? null;

  const loadMore = useCallback(async (): Promise<void> => {
    if (!nextCursor) return;
    const q = queryRef.current;
    const page = await facade.queryCollection({ ...q, cursor: nextCursor });
    useCollectionsStore.getState().appendPage(q, page.page);
  }, [facade, nextCursor]);

  return {
    result,
    items,
    loading: cached ? cached.loading : true,
    error,
    hasMore: nextCursor != null,
    loadMore,
    refetch,
  };
}
