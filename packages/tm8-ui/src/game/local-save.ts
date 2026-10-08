import type { MapCameraState } from '../story/game/maps/WalkingMapView';
import type { Point } from '../story/game/map-model';
import type { GameMapSelection } from './types';

export interface GameMapMemory { position?: Point; camera?: MapCameraState }
export interface GameSave {
  version: 1;
  spaceId: string;
  memberId: string;
  current: GameMapSelection;
  stack: GameMapSelection[];
  maps: Record<string, GameMapMemory>;
}
type SaveStorage = Pick<Storage, 'getItem' | 'setItem'>;
const TYPES = new Set(['hub', 'taskland', 'office', 'library', 'factory', 'town']);
const MAX_STACK = 64;
const MAX_MAPS = 128;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500;
const coordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
export const validPosition = (value: unknown): value is Point => object(value) && coordinate(value.x) && coordinate(value.z);
export function validCamera(value: unknown): value is MapCameraState {
  const vector = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(coordinate);
  return object(value) && coordinate(value.zoom) && value.zoom >= 0.1 && value.zoom <= 1_000 && vector(value.position) && vector(value.target);
}
function selection(value: unknown): GameMapSelection | null {
  if (!object(value) || typeof value.type !== 'string' || !TYPES.has(value.type) || !object(value.scope)
    || !['space', 'story'].includes(String(value.scope.kind)) || !id(value.scope.id)) return null;
  return { type: value.type as GameMapSelection['type'], scope: { kind: value.scope.kind as 'space' | 'story', id: value.scope.id },
  };
}
export function mapKey(map: GameMapSelection): string { return JSON.stringify([map.scope.kind, map.scope.id, map.type]); }
export function gameSaveKey(spaceId: string, memberId: string): string { return `tm8:game:v1:${JSON.stringify([spaceId, memberId])}`; }
export function freshGameSave(spaceId: string, memberId: string): GameSave {
  return { version: 1, spaceId, memberId, current: { type: 'hub', scope: { kind: 'space', id: spaceId } }, stack: [], maps: Object.create(null) };
}
function browserStorage(): SaveStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}
export function readGameSave(spaceId: string, memberId: string, storage: SaveStorage | undefined = browserStorage()): GameSave {
  const fallback = freshGameSave(spaceId, memberId);
  try {
    const raw = storage?.getItem(gameSaveKey(spaceId, memberId));
    if (!raw || raw.length > 500_000) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed) || parsed.version !== 1 || parsed.spaceId !== spaceId || parsed.memberId !== memberId
      || !Array.isArray(parsed.stack) || parsed.stack.length > MAX_STACK) return fallback;
    const current = selection(parsed.current), stack = parsed.stack.map(selection);
    if (!current || stack.some(s => !s)) return fallback;
    const route = [...stack as GameMapSelection[], current];
    if (mapKey(route[0]!) !== mapKey(fallback.current)) return fallback;
    for (let i = 0; i < route.length; i++) {
      const map = route[i]!;
      if (map.scope.kind === 'space' && map.scope.id !== spaceId) return fallback;
      if (i > 0) {
        const parent = route[i - 1]!;
        // Typed maps descend from their hub; child stories descend from a hub.
        if (parent.type !== 'hub' || (map.type !== 'hub' && (map.scope.kind !== parent.scope.kind || map.scope.id !== parent.scope.id))
          || (map.type === 'hub' && (map.scope.kind !== 'story' || map.scope.id === parent.scope.id))) return fallback;
      }
    }
    const maps: GameSave['maps'] = Object.create(null);
    if (object(parsed.maps)) for (const [key, value] of Object.entries(parsed.maps).slice(-MAX_MAPS)) {
      let parts: unknown;
      try { parts = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(parts) || parts.length !== 3) continue;
      const map = selection({ scope: { kind: parts[0], id: parts[1] }, type: parts[2] });
      if (!map || mapKey(map) !== key || (map.scope.kind === 'space' && map.scope.id !== spaceId) || !object(value)) continue;
      const memory: GameMapMemory = {};
      if (validPosition(value.position)) memory.position = { x: value.position.x, z: value.position.z };
      if (validCamera(value.camera)) memory.camera = { zoom: value.camera.zoom, position: [...value.camera.position], target: [...value.camera.target] };
      maps[key] = memory;
    }
    return { ...fallback, current, stack: stack as GameMapSelection[], maps };
  } catch { return fallback; }
}
export function writeGameSave(save: GameSave, storage: SaveStorage | undefined = browserStorage()): boolean {
  try {
    if (!storage) return false;
    const routeEntry = ({ type, scope }: GameMapSelection) => ({ type, scope });
    storage.setItem(gameSaveKey(save.spaceId, save.memberId), JSON.stringify({ ...save, current: routeEntry(save.current), stack: save.stack.map(routeEntry) }));
    return true;
  } catch { return false; }
}
export function enterGameMap(save: GameSave, target: GameMapSelection): GameSave {
  if (mapKey(target) === mapKey(save.current) || save.stack.length >= MAX_STACK) return save;
  return { ...save, current: target, stack: [...save.stack, save.current] };
}
export function backGameMap(save: GameSave, index = save.stack.length - 1): GameSave {
  if (index < 0 || index >= save.stack.length) return save;
  return { ...save, current: save.stack[index]!, stack: save.stack.slice(0, index) };
}
export function rememberGameMap(save: GameSave, key: string, memory: GameMapMemory): GameSave {
  const maps = { ...save.maps };
  const previous = maps[key];
  delete maps[key];
  maps[key] = { ...previous, ...memory };
  while (Object.keys(maps).length > MAX_MAPS) delete maps[Object.keys(maps)[0]!];
  return { ...save, maps };
}
