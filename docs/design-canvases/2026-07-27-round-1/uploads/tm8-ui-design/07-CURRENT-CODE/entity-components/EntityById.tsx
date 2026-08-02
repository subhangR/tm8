/**
 * Id-resolved chip/card — for surfaces that only hold an EntityId (message
 * `{{embed:…}}` tokens, mention lists). Reads the graph-store cache first,
 * fetches through the facade on miss, and keeps history shape with a muted
 * "unavailable" token when the entity is gone (deleted reads reject).
 */
import { useEffect, useState } from 'react';
import { useGraphStore } from '../stores';
import type { EntityId, EntitySummary } from '../types/contract';
import { useFacade } from './context';
import { EntityCard } from './EntityCard';
import { EntityChip } from './EntityChip';
import { ChipSkeleton, EntityCardSkeleton } from './skeletons';

function useEntitySummary(entityId: EntityId): { summary: EntitySummary | undefined; missing: boolean } {
  const summary = useGraphStore((s) => s.entities[entityId]);
  const facade = useFacade();
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (summary) return;
    let cancelled = false;
    facade.getEntity(entityId)
      .then((detail) => { if (!cancelled) useGraphStore.getState().ingestDetail(detail); })
      .catch(() => { if (!cancelled) setMissing(true); });
    return () => { cancelled = true; };
  }, [entityId, summary, facade]);

  return { summary, missing };
}

function Unavailable({ entityId }: { entityId: EntityId }) {
  return (
    <span className="cv2-chip cv2-chip--tombstone" title={entityId}>
      <span className="cv2-chip__glyph" aria-hidden="true">✕</span>
      <span className="cv2-chip__meta">unavailable</span>
    </span>
  );
}

export function ChipById({ entityId }: { entityId: EntityId }) {
  const { summary, missing } = useEntitySummary(entityId);
  if (summary) return <EntityChip entity={summary} />;
  return missing ? <Unavailable entityId={entityId} /> : <ChipSkeleton />;
}

export function CardById({ entityId }: { entityId: EntityId }) {
  const { summary, missing } = useEntitySummary(entityId);
  if (summary) return <EntityCard entity={summary} />;
  return missing ? <Unavailable entityId={entityId} /> : <EntityCardSkeleton />;
}
