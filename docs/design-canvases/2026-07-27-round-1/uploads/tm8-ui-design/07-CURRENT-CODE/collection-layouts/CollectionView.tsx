/**
 * CollectionView — ONE system for every list of entities.
 *
 * `CollectionView(query, layout, groupBy, sortBy)` executes the query against
 * the facade (cached + live via useCollection) and renders it in any of the
 * six layouts: List · Board · Tree · Feed · Gallery · Graph. The layout
 * switcher, groupBy pivot (any axis, uniformly), and save-view control ride
 * on top; every cell is the same Z2 EntityCard; arrows navigate via the
 * shell's list key-nav.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFacade } from '../entity';
import { useNavStore } from '../stores/nav';
import { useCollectionsStore } from '../stores/collections';
import type {
  CollectionQuery, EntityId, GraphQuery, SavedView, TaskAxis,
} from '../types/contract';
import { GraphCanvas } from './graph/GraphCanvas';
import { groupItems, type GroupByKey } from './grouping';
import { EmptyState } from './EmptyState';
import {
  COLLECTION_LAYOUTS, GroupByPivot, LayoutSwitcher, SaveViewControl,
  type CollectionLayout,
} from './controls';
import type { RowAction, RowSelection } from './slots';
import { useCollection } from './useCollection';
import { BoardLayout } from './layouts/BoardLayout';
import { FeedLayout } from './layouts/FeedLayout';
import { GalleryLayout } from './layouts/GalleryLayout';
import { ListLayout } from './layouts/ListLayout';
import { TreeLayout } from './layouts/TreeLayout';

export interface CollectionViewProps {
  query: CollectionQuery;
  /** Initial layout; the built-in switcher takes over after mount. */
  layout?: CollectionLayout;
  groupBy?: GroupByKey;
  sortBy?: CollectionQuery['sort'];
  onOpenEntity?: (id: EntityId) => void;
  /** Hide the switcher/pivot/save-view chrome (rail sections, channel tabs). */
  showControls?: boolean;
  /** Replaces the built-in teaching empty state. */
  emptyState?: React.ReactNode;
  /** Applied saved view — seeds layout/groupBy and the graph's positions. */
  savedView?: SavedView | null;
  /** Per-row action slot, rendered by the List/Board/Tree/Gallery rows. */
  rowAction?: RowAction;
  /** Checkbox-selection mode for the List/Board/Tree/Gallery rows. */
  selection?: RowSelection;
  /** Tree layout: levels auto-expanded on mount (default 0 — roots only). */
  expandDepth?: number;
}

function coerceLayout(l: string | undefined): CollectionLayout {
  return (COLLECTION_LAYOUTS as readonly string[]).includes(l ?? '') ? (l as CollectionLayout) : 'list';
}

