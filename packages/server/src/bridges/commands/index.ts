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
import { createBridgeSessionKeeper, type BridgeSessionKeeper } from '../runtime/keeper.js';
import type { BridgeCommandPorts, BridgeGroupPort, BridgeGroupResult } from './ports.js';
import type { BridgeRuntimeHub } from '../runtime/hub.js';
import type { GroupFrame } from '@tm8/contract';

export { createBridgeCommandExecutor, VERB_TIER } from './executor.js';
export type { BridgeCommandExecutor } from './executor.js';
export type { BridgeCommandInput, BridgeCommandOrigin, BridgeCommandPorts } from './ports.js';
export { isBridgeCommandText, parseBridgeCommand } from './parse.js';

/**
 * 426: the number's group powers, through the runtime that runs it. The hub
 * is read when a command runs (it is built after the executor).
 */
export function bridgeGroupPort(db: Db, hub: () => BridgeRuntimeHub | undefined): BridgeGroupPort {
  const runtimeOf = async (connectionId: string): Promise<{ hub: BridgeRuntimeHub; runtimeId: string }> => {
    const h = hub();
    const runtimeId = await db.rpc<string | null>(bridgesWorkerClaims(), 'bridge_runtime_of', [connectionId]);
    if (!h || !runtimeId) throw new Error('WhatsApp is not connected on this number right now');
    return { hub: h, runtimeId };
  };
  const settled = (frame: GroupFrame): BridgeGroupResult => {
    if ('error' in frame) throw new Error(frame.error);
    return { conversationId: frame.conversationId, subject: frame.subject, results: frame.results, inviteLink: frame.inviteLink };
  };
  return {
    async create(input) {
      const { hub: h, runtimeId } = await runtimeOf(input.connectionId);
      return settled(await h.createGroup(runtimeId, input));
    },
    async add(input) {
      const { hub: h, runtimeId } = await runtimeOf(input.connectionId);
      return settled(await h.addToGroup(runtimeId, input));
    },
  };
}

export function createBridgeCommands(deps: {
  db: Db;
  spawnService: SpawnService;
  logger?: BridgeCommandPorts['logger'];
  /** 426: /split and /invite; absent, both say this node cannot make groups. */
  groups?: BridgeGroupPort;
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
    ...(deps.groups ? { groups: deps.groups } : {}),
  });
}

/** R11: the keeper that resumes, else replaces, a bridge's stopped session (runtime/keeper.ts). */
export function createBridgeKeeper(deps: {
  db: Db;
  spawnService: SpawnService;
  log?: (line: string) => void;
}): BridgeSessionKeeper {
  const workers = createBridgeWorkerPort({ db: deps.db, spawnService: deps.spawnService });
  return createBridgeSessionKeeper({
    db: deps.db,
    spawnWorker: workers.spawnWorker,
    resumeWorker: workers.resumeWorker,
    postNotice: postBridgeNotice,
    ...(deps.log ? { log: deps.log } : {}),
  });
}
