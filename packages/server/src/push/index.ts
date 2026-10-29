/**
 * Push dispatch (TM8 Mobile S6): notification.created → the push relay.
 * `createPushJobs` is the composition root's single entry point.
 */
import type { Db, DbClaims } from '../db/types.js';
import type { ScheduledJob } from '../scheduler/types.js';
import type { PushConfig } from './config.js';
import { PushDispatcher, PushReceiptChecker, type PushLogger } from './dispatcher.js';
import { ExpoPushRelay } from './expo-relay.js';
import { createPushDispatchJob, createPushReceiptJob } from './jobs.js';
import { PgPushStore } from './store.js';
import type { OpenDeviceToken, PushRelay } from './types.js';

export { pushConfigFromEnv, type PushConfig, type PushConfigResult } from './config.js';
export { nodeDeviceTokenOpener } from './token-opener.js';
export { PUSH_DISPATCH_JOB_NAME, PUSH_RECEIPTS_JOB_NAME } from './jobs.js';

export interface PushJobsDeps {
  readonly db: Db;
  /** The push worker: node owner claims with nodeAdmin and backgroundJob 'push.dispatch'. */
  readonly claims: () => Promise<DbClaims>;
  readonly config: PushConfig;
  readonly openToken: OpenDeviceToken;
  /** Tests inject a fake; production builds the Expo relay from `config`. */
  readonly relay?: PushRelay;
  readonly logger?: PushLogger;
}

export function createPushJobs(deps: PushJobsDeps): ScheduledJob[] {
  const store = new PgPushStore({ db: deps.db, claims: deps.claims });
  const relay = deps.relay ?? new ExpoPushRelay({ accessToken: deps.config.accessToken });
  const dispatcher = new PushDispatcher({
    store,
    relay,
    openToken: deps.openToken,
    origin: deps.config.origin,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
  const checker = new PushReceiptChecker({ store, relay, ...(deps.logger ? { logger: deps.logger } : {}) });
  return [createPushDispatchJob({ dispatcher }), createPushReceiptJob({ checker })];
}
