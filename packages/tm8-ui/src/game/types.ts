import type { MapInput, MapScope, MapType } from '../story/game/map-model';

export interface GameMapResult { input: MapInput; title: string }
export type GameMapLoader = (scope: MapScope, signal?: AbortSignal, type?: MapType) => Promise<GameMapResult>;
export interface GameMapSelection { type: MapType; scope: MapScope; title?: string }

export interface GameModeProps {
  spaceId: string;
  memberId: string;
  spaceTitle?: string;
  loadMap: GameMapLoader;
  onInspect: (entityId: string) => void;
}
