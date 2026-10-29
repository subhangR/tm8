/**
 * The push worker on the R26 scheduler: one fast job that dispatches, one slow
 * job that reads receipts. Both are registered by the composition root only
 * when push is configured (push/config.ts).
 */
import type { JobOutcome, ScheduledJob } from '../scheduler/types.js';
import type { PushDispatcher, PushReceiptChecker } from './dispatcher.js';

export const PUSH_DISPATCH_JOB_NAME = 'push.dispatch';
export const PUSH_RECEIPTS_JOB_NAME = 'push.receipts';

export function createPushDispatchJob(options: {
  readonly dispatcher: Pick<PushDispatcher, 'tick'>;
  readonly intervalMs?: number;
}): ScheduledJob {
  return {
    name: PUSH_DISPATCH_JOB_NAME,
    // A push is worth having while it is news; the queue claim is one cheap
    // call when nobody has a phone registered.
    intervalMs: options.intervalMs ?? 2_000,
    jitterRatio: 0.1,
    runOnStart: true,
    timeoutMs: 60_000,
    quietSkips: true,
    async run(): Promise<JobOutcome> {
      const result = await options.dispatcher.tick();
      if (result.enqueued === 0 && result.claimed === 0 && result.skipped === 0 && result.expired === 0) {
        return { skipped: true, reason: 'no push to send' };
      }
      return { affected: result.accepted, detail: { ...result } };
    },
  };
}

export function createPushReceiptJob(options: {
  readonly checker: Pick<PushReceiptChecker, 'tick'>;
  readonly intervalMs?: number;
}): ScheduledJob {
  return {
    name: PUSH_RECEIPTS_JOB_NAME,
    intervalMs: options.intervalMs ?? 5 * 60_000,
    jitterRatio: 0.1,
    runOnStart: true,
    timeoutMs: 120_000,
    quietSkips: true,
    async run(): Promise<JobOutcome> {
      const result = await options.checker.tick();
      if (result.checked === 0 && result.expired === 0 && result.pruned === 0) {
        return { skipped: true, reason: 'no receipt due' };
      }
      return { affected: result.devicesDeleted, detail: { ...result } };
    },
  };
}
