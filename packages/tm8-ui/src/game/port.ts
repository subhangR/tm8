import type { GameMapContext, GameMapIdentity, GameMapSelection } from '@tm8/contract';
import type { GamePersistencePort } from './durable-save';

/** Optional on fixture seams; the real seam uses its normal authenticated transport. */
export interface GamePort extends GamePersistencePort {
  open(spaceId: string, selection: GameMapSelection, signal?: AbortSignal): Promise<GameMapIdentity>;
  context(mapId: string, cursor?: string, signal?: AbortSignal): Promise<GameMapContext>;
}
