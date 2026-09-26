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
import { CollabError } from '@tm8/contract';

import type { Db } from '../db/types.js';
import type { LoopbackOwner } from '../identity/loopback.js';
import { TOKEN_PREFIX } from '../identity/crypto.js';
import { resolveBearerIdentity } from '../identity/pg-auth.js';
import { readTm8SessionCookie } from './session-cookie.js';
import { autoOwnerResolver } from './security.js';
import type { IdentityResolver, SpaceSessionsMode } from './types.js';

export interface SessionIdentityResolverOptions {
  readonly db: Db;
  /** The memoised node-owner resolver — the auto-owner arm's source. */
  readonly owner: () => Promise<LoopbackOwner>;
  /** `TM8_SPACE_SESSIONS`, read once at boot. Absent means `agents`. */
  readonly spaceSessions?: SpaceSessionsMode;
}

/**
 * Whether a verified session row binds `tm8.session_space_id`. Every row that
 * carries a space binds it unless the node runs `off`: agent kinds always carry
 * one (226's `auth_sessions_pinned_kinds_have_space`), and a human row carries
 * one only when `auth.space.enter` (233, W3) minted it. A human GATE session
 * has `space_id` null and binds nothing, so under `agents` every pre-W3 human
 * session answers exactly as before.
 */
function sessionSpacePin(mode: SpaceSessionsMode, spaceId: string | null | undefined): string | undefined {
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
    if (raw.startsWith(TOKEN_PREFIX)) {
      const session = await resolveBearerIdentity(db, raw);
      const sessionSpaceId = sessionSpacePin(spaceSessions, session.spaceId);
      return {
        kind: 'bearer',
        identityId: session.identityId,
        // K6 (W3): a space-pinned session never carries node-admin power; node
        // admin is gate admin. Migration 233 refuses it in SQL as well.
        nodeAdmin: sessionSpaceId ? false : session.isNodeAdmin,
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
        // 082 / R11. Taken straight off the verified session row, which
        // `resolveBearerIdentity` looked up by TOKEN HASH — so it is a
        // server fact, not a client assertion. This is the only thing that
        // distinguishes a human from an agent carrying that human's full
        // identity (sub-doc 14, channel C7).
        authKind: session.kind,
        // 226/227. The space the session was minted for, off the same
        // verified row. Every membership helper intersects with it.
        ...(sessionSpaceId ? { sessionSpaceId } : {}),
      };
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
