/**
 * Docs screen data hooks — the only facade reads the screen performs.
 *
 * Everything else on the screen is composition (CollectionView tree, the Z4
 * EntityFullView reader, the Thread margin slot), so this file holds just the
 * two reads the reader chrome needs: the doc set (for the default selection)
 * and the version history of the doc being read.
 */
import { useCallback } from 'react';
import type { CollabFacade } from '../../facade/CollabFacade';
import { useAsyncValue, type AsyncValue } from '../../shell';
import type {
  CollectionResult, EntityId, EntitySummary, Page, SpaceId,
} from '../../types/contract';

/** A row of `getVersions` — the doc's edit history. */
export interface DocVersionRow { version: number; changedBy: EntityId; changedAt: string }

/** The whole doc set, ordered; the tree sidebar renders it, we pick a default. */
export function useDocs(
  facade: CollabFacade,
  spaceId: SpaceId,
  nonce: number,
): AsyncValue<CollectionResult> {
  const load = useCallback(
    () => facade.queryCollection({ spaceId, kinds: ['doc'], sort: 'position', limit: 200 }),
    [facade, spaceId],
  );
  return useAsyncValue(load, [load, nonce]);
}

/**
 * Default selection: the top of the tree — the first doc without a parent in
 * the result, falling back to the first doc at all.
 */
export function defaultDocId(items: EntitySummary[]): EntityId | null {
  const ids = new Set(items.map((d) => d.id));
  const root = items.find((d) => d.parentId == null || !ids.has(d.parentId));
  return (root ?? items[0])?.id ?? null;
}

/** Version history of the doc in the reader (refetches as the doc is edited). */
export function useDocVersions(
  facade: CollabFacade,
  docId: EntityId | null,
  version: number | null,
): AsyncValue<Page<DocVersionRow>> {
  const load = useCallback(
    () => (docId ? facade.getVersions(docId) : Promise.resolve({ items: [], nextCursor: null })),
    [facade, docId],
  );
  return useAsyncValue(docId ? load : null, [load, version]);
}
