/**
 * Collections store — CollectionQuery → CollectionResult cache with cursor
 * append, saved views, and in-place entity patching so live events move board
 * cards without a refetch.
 */
import { create } from 'zustand';
import type {
  CollectionQuery, CollectionResult, EntityId, EntitySummary, Page, SavedView,
} from '../types/contract';

/** Stable cache key: JSON with recursively sorted object keys. */
export function collectionKey(query: CollectionQuery): string {
  const sortValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const val = (v as Record<string, unknown>)[k];
        if (val !== undefined) out[k] = sortValue(val);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortValue(query));
}

export interface CachedCollection {
  result: CollectionResult;
  fetchedAt: number;
  loading: boolean;
}

export interface CollectionsState {
  cache: Record<string, CachedCollection>;
  savedViews: SavedView[];

  setLoading: (query: CollectionQuery) => void;
  setResult: (query: CollectionQuery, result: CollectionResult) => void;
  /** Append a follow-up cursor page onto the cached result. */
  appendPage: (query: CollectionQuery, page: Page<EntitySummary>) => void;
  /** Patch a fresher summary into every cached result that contains it. */
  applyEntityPatch: (summary: EntitySummary) => void;
  removeEntity: (id: EntityId) => void;
  invalidate: (query: CollectionQuery) => void;
  invalidateAll: () => void;
  setSavedViews: (views: SavedView[]) => void;
  upsertSavedView: (view: SavedView) => void;
  removeSavedView: (viewId: string) => void;
  reset: () => void;
}

export const useCollectionsStore = create<CollectionsState>()((set) => ({
  cache: {},
  savedViews: [],

  setLoading: (query) => set((s) => {
    const key = collectionKey(query);
    const prior = s.cache[key];
    return {
      cache: {
        ...s.cache,
        [key]: prior
          ? { ...prior, loading: true }
          : { result: { query, page: { items: [], nextCursor: null } }, fetchedAt: 0, loading: true },
      },
    };
  }),

  setResult: (query, result) => set((s) => ({
    cache: { ...s.cache, [collectionKey(query)]: { result, fetchedAt: Date.now(), loading: false } },
  })),

  appendPage: (query, page) => set((s) => {
    const key = collectionKey(query);
    const cached = s.cache[key];
    if (!cached) return {};
    const have = new Set(cached.result.page.items.map((i) => i.id));
    const items = [...cached.result.page.items, ...page.items.filter((i) => !have.has(i.id))];
    return {
      cache: {
        ...s.cache,
        [key]: {
          ...cached,
          fetchedAt: Date.now(),
          result: { ...cached.result, page: { ...page, items } },
        },
      },
    };
  }),

  applyEntityPatch: (summary) => set((s) => {
    let changed = false;
    const cache: typeof s.cache = {};
    for (const [key, cached] of Object.entries(s.cache)) {
      const hit = cached.result.page.items.some((i) => i.id === summary.id)
        || cached.result.groups?.some((g) => g.items.some((i) => i.id === summary.id));
      if (!hit) { cache[key] = cached; continue; }
      changed = true;
      cache[key] = {
        ...cached,
        result: {
          ...cached.result,
          page: {
            ...cached.result.page,
            items: cached.result.page.items.map((i) => (i.id === summary.id ? summary : i)),
          },
          groups: cached.result.groups?.map((g) => ({
            ...g,
            items: g.items.map((i) => (i.id === summary.id ? summary : i)),
          })),
        },
      };
    }
    return changed ? { cache } : {};
  }),

  removeEntity: (id) => set((s) => {
    let changed = false;
    const cache: typeof s.cache = {};
    for (const [key, cached] of Object.entries(s.cache)) {
      const hit = cached.result.page.items.some((i) => i.id === id)
        || cached.result.groups?.some((g) => g.items.some((i) => i.id === id));
      if (!hit) { cache[key] = cached; continue; }
      changed = true;
      cache[key] = {
        ...cached,
        result: {
          ...cached.result,
          page: { ...cached.result.page, items: cached.result.page.items.filter((i) => i.id !== id) },
          groups: cached.result.groups?.map((g) => ({ ...g, items: g.items.filter((i) => i.id !== id) })),
        },
      };
    }
    return changed ? { cache } : {};
  }),

  invalidate: (query) => set((s) => {
    const key = collectionKey(query);
    if (!s.cache[key]) return {};
    const cache = { ...s.cache };
    delete cache[key];
    return { cache };
  }),

  invalidateAll: () => set({ cache: {} }),

  setSavedViews: (views) => set({ savedViews: views }),
  upsertSavedView: (view) => set((s) => {
    const rest = s.savedViews.filter((v) => v.id !== view.id);
    return { savedViews: [...rest, view] };
  }),
  removeSavedView: (viewId) => set((s) => ({ savedViews: s.savedViews.filter((v) => v.id !== viewId) })),

  reset: () => set({ cache: {}, savedViews: [] }),
}));

// --- narrow selectors -----------------------------------------------------------
export const selectCollection = (query: CollectionQuery) => {
  const key = collectionKey(query);
  return (s: CollectionsState): CachedCollection | undefined => s.cache[key];
};
export const selectSavedViews = (s: CollectionsState): SavedView[] => s.savedViews;
