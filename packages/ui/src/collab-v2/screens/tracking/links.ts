/**
 * Edge-derived link helpers for the tracking rows.
 *
 * A PR's linked tasks are the counterparts of its `tracks` edges — read from
 * `Connections` (the contract's own edge projection) in whichever direction they
 * arrive, so the screen never assumes an arrow direction or a kind.
 */
import type { Connections, EntityId, EntitySummary } from '../../types/contract';

export const TRACKS_EDGE = 'tracks';

/** Counterpart entities joined to `selfId` by edges of `type`, de-duplicated. */
export function counterparts(
  connections: Connections | null | undefined,
  type: string,
  selfId: EntityId,
): EntitySummary[] {
  const groups = [...(connections?.outgoing ?? []), ...(connections?.incoming ?? [])];
  const seen = new Map<EntityId, EntitySummary>();
  for (const group of groups) {
    if (group.type !== type) continue;
    for (const edge of group.edges) {
      const other = edge.source.id === selfId ? edge.target : edge.source;
      if (other.id !== selfId && !seen.has(other.id)) seen.set(other.id, other);
    }
  }
  return [...seen.values()];
}
