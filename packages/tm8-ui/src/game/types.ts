import type { MapInput, MapScope, MapType } from '../story/game/map-model';
import type { Seam } from '../data/seam';

/** The host already owns the authorized space socket and its liveness cadence. */
export type GameMapEvents = Pick<Seam, 'onEvent' | 'onResync' | 'liveness'>;

export interface GameMapResult { input: MapInput; title: string }
export type GameMapLoader = (scope: MapScope, signal?: AbortSignal, type?: MapType) => Promise<GameMapResult>;
export interface GameMapSelection { type: MapType; scope: MapScope; title?: string }

export interface GameModeProps {
  spaceId: string;
  memberId: string;
  spaceTitle?: string;
  loadMap: GameMapLoader;
  events?: GameMapEvents;
  onInspect: (entityId: string) => void;
}
