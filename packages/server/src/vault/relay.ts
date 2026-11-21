/**
 * The tm8 server's vault relay (Secure Vault brief v2; task 01a1fa87-dd1a,
 * WS-A). Every /v2/vault request passes through here, and nothing else in the
 * server touches a vault route.
 *
 * WHAT IT DECIDES. Who is calling: a signed-in tm8 member, or an agent acting
 * for its launching member. Which space: the x-tm8-vault-space header checked
 * against the caller's own memberships, else the session's pinned space, else
 * the caller's only membership. Nothing about items, grants, approvals or
 * secrets: the broker decides all of that, and treats a tm8 credential as
 * attribution only, never as owner authority (packages/vault core-types.ts).
 *
 * WHAT IT FORWARDS. The method, the path and the raw query, the body bytes it
 * signed, a JSON content type and the broker's own two cookies. No
 * Authorization header, no tm8 session cookie and no other client header, so a
 * tm8 credential never reaches the broker. The signed attestation
 * (x-tm8-vault-caller) binds caller, method, path, query and a body digest for
 * at most 15 seconds, once.
 *
 * THE ORIGIN (independent review F04). The client's Origin header is not
 * forwarded either. For a browser session the attestation carries it instead,
 * signed, once checkTransport has accepted it; for every other caller it
 * carries null. The broker's human-only commands decide on that claim against
 * its own exact WebAuthn origins, so the relay neither drops nor replaces the
 * origin check: it is the one hop that can vouch for the header (attestableOrigin).
 *
 * WHAT IT PASSES BACK. The status and the JSON body, the broker's own cookies
 * in the broker's exact shape (anything else is dropped), a numeric
 * Retry-After, and the fixed RESPONSE_HEADERS below. No other broker header,
 * so the broker can never grant CORS or relax them. It strips
 * x-tm8-vault-alerts and writes each alert to the owner's tm8 inbox
 * (internal.vault_notify, migration 451).
 *
 * ORDER (http/server.ts). This runs after checkTransport, so a foreign Origin
 * (S3) and a cookie-carrying command without X-TM8-Client (S6) are already
 * refused, and before readJsonBody, because the bytes the attestation digests
 * must be the bytes forwarded.
 *
 * LOGS. Operation, status, duration, counts and the tm8 request id. Never a
 * body, a header value, a cookie, a caller id or an alert's params (RULE 5).
 */
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { CollabError, VAULT_BASE_PATH, VAULT_SPACE_HEADER } from '@tm8/contract';
import {
  AttestationTooLargeError, VAULT_ALERTS_HEADER, VAULT_ATTESTATION_HEADER, VAULT_COOKIE_NAMES,
  decodeVaultAlerts, isCanonicalBrowserOrigin, matchVaultRoute, signAttestation, vaultBodyLimit, type VaultAlertBatch,
} from '@tm8/vault/relay';

import type { Db, DbClaims } from '../db/types.js';
import type { FacadeDeps } from '../facade/deps.js';
import { readRawBody } from '../http/body.js';
import { supportClaims } from '../http/support-claims.js';
import type { RequestIdentity } from '../http/types.js';
import { wsClientKey } from '../http/ws-admission.js';
import { requireWriteApiScope } from '../identity/api-scope.js';
import type { VaultRelayConfig } from './config.js';

export type VaultCaller = Parameters<typeof signAttestation>[0]['caller'];
export type VaultAlert = VaultAlertBatch['alerts'][number];

/** The attestation schema's own bounds (packages/vault relay/attestation.ts). */
const MAX_PATH_CHARS = 512;
const MAX_QUERY_CHARS = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRINTABLE = /^[\x21-\x7e]*$/;
const JSON_REQUEST_TYPE = /^application\/json\s*(;\s*charset=utf-8\s*)?$/i;
const JSON_RESPONSE_TYPE = /^application\/json\s*(;|$)/i;
const VAULT_COOKIE_LIST: readonly string[] = [VAULT_COOKIE_NAMES.session, VAULT_COOKIE_NAMES.refresh];
/** serializeVaultCookie's exact output (packages/vault broker/dispatcher.ts). */
const VAULT_SET_COOKIE = new RegExp(
  `^(?:${VAULT_COOKIE_NAMES.session}=[A-Za-z0-9_-]{0,256}; Max-Age=\\d{1,10}; Path=/v2/vault`
  + `|${VAULT_COOKIE_NAMES.refresh}=[A-Za-z0-9_-]{0,256}; Max-Age=\\d{1,10}; Path=/v2/vault/session)`
  + '; HttpOnly; Secure; SameSite=Strict$',
);

