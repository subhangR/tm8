/**
 * The bridge keeps its session running (R11; migration 425 §2-§3).
 *
 * When a message routes to a bridge whose session target is not running, the
 * inbound door says so (`targetSession.live = false`) and the route calls
 * `ensure` BEFORE it hands the message to delivery:
 *
 *   1. resume the same session (it keeps its context and its handle);
 *   2. if that fails, start a new session as the bridge's teammate and move
 *      the bridge to it (`bridge_managed_retarget`, reason `resume_failed`);
 *      the delivery then re-makes the routed copy on the new session (425 §2);
 *   3. tell the group which of the two happened, once, as a bridge notice.
 *
 * The launch borrows the authority of the member who created the bridge (else
 * the number's owner), read by `bridge_managed_context`; with neither, nothing
 * is launched and the message stays stored on the dead session.
 *
 * One `ensure` per bridge runs at a time: messages that arrive while a session
 * is being resumed wait for that one attempt instead of starting their own.
 */
import type { Db, DbClaims } from '../../db/types.js';
import type { BridgeCommandPorts, BridgeNoticeInput } from '../commands/ports.js';
import { bridgesWorkerClaims } from '../outbox.js';

interface ManagedContext {
  bridgeId: string;
  spaceId: string;
  title: string | null;
  targetKind: 'chat' | 'work_session' | 'channel';
  targetId: string;
  targetTitle: string | null;
  targetLive: boolean;
  teammateId: string | null;
  actingIdentityId: string | null;
  live: boolean;
}

export type BridgeKeeperOutcome = 'live' | 'resumed' | 'replaced' | 'skipped' | 'failed';

export interface BridgeSessionKeeper {
  /** Make the bridge's session target able to take `messageId`. Never throws. */
  ensure(bridgeId: string, messageId: string): Promise<BridgeKeeperOutcome>;
}

export function createBridgeSessionKeeper(o: {
  readonly db: Db;
  readonly spawnWorker: BridgeCommandPorts['spawnWorker'];
  readonly resumeWorker: BridgeCommandPorts['resumeWorker'];
  readonly postNotice: (db: Db, input: BridgeNoticeInput) => Promise<unknown>;
  readonly log?: (line: string) => void;
}): BridgeSessionKeeper {
  const running = new Map<string, Promise<BridgeKeeperOutcome>>();

  async function attempt(bridgeId: string, messageId: string): Promise<BridgeKeeperOutcome> {
    const ctx = await o.db.rpc<ManagedContext | null>(bridgesWorkerClaims(), 'bridge_managed_context', [bridgeId]);
    if (!ctx || !ctx.live || ctx.targetKind !== 'work_session') return 'skipped';
    if (ctx.targetLive) return 'live';
    if (!ctx.actingIdentityId) {
      o.log?.(`[bridges] ${bridgeId}: session ${ctx.targetId} is not running and no member can relaunch it`);
      return 'failed';
    }
    const claims: DbClaims = { identityId: ctx.actingIdentityId, nodeAdmin: false, requestId: `bridge-keeper:${messageId}` };
    const notice = (text: string, key: string) => o.postNotice(o.db, {
      bridgeId, text, replyToMessageId: messageId, idempotencyKey: `keeper:${bridgeId}:${key}`,
    }).catch((err) => o.log?.(`[bridges] ${bridgeId}: keeper notice failed: ${(err as Error).message}`));

    try {
      const resumed = await o.resumeWorker(claims, ctx.targetId, { clientMutationId: `bridge-keeper:${bridgeId}:resume:${messageId}` });
      if (resumed.sessionId !== ctx.targetId) {
        await o.db.rpc(bridgesWorkerClaims(), 'bridge_managed_retarget', [bridgeId, resumed.sessionId, null, 'resume_failed']);
      }
      await notice('the session had stopped; resumed it', `resumed:${messageId}`);
      return 'resumed';
    } catch (err) {
      o.log?.(`[bridges] ${bridgeId}: could not resume ${ctx.targetId}: ${(err as Error).message}`);
    }

    if (!ctx.teammateId) {
      await notice('the session has stopped and could not be resumed; set a teammate on the bridge in tm8 to start a new one', `stuck:${messageId}`);
      return 'failed';
    }
    try {
      const { sessionId } = await o.spawnWorker(claims, {
        spaceId: ctx.spaceId, teamMemberId: ctx.teammateId, taskId: null, projectId: null, effort: null,
        title: (ctx.targetTitle || ctx.title || 'Group session').slice(0, 80),
        clientMutationId: `bridge-keeper:${bridgeId}:spawn:${messageId}`,
        origins: [{ bridgeId, messageId, providerMessageId: null, sender: {}, command: null }],
      });
      await o.db.rpc(bridgesWorkerClaims(), 'bridge_managed_retarget', [bridgeId, sessionId, null, 'resume_failed']);
      await notice('the session had stopped and could not be resumed; started a new one', `replaced:${messageId}`);
      return 'replaced';
    } catch (err) {
      o.log?.(`[bridges] ${bridgeId}: could not start a new session: ${(err as Error).message}`);
      await notice('the session has stopped and a new one could not be started; check the bridge in tm8', `failed:${messageId}`);
      return 'failed';
    }
  }

  return {
    async ensure(bridgeId, messageId) {
      const prior = running.get(bridgeId);
      if (prior) return prior.then(() => 'live' as const);
      const run = attempt(bridgeId, messageId).catch((err) => {
        o.log?.(`[bridges] ${bridgeId}: keeper failed: ${(err as Error).message}`);
        return 'failed' as const;
      }).finally(() => running.delete(bridgeId));
      running.set(bridgeId, run);
      return run;
    },
  };
}
