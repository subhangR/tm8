/** Movement/minimap metadata for any typed map. Model geometry stays authoritative. */
import type { StoryTone } from '../../model';
import type { Place, PlaceShape, Road, World } from '../world';
import type { Bounds, MapModel, MapPlace, MapPortal, Point } from './types';
import { pathLength, routeRoad } from '../roads';
import { doorstep, roadObstacles } from '../world';

function shapeOf(p: MapPlace): PlaceShape {
  if (p.kind === 'task') return 'building';
  if (p.kind === 'work_session') return 'tent';
  if (p.kind === 'team_member') return 'camp';
  if (['doc', 'file', 'artifact', 'drawing', 'memory', 'skill'].includes(p.kind)) return 'library';
  if (['project', 'pull_request', 'commit', 'worktree'].includes(p.kind)) return 'factory';
  return 'stone';
}
function toneOf(status: string | null): StoryTone | null {
  if (['done', 'complete', 'completed', 'merged'].includes(status ?? '')) return 'done';
  if (status === 'blocked') return 'blocked';
  if (['working', 'in_review', 'running'].includes(status ?? '')) return 'working';
  return status ? 'todo' : null;
}
function place(p: MapPlace | MapPortal): Place {
  const entity = 'entityId' in p && 'kind' in p ? p : null;
  return {
    id: p.id, kind: entity?.kind ?? 'story', title: entity?.label ?? (p as MapPortal).label,
    shape: entity ? shapeOf(entity) : 'portal', x: p.x, z: p.z,
    footprint: p.radius, siteRadius: entity?.footprint ?? p.radius,
    ring: entity ? entity.depth + 1 : 1, parentId: entity?.parentId ?? null,
    anchorId: entity?.parentId ?? null, rootIds: [], root: !entity?.parentId,
    portal: !entity, tone: toneOf(entity?.status ?? null), status: entity?.status ?? null,
    live: entity?.processState === 'running', recent: false, progress: entity?.progress ?? null,
    encounters: [], members: [], hasWorker: false, pendingAttention: entity?.attention ?? null,
    attachments: entity?.mailbox ? { library: { count: 0, memberIds: [] }, mailbox: { ...entity.mailbox, approx: entity.mailbox.approx ?? false } } : null,
    district: null,
  };
}
/** Playable ground includes the origin and the default entrance, with a four-unit margin. */
export function walkingBounds(model: MapModel): Bounds {
  const b = model.bounds;
  return { minX: Math.min(0, b.minX) - 4, maxX: Math.max(0, b.maxX) + 4,
    minZ: Math.min(0, b.minZ) - 4, maxZ: Math.max(6, b.maxZ) + 4 };
}
/** Prefer the conventional entrance; otherwise use clear ground left of every footprint. */
export function walkingEntrance(model: MapModel): Point {
  const conventional = { x: 0, z: model.type === 'hub' ? 0 : 6 };
  if (isWalkingPositionSafe(model, conventional)) return conventional;
  return { x: Math.min(0, model.bounds.minX) - 2, z: 0 };
}
/** Compounds include walkable streets; only occupied footprints block a saved pose. */
export function isWalkingPositionSafe(model: MapModel, point: Point): boolean {
  const b = walkingBounds(model);
  return Number.isFinite(point.x) && Number.isFinite(point.z) && point.x >= b.minX && point.x <= b.maxX && point.z >= b.minZ && point.z <= b.maxZ
    && [...model.places, ...model.portals, ...model.decor].every(p => Math.hypot(p.x - point.x, p.z - point.z) >= p.radius + .6);
}
export function mapWalkingWorld(model: MapModel): World {
  const places = [...model.places, ...model.portals].map(place);
  const byId = new Map(places.map(p => [p.id, p]));
  const obstacles = roadObstacles(places);
  const roads: Road[] = model.roads.filter(r => byId.has(r.fromId) && byId.has(r.toId)).map(r => {
    // Displayed dependency lines join building centres. Walking joins safe doorsteps.
    const points = routeRoad(doorstep(byId.get(r.fromId)!), doorstep(byId.get(r.toId)!), obstacles);
    return { ...r, points, family: 'blocks', cross: false, length: pathLength(points) };
  });
  // Decorative paths still supply walk routes; resolve their nearest entrances.
  for (const path of model.paths) {
    if (path.points.length < 2) continue;
    const nearest = (point: { x: number; z: number }) => places.reduce<Place | null>((best, p) => !best || Math.hypot(p.x - point.x, p.z - point.z) < Math.hypot(best.x - point.x, best.z - point.z) ? p : best, null);
    const from = nearest(path.points[0]!), to = nearest(path.points[path.points.length - 1]!);
    if (from && to && from.id !== to.id && Math.hypot(from.x - path.points[0]!.x, from.z - path.points[0]!.z) <= from.footprint + 2 && Math.hypot(to.x - path.points[path.points.length - 1]!.x, to.z - path.points[path.points.length - 1]!.z) <= to.footprint + 2) roads.push({ id: path.id, fromId: from.id, toId: to.id, type: 'path', family: 'parent', cross: false, points: path.points, length: pathLength(path.points) });
  }
  const adjacency = new Map<string, string[]>();
  for (const r of roads) {
    adjacency.set(r.fromId, [...(adjacency.get(r.fromId) ?? []), r.toId]);
    adjacency.set(r.toId, [...(adjacency.get(r.toId) ?? []), r.fromId]);
  }
  const b = model.bounds;
  const extent = Math.max(20, ...[b.minX, b.maxX].flatMap(x => [b.minZ, b.maxZ].map(z => Math.hypot(x, z)))) + 8;
  return { storyId: model.scope.id, hubId: model.scope.id, places, byId, roads, adjacency, extent, districts: [] };
}