/**
 * On every vault answer, the relay's refusals included. No Access-Control-* header is ever sent: tm8 refuses
 * cross-origin callers (http/security.ts S3 and S4).
 *
 * A vault answer is JSON that only a same-origin fetch reads, so it may load nothing, may not be framed, and
 * may not be embedded by another origin (review addendum 2, C3). Cross-Origin-Resource-Policy is same-origin,
 * not same-site, because artifacts.tm8.sh, which serves agent-authored documents, is the same site as tm8.sh
 * (deploy/utho/nginx/sites-available/artifacts-tm8-sh).
 */
const RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
});

/** Memberships the caller's own claims can see; a space-pinned session sees only its pin. */
const MEMBERSHIP_SQL = `select s.space_id::text as space_id,
       internal.current_member_id(s.space_id)::text as member_id,
       internal.is_space_admin(s.space_id) as admin
  from unnest(internal.member_space_ids()) as s(space_id)`;

const NOTIFY_SQL = 'select internal.vault_notify($1::uuid, $2::uuid, $3::text, $4::uuid, $5::jsonb, $6::timestamptz) as id';

export interface VaultRelayLogEvent {
  readonly event: 'vault.relay' | 'vault.alerts.dropped' | 'vault.alerts.undelivered' | 'vault.alerts.malformed';
  readonly requestId: string;
  readonly op?: string | null;
  readonly status?: number;
  readonly ms?: number;
  readonly count?: number;
}

export interface VaultRelayOptions {
  /** null: the vault is off on this node. */
  readonly config: VaultRelayConfig | null;
  readonly deps: FacadeDeps;
  /** Defaults to internal.vault_notify, run under the claims of the request the alert rode on. */
  readonly notify?: (alert: VaultAlert, claims: DbClaims) => Promise<void>;
  readonly log?: (event: VaultRelayLogEvent) => void;
  readonly now?: () => number;
}

export interface VaultRelayContext {
  readonly requestId: string;
  readonly identity: RequestIdentity;
  /** The server's parsed request URL: only pathname and search are read. */
  readonly url: URL;
}

export interface VaultRelay {
  readonly enabled: boolean;
  matches(pathname: string): boolean;
  handleHttp(req: IncomingMessage, res: ServerResponse, context: VaultRelayContext): Promise<void>;
  /** Resolves when every alert delivery started so far has settled. Tests and shutdown. */
  idle(): Promise<void>;
}

interface Membership { space_id: string; member_id: string | null; admin: boolean | null }

/** A refusal the relay writes itself, in the broker's error shape. */
class RelayRefusal extends Error {
  constructor(readonly status: number, readonly code: string, readonly reason: string) {
    super(`vault: ${reason}`);
  }
}

