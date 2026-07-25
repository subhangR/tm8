/**
 * One tracking row: the Z2 EntityCard (repo#, state, fetch freshness incl.
 * stale — all rendered by the kind registry), the linked task chips from its
 * `tracks` edges, and a per-row refresh.
 *
 * `refreshSlot` is the live-webhook seam: when webhook-pushed states land, the
 * host swaps the manual button for a live indicator without touching the row.
 */
import { useEffect, useState } from 'react';
import { EntityCard, EntityChip, useFacade } from '../../entity';
import { IconBtn } from '../../kit';
import { useLiveEntity } from '../../subsystems/live';
import type { Connections, EntityId, EntitySummary } from '../../types/contract';
import { TRACKS_EDGE, counterparts } from './links';

export interface TrackingRowProps {
  entity: EntitySummary;
  onOpenEntity: (id: EntityId) => void;
  /** Refresh just this row; the host owns the pending state. */
  onRefresh: (id: EntityId) => void;
  refreshing?: boolean;
  /** Live-webhook seam — replaces the manual refresh affordance when supplied. */
  refreshSlot?: (entity: EntitySummary) => React.ReactNode;
}

export function TrackingRow({
  entity, onOpenEntity, onRefresh, refreshing = false, refreshSlot,
}: TrackingRowProps) {
  const facade = useFacade();
  // The card must show the refreshed `fetchedAt`/`stale` the moment the
  // command's patch lands — that arrives through the graph store.
  const live = useLiveEntity(entity);
  const [connections, setConnections] = useState<Connections | null>(null);

  useEffect(() => {
    let alive = true;
    facade.getConnections(entity.id).then(
      (c) => { if (alive) setConnections(c); },
      () => { if (alive) setConnections(null); },
    );
    return () => { alive = false; };
    // `version`/`activityAt` move when an edge is added, so links stay current.
  }, [facade, entity.id, live.activityAt]);

  const tasks = counterparts(connections, TRACKS_EDGE, entity.id);

  return (
    <div className="cv2-track__row" data-testid={`tracking-row-${entity.id}`} data-entity={entity.id}>
      <div
        role="button"
        tabIndex={0}
        className="cv2-track__card"
        onClick={() => onOpenEntity(entity.id)}
        onKeyDown={(e) => { if (e.key === 'Enter') onOpenEntity(entity.id); }}
      >
        <EntityCard entity={live} keyEdges={tasks} />
      </div>

      <div className="cv2-track__side">
        <div className="cv2-track__links" data-testid={`tracking-links-${entity.id}`}>
          {tasks.length > 0
            ? tasks.map((t) => <EntityChip key={t.id} entity={t} onOpen={onOpenEntity} />)
            : <span className="cv2-empty-line">no linked task</span>}
        </div>
        {refreshSlot
          ? refreshSlot(live)
          : (
            <IconBtn
              aria-label={`Refresh ${live.title}`}
              title="Re-fetch this from the forge"
              disabled={refreshing}
              onClick={() => onRefresh(live.id)}
            >
              {refreshing ? '…' : '↻'}
            </IconBtn>
          )}
      </div>
    </div>
  );
}
