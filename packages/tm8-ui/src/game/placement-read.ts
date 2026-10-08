import type { GameMapIdentity, GameMapPlacement, GameMapSelection } from '@tm8/contract';
import type { GamePort } from './port';

export interface TownPlacement { entityId: string; x: number; z: number; actorId: string; layer: 'human' | 'agent' }
function sameMap(map: GameMapIdentity, spaceId: string, selection: GameMapSelection, mapId?: string): boolean {
  return !!map.id && (!mapId || map.id === mapId) && map.spaceId === spaceId && map.type === selection.type
    && map.scope.kind === selection.scope.kind && map.scope.id === selection.scope.id;
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Map loading cancelled', 'AbortError');
}

/** Reads are bounded and only contribute town coordinates. The graph owns entity state. */
export async function readGamePlacements(port: GamePort, spaceId: string, selection: GameMapSelection,
  admittedIds: ReadonlySet<string>, signal?: AbortSignal): Promise<{ townPlacements: TownPlacement[]; warnings: string[] }> {
  try {
    cancelled(signal);
    const map = await port.open(spaceId, selection, signal);
    cancelled(signal);
    if (!sameMap(map, spaceId, selection)) throw new Error('Map identity mismatch');
    const rows = new Map<string, GameMapPlacement>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const context = await port.context(map.id, cursor, signal);
      cancelled(signal);
      if (!sameMap(context.map, spaceId, selection, map.id)) throw new Error('Map context mismatch');
      for (const row of context.placements) rows.set(row.itemId, row);
      if (!context.nextCursor) {
        const placed = new Map<string, GameMapPlacement>();
        if (selection.type === 'town') for (const row of rows.values()) {
          if (row.kind !== 'ref' || !row.entityId || !admittedIds.has(row.entityId)
            || !Number.isFinite(row.x) || !Number.isFinite(row.z) || Math.abs(row.x) > 1_000_000 || Math.abs(row.z) > 1_000_000
            || !['human', 'agent'].includes(row.layer) || (row.expiresAt !== null && !(Date.parse(row.expiresAt) > Date.now()))) continue;
          const previous = placed.get(row.entityId);
          // Human provenance wins even if an older server exposes overlapping layers.
          if (!previous || (previous.layer === 'agent' && row.layer === 'human') ||
            (previous.layer === row.layer && (row.version > previous.version ||
              (row.version === previous.version && row.itemId > previous.itemId)))) placed.set(row.entityId, row);
        }
        return { townPlacements: [...placed.values()].map(row => ({ entityId: row.entityId!, x: row.x, z: row.z,
          actorId: row.byActor, layer: row.layer })), warnings: [] };
      }
      if (seen.has(context.nextCursor)) throw new Error('Repeated placement cursor');
      seen.add(context.nextCursor);
      cursor = context.nextCursor;
    }
    throw new Error('Placement pagination limit');
  } catch {
    cancelled(signal);
    return { townPlacements: [], warnings: ['Saved placements could not be loaded. Showing the derived layout.'] };
  }
}