export function createVaultRelay(options: VaultRelayOptions): VaultRelay {
  const { config, deps } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? defaultLog;
  const notify = options.notify ?? ((alert: VaultAlert, claims: DbClaims) => deliverToInbox(deps.db, alert, claims));
  const pending = new Set<Promise<void>>();

  function deliverAlerts(header: string | string[], claims: DbClaims, requestId: string): void {
    let batch: VaultAlertBatch | null;
    try {
      batch = decodeVaultAlerts(header);
    } catch {
      log({ event: 'vault.alerts.malformed', requestId });
      return;
    }
    if (!batch) return;
    if (batch.dropped > 0) log({ event: 'vault.alerts.dropped', requestId, count: batch.dropped });
    const alerts = batch.alerts;
    if (alerts.length === 0) return;
    const run = (async () => {
      let failed = 0;
      for (const alert of alerts) {
        try { await notify(alert, claims); } catch { failed += 1; }
      }
      if (failed > 0) log({ event: 'vault.alerts.undelivered', requestId, count: failed });
    })();
    pending.add(run);
    void run.finally(() => pending.delete(run));
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse, context: VaultRelayContext): Promise<void> {
    const started = now();
    const { requestId, identity, url } = context;
    const method = req.method ?? 'GET';
    let op: string | null = null;
    const finish = (status: number): void => log({ event: 'vault.relay', requestId, op, status, ms: now() - started });

    try {
      // 401 and 403 travel through the server's own error writer, before any vault decision.
      admit(identity);
      if (!config) throw new RelayRefusal(503, 'upstream_unavailable', 'vault_disabled');
      const route = matchVaultRoute(method, url.pathname);
      if (!route) throw new RelayRefusal(404, 'not_found', 'not_found');
      op = route.row.name;
      if (route.row.method !== 'GET') requireWriteApiScope(identity);

      const path = url.pathname;
      const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
      if (path.length > MAX_PATH_CHARS || query.length > MAX_QUERY_CHARS || !PRINTABLE.test(path) || !PRINTABLE.test(query)) {
        throw new RelayRefusal(414, 'invalid_input', 'uri_too_long');
      }
      const body = await readBody(req, method, vaultBodyLimit(route.row.name));
      const claims = await supportClaims(deps, identity, requestId);
      const caller = await resolveCaller(deps.db, req, identity, claims);
      const origin = attestableOrigin(req, identity);

      let attestation: string;
      try {
        attestation = signAttestation({ privateKey: config.privateKey, caller, request: { method, path, query, body }, origin });
      } catch (error) {
        if (error instanceof AttestationTooLargeError) throw new RelayRefusal(414, 'invalid_input', 'uri_too_long');
        throw new RelayRefusal(400, 'invalid_input', 'invalid_request');
      }

      const status = await forward(config, req, res, {
        method, target: query === '' ? path : `${path}?${query}`, body, attestation, requestId,
        onAlerts: (header) => deliverAlerts(header, claims, requestId),
      });
      finish(status);
    } catch (error) {
      if (error instanceof RelayRefusal) {
        writeRefusal(res, error, requestId);
        finish(error.status);
        return;
      }
      if (error instanceof CollabError) finish(error.status);
      throw error;
    }
  }

  return {
    enabled: config !== null,
    matches: (pathname) => pathname === VAULT_BASE_PATH || pathname.startsWith(`${VAULT_BASE_PATH}/`),
    handleHttp,
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

/**
 * A signed-in human (browser or CLI) or an agent session. Not the loopback
 * auto-owner, which presents no credential at all, and not a space-link or
 * bridge-runtime credential, which acts for no member.
 */
function admit(identity: RequestIdentity): void {
  if (identity.kind !== 'bearer' || !identity.identityId) {
    throw new CollabError('unauthenticated', 'vault: sign in to tm8 first');
  }
  const kind = identity.authKind;
  if (kind !== 'browser' && kind !== 'cli' && kind !== 'agent' && kind !== 'agent_runtime') {
    throw new CollabError('forbidden', 'vault: this credential cannot use the vault');
  }
}

/** Exported for the relay tests. */
export async function resolveCaller(
  db: Db, req: IncomingMessage, identity: RequestIdentity, claims: DbClaims,
): Promise<VaultCaller> {
  const header = req.headers[VAULT_SPACE_HEADER];
  const requested = typeof header === 'string' ? header.trim().toLowerCase() : header;
  if (Array.isArray(requested) || (requested !== undefined && !UUID.test(requested))) {
    throw new RelayRefusal(400, 'invalid_input', 'invalid_space');
  }
  const rows = await db.query<Membership>(claims, MEMBERSHIP_SQL);
  const usable = rows.filter((row) => typeof row.member_id === 'string' && UUID.test(row.member_id) && UUID.test(row.space_id));
  const wanted = requested ?? identity.sessionSpaceId?.toLowerCase();
  const row = wanted !== undefined
    ? usable.find((candidate) => candidate.space_id === wanted)
    : usable.length === 1 ? usable[0] : undefined;
  if (!row) {
    if (wanted === undefined && usable.length > 1) throw new RelayRefusal(400, 'invalid_input', 'space_required');
    // One answer for a space that does not exist and a space the caller is not in.
    throw new RelayRefusal(403, 'forbidden', 'space_forbidden');
  }
  const agent = identity.authKind === 'agent' || identity.authKind === 'agent_runtime';
  const session = identity.workSessionId?.toLowerCase();
  const ip = wsClientKey(req);
  return {
    kind: agent ? 'agent' : 'member',
    memberId: row.member_id!,
    spaceId: row.space_id,
    sessionId: agent && session !== undefined && UUID.test(session) ? session : null,
    name: null,
    isSpaceAdmin: row.admin === true,
    ip: ip !== 'unknown' && ip.length <= 64 ? ip : null,
  };
}

/**
 * The Origin header to attest, or null. Exported for the relay tests.
 *
 * Only a browser session's: a browser sets Origin itself, and no page script can
 * change it, which is what the broker's human-only check relies on. A CLI, an
 * agent or a runtime credential gets null, whatever Origin it sends, so it can
 * never pass that check. The value is the header checkTransport already
 * accepted (this runs after it: S3 refuses a foreign, repeated or `null`
 * Origin), and only in its canonical form. A non-canonical value gets null
 * rather than a normalised one, so nothing is attested that the browser did
 * not send. The broker then requires an exact match with its WebAuthn origins.
 */
export function attestableOrigin(req: IncomingMessage, identity: RequestIdentity): string | null {
  if (identity.kind !== 'bearer' || identity.authKind !== 'browser') return null;
  const value = req.headers.origin;
  return isCanonicalBrowserOrigin(value) ? value : null;
}

async function readBody(req: IncomingMessage, method: string, limit: number): Promise<Buffer> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && !/^\d{1,12}$/.test(declared)) throw new RelayRefusal(400, 'invalid_input', 'invalid_request');
  let body: Buffer;
  try {
    // The server's streaming cap: stops buffering at the limit but keeps draining, so the 413 arrives.
    body = await readRawBody(req, limit);
  } catch (error) {
    if (error instanceof CollabError && error.code === 'payload_too_large') {
      throw new RelayRefusal(413, 'payload_too_large', 'payload_too_large');
    }
    throw error;
  }
  if (method === 'GET') {
    if (body.length > 0) throw new RelayRefusal(400, 'invalid_input', 'invalid_request');
    return body;
  }
  const type = req.headers['content-type'];
  if (body.length > 0 && (typeof type !== 'string' || !JSON_REQUEST_TYPE.test(type.trim()))) {
    throw new RelayRefusal(400, 'invalid_input', 'invalid_request');
  }
  return body;
}

