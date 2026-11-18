/**
 * Slack thread mode (migration 444; design doc 01a1ed5f-40af §1.2-1.3, §2.1):
 * one session per Slack thread.
 *
 * The inbound door stores a top-level message that starts a thread unrouted,
 * with its `bridge_threads` row, and answers `targetSession.live = false`, so
 * the route asks the keeper for a session BEFORE it delivers (425's R11 path).
 * The keeper asks this module first, per MESSAGE:
 *
 *   - the message is in a thread whose session runs: nothing to do;
 *   - its session stopped (idle, or ended): resume it, with its history;
 *   - it has no session yet, or the resume failed: start one, as the bridge's
 *     teammate, a child of the bridge's target session when the target is a
 *     session (else a top-level session), holding the root message as its
 *     '/thread' origin. 399's audience then delivers every message of the
 *     thread to it, and 444's outbox trigger posts its replies into the thread.
 *
 * `sweepThreads` runs on the bridges watchdog (through the command executor's
 * sweep, commands/index.ts), so it needs that watchdog running:
 * it stops a thread session that has waited for input for
 * BRIDGE_THREAD_IDLE_MS with nothing in its thread (the next reply resumes it),
 * and starts the session of a thread the server never got to (a crash between
 * the inbound commit and the keeper).
 *
 * The launch borrows the authority of the member who created the bridge, else
 * the connection's owner (425's bridge_managed_context), like the keeper.
 */
import { randomUUID } from 'node:crypto';
import type { Db, DbClaims } from '../../db/types.js';
import type { BridgeCommandOrigin, BridgeCommandPorts, BridgeNoticeInput } from '../commands/ports.js';
import { titleOf } from '../commands/parse.js';
import { bridgesWorkerClaims } from '../outbox.js';

/** A thread session with nothing in its thread for this long, and waiting for input, is stopped. */
export const BRIDGE_THREAD_IDLE_MS = 2 * 60 * 60_000;
/**
 * One sweep's time budget, well under the watchdog job's 60 s timeout. Threads
 * handed out but not reached are marked (444) and come back in a later sweep.
 */
export const BRIDGE_THREAD_SWEEP_BUDGET_MS = 20_000;
/** Stops per sweep (444 adds at most 5 starts). */
const SWEEP_BATCH = 10;

interface ThreadContext {
  bridgeId: string;
  spaceId: string;
  /** The Slack channel's name. */
  title: string | null;
  targetKind: 'chat' | 'work_session' | 'channel';
  targetId: string;
  teammateId: string | null;
  actingIdentityId: string | null;
  /** The bridge is neither ended nor paused. */
  live: boolean;
  rootMessageId: string;
  rootExternalId: string;
  rootText: string;
  sessionId: string | null;
  sessionLive: boolean;
  parentSessionId: string | null;
  sender: BridgeCommandOrigin['sender'];
  /** The thread after its root, oldest first, at most 20. */
  recent: { messageId: string; at: string; from: string; text: string }[];
}

interface DueThread {
  action: 'stop' | 'start';
  bridgeId: string;
  rootExternalId: string;
  rootMessageId: string;
  sessionId?: string;
}

export type BridgeThreadOutcome = 'live' | 'started' | 'resumed' | 'replaced' | 'skipped' | 'failed';

export interface BridgeThreadKeeper {
  /**
   * Make the session of the thread `messageId` belongs to able to take it.
   * Null when the message is in no thread that started a session (the caller
   * keeps the bridge's own target). Never throws.
   */
  ensure(bridgeId: string, messageId: string): Promise<BridgeThreadOutcome | null>;
  /** Idle stops and missed starts; answers how many threads it acted on. Never throws. */
  sweepThreads(): Promise<number>;
}

/** Slack writes a mention as <@U123> (or <@U123|name>); a title reads better without it. */
export function threadTitle(text: string, channel: string | null): string {
  const words = text.replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, ' ').replace(/(^|\s)@tm8\b/gi, ' ').trim();
  return titleOf(words || `Thread in #${channel ?? 'slack'}`, 80);
}

/**
 * What the session reads at launch. A session that starts with the root
 * delivered to it (the normal start) gets the frame only. One that will not
 * be delivered the root (a missed start, or a replacement after a failed
 * resume, `context` set) also gets the root and the thread so far, except the
 * message about to be delivered (`except`).
 */
