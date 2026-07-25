/**
 * Tracking — PRs and commits linked into the graph by `tracks` edges.
 *
 *   PR list      : Z2 cards (repo#, state, fetch freshness incl. stale) +
 *                  linked task chips + per-row refresh
 *   Refresh all  : one `trackingRefresh` command; the mock accepts it and the
 *                  patches arrive as `entity.upsert` events (the 202-style
 *                  shape a real webhook-backed backend will use), so rows
 *                  re-render themselves — this screen never polls.
 *   Commits list : the same collection system, no bespoke rows.
 *
 * v1 is manual-link; `refreshSlot` on each row is the designed slot for live
 * webhook states.
 */
import { useCallback, useState } from 'react';
import { CollectionView, useCollection } from '../../collections';
import { useFacade } from '../../entity';
import { Eyebrow } from '../../kit';
import { pushToast } from '../../subsystems/live';
import type { CollectionQuery, EntityId } from '../../types/contract';
import type { ShellViewProps } from '../../shell';
import { TrackingRow } from './TrackingRow';

let seq = 0;
const nextMutationId = (): string => `cv2-track-${Date.now().toString(36)}-${(seq += 1)}`;

export function TrackingScreen({ spaceId, onOpenEntity }: ShellViewProps) {
  const facade = useFacade();

  const prQuery: CollectionQuery = {
    spaceId, kinds: ['pull_request'], sort: 'activityAt_desc', limit: 50,
  };
  const commitQuery: CollectionQuery = {
    spaceId, kinds: ['commit'], sort: 'activityAt_desc', limit: 50,
  };

  const { items: prs, loading, hasMore, loadMore } = useCollection(prQuery);
  const [pending, setPending] = useState<Set<EntityId>>(new Set());
  const [refreshingAll, setRefreshingAll] = useState(false);

  const mark = useCallback((ids: EntityId[], on: boolean) => {
    setPending((prev) => {
      const next = new Set(prev);
      for (const id of ids) { if (on) next.add(id); else next.delete(id); }
      return next;
    });
  }, []);

  const refresh = useCallback(async (ids: EntityId[] | null) => {
    if (ids) mark(ids, true); else setRefreshingAll(true);
    try {
      await facade.trackingRefresh({
        entityIds: ids ?? undefined,
        clientMutationId: nextMutationId(),
      });
      pushToast({
        kind: 'info',
        message: ids ? 'Re-fetched from the forge.' : 'Re-fetching everything tracked…',
      });
    } catch {
      pushToast({ kind: 'error', message: 'Refresh failed — the forge did not answer.' });
    } finally {
      if (ids) mark(ids, false); else setRefreshingAll(false);
    }
  }, [facade, mark]);

  return (
    <div className="cv2-track" data-testid="view-tracking">
      <header className="cv2-track__head">
        <div className="cv2-track__headrow">
          <Eyebrow>tracking</Eyebrow>
          <h1 className="cv2-track__h1">Pull requests</h1>
          <span className="cv2-track__headspace" />
          <button
            type="button"
            className="cv2-actionbtn"
            data-testid="tracking-refresh-all"
            disabled={refreshingAll}
            onClick={() => { void refresh(null); }}
          >
            {refreshingAll ? 'Refreshing…' : '↻ Refresh all'}
          </button>
        </div>
        <p className="cv2-track__blurb">
          Linked by <span className="t-code">tracks</span> edges. Freshness is per-entity —
          a stale fetch says so on the card.
        </p>
      </header>

      <section className="cv2-track__list" aria-label="Pull requests">
        {prs.map((pr) => (
          <TrackingRow
            key={pr.id}
            entity={pr}
            onOpenEntity={onOpenEntity}
            onRefresh={(id) => { void refresh([id]); }}
            refreshing={pending.has(pr.id) || refreshingAll}
          />
        ))}
        {prs.length === 0 && !loading && (
          <p className="cv2-empty-line" data-testid="tracking-empty">
            Nothing tracked yet — link a PR from a task.
          </p>
        )}
        {hasMore && (
          <button type="button" className="cv2-actionbtn" onClick={() => { void loadMore(); }}>
            Load more
          </button>
        )}
      </section>

      <section className="cv2-track__commits" aria-label="Commits">
        <Eyebrow>commits</Eyebrow>
        <CollectionView query={commitQuery} layout="list" showControls={false} onOpenEntity={onOpenEntity} />
      </section>
    </div>
  );
}