/** Every occurrence of the two vault cookies, in order, so the broker can still refuse a duplicate. */
function vaultCookies(header: string | undefined): string | null {
  if (!header) return null;
  const pairs = header.split(';').map((pair) => pair.trim()).filter((pair) => {
    const eq = pair.indexOf('=');
    return eq > 0 && VAULT_COOKIE_LIST.includes(pair.slice(0, eq));
  });
  return pairs.length > 0 ? pairs.join('; ') : null;
}

interface Forwarded {
  readonly method: string;
  readonly target: string;
  readonly body: Buffer;
  readonly attestation: string;
  readonly requestId: string;
  readonly onAlerts: (header: string | string[]) => void;
}

/** Resolves with the status written, or 0 when the client was gone first. */
function forward(config: VaultRelayConfig, req: IncomingMessage, res: ServerResponse, request: Forwarded): Promise<number> {
  const headers: OutgoingHttpHeaders = {
    [VAULT_ATTESTATION_HEADER]: request.attestation,
    'content-length': String(request.body.length),
    connection: 'close',
  };
  if (request.body.length > 0) headers['content-type'] = 'application/json';
  const cookie = vaultCookies(req.headers.cookie);
  if (cookie) headers.cookie = cookie;

  return new Promise<number>((resolve, reject) => {
    // Gone while its body was read: never start a broker request for nobody.
    if (res.destroyed) { resolve(0); return; }
    let settled = false;
    const settle = (fn: () => void): void => { if (!settled) { settled = true; fn(); } };
    const broker = config.broker;
    const upstream = broker.kind === 'socket'
      ? httpRequest({ socketPath: broker.socketPath, path: request.target, method: request.method, headers, agent: false })
      : httpsRequest({
        host: broker.url.hostname, port: broker.url.port || 443, servername: broker.url.hostname,
        path: request.target, method: request.method, headers, agent: false,
        key: broker.key, cert: broker.cert, ca: broker.ca, minVersion: 'TLSv1.3', rejectUnauthorized: true,
      });
    const timer = setTimeout(() => upstream.destroy(new Error('vault broker timeout')), config.timeoutMs);
    // A caller who goes away takes the broker request with it: a fill must not outlive its requester.
    res.once('close', () => { if (!res.writableFinished) upstream.destroy(new Error('vault client closed')); });

    // on, not once: a destroyed request can emit a second error, and an unheard one crashes the server.
    upstream.on('error', () => {
      clearTimeout(timer);
      settle(() => {
        if (res.headersSent || res.destroyed) { res.destroy(); resolve(0); return; }
        reject(new RelayRefusal(503, 'upstream_unavailable', 'vault_unavailable'));
      });
    });
    upstream.once('response', (incoming) => {
      // The budget covers the whole answer, not only its headers: a broker that
      // stalls mid-body is cut at the same deadline.
      incoming.once('close', () => clearTimeout(timer));
      incoming.on('error', () => res.destroy());
      const alerts = incoming.headers[VAULT_ALERTS_HEADER];
      if (alerts !== undefined) request.onAlerts(alerts);
      const status = incoming.statusCode ?? 0;
      const type = incoming.headers['content-type'];
      if (status < 200 || status > 599 || typeof type !== 'string' || !JSON_RESPONSE_TYPE.test(type)) {
        incoming.resume();
        clearTimeout(timer);
        settle(() => reject(new RelayRefusal(503, 'upstream_unavailable', 'vault_unavailable')));
        return;
      }
      const out: OutgoingHttpHeaders = {
        ...RESPONSE_HEADERS, 'content-type': 'application/json; charset=utf-8', 'x-tm8-request-id': request.requestId,
      };
      const length = incoming.headers['content-length'];
      if (typeof length === 'string' && /^\d{1,12}$/.test(length)) out['content-length'] = length;
      const retryAfter = incoming.headers['retry-after'];
      if (typeof retryAfter === 'string' && /^\d{1,6}$/.test(retryAfter)) out['retry-after'] = retryAfter;
      const cookies = (incoming.headers['set-cookie'] ?? []).filter((value) => VAULT_SET_COOKIE.test(value));
      if (cookies.length > 0) out['set-cookie'] = cookies;
      settle(() => {
        if (res.destroyed) { incoming.resume(); resolve(0); return; }
        res.writeHead(status, out);
        incoming.once('aborted', () => res.destroy());
        incoming.pipe(res);
        resolve(status);
      });
    });
    upstream.end(request.body);
  });
}

