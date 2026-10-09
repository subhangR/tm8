import { BoundsIndex } from './spatial-index';
import type { MapPlace, TownPlacement } from './types';

/** Fixed authoritative placements, then stable yard slots avoiding those buildings.
 * Does not admit entities or interpret actor permissions/storage expiry.
 */
export function placeShippedEntities(places: MapPlace[], placements: readonly TownPlacement[]) {
  const admitted = new Set(places.map(p => p.id));
  const fixed = new Map<string, TownPlacement>();
  const warnings: string[] = [];
  for (const placement of placements) {
    if (!admitted.has(placement.entityId)) continue;
    if (!Number.isFinite(placement.x) || !Number.isFinite(placement.z)) {
      warnings.push(`Invalid town placement for ${placement.entityId}; kept in Shipping Yard`); continue;
    }
    if (fixed.has(placement.entityId)) { warnings.push(`Duplicate town placement for ${placement.entityId} ignored`); continue; }
    fixed.set(placement.entityId, placement);
  }
  const index = new BoundsIndex(12);
  const move = (place: MapPlace, x: number, z: number) => {
    place.x = x; place.z = z;
    // Town entities are independent leaves; reconstructing bounds avoids tiny
    // translation-rounding drift on reload at the same persisted coordinates.
    place.compoundBounds = { minX: x - place.radius, maxX: x + place.radius, minZ: z - place.radius, maxZ: z + place.radius };
  };
  const box = (p: MapPlace, x = p.x, z = p.z) => ({
    id: p.id, minX: x - p.radius, maxX: x + p.radius, minZ: z - p.radius, maxZ: z + p.radius,
  });
  for (const p of places) {
    const location = fixed.get(p.id); if (!location) continue;
    move(p, location.x, location.z); p.groupId = 'group:@roots:town';
    if (index.collides(box(p))) warnings.push(`Persisted town placement ${p.id} overlaps another placed building`);
    index.insert(box(p));
  }
  for (const p of places) {
    if (fixed.has(p.id)) continue;
    if (index.collides(box(p))) {
      const step = 2 * p.radius + 3;
      let located = false;
      for (let ring = 1; !located; ring++) {
        for (let dx = -ring; dx <= ring && !located; dx++) for (let dz = -ring; dz <= ring; dz++) {
          if (Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          const x = p.x + dx * step, z = p.z + dz * step;
          if (!index.collides(box(p, x, z))) { move(p, x, z); located = true; break; }
        }
      }
    }
    index.insert(box(p));
  }
  return { fixed, warnings };
}
