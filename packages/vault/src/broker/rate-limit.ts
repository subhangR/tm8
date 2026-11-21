import { VaultError, type Clock, type VaultCaller } from '../core-types.js';
import type { VaultOperationName } from '@tm8/contract';
import { RECOVERY_CODE_COUNT } from '../owner-auth/codes.js';

/**
 * Every routed operation takes one token from the caller's bucket for its class before its authority is
 * checked, so refused calls count too (review addendum 2, C2).
 *
 * A bucket belongs to one member and one kind of caller. A member's browser and the agents acting as that
 * member never share one, so an agent's calls cannot spend the budget its member signs in, captures,
 * approves or revokes with. That holds even for calls the agent is refused.
 *
 * Human sign-in and capture are also limited by client address. Agents are not. An agent on the tm8 host
 * reaches the tm8 server over loopback, where the relay takes the address from X-Real-IP
 * (server/src/http/ws-admission.ts), so an agent's address is the host's own, which every member's agents
 * share, or one it chose. An address bucket would let it use up someone else's budget.
 */
export type RateClass = 'auth' | 'capture' | 'import' | 'verify' | 'read' | 'command';
export interface RateRule { capacity: number; refillPerSecond: number }
export const BROKER_RATE_LIMITS: Readonly<Record<RateClass, RateRule>> = {
  auth: { capacity: 10, refillPerSecond: 1 / 6 },
  capture: { capacity: 20, refillPerSecond: 1 / 3 },
  import: { capacity: 5, refillPerSecond: 1 / 12 },
  /** Each call walks the whole chain and reads the retained anchor. The audit panel asks once per page. */
  verify: { capacity: 20, refillPerSecond: 1 / 3 },
  read: { capacity: 120, refillPerSecond: 2 },
  command: { capacity: 30, refillPerSecond: 1 / 2 },
};

/**
 * Budgets the whole broker shares, whoever asks.
 *
 * `kdf` counts Argon2id hashes and verifications (64 MiB, t=3). Each one holds the broker's event loop for
 * about 0.4-0.6 s on the reference host (measured 21 Nov 2026), so per-caller limits alone would let enough
 * members together stall every request. The dispatcher charges it after every authority check, so a refused
 * request costs nothing.
 */
export type SharedRateClass = 'kdf';
export const BROKER_SHARED_LIMITS: Readonly<Record<SharedRateClass, RateRule>> = {
  kdf: { capacity: 20, refillPerSecond: 1 / 3 },
};

export function rateClass(op: VaultOperationName, read: boolean): RateClass {
  if (/^vault\.(webauthn|session|passkeys|recovery)\./.test(op)) return 'auth';
  if (/^vault\.(captures|captureLinks)\./.test(op)) return 'capture';
  if (op.startsWith('vault.imports.')) return 'import';
  if (op === 'vault.audit.verify') return 'verify';
  return read ? 'read' : 'command';
}

/**
 * How many Argon2id operations a request can run: one code verification, or one hash per new
 * recovery code. These are the only operations that reach owner-auth/codes.ts.
 */
export function kdfCost(op: VaultOperationName, input: unknown): number {
  if (op === 'vault.recovery.codes.create') return RECOVERY_CODE_COUNT;
  if (op === 'vault.passkeys.registerBegin' && typeof input === 'object' && input !== null) {
    const codes = input as { enrollmentCode?: unknown; recoveryCode?: unknown };
    return codes.enrollmentCode !== undefined || codes.recoveryCode !== undefined ? 1 : 0;
  }
  return 0;
}

/** Bounded, fail-closed token buckets; no caller values leave this object. */
export class BrokerRateLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number; rule: RateRule }>();
  constructor(
    private readonly clock: Clock,
    private readonly rules: Readonly<Record<RateClass, RateRule>> = BROKER_RATE_LIMITS,
    private readonly maxBuckets = 100_000,
    private readonly shared: Readonly<Record<SharedRateClass, RateRule>> = BROKER_SHARED_LIMITS,
  ) {
    for (const rule of [...Object.values(rules), ...Object.values(shared)]) {
      if (!Number.isFinite(rule.capacity) || rule.capacity < 1 || !Number.isFinite(rule.refillPerSecond) || rule.refillPerSecond <= 0) {
        throw new TypeError('vault broker: invalid rate limit');
      }
    }
    // A batch the budget can never hold would refuse every request for new recovery codes.
    if (shared.kdf.capacity < RECOVERY_CODE_COUNT) throw new TypeError('vault broker: invalid rate limit');
  }

  take(caller: VaultCaller, group: RateClass): void {
    const keys = [`member:${caller.spaceId}:${caller.memberId}:${caller.kind}:${group}`];
    if ((group === 'auth' || group === 'capture') && caller.kind === 'member' && caller.ip !== null) keys.push(`ip:${caller.ip}:${group}`);
    this.#take(keys, this.rules[group], 1);
  }

  /** Takes `cost` tokens from a budget the whole broker shares. */
  takeShared(group: SharedRateClass, cost: number): void {
    const rule = this.shared[group];
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > rule.capacity) throw new TypeError('vault broker: invalid rate cost');
    this.#take([`shared:${group}`], rule, cost);
  }

  #take(keys: string[], rule: RateRule, cost: number): void {
    const now = this.clock.now().getTime();
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
    const wait = Math.max(...selected.map((bucket) => Math.max(0, cost - bucket.tokens) / rule.refillPerSecond));
    if (wait > 0) throw new VaultError('rate_limited', null, { retryAfterSeconds: Math.ceil(wait) });
    for (const bucket of selected) bucket.tokens -= cost;
  }
}