function brief(ctx: ThreadContext, idleMs: number, context: { except: string | null } | null): string {
  const hours = Math.round(idleMs / 3_600_000);
  const lines = [
    `You were started by a message in the Slack channel #${ctx.title ?? 'unknown'}, and you live in its thread.`,
    'Every reply in that thread reaches you as a bridge message; answer each by replying to it, and your answer is posted into the thread under your own name.',
    `When nothing happens in the thread for ${hours} hour${hours === 1 ? '' : 's'} while you wait for input, you are stopped; the next reply in the thread resumes you with this history.`,
  ];
  if (context) {
    lines.push('', `The message that started the thread${ctx.sender.participant ? ` (from ${ctx.sender.participant})` : ''}:`, ctx.rootText);
    const recent = (ctx.recent ?? []).filter((m) => m.messageId !== context.except);
    if (recent.length > 0) {
      lines.push('', 'The thread so far (oldest first):');
      for (const m of recent) lines.push(`- ${m.from}: ${m.text.replace(/\s+/g, ' ')}`);
    }
  }
  return lines.join('\n');
}

export function createBridgeThreadKeeper(o: {
  readonly db: Db;
  readonly spawnWorker: BridgeCommandPorts['spawnWorker'];
  readonly resumeWorker: BridgeCommandPorts['resumeWorker'];
  readonly stopWorker?: BridgeCommandPorts['stopWorker'];
  readonly postNotice: (db: Db, input: BridgeNoticeInput) => Promise<unknown>;
  readonly idleMs?: number;
  readonly sweepBudgetMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}): BridgeThreadKeeper {
  const idleMs = o.idleMs ?? BRIDGE_THREAD_IDLE_MS;
  const budgetMs = o.sweepBudgetMs ?? BRIDGE_THREAD_SWEEP_BUDGET_MS;
  const now = o.now ?? Date.now;
  const running = new Map<string, Promise<BridgeThreadOutcome>>();

  const context = (bridgeId: string, messageId: string) =>
    o.db.rpc<ThreadContext | null>(bridgesWorkerClaims(), 'bridge_thread_context', [bridgeId, messageId]);
  const claimsOf = (ctx: ThreadContext, key: string): DbClaims =>
    ({ identityId: ctx.actingIdentityId!, nodeAdmin: false, requestId: `bridge-thread:${key}` });
  const notice = (ctx: ThreadContext, text: string, key: string) => o.postNotice(o.db, {
    bridgeId: ctx.bridgeId, text, replyToMessageId: ctx.rootMessageId,
    idempotencyKey: `thread:${ctx.bridgeId}:${ctx.rootExternalId}:${key}`,
  }).catch((err) => o.log?.(`[bridges] ${ctx.bridgeId}: thread notice failed: ${(err as Error).message}`));

  async function start(ctx: ThreadContext, attempt: string, context: { except: string | null } | null): Promise<boolean> {
    if (!ctx.teammateId) {
      await notice(ctx, 'no session could start for this thread: set a teammate on the bridge in tm8', 'no-teammate');
      return false;
    }
    try {
      const { sessionId } = await o.spawnWorker(claimsOf(ctx, attempt), {
        spaceId: ctx.spaceId, teamMemberId: ctx.teammateId, taskId: null, projectId: null, effort: null,
        title: threadTitle(ctx.rootText, ctx.title),
        clientMutationId: `bridge-thread:${ctx.bridgeId}:${ctx.rootExternalId}:${attempt}`,
        // The bridge's target session is the parent. A chat or channel target has
        // no session to hang under, so the thread session is a top-level session
        // (444's bridge_thread_context answers parentSessionId null for those).
        origins: [{ bridgeId: ctx.bridgeId, messageId: ctx.rootMessageId, providerMessageId: ctx.rootExternalId, sender: ctx.sender, command: '/thread' }],
        parentSessionId: ctx.parentSessionId,
        promptExtra: brief(ctx, idleMs, context),
      });
      await o.db.rpc(bridgesWorkerClaims(), 'bridge_thread_bind', [ctx.bridgeId, ctx.rootExternalId, sessionId]);
      return true;
    } catch (err) {
      o.log?.(`[bridges] ${ctx.bridgeId}: could not start the session of thread ${ctx.rootExternalId}: ${(err as Error).message}`);
      await notice(ctx, 'a session could not be started for this thread; check the bridge in tm8', `failed:${attempt}`);
      return false;
    }
  }

  async function attempt(ctx: ThreadContext, messageId: string, includeRoot: boolean): Promise<BridgeThreadOutcome> {
    if (!ctx.live) return 'skipped';
    if (ctx.sessionLive) return 'live';
    if (!ctx.actingIdentityId) {
      o.log?.(`[bridges] ${ctx.bridgeId}: thread ${ctx.rootExternalId} has no member who can launch its session`);
      return 'failed';
    }
    if (ctx.sessionId) {
      try {
        const resumed = await o.resumeWorker(claimsOf(ctx, `resume:${messageId}`), ctx.sessionId, {
          clientMutationId: `bridge-thread:${ctx.bridgeId}:${ctx.rootExternalId}:resume:${messageId}`,
        });
        await o.db.rpc(bridgesWorkerClaims(), 'bridge_thread_bind', [ctx.bridgeId, ctx.rootExternalId, resumed.sessionId]);
        return 'resumed';
      } catch (err) {
        o.log?.(`[bridges] ${ctx.bridgeId}: could not resume thread session ${ctx.sessionId}: ${(err as Error).message}`);
      }
      // A replacement has none of the old session's history: it is told the thread.
      return (await start(ctx, `spawn:${messageId}`, { except: messageId })) ? 'replaced' : 'failed';
    }
    return (await start(ctx, 'spawn', includeRoot ? { except: null } : null)) ? 'started' : 'failed';
  }

  function ensureWith(bridgeId: string, messageId: string, includeRoot: boolean): Promise<BridgeThreadOutcome | null> {
    return context(bridgeId, messageId).then((ctx) => {
      if (!ctx) return null;
      const key = `${bridgeId}:${ctx.rootExternalId}`;
      const prior = running.get(key);
      // A second message of a thread being started waits for that start.
      if (prior) return prior.then(() => 'live' as const);
      const run = attempt(ctx, messageId, includeRoot).catch((err) => {
        o.log?.(`[bridges] ${bridgeId}: thread keeper failed: ${(err as Error).message}`);
        return 'failed' as const;
      }).finally(() => running.delete(key));
      running.set(key, run);
      return run;
    }).catch((err) => {
      o.log?.(`[bridges] ${bridgeId}: thread context of ${messageId} failed: ${(err as Error).message}`);
      return 'failed' as const;
    });
  }

  return {
    ensure: (bridgeId, messageId) => ensureWith(bridgeId, messageId, false),

    async sweepThreads() {
      const deadline = now() + budgetMs;
      let due: DueThread[];
      try {
        due = await o.db.rpc<DueThread[]>(bridgesWorkerClaims('bridges.threads'), 'bridge_threads_due', [Math.round(idleMs / 1000), SWEEP_BATCH]);
      } catch (err) {
        o.log?.(`[bridges] thread sweep failed: ${(err as Error).message}`);
        return 0;
      }
      let acted = 0;
      for (const row of Array.isArray(due) ? due : []) {
        // Out of time: the rest were marked when handed out and come back later.
        if (now() > deadline) break;
        try {
          if (row.action === 'start') {
            // Nothing delivered the root to a session, so its brief carries it.
            const outcome = await ensureWith(row.bridgeId, row.rootMessageId, true);
            if (outcome === 'started') acted += 1;
            continue;
          }
          if (!o.stopWorker || !row.sessionId) continue;
          const ctx = await context(row.bridgeId, row.rootMessageId);
          if (!ctx?.actingIdentityId) continue;
          await o.stopWorker(claimsOf(ctx, `idle:${row.sessionId}`), row.sessionId, {
            reason: 'thread_idle', clientMutationId: `bridge-thread:${row.bridgeId}:${row.rootExternalId}:idle:${randomUUID()}`,
          });
          await o.db.rpc(bridgesWorkerClaims(), 'bridge_thread_idle_stopped', [row.bridgeId, row.rootExternalId]);
          acted += 1;
        } catch (err) {
          o.log?.(`[bridges] ${row.bridgeId}: thread ${row.rootExternalId} ${row.action} failed: ${(err as Error).message}`);
        }
      }
      return acted;
    },
  };
}
