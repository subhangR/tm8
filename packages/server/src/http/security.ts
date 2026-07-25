/**
 * The security middleware seam.
 *
 * SCOPE, HONESTLY STATED. Per a CTO scope trim (2026-07-25, user-directed —
 * speed to the working loop), exactly ONE rule from 10-SECURITY-MODEL is
 * enforced in this pass:
 *
 *   S1 — tm8-server binds 127.0.0.1 only. Enforced in ./config.ts, which
 *        REFUSES TO START on a non-loopback `TM8_BIND` rather than binding
 *        wide open without the token auth (S8) that would make it safe.
 *
 * Everything else in §2–§3 of the security model is DEFERRED to post-G1A and
 * slots into this file. It is not implemented, and this file does not pretend
 * otherwise — each rule below is a named no-op with its acceptance test
 * already written down (10-SECURITY §10), so landing it later is filling in a
 * body, not rediscovering a requirement:
 *
 *   S2 — Host-header allowlist (DNS-rebinding defense). `Host` must be
 *        `localhost:<port>`, `127.0.0.1:<port>`, or a configured hostname;
 *        otherwise 403. Applies to HTTP and the WS upgrade.
 *   S3 — WS Origin check on `/v2/ws` and PTY sockets: reject browser origins
 *        other than the served UI origin(s). A request with NO Origin is a
 *        non-browser client (CLI, rigs) and is allowed — it authenticates per
 *        S8 instead.
 *   S4 — CORS: same-origin only. Never `Access-Control-Allow-Origin: *`,
 *        never a reflected origin. The UI is served by tm8-server (or proxied
 *        by the Vite dev server) precisely so cross-origin access is never
 *        needed.
 *   S6 — `X-TM8-Client` required on state-changing requests that carry a
 *        browser session cookie; bearer-token clients are exempt by
 *        construction.
 *
 * WHY IT IS SAFE TO DEFER *RIGHT NOW*, and only right now: with S1 enforced
 * the socket is unreachable from the network. The residual exposure is a
 * malicious page in the user's own browser (adversary A1) reaching
 * `127.0.0.1:4610` — which is real, and which S2/S3/S4/S6 exist to close.
 * This must not ship to G1A unclosed.
 *
 * The check functions are wired into the request pipeline TODAY as pass-through
 * calls, so enabling a rule is a change to this file alone.
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { ServerConfig } from './config.js';
import type { IdentityResolver, RequestIdentity } from './types.js';

export interface SecurityDecision {
  /** `undefined` means "allowed". Otherwise the request is refused with this. */
  readonly refusal?: { code: 'forbidden'; message: string };
}

const ALLOWED: SecurityDecision = {};

/** S2 — Host allowlist. DEFERRED: currently allows everything. */
export function checkHost(_headers: IncomingHttpHeaders, _config: ServerConfig): SecurityDecision {
  return ALLOWED;
}

/** S3/S4 — Origin allowlist for HTTP + the WS upgrade. DEFERRED. */
export function checkOrigin(_headers: IncomingHttpHeaders, _config: ServerConfig): SecurityDecision {
  return ALLOWED;
}

/** S6 — `X-TM8-Client` on cookie-authenticated mutations. DEFERRED. */
export function checkCsrf(
  _method: string,
  _headers: IncomingHttpHeaders,
  _config: ServerConfig,
): SecurityDecision {
  return ALLOWED;
}

/**
 * Run every transport check in order, returning the first refusal.
 * One call site in the request pipeline; one place to add a rule.
 */
export function checkTransport(
  method: string,
  headers: IncomingHttpHeaders,
  config: ServerConfig,
): SecurityDecision {
  for (const check of [
    () => checkHost(headers, config),
    () => checkOrigin(headers, config),
    () => checkCsrf(method, headers, config),
  ]) {
    const decision = check();
    if (decision.refusal) return decision;
  }
  return ALLOWED;
}

/**
 * S5 — v1 local mode auto-authenticates the owner (T-L7). This is *only*
 * sound because S1 holds: the socket is loopback-only. The moment a
 * non-loopback bind is allowed, this resolver must be replaced by the
 * bearer-token path (S8) — the two changes are one change.
 *
 * W2 replaces this with the identity block's resolver (Lyra's package slice);
 * the returned `identityId`/`actorId` become `SET LOCAL tm8.identity_id` /
 * `tm8.actor_id` per transaction (Cygnus, R2).
 */
export const autoOwnerResolver: IdentityResolver = (): RequestIdentity => ({ kind: 'auto-owner' });

/** Response headers applied to every response the frame writes. */
export const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  // Blob download (S17) and any served asset must not be MIME-sniffed.
  'x-content-type-options': 'nosniff',
};
