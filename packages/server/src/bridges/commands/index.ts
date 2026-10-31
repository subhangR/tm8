/**
 * Bridges B1b-4: the command executor, bound to the real server. `main.ts`
 * builds it where the execution runtime exists and injects it as the inbound
 * door's `BridgeCommandHook` (B1b-2, bridges/runtime/command-hook.ts).
 */
import type { SpawnService } from '@tm8/execution';
import type { Db } from '../../db/types.js';
import { createBridgeWorkerPort } from '../../facade/execution-handlers.js';
import { bridgesWorkerClaims, postBridgeNotice, reactBridgeMessage } from '../outbox.js';
import { createBridgeCommandExecutor, type BridgeCommandExecutor } from './executor.js';
import type { BridgeCommandPorts } from './ports.js';

export { createBridgeCommandExecutor, VERB_TIER } from './executor.js';
export type { BridgeCommandExecutor } from './executor.js';
export type { BridgeCommandInput, BridgeCommandOrigin, BridgeCommandPorts } from './ports.js';
export { isBridgeCommandText, parseBridgeCommand } from './parse.js';

export function createBridgeCommands(deps: {
  db: Db;
  spawnService: SpawnService;
  logger?: BridgeCommandPorts['logger'];
}): BridgeCommandExecutor {
  const { db } = deps;
  const workers = createBridgeWorkerPort({ db, spawnService: deps.spawnService });
  return createBridgeCommandExecutor({
    db,
    executorClaims: async () => bridgesWorkerClaims(),
    postNotice: postBridgeNotice,
    react: reactBridgeMessage,
    // B1b-2's command state (message_origins.command_state); only the bridges worker may move it.
    claim: async messageId => (await db.rpc<boolean>(bridgesWorkerClaims(), 'internal.bridge_command_claim', [messageId])) === true,
    settle: async (messageId, outcome) => {
      await db.rpc(bridgesWorkerClaims(), 'internal.bridge_command_settle', [messageId, outcome]);
    },
    // B1b-3's recorder door: authored_from -> bridge (+ -> message), D31 shape, in the create's tx.
    recordOrigin: async (q, entityId, origin) => {
      await q.rpc('record_bridge_provenance', [entityId, JSON.stringify([origin])]);
    },
    spawnWorker: workers.spawnWorker,
    stopWorker: workers.stopWorker,
    resumeWorker: workers.resumeWorker,
    // B1b-3: mints the session's space handle (D23) and records it appeared on this bridge.
    workerHandle: async (claims, bridgeId, sessionId) => {
      const raw = await db.rpc<{ handle?: string; title?: string | null } | null>(claims, 'bridge_poster_handle', [bridgeId, sessionId]);
      return raw?.handle ? { handle: raw.handle, title: raw.title ?? null } : null;
    },
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}
