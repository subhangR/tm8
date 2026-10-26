/**
 * W9c (migration 301): the TARGET server's three server-to-server routes for
 * a space link whose home is on ANOTHER server (`REMOTE_SPACE_LINK_PATHS`).
 * Not catalog operations: they are dispatched before generic identity
 * resolution (like the voice webhook), because they authenticate themselves.
 * While `TM8_REMOTE_SPACE_LINKS` is off they do not exist (the router's 404).
 *
 *   claim  — no bearer. The pairing code from `spaceLinks.inbound.grant` is
 *            the credential: rate limited per client IP and per code-hash
 *            prefix, single use (burnt on any outcome, in SQL), and the home
 *            server must name the home space the grant named. It mints the
 *            member's `link` session, pinned to B and stamped via_link_id,
 *            and returns the token ONCE. Only its hash is stored here.
 *   invoke — `authorization: Bearer <link session>`. The ONLY wire a link
 *            session is accepted on (W7p layer (i) still refuses it on every
 *            other one), and only a live session of an INBOUND REMOTE row.
 *            The home server's guards are not trusted: this side re-applies
 *            its own — canonical op, SPACE_LINK_REFUSED with THIS row's spawn
 *            switch, the via chain (must end at the granted home; never back
 *            into B; hop limit), a rate bucket per row — then runs the op
 *            through the same admitted dispatch the local executor uses
 *            (createLinkDispatcher), so layers (ii) and (iii) and SQL decide.
 *            Every outcome is one `cross_space_audit` row in B, which B's
 *            admins read through spaceLinks.inbound.audit.
 *   revoke — the same bearer; ends the session (the home's logout/remove).
 *
 * A bad or dead bearer is 401, which the home reads as "signed out". Every
 * answer carries `remoteLink: 'v1'`, so the home tells a 404 from an op apart
 * from a 404 from a server that has no such route.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  CollabError,
  REMOTE_SPACE_LINK_PATHS,
  RemoteSpaceLinkClaimRequestSchema,
  SPACE_LINK_VIA_HEADER,
  SpaceLinksInvokeInputSchema,
  getOperation,
  isCollabError,
  isOperationName,
  spaceLinkRefusal,
  spaceLinkViaRefusal,
  type RemoteSpaceLinkClaimResponse,
  type RemoteSpaceLinkInvokeResponse,
  type SpaceLinkAuditEntry,
} from '@tm8/contract';

import type { DbClaims } from '../../../db/types.js';
import { readJsonBody } from '../../../http/body.js';
import { toWireError } from '../../../http/errors.js';
import { FixedWindowLimiter } from '../../../http/fixed-window.js';
import { identityFromSession } from '../../../http/identity-resolver.js';
import type { RequestContext, RequestIdentity } from '../../../http/types.js';
import { wsClientKey } from '../../../http/ws-admission.js';
import { isInvalidTokenError, resolveBearerIdentity, type ResolvedAuthSession } from '../../../identity/pg-auth.js';
import { pairingCodeHash, type DbSpaceLinkStore, type RemoteInboundRow } from '../../../credentials/space-link-store.js';
import { REMOTE_LINK_MARKER, REMOTE_LINK_MARKER_VALUE } from '../../../remote/link-forwarder.js';
import type { FacadeDeps } from '../../deps.js';
import { claimsFor } from '../../context.js';
import type { HandlerRegistry } from '../../registry.js';
import {
  SPACE_LINK_INVOKE_LIMIT,
  SPACE_LINK_REFUSED_CODE,
  SpaceLinkExecuteFailure,
  createLinkDispatcher,
  deferredToTarget,
  parseVia,
  remoteIdOf,
} from './space-link-invoke.js';

export type RemoteSpaceLinkRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { requestId: string },
) => Promise<boolean>;

/** Claim attempts per client IP, and per sha256 prefix of the code. */
export const REMOTE_CLAIM_IP_LIMIT = { limit: 10, windowMs: 60_000 } as const;
export const REMOTE_CLAIM_CODE_LIMIT = { limit: 5, windowMs: 10 * 60_000 } as const;

const PATHS: ReadonlySet<string> = new Set(Object.values(REMOTE_SPACE_LINK_PATHS));

export interface RemoteSpaceLinkRouteOptions {
  claimIpLimiter?: FixedWindowLimiter;
  claimCodeLimiter?: FixedWindowLimiter;
  invokeLimiter?: FixedWindowLimiter;
}

function unauthenticated(message = 'the remote space link session is not valid here'): CollabError {
  return new CollabError('unauthenticated', message, { details: { reason: 'space_link_signed_out' } });
}

function refusedErr(reason: string, message?: string): CollabError {
  return new CollabError('forbidden', message ?? `refused through a space link: ${reason}`, {
    details: { reason: SPACE_LINK_REFUSED_CODE, refusal: reason },
  });
}

