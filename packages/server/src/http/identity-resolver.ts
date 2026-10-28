/**
 * ONE identity path for every transport, and the file it can be tested from.
 *
 * This used to be an inline closure inside `startServer`, which meant the
 * resolver every HTTP request, every WebSocket upgrade and every raw-byte
 * support route runs through had no test that could reach it — the suites that
 * cover those routes all inject a stub identity, because there was nothing else
 * to inject. That gap has a cost on the record: the raw upload PUT carried the
 * `FileUploadGrant` token in `Authorization` while the browser attached its
 * session cookie to the same request, the two credentials disagreed, and this
 * resolver correctly refused the pair — on a path no test composed, so every
 * browser upload failed in production while the upload suite stayed green.
 *
 * `startServer` still owns the wiring; this file owns the RULE, and
 * `test/one-identity-path.test.ts` can now assert it directly.
 */
import type { IncomingMessage } from 'node:http';
import { CollabError } from '@tm8/contract';

import type { Db } from '../db/types.js';
import type { LoopbackOwner } from '../identity/loopback.js';
import { TOKEN_PREFIX } from '../identity/crypto.js';
import { refuseLinkSessionOnTransport } from '../identity/link-bearer.js';
import { refuseMcpTokenOnTransport } from '../identity/mcp-token.js';
import { resolveBearerIdentity, type ResolvedAuthSession } from '../identity/pg-auth.js';
import { readTm8SessionCookie } from './session-cookie.js';
import { autoOwnerResolver } from './security.js';
import type { IdentityResolver, RequestIdentity, SpaceSessionsMode } from './types.js';

export interface SessionIdentityResolverOptions {
  readonly db: Db;
  /** The memoised node-owner resolver — the auto-owner arm's source. */
  readonly owner: () => Promise<LoopbackOwner>;
  /** `TM8_SPACE_SESSIONS`, read once at boot. Absent means `agents`. */
  readonly spaceSessions?: SpaceSessionsMode;
}

/**
 * 226's `auth_sessions_pinned_kinds_have_space`: `check (kind not in ('agent',
 * 'agent_runtime', 'link') or space_id is not null)`. A row of one of these
 * kinds was minted FOR a Space and cannot exist without one, so its Space is
 * not a policy choice — it is part of what the credential is.
 */
const ALWAYS_PINNED_KINDS: ReadonlySet<string> = new Set(['agent', 'agent_runtime', 'link']);

/**
 * Whether a verified session row binds `tm8.session_space_id`.
 *
 * B20 (Q15). The three kinds 226 forces a `space_id` onto bind it in EVERY
 * `TM8_SPACE_SESSIONS` mode, `off` included. `off` gates only the HUMAN
 * `auth.space.enter` pins (233, W3) — the thing W3 added and the thing the
 * kill switch exists to take back. It was never meant to hand an agent bearer
 * its identity's OTHER Spaces, which is what un-pinning it does: one
 * `TM8_SPACE_SESSIONS=off` on a node turned every agent token into a
 * cross-Space credential for its whole identity (the pre-W0a leak). This is
 * the same argument `viaLinkId` below already carries: the pin only ever
 * NARROWS, so no mode may un-bind it.
 *
 * This REVERSES a documented decision: the W3 audit matrix (#852,
 * `test/db/cross-space-token.pg.test.ts`) pinned the un-pinning as "the
 * documented behaviour of the kill switch", in the same comment that called it
 * "the pre-W0a leak". Those nine cells now assert the narrowing, each citing
 * B20/Q15 and keeping its paired positive. The kind x mode table is
 * `test/identity/pinned-kinds-always-bound.test.ts`.
 *
 * A human row carries a `space_id` only when `auth.space.enter` minted it. A
 * human GATE session has `space_id` null and binds nothing, so under `agents`
 * every pre-W3 human session answers exactly as before.
 */
function sessionSpacePin(
  mode: SpaceSessionsMode,
  kind: string,
  spaceId: string | null | undefined,
  sessionId: string,
): string | undefined {
  if (ALWAYS_PINNED_KINDS.has(kind)) {
    // Unreachable through SQL while 226's CHECK stands, and refused rather
    // than binding `undefined` if it ever is: an agent row with no Space is a
    // broken invariant, and the fail-open answer is exactly the leak above.
    //
    // B32: logged at error level as well, because a 401 on its own reads as a
    // credential problem to whoever hit it and tells the OPERATOR nothing. The
    // session id and kind are enough to find the row; the token never appears.
    if (!spaceId) {
      console.error(
        `[tm8] BROKEN INVARIANT: auth_sessions row ${sessionId} of kind ${kind} has no space_id ` +
          `(226 auth_sessions_pinned_kinds_have_space); refusing the credential (B20/Q15)`,
      );
      throw new CollabError('unauthenticated', `a ${kind} session is not bound to a space`);
    }
    return spaceId;
  }
  return mode !== 'off' && spaceId ? spaceId : undefined;
}

/**
 * A valid tm8 session is resolved independently of transport; every non-session
 * request passes through the guarded local-only owner arm before the database
 * owner is attached.
 */
