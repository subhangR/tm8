/** Geometry bridge for the retained walking game. Navigation metadata stays
 * outside MapModel; all geometry consumed by its renderer comes through it. */
import type { World } from '../world';
import type { MapModel, MapPlace } from './types';

export function walkingMapModel(world: World): MapModel {
  const places: MapPlace[] = world.places.filter(p => !p.portal && !p.members.length).map(p => ({
    id: p.id, entityId: p.id, kind: p.kind, title: p.title, label: p.title,
    x: p.x, z: p.z, radius: p.footprint, footprint: p.siteRadius,
    compoundBounds: { minX: p.x-p.siteRadius, maxX: p.x+p.siteRadius, minZ: p.z-p.siteRadius, maxZ: p.z+p.siteRadius },
    parentId: p.parentId, depth: Math.max(0, p.ring-1), groupId: p.district ?? 'collection',
    assetKey: p.shape, badges: [], mailbox: p.attachments?.mailbox ?? null,
    attention: p.pendingAttention ?? 0, status: p.status, progress: p.progress,
    constructionStage: 'complete', workStatus: null, role: 'entity',
  }));
  return {
    id: `map:story:${world.storyId}:walking`, type: 'hub', scope: { kind: 'story', id: world.storyId },
    places, groups: [], robots: [], layout: { containers: {} }, warnings: [],
    roads: world.roads.filter(r => r.type === 'depends_on').map(r => ({ id: r.id, edgeId: r.id, type: 'depends_on', fromId: r.fromId, toId: r.toId, points: r.points })),
    paths: world.roads.filter(r => r.type !== 'depends_on').map(r => ({ id: r.id, role: 'decorative-path', points: r.points })),
    decor: world.places.filter(p => p.members.length && !p.portal).map(p => ({ id: p.id, role: 'decor', assetKey: p.shape, label: p.title, radius: p.footprint, x: p.x, z: p.z })),
    portals: world.places.filter(p => p.portal).map(p => ({ id: p.id, entityId: p.id, label: p.title, assetKey: p.shape, radius: p.footprint, x: p.x, z: p.z, target: { type: 'hub', scope: { kind: 'story', id: p.id } } })),
    bounds: { minX: -world.extent, maxX: world.extent, minZ: -world.extent, maxZ: world.extent },
  };
}

/** Preserve encounters, aggregate membership, discovery and portal actions;
 * take positions, sizes and road geometry exclusively from the map input. */
export function walkingWorld(model: MapModel, navigation: World): World {
  const positions = new Map([...model.places, ...model.decor, ...model.portals].map(p => [p.id, p]));
  const places = navigation.places.flatMap(p => {
    const geometry = positions.get(p.id);
    if (!geometry) return [];
    return [{ ...p, x: geometry.x, z: geometry.z, footprint: geometry.radius,
      siteRadius: 'footprint' in geometry ? geometry.footprint : geometry.radius }];
  });
  const routes = new Map([...model.roads, ...model.paths].map(r => [r.id, r.points]));
  const roads = navigation.roads.flatMap(r => {
    const points = routes.get(r.id);
    if (!points) return [];
    const length = points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x-points[i]!.x, p.z-points[i]!.z), 0);
    return [{ ...r, points, length }];
  });
  const adjacency = new Map<string, string[]>();
  for (const r of roads) {
    adjacency.set(r.fromId, [...(adjacency.get(r.fromId) ?? []), r.toId]);
    adjacency.set(r.toId, [...(adjacency.get(r.toId) ?? []), r.fromId]);
  }
  return { ...navigation, places, byId: new Map(places.map(p => [p.id,p])), roads, adjacency,
    extent: Math.max(Math.abs(model.bounds.minX), Math.abs(model.bounds.maxX), Math.abs(model.bounds.minZ), Math.abs(model.bounds.maxZ)) };
}
