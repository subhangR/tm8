/**
 * The security middleware seam.
 *
 * SCOPE. Rules from 10-SECURITY-MODEL enforced in this file as of the
 * artifacts Phase 0 (2026-07-31; previously every rule below was a named
 * no-op — see git history for the deferral rationale):
 *
 *   S1 — tm8-server binds 127.0.0.1 only. Enforced in ./config.ts, which
 *        REFUSES TO START on a non-loopback `TM8_BIND` rather than binding
 *        wide open without the token auth (S8) that would make it safe.
 *   S2 — Host-header allowlist (DNS-rebinding defense). The Host's hostname
 *        must be loopback (`127.0.0.1`, `localhost`, `::1`) or a configured
 *        hostname; otherwise 403. Applies to HTTP AND the WS upgrade — the
 *        upgrade listener has its own wiring in ./server.ts because it never
 *        passes through the ordinary request handler (design C3: two wiring
 *        changes, not one).
 *   S3 — Origin check: a request that CARRIES an Origin header is a browser
 *        context and its origin's hostname must be in the same allowlist. A
 *        request with NO Origin is a non-browser client (CLI, rigs) and is
 *        allowed — it authenticates per S8 instead. `Origin: null` (opaque
 *        origins: sandboxed iframes — exactly an artifact preview frame — and
 *        `file:` pages) is REFUSED: no legitimate caller of the privileged
 *        API is an opaque-origin document.
 *   S4 — CORS: same-origin only. This server never emits
 *        `Access-Control-Allow-Origin` — not `*`, not a reflected origin
 *        (grep: this file and ./server.ts set no ACAO header anywhere). A
 *        cross-site page therefore cannot READ responses; S3 above is what
 *        stops its mutations from LANDING. A CORS preflight (OPTIONS with
 *        Access-Control-Request-Method) announces a cross-origin intent and
 *        is refused outright.
 *   S6 — `X-TM8-Client` required on state-changing requests that carry the
 *        TM8 browser cookie. The Secure/HttpOnly cookie authenticates browser
 *        HTTP and native WebSocket upgrades, so this gate prevents ambient
 *        cookie authority from landing a cross-site mutation. "TM8 cookie" is
 *        load-bearing and was learned the hard way: cookies are host-scoped,
 *        not port-scoped, so gating on *any* Cookie header 403s every mutation
 *        as soon as an unrelated app on this loopback host sets one. See
 *        `carriesTm8Cookie`.
 *
 * THE PREVIEW-ORIGIN PARTITION (design §9.2/§9.3, user-ratified 2026-07-31):
 * when the artifact-preview listener is configured, its hostname is REMOVED
 * from the app allowlist below — the loopback trio included. A hostname is
 * only distinct if the other listener refuses it: the node binds loopback and
 * answers to every loopback name it is reached by, so leaving `localhost` in
 * the app's allowlist while the preview claims `localhost:4613` would be two
 * names for one socket and no separation at all. The preview listener's own
 * (inverse) Host check lives with it in ./artifact-preview.ts; the boot
 * refusal that keeps the two origins disjoint lives in ./config.ts.
 * Consequence, deliberate: the app is reached at `http://127.0.0.1:4610`,
 * never `http://localhost:4610` — that name now belongs to the preview.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { TM8_CLIENT_HEADER } from '@tm8/contract';
import type { ServerConfig } from './config.js';
import type { IdentityResolutionContext, IdentityResolver, RequestIdentity } from './types.js';

export interface SecurityDecision {
  /** `undefined` means "allowed". Otherwise the request is refused with this. */
  readonly refusal?: { code: 'forbidden'; message: string };
}

const ALLOWED: SecurityDecision = {};

/** Loopback names every tm8 node answers to. Mirrors config.ts LOOPBACK. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function refuse(message: string): SecurityDecision {
  return { refusal: { code: 'forbidden', message } };
}

/**
 * Hostname out of a Host header value: strips the port without breaking
 * bracketed IPv6 (`[::1]:4610` → `[::1]`), lowercases. Returns null for
 * values that cannot be a hostname at all.
 */
function hostnameOfHostHeader(host: string): string | null {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close === -1) return null;
    return trimmed.slice(0, close + 1);
  }
  const colon = trimmed.indexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

function allowedHostnames(config: ServerConfig): Set<string> {
  const set = new Set(LOOPBACK_HOSTNAMES);
  for (const name of config.extraAllowedHostnames ?? []) set.add(name.toLowerCase());
  // The preview-origin partition (header note): the preview hostname is the
  // OTHER listener's name, and this socket must refuse it — Host and Origin
  // both, since both checks read this set.
  if (config.preview) set.delete(config.preview.host);
  return set;
}

/** S2 — Host allowlist. A Host that names anything but this node is a
 * DNS-rebinding attempt (evil.com resolving to 127.0.0.1 still sends
 * `Host: evil.com`). An ABSENT Host is allowed: browsers always send one, so
 * absence proves a non-browser client, which S8 owns. */
export function checkHost(headers: IncomingHttpHeaders, config: ServerConfig): SecurityDecision {
  const host = headers.host;
  if (host === undefined) return ALLOWED;
  const hostname = hostnameOfHostHeader(host);
  if (hostname === null || !allowedHostnames(config).has(hostname)) {
    return refuse(`Host ${JSON.stringify(host)} is not this node (S2 host allowlist)`);
  }
  return ALLOWED;
}

