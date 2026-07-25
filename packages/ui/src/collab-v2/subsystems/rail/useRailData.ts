/**
 * useRailData — the rail's read path. Hierarchy and connections are LAZY
 * sections: when the host already holds an `EntityDetail` (the panel slot)
 * they seed instantly; otherwise the rail fetches them itself, so
 * `<ConnectionsRail entityId />` works standalone anywhere.
 *
 * Invalidation: any edge event touching this entity (the graph store indexes
 * exactly that in `edgeIdsByEntity`) refetches both sections, as does a
 * version bump on the seed detail.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFacade } from '../../entity';
import { useGraphStore } from '../../stores';
import type {
  Connections, EntityDetail, EntityId, Hierarchy,
} from '../../types/contract';

interface RailState {
  id: EntityId;
  hierarchy: Hierarchy | null;
  connections: Connections | null;
  loading: boolean;
  failed: boolean;
}

export interface RailData extends RailState {
  childrenLoading: boolean;
  refresh: () => void;
  loadMoreChildren: () => void;
}

function initial(id: EntityId, seed?: EntityDetail): RailState {
  const usable = seed && seed.id === id ? seed : undefined;
  return {
    id,
    hierarchy: usable?.hierarchy ?? null,
    connections: usable?.connections ?? null,
    loading: usable == null,
    failed: false,
  };
}

export function useRailData(entityId: EntityId, seed?: EntityDetail): RailData {
  const facade = useFacade();
  const seedRef = useRef(seed);
  seedRef.current = seed;

  const [state, setState] = useState<RailState>(() => initial(entityId, seed));
  const [childrenLoading, setChildrenLoading] = useState(false);
  // Switching entity mid-life: reset during render (no flash of stale edges).
  if (state.id !== entityId) setState(initial(entityId, seedRef.current));

  const fetchAll = useCallback((id: EntityId) => {
    let cancelled = false;
    void Promise.all([facade.getHierarchy(id), facade.getConnections(id)])
      .then(([hierarchy, connections]) => {
        if (cancelled) return;
        setState((p) => (p.id === id ? { ...p, hierarchy, connections, loading: false, failed: false } : p));
      })
      .catch(() => {
        if (cancelled) return;
        setState((p) => (p.id === id ? { ...p, loading: false, failed: true } : p));
      });
    return () => { cancelled = true; };
  }, [facade]);

  // Unseeded mount → fetch. Seeded → the panel already paid for these bytes.
  useEffect(() => {
    const s = seedRef.current;
    if (s && s.id === entityId) return undefined;
    return fetchAll(entityId);
  }, [entityId, fetchAll]);

  // Seed refreshed (host refetched after a command) → adopt its sections.
  const seedVersion = seed && seed.id === entityId ? seed.version : null;
  useEffect(() => {
    const s = seedRef.current;
    if (!s || s.id !== entityId) return;
    setState((p) => (p.hierarchy === s.hierarchy && p.connections === s.connections
      ? p
      : { id: entityId, hierarchy: s.hierarchy, connections: s.connections, loading: false, failed: false }));
  }, [entityId, seedVersion]);

  // Live edge events for this entity → the rail is stale, refetch.
  const edgeSignal = useGraphStore((s) => s.edgeIdsByEntity[entityId]);
  const lastSignal = useRef<{ id: EntityId; value: string[] | undefined } | null>(null);
  useEffect(() => {
    const prev = lastSignal.current;
    lastSignal.current = { id: entityId, value: edgeSignal };
    if (!prev || prev.id !== entityId || prev.value === edgeSignal) return undefined;
    return fetchAll(entityId);
  }, [entityId, edgeSignal, fetchAll]);

  const refresh = useCallback(() => { fetchAll(entityId); }, [entityId, fetchAll]);

  const cursor = state.hierarchy?.children.nextCursor ?? null;
  const loadMoreChildren = useCallback(() => {
    if (!cursor) return;
    setChildrenLoading(true);
    void facade.getHierarchy(entityId, cursor)
      .then((page) => {
        setState((p) => {
          if (p.id !== entityId || !p.hierarchy) return p;
          const seen = new Set(p.hierarchy.children.items.map((c) => c.id));
          return {
            ...p,
            hierarchy: {
              ...p.hierarchy,
              children: {
                items: [...p.hierarchy.children.items, ...page.children.items.filter((c) => !seen.has(c.id))],
                nextCursor: page.children.nextCursor,
                total: page.children.total ?? p.hierarchy.children.total,
              },
            },
          };
        });
      })
      .catch(() => { /* keep what we have; the "load more" stays available */ })
      .finally(() => setChildrenLoading(false));
  }, [facade, entityId, cursor]);

  return { ...state, childrenLoading, refresh, loadMoreChildren };
}
