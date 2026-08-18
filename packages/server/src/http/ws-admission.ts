import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

import { FixedWindowLimiter } from './fixed-window.js';
import { isLoopbackPeer } from './security.js';

export interface WsAdmissionLimits {
  readonly maxConnections: number;
  readonly maxConnectionsPerClient: number;
  readonly maxConnectionsPerIdentity: number;
  readonly maxUpgradeAttempts: number;
  readonly upgradeWindowMs: number;
}

export const DEFAULT_WS_ADMISSION_LIMITS: WsAdmissionLimits = {
  maxConnections: 256,
  maxConnectionsPerClient: 16,
  maxConnectionsPerIdentity: 16,
  maxUpgradeAttempts: 120,
  upgradeWindowMs: 60_000,
};

export type WsAdmissionRefusal = { status: 429 | 503; message: 'upgrade refused' };
export type WsAdmissionLease = { ok: true; release(): void };

/** Stable, non-secret client bucket for the supported nginx→loopback shape. */
export function wsClientKey(req: IncomingMessage): string {
  const peer = req.socket?.remoteAddress ?? 'unknown';
  if (isLoopbackPeer(peer)) {
    const raw = req.headers['x-real-ip'];
    const candidate = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (candidate && isIP(candidate) !== 0) return candidate;
  }
  return peer;
}

export class WsAdmissionController {
  private readonly limits: WsAdmissionLimits;
  private total = 0;
  private readonly clients = new Map<string, number>();
  private readonly identities = new Map<string, number>();
  /**
   * The upgrade-rate half now lives in the shared limiter (./fixed-window.ts);
   * the counters below it are connection CAPACITY, which is a different
   * question and stays here. Behaviour is unchanged — same fixed window, same
   * lazy bounded eviction, same fail-closed-for-new-keys arm.
   */
  private readonly upgrades: FixedWindowLimiter;

  constructor(limits: Partial<WsAdmissionLimits> = {}, now: () => number = Date.now) {
    this.limits = { ...DEFAULT_WS_ADMISSION_LIMITS, ...limits };
    this.upgrades = new FixedWindowLimiter(
      { limit: this.limits.maxUpgradeAttempts, windowMs: this.limits.upgradeWindowMs },
      now,
    );
  }

  /** Rate and coarse-capacity check before expensive auth/grant consumption. */
  preflight(clientKey: string): WsAdmissionRefusal | undefined {
    if (!this.upgrades.hit(clientKey).ok) {
      return { status: 429, message: 'upgrade refused' };
    }
    if (this.total >= this.limits.maxConnections) {
      return { status: 503, message: 'upgrade refused' };
    }
    if ((this.clients.get(clientKey) ?? 0) >= this.limits.maxConnectionsPerClient) {
      return { status: 429, message: 'upgrade refused' };
    }
    return undefined;
  }

  /** Atomically reserves total/client/identity capacity; release is idempotent. */
  admit(clientKey: string, identityKey: string): WsAdmissionLease | WsAdmissionRefusal {
    if (this.total >= this.limits.maxConnections) {
      return { status: 503, message: 'upgrade refused' };
    }
    if (
      (this.clients.get(clientKey) ?? 0) >= this.limits.maxConnectionsPerClient ||
      (this.identities.get(identityKey) ?? 0) >= this.limits.maxConnectionsPerIdentity
    ) {
      return { status: 429, message: 'upgrade refused' };
    }
    this.total += 1;
    this.clients.set(clientKey, (this.clients.get(clientKey) ?? 0) + 1);
    this.identities.set(identityKey, (this.identities.get(identityKey) ?? 0) + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.total -= 1;
        this.decrement(this.clients, clientKey);
        this.decrement(this.identities, identityKey);
      },
    };
  }

  connectionCount(): number {
    return this.total;
  }

  private decrement(map: Map<string, number>, key: string): void {
    const next = (map.get(key) ?? 1) - 1;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }
}
