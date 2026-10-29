/**
 * Push is dark by default (ac4): nothing is wired unless TM8_PUSH_RELAY=expo
 * and TM8_PUBLIC_ORIGIN are both set, and the composition takes an injected
 * relay, so a test never builds the Expo client at all.
 */
import { describe, expect, it } from 'vitest';

import type { Db } from '../../src/db/types.js';
import { createPushJobs, nodeDeviceTokenOpener, pushConfigFromEnv } from '../../src/push/index.js';
import { FakePushRelay } from './fake-relay.js';
import { ORIGIN, stubSeal } from './fixtures.js';

describe('pushConfigFromEnv', () => {
  it('is off when nothing is set, and says what to set', () => {
    expect(pushConfigFromEnv({}, ORIGIN)).toEqual({
      enabled: false, reason: 'not configured (set TM8_PUSH_RELAY=expo and TM8_PUBLIC_ORIGIN)',
    });
    expect(pushConfigFromEnv({ TM8_PUSH_RELAY: 'off' }, ORIGIN).enabled).toBe(false);
  });

  it('is off without a public origin: a push must name the origin the phone knows', () => {
    const result = pushConfigFromEnv({ TM8_PUSH_RELAY: 'expo' }, undefined);
    expect(result.enabled).toBe(false);
    expect(!result.enabled && result.reason).toContain('TM8_PUBLIC_ORIGIN');
  });

  it('refuses a relay it does not know rather than guessing', () => {
    const result = pushConfigFromEnv({ TM8_PUSH_RELAY: 'apns' }, ORIGIN);
    expect(result).toEqual({ enabled: false, reason: 'TM8_PUSH_RELAY="apns" is not a relay this node knows (expo)' });
  });

  it('is on with both, carrying the Expo access token only when one is set', () => {
    expect(pushConfigFromEnv({ TM8_PUSH_RELAY: ' Expo ' }, ORIGIN)).toEqual({
      enabled: true, config: { relay: 'expo', origin: ORIGIN },
    });
    expect(pushConfigFromEnv({ TM8_PUSH_RELAY: 'expo', TM8_EXPO_ACCESS_TOKEN: 'secret' }, ORIGIN)).toEqual({
      enabled: true, config: { relay: 'expo', origin: ORIGIN, accessToken: 'secret' },
    });
  });
});

describe('createPushJobs', () => {
  it('registers the dispatch and receipt jobs on the injected relay', async () => {
    const calls: string[] = [];
    const db = {
      rpc: async (_claims: unknown, fn: string) => {
        calls.push(fn);
        return fn === 'public.claim_push_dispatch'
          ? { items: [], enqueued: 0, skippedRead: 0, skippedNoDevice: 0, expired: 0 }
          : { ticketIds: [], expired: 0 };
      },
      tx: async () => { throw new Error('no transaction expected'); },
      query: async () => [],
      end: async () => undefined,
    } as unknown as Db;
    const relay = new FakePushRelay();
    const jobs = createPushJobs({
      db,
      config: { relay: 'expo', origin: ORIGIN },
      openToken: () => 'never',
      claims: async () => ({ identityId: 'owner', nodeAdmin: true, backgroundJob: 'push.dispatch' }),
      relay,
    });
    expect(jobs.map((job) => job.name)).toEqual(['push.dispatch', 'push.receipts']);
    for (const job of jobs) await job.run({} as never);
    expect(calls).toEqual(['public.claim_push_dispatch', 'public.claim_push_receipts']);
    expect(relay.sends).toHaveLength(0);
  });
});

describe('nodeDeviceTokenOpener before 392 is on the branch', () => {
  it('opens nothing, so a node built without S1 sends nothing', () => {
    const open = nodeDeviceTokenOpener(Buffer.alloc(32));
    expect(() => open('alice', stubSeal('alice', 'ExponentPushToken[x]'))).toThrow(/392/);
  });
});