export function createSessionIdentityResolver(
  options: SessionIdentityResolverOptions,
): IdentityResolver {
  const { db, owner } = options;
  const spaceSessions = options.spaceSessions ?? 'agents';
  return async (headers, context) => {
    const header = headers.authorization;
    const authorization = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';
    const cookie = readTm8SessionCookie(headers) ?? '';
    // Authorization remains the CLI/agent carrier. A browser cookie is the
    // only credential a native WebSocket can send without putting a secret
    // in its URL. If both are present, they must name the same token: a
    // stale cookie plus a new Authorization pass must not silently choose a
    // principal and leave the other credential live in the request.
    //
    // This rule is why a CAPABILITY may never ride in `Authorization` on a
    // route a browser reaches — it is not a competing principal, but it is
    // indistinguishable from one here. See `TM8_UPLOAD_TOKEN_HEADER`.
    if (authorization && cookie && authorization !== cookie) {
      throw new CollabError('unauthenticated', 'conflicting authentication credentials');
    }
    const raw = authorization || cookie;
    // 357 (§5.5), layer (i): an MCP token is accepted ONLY by the `/mcp` route,
    // which resolves its own bearer. It is refused HERE, on the raw carrier,
    // and BEFORE the auto-owner arm — because `tm8m_` does not match the bearer
    // prefix below, so an unrefused MCP token would fall through to
    // `autoOwnerResolver` and come back as the node owner on any loopback
    // request. No allow-list, ever. See identity/mcp-token.ts.
    refuseMcpTokenOnTransport(raw);
    if (raw.startsWith(TOKEN_PREFIX)) {
      const session = await resolveBearerIdentity(db, raw);
      // 256 (W7p, layer (i)): a `link` session's token is never accepted on
      // a wire — every transport resolves through this closure. It is refused
      // HERE, not in the shared `resolveBearerIdentity`, which
      // `DbSpaceLinkStore.use` calls in-process. No allow-list, ever. See
      // identity/link-bearer.ts.
      refuseLinkSessionOnTransport(session.kind);
      return identityFromSession(session, raw, spaceSessions);
    }

    const fallback = await autoOwnerResolver(headers, context);
    if (fallback.kind === 'anonymous') return fallback;
    const resolved = await owner();
    // The auto-owner is the person at the node's own UI — a browser session
    // in everything but the token. It is never an agent: an agent always
    // arrives with a bearer credential on the branch above. The auto-owner
    // path's own exposure is gated by TM8_DISABLE_AUTO_OWNER; refusing it a
    // kind here would duplicate that control in the wrong file and break
    // local development for no gain.
    return { kind: 'auto-owner', identityId: resolved.identityId, authKind: 'browser' };
  };
}

/**
 * The request identity for a resolved session — the one mapping, shared by the
 * wire closure above and by an in-process caller that resolved a session
 * itself (`DbSpaceLinkStore.use`, and #884's invoke, which binds a `link`
 * session the wire never accepts). Every field comes off the verified row.
 */
export function identityFromSession(
  session: ResolvedAuthSession,
  raw: string,
  spaceSessions: SpaceSessionsMode,
): RequestIdentity {
  const sessionSpaceId = sessionSpacePin(spaceSessions, session.kind, session.spaceId, session.sessionId);
  return {
    kind: 'bearer',
    identityId: session.identityId,
    // K6 (W3): a space-pinned session never carries node-admin power; node
    // admin is gate admin. Migration 233 refuses it in SQL as well.
    nodeAdmin: sessionSpaceId ? false : session.isNodeAdmin || session.isOwner,
    accountId: session.accountId,
    sessionId: session.sessionId,
    ...(session.workSessionId ? { workSessionId: session.workSessionId } : {}),
    token: raw,
    ...(session.actingAsTeamMemberId ? { actorId: session.actingAsTeamMemberId } : {}),
    ...(session.runtimeMemberId ? { runtimeMemberId: session.runtimeMemberId } : {}),
    ...(session.runtimeThreadRootId
      ? { runtimeThreadRootId: session.runtimeThreadRootId }
      : {}),
    ...(session.runtimeChatId ? { runtimeChatId: session.runtimeChatId } : {}),
    ...(session.runtimeEpoch != null ? { runtimeEpoch: session.runtimeEpoch } : {}),
    ...(session.runtimeNativeGeneration != null ? { runtimeNativeGeneration: session.runtimeNativeGeneration } : {}),
    // 082 / R11. Taken straight off the verified session row, which
    // `resolveBearerIdentity` looked up by TOKEN HASH — so it is a
    // server fact, not a client assertion. This is the only thing that
    // distinguishes a human from an agent carrying that human's full
    // identity (sub-doc 14, channel C7).
    authKind: session.kind,
    apiScope: session.apiScope ?? 'write',
    // 226/227. The space the session was minted for, off the same
    // verified row. Every membership helper intersects with it. For an
    // agent, agent_runtime or link row it is bound in every spaces mode
    // (B20/Q15); for a human row only `auth.space.enter` sets it, and
    // `off` leaves it unbound.
    ...(sessionSpaceId ? { sessionSpaceId } : {}),
    // 256 (W7p). Off the same verified row; NOT gated by the spaces mode —
    // it only narrows, and `off` must not un-bind a link.
    ...(session.viaLinkId ? { viaLinkId: session.viaLinkId } : {}),
  };
}

/**
 * The WebSocket upgrades' resolver (events WS and PTY attach): the same
 * closure as HTTP — so layer (i)'s link refusal covers both sockets — with
 * anonymous refused. Lifted out of `startServer` so a test reaches the exact
 * function the sockets are wired to.
 */
export function createSocketIdentityResolver(
  resolver: IdentityResolver,
  disableAutoOwner: boolean,
): (req: IncomingMessage) => Promise<RequestIdentity> {
  return async (req) => {
    const identity = await resolver(req.headers, {
      remoteAddress: req.socket.remoteAddress,
      disableAutoOwner,
    });
    if (identity.kind === 'anonymous') {
      throw new CollabError('unauthenticated', 'authentication is required');
    }
    return identity;
  };
}