function rateLimited(retryAfterMs: number): CollabError {
  return new CollabError('rate_limited', 'too many remote space link requests', {
    details: { retryAfterMs, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) },
  });
}

function send(res: ServerResponse, status: number, requestId: string, body: Record<string, unknown>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'x-tm8-request-id': requestId,
  });
  res.end(JSON.stringify({ ...body, [REMOTE_LINK_MARKER]: REMOTE_LINK_MARKER_VALUE }));
}

function sendError(res: ServerResponse, error: unknown, requestId: string): void {
  if (!isCollabError(error)) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`[space-link] remote route error (requestId=${requestId}): ${detail}`);
  }
  const { status, body } = toWireError(error, requestId);
  send(res, status, requestId, body as unknown as Record<string, unknown>);
}

function bearerOf(req: IncomingMessage): string | null {
  const raw = req.headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = /^Bearer\s+(\S+)$/i.exec(value?.trim() ?? '');
  return match ? match[1]! : null;
}

export function createRemoteSpaceLinkRoute(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  store: DbSpaceLinkStore,
  claimsOf: (ctx: RequestContext) => Promise<DbClaims>,
  options: RemoteSpaceLinkRouteOptions = {},
): RemoteSpaceLinkRoute {
  const claimIp = options.claimIpLimiter ?? new FixedWindowLimiter(REMOTE_CLAIM_IP_LIMIT);
  const claimCode = options.claimCodeLimiter ?? new FixedWindowLimiter(REMOTE_CLAIM_CODE_LIMIT);
  const invokeLimiter = options.invokeLimiter ?? new FixedWindowLimiter(SPACE_LINK_INVOKE_LIMIT);
  const spaceSessions = deps.config.spaceSessions ?? 'agents';
  const dispatch = createLinkDispatcher(registry, deps, store, claimsOf);

  /** The bearer, resolved here (never through the transport resolver) and held to kind `link`. */
  async function linkSession(req: IncomingMessage, requestId: string): Promise<{
    session: ResolvedAuthSession; identity: RequestIdentity; claims: DbClaims;
  }> {
    const token = bearerOf(req);
    if (!token) throw unauthenticated('a remote space link session is required');
    let session: ResolvedAuthSession;
    try {
      session = await resolveBearerIdentity(deps.db, token);
    } catch (error) {
      if (isInvalidTokenError(error) || (isCollabError(error) && error.code === 'unauthenticated')) throw unauthenticated();
      throw error;
    }
    // LoginKind predates kind `link` (250); the row's kind is read as written.
    if ((session.kind as string) !== 'link' || !session.viaLinkId || !session.spaceId) throw unauthenticated();
    // Pinned to B in every TM8_SPACE_SESSIONS mode; never node admin (K6).
    const identity: RequestIdentity = {
      ...identityFromSession(session, token, spaceSessions),
      sessionSpaceId: session.spaceId,
      nodeAdmin: false,
    };
    const claims = claimsFor(await deps.owner(), { identity, requestId } as RequestContext);
    return { session, identity, claims };
  }

  async function inboundRow(claims: DbClaims, sessionId: string): Promise<RemoteInboundRow> {
    try {
      return await store.inboundRow(claims, sessionId);
    } catch (error) {
      // Signed out, revoked, removed or not an inbound remote row: all the same to the home.
      if (isCollabError(error) && ['not_found', 'forbidden', 'conflict', 'invalid_input'].includes(error.code)) {
        throw unauthenticated();
      }
      throw error;
    }
  }

  async function claim(req: IncomingMessage, body: unknown): Promise<RemoteSpaceLinkClaimResponse> {
    const ip = claimIp.hit(wsClientKey(req));
    if (!ip.ok) throw rateLimited(ip.retryAfterMs);
    const parsed = RemoteSpaceLinkClaimRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new CollabError('invalid_input', 'malformed claim', { details: { issues: parsed.error.issues } });
    }
    const code = claimCode.hit(pairingCodeHash(parsed.data.pairingCode).slice(0, 8));
    if (!code.ok) throw rateLimited(code.retryAfterMs);
    const outcome = await store.claimInbound(parsed.data);
    if (!outcome.ok) {
      throw new CollabError('forbidden', 'the pairing code is invalid, expired, already used or for another home space', {
        details: { reason: `space_link_pairing_${outcome.reason}` },
      });
    }
    const { ok: _ok, ...claimed } = outcome;
    return claimed;
  }

  async function invoke(req: IncomingMessage, body: unknown, requestId: string): Promise<RemoteSpaceLinkInvokeResponse> {
    const { session, identity, claims } = await linkSession(req, requestId);
    const row = await inboundRow(claims, session.sessionId);

    let op = '(unknown)';
    let via: string[] = [];
    const audit = (result: SpaceLinkAuditEntry['result'], reason: string | null, remoteId: string | null = null) =>
      store.recordAudit(claims, {
        homeSpaceId: row.targetSpaceId, linkId: row.linkId, linkRef: row.linkId, targetSpaceId: row.targetSpaceId,
        workSessionId: null, op, via, result, reason, remoteId,
      });
    const refuse = async (error: CollabError, reason: string): Promise<never> => {
      await audit('refused', reason).catch(() => undefined);
      throw error;
    };

    const parsed = SpaceLinksInvokeInputSchema.safeParse(body);
    if (!parsed.success) {
      return refuse(new CollabError('invalid_input', 'malformed invoke', { details: { issues: parsed.error.issues } }), 'invalid_input');
    }
    const { op: requested, params, query, input } = parsed.data;
    if (!isOperationName(requested)) {
      return refuse(refusedErr('unknown_op', 'not a catalog operation (names are exact and case-sensitive)'), 'unknown_op');
    }
    op = requested;
    const binding = getOperation(requested);
    // THIS server's refused set and THIS row's spawn switch: the home's are not trusted.
    // An own-spawn session body (#1053) is decided by the dispatcher, from THIS
    // server's spawn provenance under the link session, exactly as for a local link.
    const refusal = spaceLinkRefusal(requested, binding.kind, input, row.allowSpawn === true);
    if (refusal && !deferredToTarget(requested, refusal)) return refuse(refusedErr(refusal), refusal);

    try {
      via = parseVia(req.headers[SPACE_LINK_VIA_HEADER]);
    } catch (error) {
      return refuse(error as CollabError, 'via_hops');
    }
    // The chain ends at the home space the grant named; B is never already in it.
    const home = via[via.length - 1];
    if (!home || home !== row.remoteHomeSpaceId.toLowerCase()) {
      return refuse(refusedErr('via_loop', 'the via chain must end at the link\'s home space'), 'via_home');
    }
    const chain = spaceLinkViaRefusal(via.slice(0, -1), home, row.targetSpaceId);
    if (chain) return refuse(refusedErr(chain), chain);

    const verdict = invokeLimiter.hit(row.tokenRowId);
    if (!verdict.ok) return refuse(rateLimited(verdict.retryAfterMs), 'rate_limited');
    if (!registry.get(requested) || binding.status !== 'v1') {
      return refuse(new CollabError('not_implemented', `operation ${requested} is not implemented on this node`), 'not_implemented');
    }
    if (binding.kind === 'stream') {
      return refuse(new CollabError('invalid_input', 'a streaming operation cannot run through a space link'), 'stream_op');
    }

    let outcome;
    try {
      outcome = await dispatch({
        identity, linkId: row.linkId, targetSpaceId: row.targetSpaceId, op: requested, binding,
        params: params ?? {}, query: query ?? {}, input, via, sourceWorkSessionId: null,
        // The home's ids are unknown here: completers are authorized by B as named.
        homeIds: [], link: { linkId: row.linkId, targetSpaceId: row.targetSpaceId },
      });
    } catch (error) {
      if (error instanceof SpaceLinkExecuteFailure) {
        await audit('error', error.reason).catch(() => undefined);
        throw error.error;
      }
      await audit('error', isCollabError(error) ? error.code : 'internal').catch(() => undefined);
      throw error;
    }
    const { data, requestId: innerId, spawnedSessionId, provenanceUnrecorded } = outcome;
    const recorded = audit('ok', provenanceUnrecorded ? 'provenance_unrecorded' : null,
      spawnedSessionId ?? remoteIdOf(data) ?? innerId);
    // A spawn already happened: a failed audit must not turn it into a retry.
    const auditId = spawnedSessionId ? await recorded.catch(() => '') : await recorded;
    return { result: data, auditId, spawnedSessionId: spawnedSessionId ?? null };
  }

  async function revoke(req: IncomingMessage, requestId: string): Promise<{ revoked: boolean }> {
    const { session, claims } = await linkSession(req, requestId);
    try {
      return { revoked: await store.revokeInboundSession(claims, session.sessionId) };
    } catch (error) {
      if (isCollabError(error) && ['not_found', 'forbidden'].includes(error.code)) throw unauthenticated();
      throw error;
    }
  }

  return async (req, res, { requestId }) => {
    if (deps.config.remoteSpaceLinks !== true || req.method !== 'POST') return false;
    const pathname = new URL(req.url ?? '/', 'http://tm8.invalid').pathname;
    if (!PATHS.has(pathname)) return false;
    try {
      const { value: body } = await readJsonBody(req, Math.min(deps.config.maxBodyBytes ?? 1024 * 1024, 1024 * 1024));
      let data: unknown;
      if (pathname === REMOTE_SPACE_LINK_PATHS.claim) data = await claim(req, body);
      else if (pathname === REMOTE_SPACE_LINK_PATHS.invoke) data = await invoke(req, body, requestId);
      else data = await revoke(req, requestId);
      send(res, 200, requestId, { data, requestId });
    } catch (error) {
      sendError(res, error, requestId);
    }
    return true;
  };
}
