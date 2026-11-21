import { VaultError, type Clock, type VaultCaller } from '../core-types.js';
import type { VaultOperationName } from '@tm8/contract';

export type RateClass = 'auth' | 'capture' | 'import' | 'read' | 'command';
export interface RateRule { capacity: number; refillPerSecond: number }
export const BROKER_RATE_LIMITS: Readonly<Record<RateClass, RateRule>> = {
  auth: { capacity: 10, refillPerSecond: 1 / 6 },
  capture: { capacity: 20, refillPerSecond: 1 / 3 },
  import: { capacity: 5, refillPerSecond: 1 / 12 },
  read: { capacity: 120, refillPerSecond: 2 },
  command: { capacity: 30, refillPerSecond: 1 / 2 },
};

export function rateClass(op: VaultOperationName, read: boolean): RateClass {
  if (/^vault\.(webauthn|session|passkeys|recovery)\./.test(op)) return 'auth';
  if (/^vault\.(captures|captureLinks)\./.test(op)) return 'capture';
  if (op.startsWith('vault.imports.')) return 'import';
  return read ? 'read' : 'command';
}

/** Bounded, fail-closed token buckets; no caller values leave this object. */
export class BrokerRateLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number; rule: RateRule }>();
  constructor(private readonly clock: Clock, private readonly rules = BROKER_RATE_LIMITS, private readonly maxBuckets = 100_000) {
    for (const rule of Object.values(rules)) {
      if (!Number.isFinite(rule.capacity) || rule.capacity < 1 || !Number.isFinite(rule.refillPerSecond) || rule.refillPerSecond <= 0) {
        throw new TypeError('vault broker: invalid rate limit');
      }
    }
  }

  take(caller: VaultCaller, group: RateClass): void {
    const now = this.clock.now().getTime();
    const keys = [`member:${caller.spaceId}:${caller.memberId}:${group}`];
    if ((group === 'auth' || group === 'capture') && caller.ip !== null) keys.push(`ip:${caller.ip}:${group}`);
    const rule = this.rules[group];
    if (this.#buckets.size + keys.length > this.maxBuckets) {
      for (const [key, bucket] of this.#buckets) {
        if ((now - bucket.at) / 1000 * bucket.rule.refillPerSecond >= bucket.rule.capacity) this.#buckets.delete(key);
      }
    }
    const selected = keys.map((key) => {
      const old = this.#buckets.get(key);
      if (!old && this.#buckets.size >= this.maxBuckets) throw new VaultError('rate_limited', null, { retryAfterSeconds: 60 });
      const bucket = old ?? { tokens: rule.capacity, at: now, rule };
      bucket.tokens = Math.min(rule.capacity, bucket.tokens + Math.max(0, now - bucket.at) / 1000 * rule.refillPerSecond);
      bucket.at = now;
      this.#buckets.set(key, bucket);
      return bucket;
    });
    const wait = Math.max(...selected.map((bucket) => Math.max(0, 1 - bucket.tokens) / rule.refillPerSecond));
    if (wait > 0) throw new VaultError('rate_limited', null, { retryAfterSeconds: Math.ceil(wait) });
    for (const bucket of selected) bucket.tokens -= 1;
  }
}
