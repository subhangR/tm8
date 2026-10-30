/**
 * Bridges B1b-5 (BRIDGE-ENTITY-DESIGN §2.5, §7.3 item 8): the QR or pairing
 * code for `bridges.connections.begin`, relayed from the connector runtime to
 * the member who asked, and to nobody else. It is never stored.
 *
 * Coordinator ruling (2026-10-30, on §3.6): NOT the recipient_member_id
 * mechanism, which writes `workspace_events` and so would keep a QR in the
 * retained log behind `events.poll` and replay. Instead an in-memory pending
 * map (connection → the begin caller) and `fanOutToIdentity`, a fan-out whose
 * only selector is that caller's verified identity, on human sockets only.
 * The frame is not a `WorkspaceEvent`: no space, no seq, no log.
 *
 * B1b-2 owns the runtime side: its hub satisfies `BridgeRuntimeLink`
 * structurally, its `auth` door calls `relay()` and its `state` door calls
 * `settle()` on linked and logged_out.
 */
import {
  BridgeConnectionAuthFrameSchema, type AuthFrame, type BridgeConnectionAuthFlow, type BridgeConnectionAuthFrame,
} from '@tm8/contract';
import type { DbClaims } from '../db/types.js';
import { fanOutToIdentity, type IdentityAddress, type SubscriptionRegistry } from '../events/subscriptions.js';

/** The runtime hub as begin needs it (B1b-2's BridgeRuntimeHub). */
export interface BridgeRuntimeLink {
  /**
   * Send `connect` (stateKey and allowlist filled by the hub) to the live
   * runtime for the provider; null when no runtime of that provider is
   * connected. The hub records `bridge_connections.runtime_id` itself, under
   * `claims`: the begin caller's OWN claims, never the bridges worker's, so
   * 398's bridge_runtime_connect admits only the connection's human owner.
   */
  connect(input: { provider: 'whatsapp'; connectionId: string; authFlow?: BridgeConnectionAuthFlow }, claims: DbClaims): Promise<{ runtimeId: string } | null>;
}

/** How long a begin waits for its runtime before the pending entry lapses on its own. */
export const CONNECTION_AUTH_PENDING_MS = 10 * 60_000;

interface Pending { to: IdentityAddress; until: number }

export class ConnectionAuthRelay {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly registry: SubscriptionRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  /** begin: the next auth frames for this connection go to `to` only. A later begin replaces an earlier one. */
  expect(connectionId: string, to: IdentityAddress): void {
    this.pending.set(connectionId, { to, until: this.now() + CONNECTION_AUTH_PENDING_MS });
  }

  /**
   * The runtime's `auth` frame. Delivered to the begin caller's open human
   * sockets; dropped (false) when nobody asked, the ask lapsed, or the frame
   * is off-contract. Nothing about the frame is logged or kept.
   */
  relay(frame: AuthFrame): boolean {
    const entry = this.pending.get(frame.connectionId);
    if (!entry) return false;
    if (entry.until <= this.now()) {
      this.pending.delete(frame.connectionId);
      return false;
    }
    const candidate: BridgeConnectionAuthFrame = {
      type: 'bridge.connection.auth',
      connectionId: frame.connectionId,
      ...(frame.qrPng !== undefined ? { qrPng: frame.qrPng } : {}),
      ...(frame.pairingCode !== undefined ? { pairingCode: frame.pairingCode } : {}),
      expiresAt: frame.expiresAt,
    };
    const parsed = BridgeConnectionAuthFrameSchema.safeParse(candidate);
    if (!parsed.success) return false;
    return fanOutToIdentity(this.registry, entry.to, JSON.stringify(parsed.data)) > 0;
  }

  /** The connection linked or logged out: no more auth frames for it. */
  settle(connectionId: string): void {
    this.pending.delete(connectionId);
  }

  /** For tests and diagnostics: whether a begin is waiting on this connection. */
  isPending(connectionId: string): boolean {
    const entry = this.pending.get(connectionId);
    return entry !== undefined && entry.until > this.now();
  }
}
