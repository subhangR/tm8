/**
 * REMOTE INVOKE — the seam between W7's `spaceLinks.invoke` and W8's remote
 * servers (plan 01a0d9eb §3 W8, T25/T27).
 *
 * W7 calls `forward` when a link's `target_server_id` is set (the target space
 * is on another server). W7 has already applied the refused set on the HOME
 * server; this module adds no second list.
 *
 * For a remote link W7 must NOT call `DbSpaceLinkStore.use()`: that resolves
 * the stored token against THIS node's auth_sessions, where a token minted on
 * S2 never exists, so it would mark every remote link `signed_out`. The
 * forwarder opens the sealed link session itself and never resolves it here.
 *
 * W9c (migration 299) enables it BEHIND A SWITCH (`TM8_REMOTE_SPACE_LINKS`,
 * default off). Off, the composition root wires `DisabledRemoteInvokeForwarder`
 * exactly as W8 did, so a remote link refuses at once with
 * `space_link_remote_disabled`. On, it wires `HttpsRemoteInvokeForwarder`
 * (link-forwarder.ts): the stored session is NOT a human gate session (that
 * storage is retired, finding S4) but a `link` session the TARGET minted for
 * the member, pinned to B, presented only on the target's dedicated
 * `/link/v1/invoke` route. Every other wire still refuses a link token (W7p
 * layer (i)), and the target re-applies its own refused set.
 */
import type { DbClaims } from '../db/types.js';

export interface RemoteInvokeRequest {
  /** The calling agent's claims on the HOME server (they own the link row). */
  claims: DbClaims;
  linkId: string;
  /** The `server` entity the link targets (`space_links.target_server_id`). */
  serverId: string;
  /** A catalog operation name, e.g. `entities.get`. */
  op: string;
  /** Path parameters for the op's route (`:id`, `:spaceId`, ...). */
  params?: Record<string, string>;
  /** Query string parameters. */
  query?: Record<string, string>;
  input: unknown;
  /**
   * Sent as `x-tm8-via` EXACTLY as given: W7 fills it as
   * `[...received chain, homeSpaceId]`, the in-process header's value. The
   * forwarder adds no hop of its own.
   */
  via: readonly string[];
  workSessionId?: string;
  /** Whole-call budget; defaults to `REMOTE_INVOKE_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export type RemoteInvokeResult =
  /** S2 answered 2xx. */
  | { kind: 'ok'; status: number; body: unknown }
  /** S2 answered a non-2xx other than 401; the error envelope is passed through. */
  | { kind: 'refused'; status: number; code: string; message: string }
  /**
   * S2 answered 401. THE FORWARDER marks the home row `signed_out` (244
   * `mark_space_link_stale`, no retry, member attention raised in SQL) before
   * returning this; W7 does not mark it.
   */
  | { kind: 'signed_out' }
  /** The guard or TLS refused before any request: the target can never be reached from here (T27). */
  | { kind: 'unreachable'; reason: 'non_public_address' | 'invalid_url' | 'dns' | 'tls' }
  /** The target is down: refused, reset or silent. Fails within the timeout. */
  | { kind: 'offline'; reason: 'connect_refused' | 'timeout' | 'reset' }
  /** Forwarding to another server is switched off on this node. Nothing was opened, resolved or sent. */
  | { kind: 'disabled'; reason: 'remote_links_disabled' }
  /**
   * W9c: the target answered 404 on the remote-link wire itself (not an op's
   * own not_found): an older build, or its switch is off. NOT signed_out —
   * the stored session may be perfectly good.
   */
  | { kind: 'unsupported' };

export interface RemoteInvokeForwarder {
  forward(request: RemoteInvokeRequest): Promise<RemoteInvokeResult>;
}

export const REMOTE_INVOKE_TIMEOUT_MS = 10_000;
/**
 * W9c: a spawn, resume or dispatch on the target provisions a workdir and
 * mints sessions before it answers (measured ~14s on a dev box), so it gets a
 * longer budget. A timeout there is NOT safe to retry: the child may exist.
 */
export const REMOTE_SPAWN_TIMEOUT_MS = 120_000;

/** The forwarder while `TM8_REMOTE_SPACE_LINKS` is off (the default): refuses, opens nothing. */
export class DisabledRemoteInvokeForwarder implements RemoteInvokeForwarder {
  async forward(_request: RemoteInvokeRequest): Promise<RemoteInvokeResult> {
    return { kind: 'disabled', reason: 'remote_links_disabled' };
  }
}