export function CollectionView({
  query, layout, groupBy, sortBy, onOpenEntity, showControls = true, emptyState,
  savedView = null, rowAction, selection, expandDepth,
}: CollectionViewProps) {
  const facade = useFacade();
  const [uiLayout, setUiLayout] = useState<CollectionLayout>(
    layout ?? coerceLayout(savedView?.query.layout ?? query.layout),
  );
  const [uiGroupBy, setUiGroupBy] = useState<GroupByKey | undefined>(
    groupBy ?? savedView?.query.groupBy ?? query.groupBy,
  );
  const [uiSort, setUiSort] = useState<CollectionQuery['sort'] | undefined>(
    sortBy ?? savedView?.query.sort ?? query.sort,
  );
  useEffect(() => { if (layout) setUiLayout(layout); }, [layout]);
  useEffect(() => { if (groupBy) setUiGroupBy(groupBy); }, [groupBy]);
  useEffect(() => { if (sortBy) setUiSort(sortBy); }, [sortBy]);

  // A board without a pivot pivots on workStatus — the one default the brief
  // allows, because a board IS its columns.
  const effectiveGroupBy: GroupByKey | undefined =
    uiLayout === 'board' ? (uiGroupBy ?? 'workStatus') : uiGroupBy;

  const effectiveQuery: CollectionQuery = useMemo(() => ({
    ...(savedView?.query ?? query),
    layout: uiLayout,
    groupBy: effectiveGroupBy,
    sort: uiSort,
  }), [query, savedView, uiLayout, effectiveGroupBy, uiSort]);

  const [axes, setAxes] = useState<TaskAxis[]>([]);
  useEffect(() => {
    let alive = true;
    facade.getTaskAxes(effectiveQuery.spaceId).then(
      (a) => { if (alive) setAxes(a); },
      () => { /* pivot simply shows the built-ins */ },
    );
    return () => { alive = false; };
  }, [facade, effectiveQuery.spaceId]);

  const collection = useCollection(effectiveQuery);
  const open = onOpenEntity ?? ((id: EntityId) => useNavStore.getState().pushPanel({ entityId: id }));

  // Groups are recomputed client-side from the (live-patched) items so
  // optimistic mutations move cards immediately; the algorithm is the
  // facade's own (see grouping.ts).
  const groups = useMemo(
    () => (effectiveGroupBy ? groupItems(collection.items, effectiveGroupBy, axes) : undefined),
    [collection.items, effectiveGroupBy, axes],
  );

  const graphLayoutRef = useRef<Record<string, { x: number; y: number }> | null>(
    savedView?.graphLayout ?? null,
  );

  const saveView = async (input: {
    name: string; shareMode: 'private' | 'space'; query: CollectionQuery;
    graphLayout?: Record<string, { x: number; y: number }>;
  }): Promise<SavedView> => {
    const view = await facade.createSavedView(effectiveQuery.spaceId, input);
    useCollectionsStore.getState().upsertSavedView(view);
    return view;
  };

  const isEmpty = !collection.loading && collection.items.length === 0;

  return (
    <div className="cv2-collection" data-layout={uiLayout}>
      {showControls && (
        <div className="cv2-collection__controls">
          <LayoutSwitcher value={uiLayout} onChange={setUiLayout} />
          <GroupByPivot value={uiGroupBy} axes={axes} onChange={setUiGroupBy} />
          <span className="cv2-collection__spacer" />
          <SaveViewControl
            query={effectiveQuery}
            graphLayout={uiLayout === 'graph' ? graphLayoutRef.current : null}
            onSave={saveView}
          />
        </div>
      )}

      {collection.error && (
        <div className="cv2-board__banner" role="alert">
          {collection.error.message}
          <button type="button" className="cv2-board__bannerclose" onClick={collection.refetch}>retry</button>
        </div>
      )}

      {collection.loading && collection.items.length === 0 && (
        <div className="cv2-collection__loading" role="status">loading…</div>
      )}

      {isEmpty && (emptyState ?? <EmptyState kinds={effectiveQuery.kinds} />)}

      {!isEmpty && uiLayout === 'list' && (
        <ListLayout items={collection.items} onOpen={open} rowAction={rowAction} selection={selection} />
      )}
      {!isEmpty && uiLayout === 'feed' && <FeedLayout items={collection.items} onOpen={open} />}
      {!isEmpty && uiLayout === 'gallery' && (
        <GalleryLayout items={collection.items} onOpen={open} rowAction={rowAction} selection={selection} />
      )}
      {!isEmpty && uiLayout === 'board' && (
        <BoardLayout
          items={collection.items}
          groupBy={effectiveGroupBy ?? 'workStatus'}
          axes={axes}
          onOpen={open}
          rowAction={rowAction}
          selection={selection}
        />
      )}
      {!isEmpty && uiLayout === 'tree' && (
        <TreeLayout
          items={collection.items}
          onOpen={open}
          onChanged={collection.refetch}
          rowAction={rowAction}
          selection={selection}
          expandDepth={expandDepth}
        />
      )}
      {uiLayout === 'graph' && (
        <GraphCanvas
          query={effectiveQuery as GraphQuery}
          onOpenEntity={open}
          savedView={savedView}
          onLayoutChange={(l) => { graphLayoutRef.current = l; }}
        />
      )}

      {!isEmpty && uiLayout !== 'graph' && collection.hasMore && (
        <button type="button" className="cv2-collection__more" onClick={() => void collection.loadMore()}>
          load more
        </button>
      )}
      {groups && uiLayout !== 'board' && uiLayout !== 'graph' && groups.length > 0 && (
        // Non-board layouts surface the pivot as section counts (the list
        // itself stays flat; the board is the grouped presentation).
        <div className="cv2-collection__groupsummary" aria-label="Group summary">
          {groups.map((g) => (
            <span key={g.key} className="cv2-collection__chip" data-group={g.key}>
              {g.label} · {g.items.length}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