function writeRefusal(res: ServerResponse, refusal: RelayRefusal, requestId: string): void {
  if (res.headersSent || res.destroyed) { res.destroy(); return; }
  const body = JSON.stringify({
    error: {
      code: refusal.code, message: refusal.message, details: { reason: refusal.reason }, requestId,
      retryable: refusal.status === 503 || refusal.status === 429,
    },
  });
  res.writeHead(refusal.status, {
    ...RESPONSE_HEADERS, 'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)), 'x-tm8-request-id': requestId,
  });
  res.end(body);
}

async function deliverToInbox(db: Db, alert: VaultAlert, claims: DbClaims): Promise<void> {
  await db.tx(claims, (q) => q.query(NOTIFY_SQL, [
    alert.spaceId, alert.memberId, alert.kind, alert.itemId, JSON.stringify(alert.params), alert.at,
  ]));
}

function defaultLog(event: VaultRelayLogEvent): void {
  const parts = [`requestId=${event.requestId}`];
  if (event.op !== undefined) parts.push(`op=${event.op ?? '-'}`);
  if (event.status !== undefined) parts.push(`status=${event.status}`);
  if (event.ms !== undefined) parts.push(`ms=${event.ms}`);
  if (event.count !== undefined) parts.push(`count=${event.count}`);
  const line = `[tm8] ${event.event} ${parts.join(' ')}`;
  if (event.event === 'vault.relay') console.info(line);
  else console.warn(line);
}
