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
 * The stored link session (L_C) is the only credential a forwarded call
 * presents. The member's gate token for S2 (`server_gate_tokens`) is used only
 * to mint and refresh L_C on S2.
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
  /**
   * Forwarding to another server is refused. Nothing was opened, resolved or
   * sent. Lead ruling 09:12Z (e): until S2's `auth.space.enter` can mint a
   * kind `link` session (with its cells) on main, a remote L_C would be a
   * pinned cli session there and S2 would not refuse it credential ops in SQL.
   */
  | { kind: 'disabled'; reason: 'remote_links_disabled' };

export interface RemoteInvokeForwarder {
  forward(request: RemoteInvokeRequest): Promise<RemoteInvokeResult>;
}

export const REMOTE_INVOKE_TIMEOUT_MS = 10_000;

/**
 * The forwarder. HARD-CODED REFUSAL (lead ruling 09:12Z (e)): no flag, env var,
 * config key or runtime switch reaches past it. Lifting it is a code change in
 * the PR that lands kind `link` minting on `auth.space.enter`, with its cells.
 */
export class DisabledRemoteInvokeForwarder implements RemoteInvokeForwarder {
  async forward(_request: RemoteInvokeRequest): Promise<RemoteInvokeResult> {
    return { kind: 'disabled', reason: 'remote_links_disabled' };
  }
}