/** S3/S4 — Origin allowlist for HTTP + the WS upgrade. See the header note. */
export function checkOrigin(headers: IncomingHttpHeaders, config: ServerConfig): SecurityDecision {
  const origin = headers.origin;
  if (origin === undefined) return ALLOWED; // non-browser client
  if (Array.isArray(origin) || origin.includes(',')) {
    return refuse('multiple Origin values are not accepted (S3)');
  }
  const value = origin;
  if (value === 'null') {
    return refuse('opaque-origin documents may not call this API (S3)');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return refuse(`unparseable Origin ${JSON.stringify(value)} (S3)`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if ((config.allowedOrigins?.length ?? 0) > 0) {
    // Browser Origin is exactly scheme://host[:port]. Refuse values that URL
    // parsing would otherwise normalize (credentials, path, query, fragment,
    // or a trailing slash) before comparing the operator's exact allowlist.
    if (value !== parsed.origin || !config.allowedOrigins!.includes(value)) {
      return refuse(`cross-origin request from ${parsed.origin} refused (S3 exact-origin allowlist)`);
    }
    return ALLOWED;
  }
  // URL.hostname strips IPv6 brackets; the allowlist stores both forms.
  if (!allowedHostnames(config).has(hostname) && !allowedHostnames(config).has(`[${hostname}]`)) {
    return refuse(`cross-origin request from ${parsed.origin} refused (S3/S4 same-origin only)`);
  }
  return ALLOWED;
}

/**
 * Does this request carry a cookie *tm8 itself* set?
 *
 * "Has a Cookie header" is NOT the same question, and conflating the two is
 * what turned S6 from a dormant gate into a hard block on every mutation:
 * cookies are scoped by host, NOT by port, so every cookie any other app on
 * this loopback host has ever set — some unrelated dev server on
 * `127.0.0.1:3000`, an OAuth callback, a notebook — is delivered to this node
 * too. A foreign cookie authenticates nothing here, so it must not arm a
 * CSRF gate that no tm8 client could satisfy.
 *
 * Matched by NAME, and matched loosely: any cookie name containing `tm8`
 * counts, so `tm8_session`, `tm8-sid` and the `__Host-tm8…` form are all
 * covered without this file having to predict the exact spelling a future
 * cookie-auth layer picks. That keeps the gate standing-by-default — the
 * property the deferral was protecting — while ignoring cookies that are none
 * of our business.
 */
function carriesTm8Cookie(header: IncomingHttpHeaders['cookie']): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(';') : header;
  return raw.split(';').some((pair) => (pair.split('=')[0] ?? '').trim().toLowerCase().includes('tm8'));
}

/**
 * S6 — `X-TM8-Client` on cookie-authenticated mutations. See the header note
 * and `carriesTm8Cookie` for why the trigger must mean *tm8's* cookies only.
 */
export function checkCsrf(
  method: string,
  headers: IncomingHttpHeaders,
  _config: ServerConfig,
): SecurityDecision {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return ALLOWED;
  // bearer/no-auth clients are exempt by construction
  if (!carriesTm8Cookie(headers.cookie)) return ALLOWED;
  if (headers[TM8_CLIENT_HEADER] === undefined) {
    return refuse('state-changing requests with a browser cookie require X-TM8-Client (S6)');
  }
  return ALLOWED;
}

/** S4 — a CORS preflight announces a cross-origin caller; there are none. */
function checkPreflight(method: string, headers: IncomingHttpHeaders): SecurityDecision {
  if (method === 'OPTIONS' && headers['access-control-request-method'] !== undefined) {
    return refuse('cross-origin use of this API is not supported (S4 same-origin only)');
  }
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
    () => checkPreflight(method, headers),
    () => checkCsrf(method, headers, config),
  ]) {
    const decision = check();
    if (decision.refusal) return decision;
  }
  return ALLOWED;
}

/**
 * S2 + S3 for the WS upgrade path. The upgrade listener in ./server.ts never
 * reaches the ordinary request handler, so it calls THIS — forgetting that
 * wiring is exactly the C3 under-scoping the design doc warns about. CSRF
 * does not apply to upgrades because exact Origin is the browser-side gate
 * there, and a preflight cannot precede one.
 */
export function checkUpgradeTransport(
  headers: IncomingHttpHeaders,
  config: ServerConfig,
): SecurityDecision {
  const host = checkHost(headers, config);
  if (host.refusal) return host;
  return checkOrigin(headers, config);
}

const FORWARDING_HEADERS = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
]);

/** Node reports IPv4 loopback as either form depending on the listening socket. */
export function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  return remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
}

/**
 * Forwarding headers are a privilege-reduction signal only. Their values are
 * never trusted; mere presence proves the request traversed another HTTP hop.
 */
export function hasForwardingEvidence(headers: IncomingHttpHeaders): boolean {
  return Object.keys(headers).some((name) => FORWARDING_HEADERS.has(name.toLowerCase()));
}

/**
 * S5 / T-L7 — auto-owner is the degenerate single-machine path, not a
 * property of the server's bind address. A reverse proxy also connects to the
 * loopback socket, so all three conditions are required: the actual TCP peer
 * is loopback, no forwarding header is present, and the operator has not set
 * the kill switch. Any uncertainty narrows to anonymous.
 */
export const autoOwnerResolver: IdentityResolver = (
  headers: IncomingHttpHeaders,
  context: IdentityResolutionContext,
): RequestIdentity => {
  if (
    context.disableAutoOwner
    || !isLoopbackPeer(context.remoteAddress)
    || hasForwardingEvidence(headers)
  ) {
    return { kind: 'anonymous' };
  }
  return { kind: 'auto-owner' };
};

/** Response headers applied to every response the frame writes. */
export const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  // Blob download (S17) and any served asset must not be MIME-sniffed.
  'x-content-type-options': 'nosniff',
};
