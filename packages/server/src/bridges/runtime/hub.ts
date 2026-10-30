/**
 * The server's end of the connector runtime link (BRIDGE-ENTITY-DESIGN §2.5,
 * D35): the push socket each runtime holds at `/v2/ws?bridgeRuntime=<id>`,
 * the allowlist push (§2.3, D28) and the outbox dispatch.
 *
 * SKELETON: the exported surface siblings code against (B1b-5's
 * `BridgeRuntimeLink.connect`). The bodies land in the next commits.
 */
import { CollabError } from '@tm8/contract';

export interface BridgeRuntimeConnectInput {
  readonly provider: 'whatsapp';
  readonly connectionId: string;
  readonly authFlow?: { kind: 'qr' } | { kind: 'pairing'; phone: string };
}

export class BridgeRuntimeHub {
  /**
   * Starts (or re-links) one connection on the live runtime for its provider:
   * a `connect` frame with the connection's stateKey and a fresh allowlist.
   * Answers null when no runtime of that provider is connected.
   */
  async connect(_input: BridgeRuntimeConnectInput): Promise<{ runtimeId: string } | null> {
    throw new CollabError('upstream_unavailable', 'bridge runtime hub is not wired yet');
  }
}
